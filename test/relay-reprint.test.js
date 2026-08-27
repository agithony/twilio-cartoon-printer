const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RelayEngine } = require("../relay-app/relay");

test("successful reprint targets the selected printer and clears deduplication", async () => {
    const engine = new RelayEngine();
    engine.config = { printer: "Dai_Nippon_Printing_DS_RX1" };
    engine.processedJobs.set("portrait.json", Date.now());
    engine.processedJobs.set("another.json", Date.now());
    let request;
    engine._request = async (method, urlPath, body) => {
        request = { method, urlPath, body };
        return { status: 200, data: { ok: true } };
    };

    const result = await engine.reprint("portrait.json");
    assert.equal(result.status, 200);
    assert.deepEqual(request, {
        method: "POST",
        urlPath: "/api/print-relay/jobs/portrait.json/reprint",
        body: { printerName: "Dai_Nippon_Printing_DS_RX1" },
    });
    assert.equal(engine.processedJobs.has("portrait.json"), false);
    assert.equal(engine.processedJobs.has("another.json"), true);
});

test("failed reprint keeps the local dedupe entry so the terminal row is not reprocessed", async () => {
    const engine = new RelayEngine();
    engine.config = { printer: "EPSON_ET_8550_Series" };
    engine.processedJobs.set("portrait.json", Date.now());
    let request;
    engine._request = async (method, urlPath, body) => {
        request = { method, urlPath, body };
        return { status: 409, data: { error: "Job still has pending terminal delivery effects" } };
    };

    const result = await engine.reprint("portrait.json");

    assert.equal(result.status, 409);
    assert.deepEqual(request.body, { printerName: "EPSON_ET_8550_Series" });
    assert.equal(engine.processedJobs.has("portrait.json"), true);
});

test("completion retries a rejected failure report and checks the response body", async () => {
    const engine = new RelayEngine();
    engine.COMPLETION_RETRY_MS = 0;
    let attempts = 0;
    engine._request = async () => {
        attempts++;
        if (attempts === 1) return { status: 503, data: { error: "unavailable" } };
        return { status: 200, data: { ok: true, state: "requeued" } };
    };

    const result = await engine._completeJob("portrait.json", {
        success: false,
        error: "Printer is offline",
        claimId: "claim-a",
    }, 2);

    assert.equal(attempts, 2);
    assert.deepEqual(result, { ok: true, state: "requeued" });
});
