const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    __shouldSkipDeliveryMediaForTest: shouldSkipDeliveryMedia,
    __oversizedWhatsappImageSuffixForTest: oversizedWhatsappImageSuffix,
} = require("../lib/queue");

test("share-page-only suppresses SMS media", () => {
    assert.equal(shouldSkipDeliveryMedia({ name: "sms" }, " Share: https://example.com", true), true);
});

test("share-page-only never suppresses WhatsApp portrait previews", () => {
    assert.equal(shouldSkipDeliveryMedia({ name: "whatsapp" }, " Share: https://example.com", true), false);
});

test("oversized WhatsApp portrait does not add a second URL when a share link exists", () => {
    assert.equal(oversizedWhatsappImageSuffix(" Share: twil.io/startup-labs-1", "https://example.com/s/job/img?e=event"), "");
});

test("oversized WhatsApp portrait retains its direct URL without a share link", () => {
    assert.equal(oversizedWhatsappImageSuffix("", "https://example.com/s/job/img?e=event"), "\nhttps://example.com/s/job/img?e=event");
});
