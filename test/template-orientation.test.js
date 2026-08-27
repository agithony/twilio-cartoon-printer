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

before(async () => {
    await sharp({
        create: { width: 300, height: 200, channels: 4, background: "#ffffff" },
    }).png().toFile(templatePath);
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        templateFile: "basic.png",
        templateFilesByOrientation: {
            portrait: "basic.png",
            landscape: TEMPLATE,
        },
        templateCompatibilityOverrides: { "basic.png": "both" },
    }));
});

after(() => {
    fs.rmSync(templatePath, { force: true });
    fs.rmSync(eventDir, { recursive: true, force: true });
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

test("native override can opt a default Both frame back out", () => {
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        templateCompatibilityOverrides: { "frame_-_overlay_-_low_center.png": "native" },
    }));
    assert.equal(settings.getTemplateCompatibility("frame_-_overlay_-_low_center.png", EVENT), "native");
});
