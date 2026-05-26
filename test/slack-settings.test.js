const { test } = require("node:test");
const assert = require("node:assert/strict");

test("slackChannel default is empty string", () => {
    // Isolate from env — delete module cache so DEFAULTS re-evaluate
    delete require.cache[require.resolve("../lib/settings")];
    const settings = require("../lib/settings");
    assert.equal(settings.get("slackChannel"), "");
});

test("slackFeedMode default is 'all'", () => {
    delete require.cache[require.resolve("../lib/settings")];
    const settings = require("../lib/settings");
    assert.equal(settings.get("slackFeedMode"), "all");
});
