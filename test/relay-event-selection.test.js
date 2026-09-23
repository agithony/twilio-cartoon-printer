const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { RelayEngine, listCloudEvents } = require("../relay-app/relay");
const { RELAY_TEMP_DIR } = require("../relay-app/job-files");
const relayVersion = require("../relay-app/package.json").version;

test("relay does not poll without an explicitly selected event", async () => {
    const engine = new RelayEngine();
    let requests = 0;
    engine.running = true;
    engine.config = { url: "https://example.test", key: "key", dryRun: true };
    engine._request = async () => { requests++; return { status: 200, data: { jobs: [] } }; };

    await engine._pollOnce();
    engine.stop();

    assert.equal(requests, 0);
    assert.throws(() => new RelayEngine().start({ eventName: "" }), /select an event/i);
});

test("relay waits for an active poll to finish before disconnecting", async () => {
    const engine = new RelayEngine();
    engine.running = true;
    engine.config = { url: "https://example.test", key: "key", eventName: "Event A", dryRun: true };
    let finishRequest;
    engine._request = () => new Promise((resolve) => { finishRequest = resolve; });

    const poll = engine._pollOnce();
    await new Promise((resolve) => setImmediate(resolve));
    let stopped = false;
    const stop = engine.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "disconnect must not abandon an in-flight poll");

    finishRequest({ status: 200, data: { jobs: [] } });
    await Promise.all([poll, stop]);
    assert.equal(stopped, true);
});

test("disconnect during cloud verification cannot emit stale connected state", async () => {
    const engine = new RelayEngine();
    const statuses = [];
    engine.on("status", (status) => statuses.push(status));
    engine.running = true;
    engine.config = { url: "https://example.test", key: "key", eventName: "Event A", dryRun: false };
    let finishRequest;
    engine._request = () => new Promise((resolve) => { finishRequest = resolve; });
    let printerChecks = 0;
    engine._findPrinter = async () => { printerChecks++; return "Printer"; };

    const verification = engine._verifyAndStart();
    await new Promise((resolve) => setImmediate(resolve));
    await engine.stop();
    finishRequest({ status: 200, data: { printSize: "5x7", printQuality: "high" } });
    await verification;

    assert.equal(printerChecks, 0);
    assert.equal(statuses.some((status) => status.cloud === "connected"), false);
    assert.equal(statuses.at(-1).cloud, "disconnected");
});

test("relay polls and claims only the selected event", async () => {
    const engine = new RelayEngine();
    const selectedEvent = "Event A & Partners";
    const matchingFilename = "29991231_235930.json";
    const imageFile = "29991231_235930_output.png";
    const imagePath = path.join(RELAY_TEMP_DIR, imageFile);
    const requests = [];
    const emitted = [];
    engine.on("job", (job) => emitted.push(job));
    engine.running = true;
    engine.config = {
        url: "https://example.test",
        key: "key",
        eventName: selectedEvent,
        printer: "Printer & One",
        dryRun: true,
    };
    engine._startHeartbeat = () => {};
    engine._stopHeartbeat = () => {};
    engine._downloadFile = async (_url, destination) => {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, "PNGDATA");
    };
    let completion = null;
    engine._completeJob = async (filename, body) => { completion = { filename, body }; };
    engine._request = async (method, requestPath, body) => {
        requests.push({ method, requestPath, body });
        if (method === "GET") {
            return { status: 200, data: { jobs: [
                { filename: matchingFilename, eventName: selectedEvent, style: "cartoon" },
                { filename: "29991231_235931.json", eventName: "Other Event", style: "anime" },
            ] } };
        }
        return { status: 200, data: { job: {
            filename: matchingFilename,
            eventName: selectedEvent,
            imageFile,
            claimId: "claim-a",
        } } };
    };

    try {
        await engine._pollOnce();
    } finally {
        engine.stop();
        fs.rmSync(imagePath, { force: true });
    }

    const listRequest = requests.find((request) => request.method === "GET");
    const listUrl = new URL(listRequest.requestPath, "https://example.test");
    assert.equal(listUrl.searchParams.get("event"), selectedEvent);
    assert.equal(listUrl.searchParams.get("printer"), "Printer & One");
    const claims = requests.filter((request) => request.method === "POST" && request.requestPath.endsWith("/ack"));
    assert.equal(claims.length, 1, "a job from another event must never be claimed");
    assert.equal(claims[0].requestPath, `/api/print-relay/jobs/${matchingFilename}/ack`);
    assert.deepEqual(claims[0].body, { printerName: "dry-run", eventName: selectedEvent });
    assert.deepEqual(completion, {
        filename: matchingFilename,
        body: { success: true, claimId: "claim-a" },
    });
    assert.equal(emitted.some((job) => job.event === selectedEvent && job.status === "claiming"), true);
    assert.equal(emitted.some((job) => job.event === selectedEvent && job.status === "downloading"), true);
});

test("relay refuses an acknowledged job from a different event before download", async () => {
    const engine = new RelayEngine();
    let downloaded = false;
    let completion = null;
    engine.running = true;
    engine.config = { url: "https://example.test", key: "key", eventName: "Event A", dryRun: true };
    engine._downloadFile = async () => { downloaded = true; };
    engine._completeJob = async (filename, body) => { completion = { filename, body }; };
    engine._request = async (method) => {
        if (method === "GET") {
            return { status: 200, data: { jobs: [
                { filename: "29991231_235932.json", eventName: "Event A", style: "cartoon" },
            ] } };
        }
        return { status: 200, data: { job: {
            eventName: "Event B",
            imageFile: "29991231_235932_output.png",
            claimId: "claim-b",
        } } };
    };

    await engine._pollOnce();
    engine.stop();

    assert.equal(downloaded, false);
    assert.deepEqual(completion, {
        filename: "29991231_235932.json",
        body: {
            success: false,
            error: "Claimed job belongs to Event B, not Event A",
            claimId: "claim-b",
        },
    });
});

test("event discovery authenticates with headers and validates the response", async () => {
    let response = { status: 200, body: { events: ["Event B", "Event A", "Event A"], currentEvent: "Event B" } };
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({
            url: req.url,
            key: req.headers["x-relay-key"],
            version: req.headers["x-relay-version"],
            eventFilter: req.headers["x-relay-event-filter"],
        });
        res.statusCode = response.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response.body));
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const config = { url: `http://127.0.0.1:${server.address().port}`, key: "secret-key" };

    try {
        assert.deepEqual(await listCloudEvents(config), {
            events: ["Event A", "Event B"],
            currentEvent: "Event B",
        });
        response = { status: 200, body: { events: "invalid" } };
        await assert.rejects(listCloudEvents(config), /invalid event list/i);
        response = { status: 401, body: { error: "Invalid relay key" } };
        await assert.rejects(listCloudEvents(config), /401: Invalid relay key/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.deepEqual(requests[0], {
        url: "/api/print-relay/events",
        key: "secret-key",
        version: relayVersion,
        eventFilter: "required",
    });
});
