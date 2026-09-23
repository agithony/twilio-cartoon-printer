const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// shouldHideFromPrinter decides whether a ready job is withheld from the
// polling printer because it already failed there. The key regression this
// guards: a SINGLE-printer booth must never have its only printer hidden from
// a job it previously failed — otherwise the job strands in ready/ forever.
const { READY_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const { mountPrintRelay, relaySupportsLandscape, shouldHideFromPrinter } = require("../lib/print-relay");

// MAX_RETRIES is 3 in lib/config; the "last try" escape opens at retries >= 2.
const P = "EPSON_ET_8550_Series";
const TARGETED_FNAME = "29991231_235954.json";
const targetedPath = path.join(READY_DIR, TARGETED_FNAME);
const EVENT_A_FNAME = "29991231_235946.json";
const EVENT_B_FNAME = "29991231_235947.json";
const COMPLETED_FNAME = "29991231_235948.json";
const eventPaths = [EVENT_A_FNAME, EVENT_B_FNAME, COMPLETED_FNAME].map((filename) => path.join(READY_DIR, filename));
const RELAY_KEY = "jobs-filter-test-key";

fs.mkdirSync(READY_DIR, { recursive: true });

after(() => {
    try { fs.unlinkSync(targetedPath); } catch {}
    for (const filePath of eventPaths) { try { fs.unlinkSync(filePath); } catch {} }
    setImmediate(() => process.exit(0));
});

function getRelay(urlPath, version, overrides = {}) {
    const app = express();
    mountPrintRelay(app);
    const originalGet = settings.get;
    const originalListEvents = settings.listEvents;
    settings.get = function patchedGet(key, ...args) {
        if (key === "printRelayKey") return RELAY_KEY;
        if (key === "eventName" && overrides.currentEvent !== undefined) return overrides.currentEvent;
        return originalGet.call(settings, key, ...args);
    };
    if (overrides.events) settings.listEvents = () => overrides.events;
    const restoreSettings = () => {
        settings.get = originalGet;
        settings.listEvents = originalListEvents;
    };
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const headers = { "x-relay-key": RELAY_KEY };
            if (version) headers["x-relay-version"] = version;
            if (overrides.requireEvent) headers["x-relay-event-filter"] = "required";
            const req = http.get({
                port: server.address().port,
                path: `/api/print-relay${urlPath}`,
                headers,
            }, (res) => {
                let chunks = "";
                res.on("data", (chunk) => { chunks += chunk; });
                res.on("end", () => {
                    server.close(() => {
                        restoreSettings();
                        resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
                    });
                });
            });
            req.on("error", (err) => {
                server.close(() => {
                    restoreSettings();
                    reject(err);
                });
            });
        });
    });
}

test("unfiltered poll never hides anything", () => {
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P] }, null, [{ name: P }]), false);
});

test("job that never failed on this printer is shown", () => {
    assert.equal(shouldHideFromPrinter({ failedPrinters: [] }, P, [{ name: P }]), false);
    assert.equal(shouldHideFromPrinter({ failedPrinters: ["OtherPrinter"] }, P, [{ name: P }, { name: "OtherPrinter" }]), false);
});

test("SINGLE printer: failed job is STILL shown to its only printer (the bug fix)", () => {
    // Only this printer is checked in; it failed the job before. Must NOT hide.
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, [{ name: P }]), false);
});

test("SINGLE printer: even with no relay list at all, not hidden", () => {
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, []), false);
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, undefined), false);
});

test("MULTI printer: failed job IS hidden from the printer that failed it (failover preserved)", () => {
    // A second live printer that hasn't failed the job exists → hide from P so
    // the other one claims it.
    const relays = [{ name: P }, { name: "EPSON_ET_8550_Series_2" }];
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, relays), true);
});

test("MULTI printer: if the only alternative ALSO failed it, stop hiding", () => {
    const relays = [{ name: P }, { name: "P2" }];
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P, "P2"], retries: 1 }, P, relays), false);
});

test("last retry before MAX_RETRIES opens the job to everyone", () => {
    // retries >= MAX_RETRIES-1 (==2) → never hidden, even with alternatives.
    const relays = [{ name: P }, { name: "P2" }];
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 2 }, P, relays), false);
});

test("relay version support starts at 1.3 and accepts later major versions", () => {
    assert.equal(relaySupportsLandscape("1.2.99"), false);
    assert.equal(relaySupportsLandscape("1.3.0"), true);
    assert.equal(relaySupportsLandscape("1.3.1-beta.1"), true);
    assert.equal(relaySupportsLandscape("2.0.0"), true);
    assert.equal(relaySupportsLandscape("invalid"), false);
    assert.equal(relaySupportsLandscape(), false);
});

test("pre-1.3 Print Stations remain compatible with portrait polling", async () => {
    const missing = await getRelay("/jobs", null);
    const old = await getRelay("/jobs", "1.2.2");
    const cli = await getRelay("/jobs", "1.4.0-cli");

    assert.equal(missing.status, 200);
    assert.ok(Array.isArray(missing.body.jobs));
    assert.equal(old.status, 200);
    assert.ok(Array.isArray(old.body.jobs));
    assert.equal(cli.status, 200, "the legacy CLI does not declare event-filter capability");
    assert.ok(Array.isArray(cli.body.jobs));
});

test("Print Station 1.4 must provide an event filter", async () => {
    const missing = await getRelay("/jobs", "1.4.0", { requireEvent: true });
    const selected = await getRelay("/jobs?event=testing", "1.4.0", { requireEvent: true });

    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /event selection/i);
    assert.equal(selected.status, 200);
    assert.ok(Array.isArray(selected.body.jobs));
});

test("targeted jobs are visible only to the named 1.3 Print Station", async () => {
    fs.writeFileSync(targetedPath, JSON.stringify({
        filePrefix: TARGETED_FNAME.replace(/\.json$/, ""),
        eventName: "__target_filter_test__",
        style: "cartoon",
        targetPrinter: P,
        outputProfile: { printSize: "6x4", printQuality: "high", orientation: "landscape" },
    }));

    const unfiltered = await getRelay("/jobs", "1.3.1");
    const wrongPrinter = await getRelay("/jobs?printer=OtherPrinter", "1.3.1");
    const targetPrinter = await getRelay(`/jobs?printer=${encodeURIComponent(P)}`, "1.3.1");
    const oldTargetPrinter = await getRelay(`/jobs?printer=${encodeURIComponent(P)}`, "1.2.2");
    const filenames = (response) => response.body.jobs.map((job) => job.filename);

    assert.equal(unfiltered.status, 200);
    assert.equal(filenames(unfiltered).includes(TARGETED_FNAME), false);
    assert.equal(filenames(wrongPrinter).includes(TARGETED_FNAME), false);
    assert.equal(filenames(targetPrinter).includes(TARGETED_FNAME), true);
    assert.equal(filenames(oldTargetPrinter).includes(TARGETED_FNAME), false);
});

test("event filter returns only jobs from the selected event", async () => {
    fs.writeFileSync(eventPaths[0], JSON.stringify({ filePrefix: "a", eventName: "Event A", style: "cartoon" }));
    fs.writeFileSync(eventPaths[1], JSON.stringify({ filePrefix: "b", eventName: "Event B", style: "cartoon" }));
    fs.writeFileSync(eventPaths[2], JSON.stringify({ filePrefix: "done", eventName: "Event A", completedAt: 1 }));

    const unfiltered = await getRelay("/jobs", "1.3.1");
    const eventA = await getRelay(`/jobs?event=${encodeURIComponent("Event A")}`, "1.3.1");
    const unknown = await getRelay("/jobs?event=Unknown", "1.3.1");
    const filenames = (response) => response.body.jobs.map((job) => job.filename);

    assert.equal(filenames(unfiltered).includes(EVENT_A_FNAME), true, "legacy unfiltered polling remains compatible");
    assert.equal(filenames(unfiltered).includes(EVENT_B_FNAME), true);
    assert.equal(filenames(unfiltered).includes(COMPLETED_FNAME), false, "completed records cannot be claimed again");
    assert.equal(filenames(eventA).includes(EVENT_A_FNAME), true);
    assert.equal(filenames(eventA).includes(EVENT_B_FNAME), false);
    assert.equal(filenames(unknown).includes(EVENT_A_FNAME), false);
    assert.equal(filenames(unknown).includes(EVENT_B_FNAME), false);
});

test("event filter rejects ambiguous duplicate query values", async () => {
    const response = await getRelay("/jobs?event=Event%20A&event=Event%20B", "1.3.1");
    assert.equal(response.status, 400);
    assert.match(response.body.error, /event filter/i);
});

test("relay event discovery is authenticated and includes the current event", async () => {
    const response = await getRelay("/events", "1.3.1", {
        events: ["Event B", "Event A", "Event A"],
        currentEvent: "Current Event",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
        events: ["Current Event", "Event A", "Event B"],
        currentEvent: "Current Event",
    });
});
