const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { RelayEngine } = require("../relay-app/relay");
const { RELAY_TEMP_DIR } = require("../relay-app/job-files");
const { READY_DIR, PRINTING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const { mountPrintRelay } = require("../lib/print-relay");

const FILENAME = "29991231_235950.json";
const IMAGE = "29991231_235950_output.png";
const imagePath = path.join(RELAY_TEMP_DIR, IMAGE);
const SERVER_FILENAME = "29991231_235953.json";
const SERVER_PREFIX = SERVER_FILENAME.replace(/\.json$/, "");
const SERVER_EVENT = "__relay_ack_profile_test__";
const serverReadyPath = path.join(READY_DIR, SERVER_FILENAME);
const serverPrintingPath = path.join(PRINTING_DIR, SERVER_FILENAME);
const serverDownloadDirectory = settings.getDownloadDir(SERVER_EVENT);
const serverImagePath = path.join(serverDownloadDirectory, `${SERVER_PREFIX}_output.png`);
const RELAY_KEY = "output-profile-test-key";

after(() => {
    fs.rmSync(imagePath, { force: true });
    fs.rmSync(serverReadyPath, { force: true });
    fs.rmSync(serverPrintingPath, { force: true });
    fs.rmSync(serverDownloadDirectory, { recursive: true, force: true });
});

function postRelay(urlPath, body) {
    const app = express();
    mountPrintRelay(app);
    const originalGet = settings.get;
    settings.get = function patchedGet(key, ...args) {
        if (key === "printRelayKey") return RELAY_KEY;
        return originalGet.call(settings, key, ...args);
    };
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const data = JSON.stringify(body);
            const req = http.request({
                port: server.address().port,
                method: "POST",
                path: `/api/print-relay${urlPath}`,
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(data),
                    "x-relay-key": RELAY_KEY,
                    "x-relay-version": "1.3.1",
                },
            }, (res) => {
                let chunks = "";
                res.on("data", (chunk) => { chunks += chunk; });
                res.on("end", () => {
                    server.close(() => {
                        settings.get = originalGet;
                        resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
                    });
                });
            });
            req.on("error", (err) => {
                server.close(() => {
                    settings.get = originalGet;
                    reject(err);
                });
            });
            req.write(data);
            req.end();
        });
    });
}

test("relay forwards the acknowledged per-job output profile to printing", async () => {
    const profile = {
        printSize: "6x4",
        printQuality: "high",
        orientation: "landscape",
        customPrintFlags: "",
    };
    const engine = new RelayEngine();
    const logs = [];
    engine.on("log", (message) => logs.push(message));
    engine.running = true;
    engine.config = { url: "https://example.test", key: "key", printer: "EPSON_ET_8550_Series", dryRun: false };
    engine._findPrinter = async () => "EPSON_ET_8550_Series";
    engine._startHeartbeat = () => {};
    engine._stopHeartbeat = () => {};
    engine._downloadFile = async (_url, destination) => {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, "PNGDATA");
    };
    let printed = null;
    let completionBody = null;
    engine._printImage = async (downloadedPath, printerName, outputProfile) => {
        printed = { downloadedPath, printerName, outputProfile };
    };
    engine._request = async (method, requestPath, requestBody) => {
        if (method === "GET" && requestPath.startsWith("/api/print-relay/jobs")) {
            return { status: 200, data: { jobs: [{ filename: FILENAME, eventName: "event", style: "cartoon" }] } };
        }
        if (method === "POST" && requestPath.endsWith("/ack")) {
            return { status: 200, data: { job: { filename: FILENAME, eventName: "event", imageFile: IMAGE, claimId: "claim-1", outputProfile: profile } } };
        }
        if (method === "POST" && requestPath.endsWith("/complete")) {
            completionBody = requestBody;
            return { status: 200, data: { ok: true } };
        }
        throw new Error(`Unexpected request: ${method} ${requestPath}`);
    };

    await engine._pollOnce();

    assert.deepEqual(printed, {
        downloadedPath: imagePath,
        printerName: "EPSON_ET_8550_Series",
        outputProfile: profile,
    }, logs.join("\n"));
    assert.deepEqual(completionBody, { success: true, claimId: "claim-1" });
});

test("relay includes the ACK claim ID when reporting a pre-print failure", async () => {
    const engine = new RelayEngine();
    engine.running = true;
    engine.config = { url: "https://example.test", key: "key", printer: "EPSON_ET_8550_Series", dryRun: false };
    engine._findPrinter = async () => "EPSON_ET_8550_Series";
    engine._startHeartbeat = () => {};
    engine._stopHeartbeat = () => {};
    engine._downloadFile = async () => { throw new Error("Download failed: HTTP 503"); };
    let completionBody = null;
    engine._request = async (method, requestPath, requestBody) => {
        if (method === "GET") {
            return { status: 200, data: { jobs: [{ filename: "29991231_235949.json", eventName: "event", style: "cartoon" }] } };
        }
        if (requestPath.endsWith("/ack")) {
            return { status: 200, data: { job: {
                filename: "29991231_235949.json",
                eventName: "event",
                imageFile: "29991231_235949_output.png",
                claimId: "claim-failure",
                outputProfile: { printSize: "6x4", printQuality: "high", orientation: "landscape" },
            } } };
        }
        if (requestPath.endsWith("/complete")) {
            completionBody = requestBody;
            return { status: 200, data: { ok: true } };
        }
        throw new Error(`Unexpected request: ${method} ${requestPath}`);
    };

    await engine._pollOnce();

    assert.deepEqual(completionBody, {
        success: false,
        error: "Download failed: HTTP 503",
        claimId: "claim-failure",
    });
});

test("relay identifies itself as 1.3.1 on cloud API requests", async () => {
    let relayVersion = null;
    const server = http.createServer((req, res) => {
        relayVersion = req.headers["x-relay-version"];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const engine = new RelayEngine();
    engine.config = {
        url: `http://127.0.0.1:${server.address().port}`,
        key: "key",
    };

    try {
        const response = await engine._request("GET", "/api/print-relay/status");
        assert.equal(response.status, 200);
        assert.equal(relayVersion, "1.3.1");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("server ACK returns and persists the job output profile with a fenced claim ID", async () => {
    const profile = {
        printSize: "6x4",
        printQuality: "high",
        orientation: "landscape",
        customPrintFlags: "-o Borderless=On",
    };
    fs.mkdirSync(READY_DIR, { recursive: true });
    fs.mkdirSync(PRINTING_DIR, { recursive: true });
    fs.mkdirSync(serverDownloadDirectory, { recursive: true });
    fs.writeFileSync(serverImagePath, "PNGDATA");
    fs.writeFileSync(serverReadyPath, JSON.stringify({
        filePrefix: SERVER_PREFIX,
        eventName: SERVER_EVENT,
        style: "cartoon",
        outputProfile: profile,
    }));

    const response = await postRelay(`/jobs/${SERVER_FILENAME}/ack`, { printerName: "EPSON_ET_8550_Series" });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.job.outputProfile, profile);
    assert.match(response.body.job.claimId, /^[0-9a-f-]{36}$/i);
    const claimed = JSON.parse(fs.readFileSync(serverPrintingPath, "utf-8"));
    assert.equal(claimed.claimId, response.body.job.claimId);
    assert.deepEqual(claimed.outputProfile, profile);
    assert.equal(claimed.printerName, "EPSON_ET_8550_Series");
});

test("targeted reprint clears local dedupe and sends printer name", async () => {
    const engine = new RelayEngine();
    engine.config = { printer: "EPSON_ET_8550_Series" };
    engine.processedJobs.set(FILENAME, Date.now());
    let body = null;
    engine._request = async (_method, _path, requestBody) => {
        body = requestBody;
        return { status: 200, data: { ok: true } };
    };

    const result = await engine.reprint(FILENAME);

    assert.equal(result.status, 200);
    assert.deepEqual(body, { printerName: "EPSON_ET_8550_Series" });
    assert.equal(engine.processedJobs.has(FILENAME), false);
});
