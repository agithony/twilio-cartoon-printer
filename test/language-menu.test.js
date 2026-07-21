const { test } = require("node:test");
const assert = require("node:assert/strict");
const menu = require("../lib/language-menu");

test("language menu holds and clears an inbound selfie", () => {
    menu.setPending("+1", { imageUrl: "https://example.com/selfie", messageSid: "MM1" });
    assert.equal(menu.getPending("+1").messageSid, "MM1");
    menu.clearPending("+1");
    assert.equal(menu.getPending("+1"), null);
});
