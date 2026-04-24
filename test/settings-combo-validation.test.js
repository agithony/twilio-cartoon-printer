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
