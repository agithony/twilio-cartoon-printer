const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __resolveGenParamsForTest } = require("../lib/pipeline");

const configuredModel = "gpt-image-2-2026-04-21";

test("sticker style forces transparent gpt-image-1.5 at square size", () => {
    const p = __resolveGenParamsForTest({
        styleObj: { sticker: true }, bgMode: "ai", bgRefCount: 0, configuredModel,
    });
    assert.equal(p.model, "gpt-image-1.5");
    assert.equal(p.background, "transparent");
    assert.equal(p.size, "1024x1024");
});

test("exact-background mode still works as before (transparent portrait)", () => {
    const p = __resolveGenParamsForTest({
        styleObj: { sticker: false }, bgMode: "exact", bgRefCount: 1, configuredModel,
    });
    assert.equal(p.model, "gpt-image-1.5");
    assert.equal(p.background, "transparent");
    assert.equal(p.size, "1024x1536");
});

test("normal style is unaffected: configured model, no transparent, portrait", () => {
    const p = __resolveGenParamsForTest({
        styleObj: { sticker: false }, bgMode: "ai", bgRefCount: 0, configuredModel,
    });
    assert.equal(p.model, configuredModel);
    assert.equal(p.background, undefined);
    assert.equal(p.size, "1024x1536");
});
