const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BRB_OVERLAY_CSS } = require("../lib/brb");
const { buildComboHtml } = require("../lib/home");
const { buildPageHtml } = require("../lib/photogallery");

test("combo display chrome uses persisted theme tokens", () => {
    const html = buildComboHtml();
    assert.match(html, /twilio-brand\.css/);
    assert.match(html, /background:\s*var\(--th-bg/);
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

test("portrait combo stacks the display without forced fullscreen", () => {
    const html = buildComboHtml();
    assert.match(html, /@media \(orientation: portrait\)/);
    assert.match(html, /flex-direction: column/);
    assert.match(html, /firstPane = Math\.max\(8/);
    assert.match(html, /pointerdown/);
    assert.match(html, /row-resize/);
    assert.doesNotMatch(html, /fsOverlay|Click anywhere to enter fullscreen|requestFullscreen/);
});

test("home combo links use normal navigation without popup windows", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "home.js"), "utf8");
    assert.doesNotMatch(source, /window\.open\('\/home\/combo'/);
});

test("landscape combo preserves the original side-by-side behavior", () => {
    const html = buildComboHtml();
    assert.match(html, /display: flex; width: 100%; height: 100%/);
    assert.match(html, /Math\.max\(15, Math\.min\(85/);
});

test("portrait photo book enlarges count and thumbnails while preserving spreads", () => {
    const html = buildPageHtml("default", "en");
    assert.match(html, /--count-number-size: clamp\(80px,9vw,124px\)/);
    assert.match(html, /--thumb-size: clamp\(82px,11vw,132px\)/);
    assert.match(html, /portrait-host/);
    assert.match(html, /combo-embedded/);
    assert.match(html, /html:not\(\.combo-embedded\) \.scene/);
    assert.match(html, /display: "double"/);
    assert.doesNotMatch(html, /display: "single"|function bindBookSwipe\(\)/);
    assert.match(html, /function configureNativePageDrag\(\)/);
    assert.match(html, /cornerSize = Math\.max\(100, Math\.min\(180/);
    assert.match(html, /standalonePortrait = window\.top === window/);
});

test("portrait combo theme changes synchronize both panes", () => {
    const html = buildComboHtml();
    assert.match(html, /twilio-theme-change/);
    assert.match(html, /\[leftPane, rightPane\]/);
    assert.match(html, /frame\.contentDocument\.documentElement\.setAttribute/);
    assert.match(html, /if \(!isPortrait\(\)\) return/);
});

test("generated display scripts remain syntactically valid", () => {
    for (const html of [buildComboHtml(), buildPageHtml("default", "en")]) {
        const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
        for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
    }
});
