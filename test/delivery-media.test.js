const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __shouldSkipDeliveryMediaForTest: shouldSkipDeliveryMedia } = require("../lib/queue");

test("share-page-only suppresses SMS media", () => {
    assert.equal(shouldSkipDeliveryMedia({ name: "sms" }, " Share: https://example.com", true), true);
});

test("share-page-only never suppresses WhatsApp portrait previews", () => {
    assert.equal(shouldSkipDeliveryMedia({ name: "whatsapp" }, " Share: https://example.com", true), false);
});
