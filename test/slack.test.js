const { test } = require("node:test");
const assert = require("node:assert/strict");

// Unset token so we test the no-op path without real Slack credentials
process.env.SLACK_BOT_TOKEN = "";
process.env.SLACK_SIGNING_SECRET = "";

test("isConfigured returns false when token is absent", () => {
    delete require.cache[require.resolve("../lib/slack")];
    const slack = require("../lib/slack");
    assert.equal(slack.isConfigured(), false);
});

test("postPortraitFeed resolves without throwing when unconfigured", async () => {
    delete require.cache[require.resolve("../lib/slack")];
    const slack = require("../lib/slack");
    await assert.doesNotReject(() => slack.postPortraitFeed({ filePrefix: "test", userPhone: "+15550001234", style: "cartoon", eventName: "test" }));
});

test("postReviewRequest resolves without throwing when unconfigured", async () => {
    delete require.cache[require.resolve("../lib/slack")];
    const slack = require("../lib/slack");
    const fakeJob = { filePrefix: "test", filename: "test.json", userPhone: "+15550001234", style: "cartoon", eventName: "test" };
    await assert.doesNotReject(() => slack.postReviewRequest(fakeJob));
});

test("notifyJobActioned resolves without throwing when unconfigured", async () => {
    delete require.cache[require.resolve("../lib/slack")];
    const slack = require("../lib/slack");
    await assert.doesNotReject(() => slack.notifyJobActioned({}, "approve", "web-ui"));
});
