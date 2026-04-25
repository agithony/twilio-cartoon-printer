const { test } = require("node:test");
const assert = require("node:assert/strict");
const brandMenu = require("../lib/brand-menu");

const activeBrands = {
    "la-kings": { name: "LA Kings" },
    "chelsea-fc": { name: "Chelsea FC" },
};
const brandList = ["la-kings", "chelsea-fc"];

test("buildMenu includes None as final option when includeNone=true", () => {
    const msg = brandMenu.buildMenu(activeBrands, brandList, { includeNone: true });
    assert.match(msg, /None/);
});

test("matchReply returns null for 'none' when includeNone=true", () => {
    // null signifies the sentinel 'user picked None'
    const matched = brandMenu.matchReply("none", activeBrands, brandList, { includeNone: true });
    assert.equal(matched, "__none__");
});

test("matchReply returns __none__ when user replies with number equal to N+1", () => {
    const matched = brandMenu.matchReply("3", activeBrands, brandList, { includeNone: true });
    assert.equal(matched, "__none__");
});

test("matchReply returns null for 'none' when includeNone=false (backward compat)", () => {
    const matched = brandMenu.matchReply("none", activeBrands, brandList);
    assert.equal(matched, null);
});
