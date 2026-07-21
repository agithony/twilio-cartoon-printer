const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "settings.json");
const EVENT_PROFILE_FILE = path.join(__dirname, "..", "data", "events", "default", "settings.json");
let _originalSettings = null;
let _originalEventProfile = null;

before(() => {
    if (fs.existsSync(SETTINGS_FILE)) {
        _originalSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
    }
    if (fs.existsSync(EVENT_PROFILE_FILE)) {
        _originalEventProfile = fs.readFileSync(EVENT_PROFILE_FILE, "utf-8");
    }
});

after(() => {
    if (_originalSettings !== null) {
        fs.writeFileSync(SETTINGS_FILE, _originalSettings);
    } else if (fs.existsSync(SETTINGS_FILE)) {
        fs.unlinkSync(SETTINGS_FILE);
    }
    if (_originalEventProfile !== null) {
        fs.writeFileSync(EVENT_PROFILE_FILE, _originalEventProfile);
    } else if (fs.existsSync(EVENT_PROFILE_FILE)) {
        fs.unlinkSync(EVENT_PROFILE_FILE);
    }
});

function freshSettings() {
    delete require.cache[require.resolve("../lib/settings")];
    const s = require("../lib/settings");
    s.load();
    return s;
}

test("attendee language defaults to English and validates runtime modes", () => {
    const settings = freshSettings();
    assert.equal(settings.DEFAULTS.languageMode, "en");

    settings.update({ languageMode: "pt_BR" });
    assert.equal(settings.get("languageMode"), "pt_BR");

    settings.update({ languageMode: "invalid" });
    assert.equal(settings.get("languageMode"), "pt_BR");

    settings.update({ languageMode: "ask" });
    assert.equal(settings.get("languageMode"), "ask");
});

test("deployment template SIDs override stale persisted values", () => {
    const settings = freshSettings();
    const original = settings.DEFAULTS.contentTemplates.en.delivery;
    settings.DEFAULTS.contentTemplates.en.delivery = "HXenvironment";
    settings.update({ contentTemplates: { en: { delivery: "HXpersisted" } } });
    assert.equal(settings.getContentSid("delivery", "en"), "HXenvironment");
    settings.DEFAULTS.contentTemplates.en.delivery = original;
});

test("customStyles accepts behavior field", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "test-style": {
                name: "Test Style",
                prompt: "A test style prompt.",
                behavior: "themed-container",
                acceptsColorPalette: false,
                containerDescription: "Subject inside a test container.",
            },
        },
    });
    const stored = settings.get("customStyles")["test-style"];
    assert.equal(stored.behavior, "themed-container");
    assert.equal(stored.acceptsColorPalette, false);
    assert.equal(stored.containerDescription, "Subject inside a test container.");
});

test("customStyles missing new fields loads cleanly (backward compat)", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "legacy-style": {
                name: "Legacy",
                prompt: "Legacy prompt.",
            },
        },
    });
    const stored = settings.get("customStyles")["legacy-style"];
    assert.equal(stored.name, "Legacy");
    assert.ok(!("behavior" in stored) || stored.behavior === undefined);
});

test("customStyles invalid behavior value is dropped", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "bad-style": {
                name: "Bad",
                prompt: "Bad prompt.",
                behavior: "banana",
            },
        },
    });
    const stored = settings.get("customStyles")["bad-style"];
    assert.ok(!("behavior" in stored) || stored.behavior === undefined,
        `Invalid behavior "banana" should have been dropped; got ${stored.behavior}`);
});

test("customBrands accepts category, scenes, allowOriginal, wardrobe, colorPalette", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "test-brand": {
                name: "Test Brand",
                brandPrompt: "legacy prompt",
                category: "wardrobe-plus-scene",
                wardrobe: "test wardrobe fragment",
                allowOriginal: false,
                colorPalette: "Recolor everything red.",
                scenes: [
                    { key: "scene-a", name: "Scene A", prompt: "Scene A prompt." },
                    { key: "scene-b", name: "Scene B", prompt: "Scene B prompt." },
                ],
            },
        },
    });
    const stored = settings.get("customBrands")["test-brand"];
    assert.equal(stored.category, "wardrobe-plus-scene");
    assert.equal(stored.wardrobe, "test wardrobe fragment");
    assert.equal(stored.allowOriginal, false);
    assert.equal(stored.colorPalette, "Recolor everything red.");
    assert.equal(stored.scenes.length, 2);
    assert.equal(stored.scenes[0].key, "scene-a");
    assert.equal(stored.scenes[0].name, "Scene A");
    assert.equal(stored.scenes[0].prompt, "Scene A prompt.");
});

test("customBrands legacy shape loads cleanly (backward compat)", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "legacy-brand": {
                name: "Legacy",
                brandPrompt: "legacy text",
                files: ["ref1.png"],
            },
        },
    });
    const stored = settings.get("customBrands")["legacy-brand"];
    assert.equal(stored.name, "Legacy");
    assert.equal(stored.brandPrompt, "legacy text");
    assert.deepEqual(stored.files, ["ref1.png"]);
});

test("customBrands invalid category is dropped", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "bad-brand": {
                name: "Bad",
                brandPrompt: "x",
                category: "banana",
            },
        },
    });
    const stored = settings.get("customBrands")["bad-brand"];
    assert.ok(!("category" in stored) || stored.category === undefined,
        `Invalid category "banana" should be dropped; got ${stored.category}`);
});

test("customBrands invalid scene entries are filtered out", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "filter-brand": {
                name: "Filter",
                brandPrompt: "x",
                scenes: [
                    { key: "ok", name: "OK scene", prompt: "ok." },
                    { name: "missing key" },
                    "not an object",
                    { key: "nokey-no-name" },
                ],
            },
        },
    });
    const stored = settings.get("customBrands")["filter-brand"];
    assert.equal(stored.scenes.length, 1, "only the valid scene should survive");
    assert.equal(stored.scenes[0].key, "ok");
});
