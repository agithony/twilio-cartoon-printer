const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildHomeHtml } = require("../lib/home");

test("all configurable OpenAI models use editable capability-specific pickers", () => {
    const html = buildHomeHtml();
    const pickers = {
        sModelOrch: "openaiVisionModels",
        sModelVision: "openaiVisionModels",
        sModelImage: "openaiImageModels",
        sModelReply: "openaiTextModels",
        sModelRefAnalysis: "openaiVisionModels",
    };

    for (const [id, list] of Object.entries(pickers)) {
        assert.match(html, new RegExp(`<input[^>]+id="${id}"[^>]+list="${list}"`));
        assert.doesNotMatch(html, new RegExp(`<select[^>]+id="${id}"`));
    }

    assert.match(html, /<datalist id="openaiTextModels">/);
    assert.match(html, /<datalist id="openaiVisionModels">/);
    assert.match(html, /<datalist id="openaiImageModels">/);
    assert.match(html, /fetch\("\/dashboard\/api\/openai-models"\)/);
    assert.match(html, /custom IDs are accepted/);
});
