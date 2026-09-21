const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
    classifyModelIds,
    loadOpenAIModelCatalog,
    resetModelCatalogCache,
} = require("../lib/openai-models");

beforeEach(() => resetModelCatalogCache());

test("classifyModelIds separates general response and image model candidates", () => {
    const models = classifyModelIds([
        { id: "gpt-6" },
        { id: "gpt-6-mini" },
        { id: "gpt-6-realtime-preview" },
        { id: "gpt-image-3" },
        { id: "o5" },
        { id: "text-embedding-4" },
        { id: "omni-moderation-latest" },
        { id: "gpt-6" },
    ]);

    assert.deepEqual(models.text, ["gpt-6", "gpt-6-mini", "o5"]);
    assert.deepEqual(models.vision, ["gpt-6", "gpt-6-mini"]);
    assert.deepEqual(models.image, ["gpt-image-3"]);
});

test("loadOpenAIModelCatalog caches successful discovery per API key", async () => {
    let calls = 0;
    let requestOptions = null;
    const client = {
        models: {
            list: async (options) => {
                calls++;
                requestOptions = options;
                return { data: [{ id: "gpt-6" }, { id: "gpt-image-3" }] };
            },
        },
    };

    const first = await loadOpenAIModelCatalog({ apiKey: "sk-test", client, now: 1000 });
    const second = await loadOpenAIModelCatalog({ apiKey: "sk-test", client, now: 2000 });

    assert.equal(calls, 1);
    assert.equal(requestOptions.timeout, 5000);
    assert.strictEqual(second, first);
    assert.equal(first.source, "openai");
    assert.deepEqual(first.models.image, ["gpt-image-3"]);
});

test("loadOpenAIModelCatalog falls back without exposing provider errors", async () => {
    const warnings = [];
    const catalog = await loadOpenAIModelCatalog({
        apiKey: "sk-test",
        client: { models: { list: async () => { throw new Error("secret provider detail"); } } },
        logger: { warn: (message) => warnings.push(message) },
        now: 1000,
    });

    assert.equal(catalog.source, "curated");
    assert.equal(catalog.reason, "discovery-unavailable");
    assert.deepEqual(catalog.models, { text: [], vision: [], image: [] });
    assert.equal(Object.prototype.hasOwnProperty.call(catalog, "error"), false);
    assert.match(warnings[0], /model discovery failed/i);
});
