const { test } = require("node:test");
const assert = require("node:assert/strict");
const twilio = require("twilio");
const { buildDefinitions, approvalCategories } = require("../scripts/create-content-templates");

test("static template inventory and samples are valid", () => {
    const definitions = buildDefinitions("https://booth.example.com", "assets/template-samples/sample-portrait.jpg");
    assert.deepEqual(Object.keys(definitions).sort(), ["delivery", "nudgeDropoff", "promo", "rating"]);
    assert.equal(definitions.delivery.variables[2], "assets/template-samples/sample-portrait.jpg");
    assert.equal(definitions.delivery.types["twilio/card"].actions.length, 1);
    assert.equal(definitions.delivery.types["twilio/card"].subtitle, "Created at the Twilio AI Photo Booth");
    assert.equal(definitions.rating.types["twilio/quick-reply"].actions.length, 5);
    assert.equal(definitions.promo.variables, undefined);
    assert.equal(approvalCategories.delivery, "UTILITY");
    assert.equal(approvalCategories.promo, "MARKETING");
});

test("installed Twilio SDK exposes approval methods used by script", () => {
    const client = twilio("AC00000000000000000000000000000000", "test");
    const context = client.content.v1.contents("HX00000000000000000000000000000000");
    assert.equal(typeof context.approvalFetch().fetch, "function");
    assert.equal(typeof context.approvalCreate.create, "function");
});
