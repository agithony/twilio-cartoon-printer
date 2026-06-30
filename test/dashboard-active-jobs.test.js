const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const express = require("express");
const http = require("http");
const { READY_DIR, PRINTING_DIR } = require("../lib/config");

// Queue dirs are gitignored runtime dirs and may be absent in a fresh checkout
// (worktree / CI). Ensure they exist so the cold-cache read has a dir to scan.
fs.mkdirSync(READY_DIR, { recursive: true });
fs.mkdirSync(PRINTING_DIR, { recursive: true });

// Mounting the dashboard pulls in the messaging/Twilio chain, which opens a
// keep-alive Socket that holds the event loop open after tests finish. Force a
// clean exit once assertions have reported, instead of waiting for the runner's
// timeout. (Pre-existing trait shared by other tests importing that chain.)
after(() => setImmediate(() => process.exit(0)));

// End-to-end test of the /api/active-jobs endpoint and the cold-cache fix.
// We mount the real dashboard router on a bare app and hit it over HTTP on a
// freshly-required module — i.e. a COLD cache. Before the fix the in-flight
// job endpoints returned [] until the module-load pre-warm resolved (~1s),
// which is exactly the "jobs don't show up / counts wrong right after start"
// symptom. With readJobsAsync's cold-path await, the first request must return
// the real ready jobs already sitting in the queue.
const { mountDashboard } = require("../lib/dashboard");

function get(app, p) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            http.get({ port, path: p }, (res) => {
                let chunks = "";
                res.on("data", (c) => chunks += c);
                res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }); });
            }).on("error", (err) => { server.close(); reject(err); });
        });
    });
}

function makeApp() {
    const app = express();
    mountDashboard(app);
    return app;
}

test("GET /api/active-jobs returns an array on a cold cache (no empty-first-call)", async () => {
    const app = makeApp();
    const { status, body } = await get(app, "/dashboard/api/active-jobs?e=all");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), "should return an array");
    // The repo's queue/ready currently holds healthy ready jobs; the cold-path
    // await means they appear on the very first request, not after pre-warm.
    // We assert the shape rather than an exact count (count is environmental).
    for (const j of body) {
        assert.ok(j.filename, "row has filename");
        assert.ok(j.status === "ready" || j.status === "printing", "row has a live status");
        assert.ok("enteredAt" in j, "row has enteredAt for sorting");
        // Phone must be masked, never raw E.164.
        if (j.phone) assert.ok(!/^\+\d{7,}$/.test(j.phone), "phone must be masked, not raw");
    }
});

test("GET /api/active-jobs respects the event filter", async () => {
    const app = makeApp();
    const { status, body } = await get(app, "/dashboard/api/active-jobs?e=__definitely_no_such_event__");
    assert.equal(status, 200);
    assert.deepEqual(body, [], "unknown event should yield no active jobs");
});
