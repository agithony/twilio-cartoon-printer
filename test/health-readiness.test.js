const { test } = require("node:test");
const assert = require("node:assert/strict");
const health = require("../lib/health");

test("application remains unready until initialization completes", () => {
    health.setReady(false);
    assert.equal(health.isReady(), false);
    health.setReady();
    assert.equal(health.isReady(), true);
});
