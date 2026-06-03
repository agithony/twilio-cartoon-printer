const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __stickerDeliveryUrl, __shouldPrintJob } = require("../lib/queue");

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
