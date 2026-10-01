const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBackgroundStep } = require("../lib/prompt-assembler");

const flatBackgrounds = [
    { key: "gradient", name: "Soft Gradient" },
    { key: "original", name: "Original Scene" },
];

const laKings = {
    name: "LA Kings",
    category: "wardrobe-plus-scene",
    scenes: [
        { key: "ice-rink", name: "Ice Rink", prompt: "Inside the arena" },
        { key: "crypto-arena", name: "Crypto Arena", prompt: "Outside the arena" },
    ],
};

test("chosen brand scenes open a menu with general background selection off", () => {
    const step = resolveBackgroundStep({ style: {}, brand: laKings, configuredChoices: flatBackgrounds, enabled: false });

    assert.equal(step.kind, "menu");
    assert.deepEqual(step.choices.map(({ key, name }) => ({ key, name })), [
        { key: "ice-rink", name: "Ice Rink" },
        { key: "crypto-arena", name: "Crypto Arena" },
    ]);
});

test("scenes also appear for a wardrobe-only brand", () => {
    const step = resolveBackgroundStep({
        style: {},
        brand: { name: "LA Kings", scenes: laKings.scenes },
        configuredChoices: flatBackgrounds,
        enabled: false,
    });

    assert.equal(step.kind, "menu");
    assert.deepEqual(step.choices.map(({ key }) => key), ["ice-rink", "crypto-arena", "original", "plain-white"]);
});

test("Unbranded bypasses background choices when general selection is off", () => {
    const step = resolveBackgroundStep({ style: {}, brand: null, configuredChoices: flatBackgrounds, enabled: false });

    assert.deepEqual(step, { kind: "skip" });
});

test("general background selection still offers configured options", () => {
    const step = resolveBackgroundStep({ style: {}, brand: null, configuredChoices: flatBackgrounds, enabled: true });

    assert.equal(step.kind, "menu");
    assert.deepEqual(step.choices.map(({ key }) => key), ["gradient", "original"]);
});

test("a sole effective scene is applied automatically", () => {
    const step = resolveBackgroundStep({
        style: {},
        brand: { category: "wardrobe-plus-scene", scenes: [{ key: "ice-rink", name: "Ice Rink", prompt: "Inside" }] },
        configuredChoices: flatBackgrounds,
        enabled: false,
    });

    assert.deepEqual(step, { kind: "auto", backgroundKey: "ice-rink" });
});

test("a sole general background is applied automatically when enabled", () => {
    const step = resolveBackgroundStep({ style: {}, brand: null, configuredChoices: [{ key: "gradient", name: "Soft Gradient" }], enabled: true });

    assert.deepEqual(step, { kind: "auto", backgroundKey: "gradient" });
});
