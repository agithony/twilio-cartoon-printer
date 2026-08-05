const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RelayEngine } = require("../relay-app/relay");

test("successful reprint targets the selected printer and clears deduplication", async () => {
    const engine = new RelayEngine();
    engine.config = { printer: "Dai_Nippon_Printing_DS_RX1" };
    engine.processedJobs.set("portrait.json", Date.now());
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
});
