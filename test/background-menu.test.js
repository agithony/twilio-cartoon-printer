const { test } = require("node:test");
const assert = require("node:assert/strict");

const settingsStub = { getMsg(k) { return k; } };
require.cache[require.resolve("../lib/settings")] = { exports: settingsStub, loaded: true, id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings") };

const bgMenu = require("../lib/background-menu");
// background-menu.matchReply takes an array of { key, name } choices
const choices = [{ key: "office", name: "Office" }, { key: "beach", name: "Beach" }];

test("matchReply: by number", () => { assert.equal(bgMenu.matchReply("1", choices), "office"); });
test("matchReply: by name", () => { assert.equal(bgMenu.matchReply("Beach", choices), "beach"); });
test("matchReply: null for bad input", () => { assert.equal(bgMenu.matchReply("xyz", choices), null); });
test("pending: set and clear", () => {
    bgMenu.setPending("+14155551234", { bg: "office" });
    assert.equal(bgMenu.hasPending("+14155551234"), true);
    bgMenu.clearPending("+14155551234");
    assert.equal(bgMenu.hasPending("+14155551234"), false);
});
