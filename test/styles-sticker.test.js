const { test } = require("node:test");
const assert = require("node:assert/strict");
const { STYLES, getActiveStyles, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

test("a built-in Sticker style exists with sticker:true", () => {
    assert.ok(STYLES.sticker, "STYLES.sticker should exist");
    assert.equal(STYLES.sticker.sticker, true);
    assert.equal(STYLES.sticker.name, "Sticker");
});

test("Sticker prompt instructs transparent background and forbids AI-drawn border", () => {
    const prompt = STYLES.sticker.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION);
    assert.match(prompt, /transparent/i);
    assert.match(prompt, /no.*(border|outline|stroke|halo)/i);
});

test("Sticker prompt carries its own 'Background:' line so the default bg line is suppressed", () => {
    // prompt-builder.js:95 suppresses the event's default background line when the
    // style prompt already contains a `background:` instruction. The sticker MUST
    // own its background instruction (transparent) — otherwise a solid default bg
    // line would be appended and fight the transparency. This regex must match the
    // one in prompt-builder.js (/background\s*[:—–-]/im).
    const prompt = STYLES.sticker.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION);
    assert.match(prompt, /background\s*[:—–-]/im);
});

test("getActiveStyles exposes sticker flag on the active style object", () => {
    const active = getActiveStyles(null, null, null, DEFAULT_PRESERVE, DEFAULT_COMPOSITION);
    assert.equal(active.sticker.sticker, true);
    // non-sticker styles report a falsy flag, never undefined-shaped
    assert.equal(active.cartoon.sticker, false);
});

test("custom styles can opt into sticker via the flag", () => {
    const active = getActiveStyles(
        null,
        { myCustom: { name: "Mine", prompt: "p", sticker: true } },
        null, DEFAULT_PRESERVE, DEFAULT_COMPOSITION
    );
    assert.equal(active.myCustom.sticker, true);
});
