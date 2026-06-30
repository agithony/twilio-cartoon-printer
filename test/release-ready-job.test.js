const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const http = require("http");

// Integration test for POST /dashboard/api/release-ready-job: it must clear a
// stranded ready job's failedPrinters + targetPrinter so any printer can claim
// it, while leaving the job in READY_DIR (no double-print risk).
const { READY_DIR } = require("../lib/config");
const { mountDashboard } = require("../lib/dashboard");

fs.mkdirSync(READY_DIR, { recursive: true });

const FNAME = "29991231_235955.json";
const readyPath = path.join(READY_DIR, FNAME);

after(() => {
    try { fs.unlinkSync(readyPath); } catch {}
    setImmediate(() => process.exit(0));
});

function post(app, p, body) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const data = JSON.stringify(body);
            const req = http.request(
                { port, method: "POST", path: p, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
                (res) => {
                    let chunks = "";
                    res.on("data", (c) => (chunks += c));
                    res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }); });
                },
            );
            req.on("error", (e) => { server.close(); reject(e); });
            req.write(data);
            req.end();
        });
    });
}

function app() {
    const a = express();
    mountDashboard(a);
    return a;
}

test("release clears failedPrinters + targetPrinter and keeps job in ready/", async () => {
    fs.writeFileSync(readyPath, JSON.stringify({
        filePrefix: "29991231_235955",
        eventName: "__release_test__",
        failedPrinters: ["EPSON_ET_8550_Series"],
        targetPrinter: "EPSON_ET_8550_Series",
        retries: 2,
    }));

    const { status, body } = await post(app(), "/dashboard/api/release-ready-job", { filename: FNAME });
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Job still in ready/ (not moved → no double-print), and cleared.
    assert.equal(fs.existsSync(readyPath), true);
    const job = JSON.parse(fs.readFileSync(readyPath, "utf-8"));
    assert.deepEqual(job.failedPrinters, []);
    assert.ok(!("targetPrinter" in job));
    assert.equal(job.retries, 0);
});

test("release returns 404 for a job not in ready/", async () => {
    const { status, body } = await post(app(), "/dashboard/api/release-ready-job", { filename: "29990000_000000.json" });
    assert.equal(status, 404);
    assert.ok(body.error);
});

test("release rejects a bad filename", async () => {
    const { status } = await post(app(), "/dashboard/api/release-ready-job", { filename: "" });
    assert.equal(status, 400);
});
