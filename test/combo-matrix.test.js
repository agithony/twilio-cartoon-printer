const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBackgroundMenu, buildComboFragments } = require("../lib/prompt-assembler");

// All 9 styles × 5 brands + None = 54 combos. We check a representative set
// mapped from the spec's decision matrix.

const styles = {
    cartoon:         { behavior: "normal",            acceptsColorPalette: true,  name: "Cartoon" },
    anime:           { behavior: "normal",            acceptsColorPalette: true,  name: "Anime" },
    watercolor:      { behavior: "normal",            acceptsColorPalette: true,  name: "Watercolor" },
    "pixel-art":     { behavior: "normal",            acceptsColorPalette: true,  name: "Pixel Art" },
    "magazine":      { behavior: "normal",            acceptsColorPalette: true,  name: "Magazine Cover" },
    "comic-geo":     { behavior: "normal",            acceptsColorPalette: true,  name: "Comic Geometric" },
    bronze:          { behavior: "normal",            acceptsColorPalette: false, name: "Bronze Sculpture" },
    "action-figure": { behavior: "themed-container",  acceptsColorPalette: true,  name: "Action Figure", containerDescription: "Toy box." },
    "trading-card":  { behavior: "themed-container",  acceptsColorPalette: true,  name: "Trading Card",  containerDescription: "Card frame." },
};

const brands = {
    "la-kings":   { category: "wardrobe-only",        scenes: [{ key: "ice-rink",    name: "Ice rink",    prompt: "ice rink" }], allowOriginal: true,  wardrobe: "LA Kings jersey" },
    "chelsea-fc": { category: "wardrobe-only",        scenes: [{ key: "stadium",     name: "Stadium",     prompt: "stadium"  }], allowOriginal: true,  wardrobe: "Chelsea kit" },
    "pga":        { category: "wardrobe-only",        scenes: [{ key: "golf-course", name: "Golf course", prompt: "course"   }], allowOriginal: true,  wardrobe: "Golf polo" },
    "coachella":  { category: "wardrobe-plus-scene",  scenes: [{ key: "main-stage",  name: "Main stage",  prompt: "stage"    }, { key: "ferris",  name: "Ferris", prompt: "ferris" }], allowOriginal: false, wardrobe: "Performer outfit" },
    "twilio":     { category: "wardrobe-plus-scene",  scenes: [{ key: "wings",       name: "Twilio wings", prompt: "wings"   }, { key: "rotary",  name: "Rotary", prompt: "rotary" }], allowOriginal: false, wardrobe: "Twilio gear", colorPalette: "Recolor to Twilio red and white." },
};

function ids(menu) { return menu.map((m) => m.key); }

// Matrix expectations from the spec
const cases = [
    // normal × wardrobe-only → [scene, original, plain-white]
    { s: "cartoon",       b: "la-kings",   expected: ["ice-rink", "original", "plain-white"] },
    { s: "anime",         b: "chelsea-fc", expected: ["stadium",  "original", "plain-white"] },
    { s: "watercolor",    b: "pga",        expected: ["golf-course", "original", "plain-white"] },
    { s: "bronze",        b: "la-kings",   expected: ["ice-rink", "original", "plain-white"] },

    // normal × wardrobe-plus-scene → brand scenes only
    { s: "comic-geo",     b: "coachella",  expected: ["main-stage", "ferris"] },
    { s: "cartoon",       b: "twilio",     expected: ["wings", "rotary"] },

    // normal × None → [original, plain-white]
    { s: "anime",         b: null,         expected: ["original", "plain-white"] },
    { s: "magazine",      b: null,         expected: ["original", "plain-white"] },

    // themed-container × wardrobe-only → [scene, original] (no plain-white)
    { s: "action-figure", b: "la-kings",   expected: ["ice-rink", "original"] },
    { s: "trading-card",  b: "pga",        expected: ["golf-course", "original"] },

    // themed-container × wardrobe-plus-scene → scenes only
    { s: "action-figure", b: "twilio",     expected: ["wings", "rotary"] },
    { s: "trading-card",  b: "coachella",  expected: ["main-stage", "ferris"] },

    // themed-container × None → [original] only (auto-skip)
    { s: "action-figure", b: null,         expected: ["original"] },
    { s: "trading-card",  b: null,         expected: ["original"] },
];

for (const c of cases) {
    const label = `${c.s} × ${c.b || "none"}`;
    test(`menu matrix: ${label} → [${c.expected.join(", ")}]`, () => {
        const menu = resolveBackgroundMenu(styles[c.s], c.b ? brands[c.b] : null);
        assert.deepEqual(ids(menu), c.expected);
    });
}

// Palette expectations
test("palette: Action Figure × Twilio — palette applied", () => {
    const f = buildComboFragments({ style: styles["action-figure"], brand: brands.twilio, background: null });
    assert.match(f.colorPalette, /Twilio red/);
    assert.match(f.containerDescription, /Toy box/);
});

test("palette: Bronze × Twilio — palette suppressed", () => {
    const f = buildComboFragments({ style: styles.bronze, brand: brands.twilio, background: null });
    assert.equal(f.colorPalette, null);
    assert.equal(f.containerDescription, null);
});

test("palette: Cartoon × LA Kings — neither fragment", () => {
    const f = buildComboFragments({ style: styles.cartoon, brand: brands["la-kings"], background: null });
    assert.equal(f.colorPalette, null);
    assert.equal(f.containerDescription, null);
});

test("palette: Trading Card × Twilio — both fragments present", () => {
    const f = buildComboFragments({ style: styles["trading-card"], brand: brands.twilio, background: null });
    assert.match(f.colorPalette, /Twilio red/);
    assert.match(f.containerDescription, /Card frame/);
});
