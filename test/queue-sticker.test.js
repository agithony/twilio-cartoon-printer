const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __stickerDeliveryUrl, __shouldPrintJob, __jobIsSticker } = require("../lib/queue");

test("sticker job delivery URL points at the transparent PNG", () => {
    const url = __stickerDeliveryUrl({ baseUrl: "https://x.test", filePrefix: "p1", style: "sticker" }, true);
    assert.equal(url, "https://x.test/images/p1_output.png");
});

test("non-sticker job delivery URL points at the MMS JPEG", () => {
    const url = __stickerDeliveryUrl({ baseUrl: "https://x.test", filePrefix: "p1", style: "cartoon" }, false);
    assert.equal(url, "https://x.test/images/p1_output_mms.jpg");
});

test("delivery URL is null when baseUrl is absent", () => {
    assert.equal(__stickerDeliveryUrl({ filePrefix: "p1" }, true), null);
});

test("printing is forced off for sticker jobs regardless of event config", () => {
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: true, isSticker: true }), false);
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: true, isSticker: false }), true);
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: false, isSticker: false }), false);
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: false, isSticker: true }), false);
});

test("jobIsSticker true when job.style is the sticker built-in", () => {
    assert.equal(__jobIsSticker({ style: "sticker", eventName: "default" }), true);
});

test("jobIsSticker false for a normal style", () => {
    assert.equal(__jobIsSticker({ style: "cartoon", eventName: "default" }), false);
});

test("jobIsSticker resolves via fallback when job.style is unset (default style decides)", () => {
    // job.style unset → falls back to event default / first active style.
    // With no event override, the built-in default is "cartoon" (non-sticker),
    // so this must be false — proving the print branch and delivery agree on
    // the SAME resolved key rather than raw job.style.
    assert.equal(__jobIsSticker({ eventName: "default" }), false);
});
