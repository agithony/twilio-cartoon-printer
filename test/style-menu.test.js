const { test } = require("node:test");
const assert = require("node:assert/strict");

const settingsStub = { getMsg(k) { return k; }, get(k) { return undefined; } };
const helpersStub = { maskPhone(p) { return p; } };
require.cache[require.resolve("../lib/settings")] = { exports: settingsStub, loaded: true, id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings") };
require.cache[require.resolve("../lib/helpers")] = { exports: helpersStub, loaded: true, id: require.resolve("../lib/helpers"), filename: require.resolve("../lib/helpers") };

const styleMenu = require("../lib/style-menu");
const activeStyles = { cartoon: { name: "Cartoon" }, anime: { name: "Anime" } };
const activeStyleList = ["cartoon", "anime"];

test("matchReply: matches by number", () => {
    assert.equal(styleMenu.matchReply("1", activeStyles, activeStyleList), "cartoon");
    assert.equal(styleMenu.matchReply("2", activeStyles, activeStyleList), "anime");
});

test("matchReply: matches by key (case-insensitive)", () => {
    assert.equal(styleMenu.matchReply("CARTOON", activeStyles, activeStyleList), "cartoon");
});

test("matchReply: matches by display name", () => {
    assert.equal(styleMenu.matchReply("Anime", activeStyles, activeStyleList), "anime");
});

test("matchReply: returns null for unrecognized input", () => {
    assert.equal(styleMenu.matchReply("xyz", activeStyles, activeStyleList), null);
});

test("pending state: hasPending false before set", () => {
    assert.equal(styleMenu.hasPending("+14155551234"), false);
});

test("pending state: hasPending true after set, false after clear", () => {
    styleMenu.setPending("+14155551234", { style: "cartoon" });
    assert.equal(styleMenu.hasPending("+14155551234"), true);
    styleMenu.clearPending("+14155551234");
    assert.equal(styleMenu.hasPending("+14155551234"), false);
});
