const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("../lib/prompt-builder");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

function makeStyle(key) {
    const s = STYLES[key];
    return {
        name: s.name, behavior: "normal", acceptsColorPalette: s.acceptsColorPalette !== false,
        containerDescription: null, core: s.core, brandCore: s.brandCore,
        prompt: s.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
    };
}
function makeInput(over) {
    const cartoon = makeStyle("cartoon");
    return {
        styleKey: "cartoon", styleObj: cartoon, stylePrompt: cartoon.prompt,
        brandObj: null, brandAnalysis: "", brandPrompt: "", brandRefBuffers: [],
        styleAnalysis: "", styleRefBuffers: [],
        bgChoice: null, bgMode: "ai", bgAnalysis: "", bgRefBuffers: [],
        scene: { subjects: 1, pets: "none", positions: "centered" },
        sceneLine: "scene_line",
        preserve: "PRESERVE", preserveBrand: "PRESERVE_BRAND",
        brandInstruction: "BRAND_INSTR", composition: "COMP",
        backgroundLine: "DEFAULT_BG", multiSubjectMode: "reject",
        reviewFeedback: null,
        ...over,
    };
}

test("solo, no brand: default background line is appended", () => {
    const out = build(makeInput());
    assert.match(out, /DEFAULT_BG/);
});

test("reviewer feedback overrides and suppresses FINAL STYLE LOCK + REMINDER", () => {
    const out = build(makeInput({
        brandRefBuffers: [Buffer.from("x")],
        reviewFeedback: "Keep original clothing.",
    }));
    assert.match(out, /Override from reviewer/);
    assert.doesNotMatch(out, /FINAL STYLE LOCK/);
    assert.doesNotMatch(out, /FINAL REMINDER/);
});

test("palette-rejecting style suppresses brand colorPalette", () => {
    const sketch = makeStyle("sketch"); // sketch.acceptsColorPalette === false
    const out = build(makeInput({
        styleKey: "sketch", styleObj: sketch, stylePrompt: sketch.prompt,
        brandObj: { category: "wardrobe-plus-scene", colorPalette: "ALL RED" },
        brandPrompt: "brand_prompt",
        brandRefBuffers: [Buffer.from("x")],
        brandAnalysis: "red jersey",
    }));
    assert.doesNotMatch(out, /ALL RED/);
});

test("multi-subject with caricature mode appends the caricature block", () => {
    const out = build(makeInput({
        scene: { subjects: 2, pets: "none", positions: "side-by-side" },
        sceneLine: "two people",
        multiSubjectMode: "caricature",
    }));
    assert.match(out, /WILDLY EXAGGERATED CARICATURE/);
    assert.match(out, /FINAL REMINDER: Exactly 2 humans/);
});

test("subject + pet: final reminder mentions the pet as an animal", () => {
    const out = build(makeInput({
        scene: { subjects: 1, pets: "dog", positions: "centered" },
        sceneLine: "one person and a dog",
    }));
    assert.match(out, /Exactly 1 human and 1 dog/);
    assert.match(out, /dog is an animal — do NOT turn it into a person/);
});

test("style prompt containing 'Background:' suppresses default background line", () => {
    const fakeStyle = {
        name: "fake", behavior: "normal", acceptsColorPalette: true,
        containerDescription: null, core: "FAKE_CORE", brandCore: "FAKE_BC",
        prompt: "Do something. Background: dark studio.",
    };
    const out = build(makeInput({
        styleKey: "fake", styleObj: fakeStyle, stylePrompt: fakeStyle.prompt,
    }));
    assert.doesNotMatch(out, /DEFAULT_BG/);
});

// ── Additional coverage identified in Task 4 review ─────────────────────────

test("style refs + style analysis: emits CRITICAL art-style preamble", () => {
    const out = build(makeInput({
        styleRefBuffers: [Buffer.from("sref1"), Buffer.from("sref2")],
        styleAnalysis: "Hand-inked with watery washes.",
    }));
    assert.match(out, /CRITICAL — Art style: You MUST replicate this exact art style: Hand-inked with watery washes\./);
    assert.match(out, /style_ref_0\.png, style_ref_1\.png/);
});

test("style refs without analysis: emits filename-only preamble", () => {
    const out = build(makeInput({
        styleRefBuffers: [Buffer.from("sref1")],
        styleAnalysis: "",
    }));
    assert.match(out, /CRITICAL — Art style: The input images named style_ref_0\.png show the exact art style to replicate/);
});

test("bgMode=ai with bgAnalysis: emits Recreate-this-exact-background block", () => {
    const out = build(makeInput({
        bgChoice: { key: "times-square", prompt: "Extra bg note." },
        bgMode: "ai",
        bgRefBuffers: [Buffer.from("bg1")],
        bgAnalysis: "A neon-lit urban intersection.",
    }));
    assert.match(out, /Background: Recreate this exact background: A neon-lit urban intersection\./);
    assert.match(out, /bg_ref_0\.png/);
    assert.match(out, /Extra bg note\./);
    assert.doesNotMatch(out, /DEFAULT_BG/);
});

test("bgMode=ai without bgAnalysis: emits Match-the-background fallback", () => {
    const out = build(makeInput({
        bgChoice: { key: "whatever", prompt: "" },
        bgMode: "ai",
        bgRefBuffers: [Buffer.from("bg1"), Buffer.from("bg2")],
        bgAnalysis: "",
    }));
    assert.match(out, /Background: Match the background shown in the reference images\./);
});

test("bgMode=exact: instructs fully transparent background for post-processing composite", () => {
    const out = build(makeInput({
        bgChoice: { key: "plain", prompt: "" },
        bgMode: "exact",
        bgRefBuffers: [Buffer.from("bg1")],
    }));
    assert.match(out, /The area around the subject must be fully transparent/);
    assert.match(out, /Render only the subject as a cut-out/);
    assert.match(out, /replaced with the actual background image in post-processing/);
});

test("bgChoice with prompt (no refs): prompt is appended verbatim", () => {
    const out = build(makeInput({
        bgChoice: { key: "custom", prompt: "Set it in a desert." },
        bgMode: "ai",
        bgRefBuffers: [],
    }));
    assert.match(out, /Set it in a desert\./);
    assert.doesNotMatch(out, /DEFAULT_BG/);
});

test("caricature + reviewer feedback: caricature block still emits, FINAL LOCK + REMINDER suppressed", () => {
    const out = build(makeInput({
        scene: { subjects: 2, pets: "none", positions: "side-by-side" },
        sceneLine: "two people",
        multiSubjectMode: "caricature",
        brandRefBuffers: [Buffer.from("x")],
        reviewFeedback: "Ignore subject count from earlier; keep original outfits.",
    }));
    assert.match(out, /WILDLY EXAGGERATED CARICATURE/);
    assert.match(out, /Override from reviewer/);
    assert.doesNotMatch(out, /FINAL STYLE LOCK/);
    assert.doesNotMatch(out, /FINAL REMINDER/);
});
