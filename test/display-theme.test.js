const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BRB_OVERLAY_CSS } = require("../lib/brb");
const { buildComboHtml } = require("../lib/home");
const { buildPageHtml } = require("../lib/photogallery");

test("combo display chrome uses persisted theme tokens", () => {
    const html = buildComboHtml();
    assert.match(html, /twilio-brand\.css/);
    assert.match(html, /background:var\(--th-bg/);
    assert.match(html, /var\(--th-card/);
});

test("BRB overlay remains legible in light mode", () => {
    assert.match(BRB_OVERLAY_CSS, /html\[data-theme="light"\] #brbOverlay/);
    assert.match(BRB_OVERLAY_CSS, /-webkit-text-fill-color: currentColor/);
});

test("photo book themes secondary and modal chrome", () => {
    const html = buildPageHtml("default", "en");
    assert.match(html, /html\[data-theme="light"\] \.action-bar/);
    assert.match(html, /html\[data-theme="light"\] \.photo-modal-close/);
    assert.match(html, /html\[data-theme="light"\] \.ab-delete-menu/);
    assert.match(html, /html\[data-theme="light"\] \.mg-card\.selected/);
    assert.match(html, /html\[data-theme="light"\] \.ab-btn\.danger/);
    assert.match(html, /html\[data-theme="light"\] \.photo-modal-nav:hover/);
    assert.match(html, /\.ab-move-sel \{\s*background-color:/);
});
