const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __assemblePromptForTest } = require("../lib/pipeline");
const promptBuilder = require("../lib/prompt-builder");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

test("parity: prompt-builder.build matches __assemblePromptForTest on cartoon solo", async () => {
    const cartoon = {
        name: "cartoon", behavior: "normal", acceptsColorPalette: true,
        containerDescription: null,
        core: STYLES.cartoon.core, brandCore: STYLES.cartoon.brandCore,
        prompt: STYLES.cartoon.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
    };
    const input = {
        styleKey: "cartoon", styleObj: cartoon, stylePrompt: cartoon.prompt,
        brandObj: null, brandAnalysis: "", brandPrompt: "", brandRefBuffers: [],
        styleAnalysis: "", styleRefBuffers: [],
        bgChoice: null, bgMode: "ai", bgAnalysis: "", bgRefBuffers: [],
        scene: { subjects: 1, pets: "none", positions: "centered" },
        sceneLine: "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.",
        preserve: DEFAULT_PRESERVE, preserveBrand: "Preserve accurately: skin tone.",
        brandInstruction: "Logos.", composition: DEFAULT_COMPOSITION,
        backgroundLine: "Background: Recreate the background from the original photo in the same art style.",
        multiSubjectMode: "reject", reviewFeedback: null,
    };
    const fromPipeline = await __assemblePromptForTest(input);
    const fromBuilder = promptBuilder.build(input);
    assert.equal(fromBuilder, fromPipeline);
});
