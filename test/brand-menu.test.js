const { test } = require("node:test");
const assert = require("node:assert/strict");

const settingsStub = { getMsg(k) { return k; } };
require.cache[require.resolve("../lib/settings")] = { exports: settingsStub, loaded: true, id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings") };

const brandMenu = require("../lib/brand-menu");
const brands = { twilio: { name: "Twilio" }, signal: { name: "Signal" } };
const brandList = ["twilio", "signal"];

test("matchReply: by number", () => { assert.equal(brandMenu.matchReply("1", brands, brandList), "twilio"); });
test("matchReply: by name", () => { assert.equal(brandMenu.matchReply("Signal", brands, brandList), "signal"); });
test("matchReply: null for bad input", () => { assert.equal(brandMenu.matchReply("xyz", brands, brandList), null); });
test("pending: set and clear", () => {
    brandMenu.setPending("+14155551234", { brand: "twilio" });
    assert.equal(brandMenu.hasPending("+14155551234"), true);
    brandMenu.clearPending("+14155551234");
    assert.equal(brandMenu.hasPending("+14155551234"), false);
});
