const { test } = require("node:test");
const assert = require("node:assert/strict");
const { STYLES } = require("../lib/styles");

test("every built-in style has behavior field", () => {
    for (const [key, style] of Object.entries(STYLES)) {
        assert.ok(
            style.behavior === "normal" || style.behavior === "themed-container",
            `Style "${key}" must set behavior to "normal" or "themed-container" (got ${style.behavior})`
        );
    }
});

test("every built-in style has acceptsColorPalette field", () => {
    for (const [key, style] of Object.entries(STYLES)) {
        assert.equal(
            typeof style.acceptsColorPalette,
            "boolean",
            `Style "${key}" must set acceptsColorPalette to a boolean (got ${typeof style.acceptsColorPalette})`
        );
    }
});

test("getActiveStyles propagates behavior and acceptsColorPalette", () => {
    const { getActiveStyles } = require("../lib/styles");
    const active = getActiveStyles([], {}, {}, "preserve line", "composition line");
    for (const [key, entry] of Object.entries(active)) {
        assert.ok(entry.behavior, `Active style "${key}" missing behavior`);
        assert.equal(typeof entry.acceptsColorPalette, "boolean",
            `Active style "${key}" missing acceptsColorPalette`);
    }
});
