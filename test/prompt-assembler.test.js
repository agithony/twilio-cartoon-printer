const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBackgroundMenu } = require("../lib/prompt-assembler");

const normalStyle = { behavior: "normal" };
const containerStyle = { behavior: "themed-container" };

const wardrobeOnlyBrand = {
    category: "wardrobe-only",
    scenes: [{ key: "ice-rink", name: "Ice rink", prompt: "ice rink bg" }],
    allowOriginal: true,
};
const wardrobePlusSceneBrand = {
    category: "wardrobe-plus-scene",
    scenes: [
        { key: "main-stage", name: "Main stage", prompt: "main stage bg" },
        { key: "ferris-wheel", name: "Ferris wheel", prompt: "ferris wheel bg" },
    ],
    allowOriginal: false,
};

test("normal + wardrobe-only: [brand scene, original, plain white]", () => {
    const menu = resolveBackgroundMenu(normalStyle, wardrobeOnlyBrand);
    assert.equal(menu.length, 3);
    assert.deepEqual(menu.map((m) => m.key), ["ice-rink", "original", "plain-white"]);
});

test("normal + wardrobe-plus-scene: brand scenes only", () => {
    const menu = resolveBackgroundMenu(normalStyle, wardrobePlusSceneBrand);
    assert.equal(menu.length, 2);
    assert.deepEqual(menu.map((m) => m.key), ["main-stage", "ferris-wheel"]);
});

test("normal + no brand: [original, plain white]", () => {
    const menu = resolveBackgroundMenu(normalStyle, null);
    assert.deepEqual(menu.map((m) => m.key), ["original", "plain-white"]);
});

test("themed-container + wardrobe-only: [brand scene, original] (no plain white)", () => {
    const menu = resolveBackgroundMenu(containerStyle, wardrobeOnlyBrand);
    assert.deepEqual(menu.map((m) => m.key), ["ice-rink", "original"]);
});

test("themed-container + wardrobe-plus-scene: brand scenes only", () => {
    const menu = resolveBackgroundMenu(containerStyle, wardrobePlusSceneBrand);
    assert.deepEqual(menu.map((m) => m.key), ["main-stage", "ferris-wheel"]);
});

test("themed-container + no brand: [original] only (auto-skip)", () => {
    const menu = resolveBackgroundMenu(containerStyle, null);
    assert.deepEqual(menu.map((m) => m.key), ["original"]);
});

test("defaults when fields missing: behavior undefined treated as normal", () => {
    const menu = resolveBackgroundMenu({}, null);
    assert.deepEqual(menu.map((m) => m.key), ["original", "plain-white"]);
});

test("defaults when brand category missing: treated as wardrobe-only", () => {
    const brand = { scenes: [{ key: "s", name: "S", prompt: "p" }] };
    const menu = resolveBackgroundMenu(normalStyle, brand);
    // allowOriginal defaults to true
    assert.deepEqual(menu.map((m) => m.key), ["s", "original", "plain-white"]);
});

test("each menu entry has { key, name, prompt }", () => {
    const menu = resolveBackgroundMenu(normalStyle, wardrobeOnlyBrand);
    for (const entry of menu) {
        assert.equal(typeof entry.key, "string");
        assert.equal(typeof entry.name, "string");
        assert.equal(typeof entry.prompt, "string");
    }
});

const { buildComboFragments } = require("../lib/prompt-assembler");

const cartoon = { behavior: "normal", acceptsColorPalette: true };
const actionFigure = {
    behavior: "themed-container",
    acceptsColorPalette: true,
    containerDescription: "Subject rendered as a collectible action figure sealed in a themed toy box.",
};
const bronze = { behavior: "normal", acceptsColorPalette: false };
const twilioBrand = {
    category: "wardrobe-plus-scene",
    wardrobe: "Twilio-branded apparel",
    colorPalette: "Recolor everything to Twilio red and white.",
};
const laKingsBrand = {
    category: "wardrobe-only",
    wardrobe: "LA Kings hockey jersey",
};

test("buildComboFragments: no brand, normal style — container=null, palette=null", () => {
    const frags = buildComboFragments({ style: cartoon, brand: null, background: null });
    assert.equal(frags.containerDescription, null);
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: themed-container style contributes containerDescription", () => {
    const frags = buildComboFragments({ style: actionFigure, brand: laKingsBrand, background: null });
    assert.match(frags.containerDescription, /toy box/);
});

test("buildComboFragments: normal style does not contribute containerDescription", () => {
    const frags = buildComboFragments({ style: cartoon, brand: laKingsBrand, background: null });
    assert.equal(frags.containerDescription, null);
});

test("buildComboFragments: brand colorPalette included when style accepts it", () => {
    const frags = buildComboFragments({ style: cartoon, brand: twilioBrand, background: null });
    assert.match(frags.colorPalette, /Twilio red/);
});

test("buildComboFragments: brand colorPalette suppressed when style rejects it (Bronze × Twilio)", () => {
    const frags = buildComboFragments({ style: bronze, brand: twilioBrand, background: null });
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: no brand means no palette", () => {
    const frags = buildComboFragments({ style: cartoon, brand: null, background: null });
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: brand without colorPalette field means no palette", () => {
    const frags = buildComboFragments({ style: cartoon, brand: laKingsBrand, background: null });
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: themed-container style without containerDescription returns null", () => {
    const incomplete = { behavior: "themed-container", acceptsColorPalette: true };
    const frags = buildComboFragments({ style: incomplete, brand: null, background: null });
    assert.equal(frags.containerDescription, null);
});
