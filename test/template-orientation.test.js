const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const settings = require("../lib/settings");

const EVENT = "__template_orientation_test__";
const TEMPLATE = "__template_landscape_test__.png";
const templatePath = path.join(settings.ROOT_DIR, "templates", TEMPLATE);
const eventDir = path.join(settings.EVENTS_DIR, EVENT);
const originalBasicCompatibility = settings.DEFAULTS.templateCompatibilityOverrides["basic.png"];

before(async () => {
    await sharp({
        create: { width: 300, height: 200, channels: 4, background: "#ffffff" },
    }).png().toFile(templatePath);
    settings.DEFAULTS.templateCompatibilityOverrides["basic.png"] = "both";
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        templateFile: "basic.png",
        templateFilesByOrientation: {
            portrait: "basic.png",
            landscape: TEMPLATE,
        },
    }));
});

after(() => {
    fs.rmSync(templatePath, { force: true });
    fs.rmSync(eventDir, { recursive: true, force: true });
    if (originalBasicCompatibility === undefined) {
        delete settings.DEFAULTS.templateCompatibilityOverrides["basic.png"];
    } else {
        settings.DEFAULTS.templateCompatibilityOverrides["basic.png"] = originalBasicCompatibility;
    }
});

test("template listing includes dimensions and orientation", async () => {
    const templates = await settings.listTemplates();
    const landscape = templates.find((template) => template.filename === TEMPLATE);
    const portrait = templates.find((template) => template.filename === "basic.png");

    assert.deepEqual(landscape, {
        filename: TEMPLATE,
        width: 300,
        height: 200,
        orientation: "landscape",
        supported: true,
    });
    assert.equal(portrait.orientation, "portrait");
    assert.ok(portrait.width < portrait.height);
});

test("template path resolves the remembered frame for each orientation", () => {
    assert.equal(settings.getTemplatePath(EVENT, "portrait"), path.join(settings.ROOT_DIR, "templates", "basic.png"));
    assert.equal(settings.getTemplatePath(EVENT, "landscape"), templatePath);
    assert.equal(settings.getTemplateCompatibility("basic.png", EVENT), "both");
    assert.equal(settings.getTemplateCompatibility("frame_-_overlay_-_low_center.png", EVENT), "both");
});

test("an explicit None selection does not fall back to the legacy frame", () => {
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        templateFile: "basic.png",
        templateFilesByOrientation: { portrait: "basic.png", landscape: "" },
    }));
    assert.equal(settings.getTemplatePath(EVENT, "landscape"), "");
});

test("a global native override opts a default Both frame out for every event", () => {
    const filename = "frame_-_overlay_-_low_center.png";
    const original = settings.DEFAULTS.templateCompatibilityOverrides[filename];
    try {
        settings.DEFAULTS.templateCompatibilityOverrides[filename] = "native";
        assert.equal(settings.getTemplateCompatibility(filename, EVENT), "native");
        assert.equal(settings.getTemplateCompatibility(filename, "another-event"), "native");
    } finally {
        settings.DEFAULTS.templateCompatibilityOverrides[filename] = original;
    }
});
