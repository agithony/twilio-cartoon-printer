const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ACTIVE_STAGES, isMissingOutput, shapeActiveJob } = require("../lib/relay-jobs");

// ── isMissingOutput ─────────────────────────────────────────────────────────

test("isMissingOutput: ready job with missing PNG is an orphan", () => {
    assert.equal(isMissingOutput("ready", false), true);
});

test("isMissingOutput: ready job with PNG present is fine", () => {
    assert.equal(isMissingOutput("ready", true), false);
});

test("isMissingOutput: printing jobs are never failed here (relay owns them)", () => {
    // Even if the file looks absent mid-print, we must not yank a job a relay
    // is actively printing.
    assert.equal(isMissingOutput("printing", false), false);
    assert.equal(isMissingOutput("printing", true), false);
});

// ── shapeActiveJob ──────────────────────────────────────────────────────────

const mask = (p) => (p ? "MASK" : null);

test("shapeActiveJob: ready job gets status 'ready' and masked phone", () => {
    const row = shapeActiveJob(
        { filePrefix: "20260506_004546", eventName: "DeveloperWeek2026", style: "cartoon", userPhone: "+14155551212", readyAt: 1778053893488 },
        "ready",
        mask,
    );
    assert.equal(row.status, "ready");
    assert.equal(row.stage, "ready");
    assert.equal(row.filename, "20260506_004546.json");
    assert.equal(row.eventName, "DeveloperWeek2026");
    assert.equal(row.style, "cartoon");
    assert.equal(row.phone, "MASK");
    assert.equal(row.enteredAt, 1778053893488); // readyAt used when no stateChangedAt
});

test("shapeActiveJob: printing job gets status 'printing' and prefers stateChangedAt", () => {
    const row = shapeActiveJob(
        { filePrefix: "p1", eventName: "E", userPhone: "+1", printerName: "EPSON_ET_8550_Series", stateChangedAt: 999, printingAt: 5, readyAt: 1 },
        "printing",
        mask,
    );
    assert.equal(row.status, "printing");
    assert.equal(row.printerName, "EPSON_ET_8550_Series");
    assert.equal(row.enteredAt, 999); // stateChangedAt wins
});

test("shapeActiveJob: missing optional fields degrade gracefully", () => {
    const row = shapeActiveJob({ filePrefix: "x" }, "ready", mask);
    assert.equal(row.style, "unknown");
    assert.equal(row.printerName, null);
    assert.equal(row.phone, null); // mask(undefined) -> null
    assert.deepEqual(row.failedPrinters, []);
    assert.equal(row.retries, 0);
});

test("shapeActiveJob: surfaces failedPrinters and retries for stuck ready jobs", () => {
    const row = shapeActiveJob(
        { filePrefix: "x", failedPrinters: ["A", "B"], retries: 2 },
        "ready",
        mask,
    );
    assert.deepEqual(row.failedPrinters, ["A", "B"]);
    assert.equal(row.retries, 2);
});

test("ACTIVE_STAGES is ready + printing", () => {
    assert.deepEqual(ACTIVE_STAGES, ["ready", "printing"]);
});
