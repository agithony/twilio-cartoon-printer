const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getMessageBody, getNpsScore } = require("../lib/inbound-payload");

test("button payload takes precedence over display text", () => {
    assert.equal(getMessageBody({ Body: "Watercolor", ButtonPayload: "watercolor" }), "watercolor");
});

test("typed messages use Body", () => {
    assert.equal(getMessageBody({ Body: "2" }), "2");
});

test("quick-reply and typed NPS scores are accepted strictly", () => {
    assert.equal(getNpsScore("nps_5"), 5);
    assert.equal(getNpsScore("3"), 3);
    assert.equal(getNpsScore("5junk"), null);
});
