// Characterize tests for Bundle 2 variant overrides.
//
// Each new override field (style: behavior / containerDescription /
// acceptsColorPalette; brand: category / wardrobe / colorPalette / allowOriginal
// / scene.prompt) MUST measurably change the prompt that reaches the image
// model. These tests build a baseline prompt and then a prompt with the
// override applied, and assert the two differ in a specific, predictable way.
//
// If any of these go silent, a variant editor tweak is no longer affecting
// what the model sees — a regression that would otherwise be invisible in
// the UI.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const promptBuilder = require("../lib/prompt-builder");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

const soloScene = { subjects: 1, pets: "none", positions: "centered" };
const soloSceneLine = "This photo has exactly 1 person.";

const baseEvent = {
    preserve: DEFAULT_PRESERVE,
    preserveBrand: "Preserve accurately: skin tone.",
    brandInstruction: "Logos and text: Copy exactly.",
    composition: DEFAULT_COMPOSITION,
    backgroundLine: "Background: Recreate.",
    multiSubjectMode: "reject",
};

function cartoonStyle(overrides = {}) {
    return {
        name: "cartoon",
        behavior: "normal",
        acceptsColorPalette: true,
        containerDescription: null,
        core: STYLES.cartoon.core,
        brandCore: STYLES.cartoon.brandCore,
        prompt: STYLES.cartoon.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
        ...overrides,
    };
}

function buildInput(overrides) {
    const styleObj = overrides.styleObj || cartoonStyle();
    return {
        styleKey: "cartoon",
        styleObj,
        stylePrompt: styleObj.prompt,
        brandKey: null,
        brandObj: null,
        brandAnalysis: "",
        brandPrompt: "",
        brandRefBuffers: [],
        styleAnalysis: "",
        styleRefBuffers: [],
        bgChoice: null,
        bgMode: "ai",
        bgAnalysis: "",
        bgRefBuffers: [],
        scene: soloScene,
        sceneLine: soloSceneLine,
        ...baseEvent,
        reviewFeedback: null,
        ...overrides,
    };
}

// ── Style override: behavior (normal → themed-container) ───────────────────

test("style override: behavior=themed-container adds container description to prompt", () => {
    const base = promptBuilder.build(buildInput({
        styleObj: cartoonStyle({ behavior: "normal", containerDescription: null }),
    }));
    const overridden = promptBuilder.build(buildInput({
        styleObj: cartoonStyle({
            behavior: "themed-container",
            containerDescription: "Subject sealed inside a collectible action-figure blister pack.",
        }),
    }));

    assert.notEqual(base, overridden, "themed-container must change the prompt");
    assert.ok(
        overridden.includes("collectible action-figure blister pack"),
        "themed-container prompt must include the container description",
    );
    assert.ok(
        !base.includes("collectible action-figure blister pack"),
        "baseline prompt must not include the container description",
    );
});

// ── Style override: containerDescription only ──────────────────────────────

test("style override: containerDescription text is wired through only when behavior is themed-container", () => {
    // themed-container with description A
    const withA = promptBuilder.build(buildInput({
        styleObj: cartoonStyle({
            behavior: "themed-container",
            containerDescription: "Inside a VINTAGE tin toy box.",
        }),
    }));
    // themed-container with description B
    const withB = promptBuilder.build(buildInput({
        styleObj: cartoonStyle({
            behavior: "themed-container",
            containerDescription: "Inside a HOLOGRAPHIC trading-card case.",
        }),
    }));

    assert.notEqual(withA, withB, "different containerDescriptions must produce different prompts");
    assert.ok(withA.includes("VINTAGE tin toy box"), "description A must appear verbatim");
    assert.ok(withB.includes("HOLOGRAPHIC trading-card case"), "description B must appear verbatim");
});

// ── Style override: acceptsColorPalette (true → false suppresses palette) ──

test("style override: acceptsColorPalette=false suppresses brand palette", () => {
    const brandWithPalette = {
        category: "wardrobe-plus-scene",
        wardrobe: "Signal conference apparel",
        colorPalette: "Recolor everything to Twilio red and white.",
        allowOriginal: false,
    };

    const paletteOn = promptBuilder.build(buildInput({
        styleObj: cartoonStyle({ acceptsColorPalette: true }),
        brandKey: "twilio",
        brandObj: brandWithPalette,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "Red Signal jacket.",
        brandRefBuffers: [Buffer.from("fake")],
    }));
    const paletteOff = promptBuilder.build(buildInput({
        styleObj: cartoonStyle({ acceptsColorPalette: false }),
        brandKey: "twilio",
        brandObj: brandWithPalette,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "Red Signal jacket.",
        brandRefBuffers: [Buffer.from("fake")],
    }));

    assert.notEqual(paletteOn, paletteOff, "flipping acceptsColorPalette must change the prompt");
    assert.ok(paletteOn.includes("Twilio red and white"), "palette must be present when accepted");
    assert.ok(!paletteOff.includes("Twilio red and white"), "palette must be suppressed when rejected");
});

// ── Brand override: wardrobe (brandPrompt text) ────────────────────────────

test("brand override: wardrobe text flows through as brandPrompt verbatim", () => {
    // brandPrompt is the text that the variant editor's brand-wardrobe field
    // feeds in — no refs, just the wardrobe string.
    const withA = promptBuilder.build(buildInput({
        brandKey: "twilio",
        brandObj: { category: "wardrobe-only", wardrobe: "Red jersey", allowOriginal: true },
        brandPrompt: "Wear a RED Twilio jersey.",
        brandAnalysis: "",
        brandRefBuffers: [],
    }));
    const withB = promptBuilder.build(buildInput({
        brandKey: "twilio",
        brandObj: { category: "wardrobe-only", wardrobe: "Blue jersey", allowOriginal: true },
        brandPrompt: "Wear a BLUE Twilio jersey.",
        brandAnalysis: "",
        brandRefBuffers: [],
    }));

    assert.notEqual(withA, withB, "different brand wardrobe must produce different prompts");
    assert.ok(withA.includes("RED Twilio jersey"));
    assert.ok(withB.includes("BLUE Twilio jersey"));
});

// ── Brand override: colorPalette ───────────────────────────────────────────

test("brand override: colorPalette injects palette directive when style accepts it", () => {
    const brandNoPalette = {
        category: "wardrobe-plus-scene",
        wardrobe: "Signal apparel",
        allowOriginal: false,
    };
    const brandWithPalette = {
        ...brandNoPalette,
        colorPalette: "Recolor to ELECTRIC PINK and CYAN.",
    };

    const without = promptBuilder.build(buildInput({
        brandKey: "twilio",
        brandObj: brandNoPalette,
        brandPrompt: "Wear Signal apparel.",
        brandAnalysis: "Apparel.",
        brandRefBuffers: [Buffer.from("fake")],
    }));
    const withPalette = promptBuilder.build(buildInput({
        brandKey: "twilio",
        brandObj: brandWithPalette,
        brandPrompt: "Wear Signal apparel.",
        brandAnalysis: "Apparel.",
        brandRefBuffers: [Buffer.from("fake")],
    }));

    assert.notEqual(without, withPalette, "adding colorPalette must change the prompt");
    assert.ok(withPalette.includes("ELECTRIC PINK and CYAN"), "palette string must appear verbatim");
    assert.ok(!without.includes("ELECTRIC PINK"));
});

// ── Brand override: category (wardrobe-only vs wardrobe-plus-scene) ────────

test("brand override: category changes the background menu shape", () => {
    // Category is a *matrix gate*, not a prompt fragment: it controls which
    // backgrounds are selectable. wardrobe-only lets original + plain-white
    // show up alongside scenes; wardrobe-plus-scene forces a scene choice.
    // This pins that the variant editor's category override actually changes
    // what the user can pick, even though the builder receives a fixed bgChoice.
    const { resolveBackgroundMenu } = require("../lib/prompt-assembler");
    const style = cartoonStyle();
    const scenes = [{ key: "office", name: "Office", prompt: "In an office.", files: [] }];

    const wardrobeOnlyMenu = resolveBackgroundMenu(style, {
        category: "wardrobe-only",
        wardrobe: "Apparel",
        allowOriginal: true,
        scenes,
    });
    const wardrobePlusSceneMenu = resolveBackgroundMenu(style, {
        category: "wardrobe-plus-scene",
        wardrobe: "Apparel",
        allowOriginal: true,
        scenes,
    });

    const wardrobeOnlyKeys = wardrobeOnlyMenu.map((m) => m.key);
    const wardrobePlusSceneKeys = wardrobePlusSceneMenu.map((m) => m.key);

    assert.deepEqual(wardrobeOnlyKeys, ["office", "original", "plain-white"]);
    assert.deepEqual(wardrobePlusSceneKeys, ["office"]);
});

// ── Brand override: scene prompt (via bgChoice.prompt) ─────────────────────

test("brand override: scene prompt is wired into the bgChoice.prompt when chosen", () => {
    // When a scene is selected as the background, its prompt is appended
    // verbatim. The variant editor override changes this prompt per-brand.
    const sceneOriginal = {
        key: "stamford-bridge",
        name: "Stamford Bridge",
        prompt: "ORIGINAL: Stadium interior with team banners.",
    };
    const sceneOverridden = {
        ...sceneOriginal,
        prompt: "OVERRIDDEN: Late-afternoon sunset over the stadium pitch.",
    };

    const original = promptBuilder.build(buildInput({
        brandKey: "chelsea",
        brandObj: {
            category: "wardrobe-plus-scene",
            wardrobe: "Chelsea kit",
            allowOriginal: false,
            scenes: [sceneOriginal],
        },
        brandPrompt: "Wear the kit.",
        brandAnalysis: "Kit.",
        brandRefBuffers: [Buffer.from("fake")],
        bgChoice: sceneOriginal,
    }));
    const overridden = promptBuilder.build(buildInput({
        brandKey: "chelsea",
        brandObj: {
            category: "wardrobe-plus-scene",
            wardrobe: "Chelsea kit",
            allowOriginal: false,
            scenes: [sceneOverridden],
        },
        brandPrompt: "Wear the kit.",
        brandAnalysis: "Kit.",
        brandRefBuffers: [Buffer.from("fake")],
        bgChoice: sceneOverridden,
    }));

    assert.notEqual(original, overridden, "changing scene prompt must change the prompt");
    assert.ok(original.includes("Stadium interior with team banners"));
    assert.ok(overridden.includes("Late-afternoon sunset over the stadium pitch"));
    assert.ok(!overridden.includes("Stadium interior with team banners"));
});

// ── Brand override: allowOriginal (matrix-level control) ──────────────────

test("brand override: allowOriginal gates the 'original' entry in the background menu", () => {
    // allowOriginal is a matrix gate — toggling it in the variant editor
    // changes whether "original background" is offered as a scene choice.
    const { resolveBackgroundMenu } = require("../lib/prompt-assembler");
    const style = cartoonStyle();
    const scenes = [{ key: "office", name: "Office", prompt: "In an office.", files: [] }];

    const allowed = resolveBackgroundMenu(style, {
        category: "wardrobe-only",
        wardrobe: "Apparel",
        allowOriginal: true,
        scenes,
    });
    const disallowed = resolveBackgroundMenu(style, {
        category: "wardrobe-only",
        wardrobe: "Apparel",
        allowOriginal: false,
        scenes,
    });

    assert.ok(allowed.some((m) => m.key === "original"), "allowOriginal=true must include 'original'");
    assert.ok(!disallowed.some((m) => m.key === "original"), "allowOriginal=false must exclude 'original'");
});
