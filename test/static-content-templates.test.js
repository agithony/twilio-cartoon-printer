const { test } = require("node:test");
const assert = require("node:assert/strict");
const twilio = require("twilio");
const { buildDefinitions, approvalCategories, getContentName, main } = require("../scripts/create-content-templates");

test("static template inventory and samples are valid", () => {
    const definitions = buildDefinitions("https://booth.example.com", "assets/template-samples/sample-portrait.jpg", "en");
    assert.deepEqual(Object.keys(definitions).sort(), ["delivery", "nudgeDropoff", "promo", "rating"]);
    assert.equal(definitions.delivery.variables[2], "assets/template-samples/sample-portrait.jpg");
    assert.equal(definitions.delivery.types["twilio/card"].actions.length, 1);
    assert.equal(definitions.delivery.types["twilio/card"].subtitle, "Created at the Twilio AI Photo Booth");
    assert.equal(definitions.rating.types["twilio/quick-reply"].actions.length, 5);
    assert.equal(definitions.promo.variables, undefined);
    assert.equal(approvalCategories.delivery, "UTILITY");
    assert.equal(approvalCategories.promo, "MARKETING");
});

test("Portuguese templates preserve payload IDs and field limits", () => {
    const definitions = buildDefinitions("https://booth.example.com", "assets/template-samples/sample-portrait.jpg", "pt_BR");
    assert.equal(definitions.delivery.language, "pt_BR");
    assert.match(definitions.delivery.friendlyName, /^pb_delivery_pt_br_[a-f0-9]+$/);
    assert.match(definitions.delivery.types["twilio/card"].title, /retrato/i);
    assert.equal(definitions.delivery.types["twilio/card"].subtitle, "Criado na cabine de fotos com IA da Twilio");
    assert.equal(definitions.rating.types["twilio/quick-reply"].actions[0].id, "nps_5");
    for (const action of definitions.rating.types["twilio/quick-reply"].actions) {
        assert.ok(action.title.length <= 20);
    }
});

test("print-only mode builds both locales without calling Twilio", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
        const result = await main({
            client: new Proxy({}, { get() { throw new Error("Twilio should not be called"); } }),
            baseUrl: "https://booth.example.com",
            samplePortraitPath: "assets/template-sample-portrait.png",
            printOnly: true,
        });
        assert.deepEqual(Object.keys(result.definitions), ["en", "pt_BR"]);
    } finally {
        console.log = originalLog;
    }
});

test("existing submitted templates resolve their name from WhatsApp approval", async () => {
    const client = {
        content: { v1: { contents: () => ({
            approvalFetch: () => ({ fetch: async () => ({ whatsapp: { name: "pb_delivery_en_abc123" } }) }),
        }) } },
    };
    assert.equal(await getContentName(client, { sid: "HXexisting", friendlyName: null }), "pb_delivery_en_abc123");
});

test("installed Twilio SDK exposes approval methods used by script", () => {
    const client = twilio("AC00000000000000000000000000000000", "test");
    const context = client.content.v1.contents("HX00000000000000000000000000000000");
    assert.equal(typeof context.approvalFetch().fetch, "function");
    assert.equal(typeof context.approvalCreate.create, "function");
});
