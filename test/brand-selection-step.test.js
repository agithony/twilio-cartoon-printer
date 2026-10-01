const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBrandStep } = require("../lib/menu-routing");
const { resolveBackgroundStep } = require("../lib/prompt-assembler");

test("one enabled brand still offers Unbranded when the opt-out is enabled", () => {
    assert.deepEqual(resolveBrandStep({
        enabled: true, brandKeys: ["la-kings"], offerUnbranded: true,
    }), { kind: "menu", includeNone: true });
});

test("removing Unbranded auto-selects the only brand and advances to its scenes", () => {
    const brandStep = resolveBrandStep({
        enabled: true, brandKeys: ["la-kings"], offerUnbranded: false,
    });
    assert.deepEqual(brandStep, { kind: "auto", brandKey: "la-kings" });

    const backgroundStep = resolveBackgroundStep({
        style: { behavior: "themed-container" },
        brand: {
            name: "LA Kings",
            scenes: [
                { key: "ice-rink", name: "Ice Rink" },
                { key: "crypto-arena", name: "Crypto Arena" },
            ],
        },
        configuredChoices: [],
        enabled: false,
    });
    assert.equal(backgroundStep.kind, "menu");
    assert.deepEqual(backgroundStep.choices.map(({ key }) => key), ["ice-rink", "crypto-arena", "original"]);
});

test("removing Unbranded still prompts when multiple brands are enabled", () => {
    assert.deepEqual(resolveBrandStep({
        enabled: true, brandKeys: ["la-kings", "twilio"], offerUnbranded: false,
    }), { kind: "menu", includeNone: false });
});

test("disabled brand selection or no brands skips the brand step", () => {
    assert.deepEqual(resolveBrandStep({
        enabled: false, brandKeys: ["la-kings"], offerUnbranded: false,
    }), { kind: "skip" });
    assert.deepEqual(resolveBrandStep({
        enabled: true, brandKeys: [], offerUnbranded: false,
    }), { kind: "skip" });
});
