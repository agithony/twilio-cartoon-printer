const { test } = require("node:test");
const assert = require("node:assert/strict");
const { shouldShowMenu } = require("../lib/menu-routing");

test("enabled selection menus are shown for a single choice", () => {
    assert.equal(shouldShowMenu(true, [{ key: "only-choice" }]), true);
});

test("enabled selection menus are shown for multiple choices", () => {
    assert.equal(shouldShowMenu(true, [{ key: "one" }, { key: "two" }]), true);
});

test("selection menus are skipped when disabled or empty", () => {
    assert.equal(shouldShowMenu(false, [{ key: "choice" }]), false);
    assert.equal(shouldShowMenu(true, []), false);
});
