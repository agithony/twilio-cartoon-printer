const { test } = require("node:test");
const { __assemblePromptForTest } = require("../lib/pipeline");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

// ─── Test fixtures (stable, no randomness) ──────────────────────────────────
const cartoonStyleObj = {
    name: "cartoon",
    behavior: "normal",
    acceptsColorPalette: true,
    containerDescription: null,
    core: STYLES.cartoon.core,
    brandCore: STYLES.cartoon.brandCore,
    prompt: STYLES.cartoon.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
};

const sketchStyleObj = {
    name: "sketch",
    behavior: "normal",
    acceptsColorPalette: false,
    containerDescription: null,
    core: STYLES.sketch.core,
    brandCore: STYLES.sketch.brandCore,
    prompt: STYLES.sketch.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
};

const actionFigureStyleObj = {
    name: "action figure",
    behavior: "themed-container",
    acceptsColorPalette: true,
    containerDescription: "Subject rendered as a collectible action figure sealed in a themed toy box with clear blister packaging.",
    core: "Collectible action figure toy sealed in branded packaging.",
    brandCore: "Action figure toy packaging.",
    prompt: "Transform this photo into a detailed action figure portrait inside a themed toy package.",
};

const wardrobeOnlyBrand = {
    category: "wardrobe-only",
    wardrobe: "Twilio-branded apparel",
    allowOriginal: true,
};

const wardrobePlusSceneBrand = {
    category: "wardrobe-plus-scene",
    wardrobe: "Signal conference apparel with branded lanyard",
    colorPalette: "Recolor everything to Twilio red and white.",
    allowOriginal: false,
};

const soloScene = { subjects: 1, pets: "none", positions: "centered" };
const soloSceneLine = "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.";

const baseEvent = {
    preserve: DEFAULT_PRESERVE,
    preserveBrand: "Preserve accurately: skin tone, eye color, hair color and style, facial hair, glasses, facial structure.",
    brandInstruction: "Logos and text: Copy the exact logos, crests, numbers, and text from the reference images. Do NOT invent, add, or modify any text or symbols.",
    composition: DEFAULT_COMPOSITION,
    backgroundLine: "Background: Recreate the background from the original photo in the same art style. Keep it natural and consistent with the scene.",
    multiSubjectMode: "reject",
};

function baseInput(overrides) {
    return {
        styleKey: "cartoon",
        styleObj: cartoonStyleObj,
        stylePrompt: cartoonStyleObj.prompt,
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

// ─── Scenarios 1-4 ──────────────────────────────────────────────────────────

test("characterize: solo cartoon, no brand, default background", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput());
    t.assert.snapshot(prompt);
});

test("characterize: solo cartoon + wardrobe-only brand", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        brandKey: "laKings",
        brandObj: wardrobeOnlyBrand,
        brandPrompt: "Wear an LA Kings hockey jersey.",
        brandAnalysis: "A black hockey jersey with silver LA Kings crest on the chest.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
    }));
    t.assert.snapshot(prompt);
});

test("characterize: solo cartoon + wardrobe-plus-scene brand (palette applies)", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        brandKey: "twilio",
        brandObj: wardrobePlusSceneBrand,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "A red Signal conference jacket with white lanyard.",
        brandRefBuffers: [Buffer.from("fake-ref-1"), Buffer.from("fake-ref-2")],
    }));
    t.assert.snapshot(prompt);
});

test("characterize: themed-container style (action figure) with brand", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        styleKey: "action-figure",
        styleObj: actionFigureStyleObj,
        stylePrompt: actionFigureStyleObj.prompt,
        brandKey: "twilio",
        brandObj: wardrobePlusSceneBrand,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "A red Signal conference jacket with white lanyard.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
    }));
    t.assert.snapshot(prompt);
});

// ─── Scenarios 5-8 ──────────────────────────────────────────────────────────

test("characterize: sketch (rejects color palette) + palette-bearing brand", async (t) => {
    // Twilio brand has a colorPalette, but sketch has acceptsColorPalette:false,
    // so the palette must be suppressed. This pins that behavior.
    const prompt = await __assemblePromptForTest(baseInput({
        styleKey: "sketch",
        styleObj: sketchStyleObj,
        stylePrompt: sketchStyleObj.prompt,
        brandKey: "twilio",
        brandObj: wardrobePlusSceneBrand,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "A red Signal conference jacket with white lanyard.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
    }));
    t.assert.snapshot(prompt);
});

test("characterize: multi-subject (2 people) cartoon, no brand, caricature mode", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        scene: { subjects: 2, pets: "none", positions: "side-by-side" },
        sceneLine: "This photo has exactly 2 HUMAN subjects. Include ALL of them positioned as shown. The output must contain exactly 2 people — no more, no fewer.",
        multiSubjectMode: "caricature",
    }));
    t.assert.snapshot(prompt);
});

test("characterize: solo cartoon + pet (dog), no brand", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        scene: { subjects: 1, pets: "dog", positions: "centered" },
        sceneLine: "This photo has exactly 1 person and a dog. The dog is an animal, NOT a person — do not turn the dog into a human. The output must contain exactly 1 person and the dog — no other people.",
    }));
    t.assert.snapshot(prompt);
});

test("characterize: reviewer feedback override (skips final lock + reminder)", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        brandKey: "laKings",
        brandObj: wardrobeOnlyBrand,
        brandPrompt: "Wear an LA Kings hockey jersey.",
        brandAnalysis: "A black hockey jersey with silver LA Kings crest on the chest.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
        reviewFeedback: "The subject is wearing a blue shirt in the original, not an LA Kings jersey. Please do not alter their original clothing.",
    }));
    t.assert.snapshot(prompt);
});
