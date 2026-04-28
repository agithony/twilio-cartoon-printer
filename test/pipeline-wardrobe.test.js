const { test } = require("node:test");
const assert = require("node:assert/strict");

// Contract test: when a brand has a `wardrobe` field, the resolver used by
// pipeline.js should prefer it over the legacy `brandPrompt`. We test the
// resolution logic in isolation (pipeline.js doesn't export it as a function,
// so we mirror it here and lock the contract via expectation).

function resolveBrandPrompt(brandDef, overrides, fallback) {
    if (!brandDef) return fallback;
    return overrides[brandDef.key] || brandDef.wardrobe || brandDef.brandPrompt || fallback;
}

test("wardrobe preferred over brandPrompt when both set", () => {
    const brand = { key: "lakings", wardrobe: "LA Kings jersey", brandPrompt: "legacy text" };
    assert.equal(resolveBrandPrompt(brand, {}, "fallback"), "LA Kings jersey");
});

test("falls back to brandPrompt when wardrobe absent", () => {
    const brand = { key: "lakings", brandPrompt: "legacy text" };
    assert.equal(resolveBrandPrompt(brand, {}, "fallback"), "legacy text");
});

test("override wins over both wardrobe and brandPrompt", () => {
    const brand = { key: "lakings", wardrobe: "jersey", brandPrompt: "legacy" };
    assert.equal(resolveBrandPrompt(brand, { lakings: "override text" }, "fallback"), "override text");
});

test("fallback used when brandDef has neither field", () => {
    const brand = { key: "lakings" };
    assert.equal(resolveBrandPrompt(brand, {}, "fallback"), "fallback");
});
