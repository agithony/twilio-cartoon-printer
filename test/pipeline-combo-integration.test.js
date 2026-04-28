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

test("resolved menu's keys carry a prompt that the pipeline will apply", () => {
    const style = { behavior: "normal", acceptsColorPalette: true };
    const brand = {
        category: "wardrobe-only",
        scenes: [{ key: "ice-rink", name: "Ice rink", prompt: "ice rink with bright arena lighting", files: [] }],
        allowOriginal: true,
        wardrobe: "LA Kings jersey",
    };
    const { resolveBackgroundMenu } = require("../lib/prompt-assembler");
    const menu = resolveBackgroundMenu(style, brand);

    // User-selected key from the SMS flow
    const chosen = menu.find((c) => c.key === "ice-rink");
    assert.ok(chosen, "brand scene should appear in resolved menu");
    assert.equal(chosen.key, "ice-rink");
    assert.ok(chosen.prompt && chosen.prompt.length > 0, "resolved choice must carry a prompt for the pipeline to apply");

    // And the synthesized entries too
    const original = menu.find((c) => c.key === "original");
    assert.ok(original && original.prompt, "synthesized 'original' must carry a default prompt");

    const plainWhite = menu.find((c) => c.key === "plain-white");
    assert.ok(plainWhite && plainWhite.prompt, "synthesized 'plain-white' must carry a default prompt");
});
