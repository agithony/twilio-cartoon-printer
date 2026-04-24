const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildComboFragments } = require("../lib/prompt-assembler");

// This test exercises the *contract* between pipeline.js and prompt-assembler.
// It does not invoke generateImage (which requires OpenAI + Twilio). It verifies
// that the fragments we plan to append to the prompt have the expected shape
// and that the integration points (themed-container + palette) work as a unit.

test("fragments for Action Figure × Twilio × rotary phone — both present", () => {
    const style = {
        behavior: "themed-container",
        acceptsColorPalette: true,
        containerDescription: "Subject rendered as a collectible plastic action figure sealed inside a themed retail toy box. The box packaging, interior scene, and decorative art are themed to match the brand and chosen background.",
    };
    const brand = {
        category: "wardrobe-plus-scene",
        wardrobe: "Twilio gear",
        colorPalette: "Recolor everything to Twilio red and white.",
    };
    const frags = buildComboFragments({ style, brand, background: null });
    assert.match(frags.containerDescription, /toy box/);
    assert.match(frags.colorPalette, /Twilio red/);
});

test("fragments for Bronze × Twilio — wardrobe kept, palette suppressed", () => {
    const style = { behavior: "normal", acceptsColorPalette: false };
    const brand = {
        category: "wardrobe-plus-scene",
        wardrobe: "Twilio gear",
        colorPalette: "Recolor everything red.",
    };
    const frags = buildComboFragments({ style, brand, background: null });
    assert.equal(frags.containerDescription, null);
    assert.equal(frags.colorPalette, null, "palette must be suppressed for acceptsColorPalette=false");
});

test("fragments for Cartoon × LA Kings — both null", () => {
    const style = { behavior: "normal", acceptsColorPalette: true };
    const brand = { category: "wardrobe-only", wardrobe: "LA Kings jersey" };
    const frags = buildComboFragments({ style, brand, background: null });
    assert.equal(frags.containerDescription, null);
    assert.equal(frags.colorPalette, null);
});
