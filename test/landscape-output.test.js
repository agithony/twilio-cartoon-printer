const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const settings = require("../lib/settings");
const {
    compositeWithTemplate,
    prepareForPrint,
    __getTemplateCacheStatsForTest,
    __clearTemplateCacheForTest,
} = require("../lib/helpers");
const { buildPrintCommand } = require("../lib/printer");

const EVENT = "__landscape_output_test__";
const EVENT_BOTH = "__landscape_output_both_test__";
const EVENT_EXPLICIT = "__landscape_output_explicit_test__";
const TEMPLATE = "__landscape_portrait_template_test__.png";
const eventDir = path.join(settings.EVENTS_DIR, EVENT);
const bothEventDir = path.join(settings.EVENTS_DIR, EVENT_BOTH);
const explicitEventDir = path.join(settings.EVENTS_DIR, EVENT_EXPLICIT);
const templatePath = path.join(settings.ROOT_DIR, "templates", TEMPLATE);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cartoon-landscape-"));
const originalTemplateCompatibility = settings.DEFAULTS.templateCompatibilityOverrides[TEMPLATE];

before(async () => {
    settings.DEFAULTS.templateCompatibilityOverrides[TEMPLATE] = "both";
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        printSize: "6x4",
        printQuality: "high",
        templateFile: TEMPLATE,
    }));
    fs.mkdirSync(bothEventDir, { recursive: true });
    fs.writeFileSync(path.join(bothEventDir, "settings.json"), JSON.stringify({
        printSize: "6x4",
        printQuality: "high",
        templateFile: TEMPLATE,
        templateFilesByOrientation: { portrait: TEMPLATE, landscape: TEMPLATE },
    }));
    fs.mkdirSync(explicitEventDir, { recursive: true });
    fs.writeFileSync(path.join(explicitEventDir, "settings.json"), JSON.stringify({
        printSize: "6x4",
        templateFilesByOrientation: { portrait: TEMPLATE, landscape: TEMPLATE },
    }));
    await sharp({
        create: { width: 100, height: 150, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
        input: { create: { width: 40, height: 20, channels: 4, background: "#ef223a" } },
        left: 0,
        top: 130,
    }]).png().toFile(templatePath);
});

after(() => {
    fs.rmSync(eventDir, { recursive: true, force: true });
    fs.rmSync(bothEventDir, { recursive: true, force: true });
    fs.rmSync(explicitEventDir, { recursive: true, force: true });
    fs.rmSync(templatePath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalTemplateCompatibility === undefined) {
        delete settings.DEFAULTS.templateCompatibilityOverrides[TEMPLATE];
    } else {
        settings.DEFAULTS.templateCompatibilityOverrides[TEMPLATE] = originalTemplateCompatibility;
    }
});

test("6x4 output profile is an exact 1800x1200 PNG at 300 DPI", () => {
    const profile = settings.getOutputProfile(EVENT);
    assert.deepEqual(profile, {
        printSize: "6x4",
        width: 1800,
        height: 1200,
        pageSize: "4x6",
        dpi: 300,
        orientation: "landscape",
        aiSize: "1536x1024",
        format: "png",
        printQuality: "high",
        resolution: "720x720dpi",
        customPrintFlags: "",
    });
});

test("maximum quality resolves to the printer's supported 720 DPI", () => {
    assert.equal(settings.PRINT_QUALITIES.max, "720x720dpi");
});

test("legacy output dimensions recover their original print orientation", () => {
    const portrait = settings.getOutputProfileForDimensions(1500, 2100, EVENT);
    const landscape = settings.getOutputProfileForDimensions(1800, 1200, EVENT);

    assert.equal(portrait.printSize, "5x7");
    assert.equal(portrait.orientation, "portrait");
    assert.equal(landscape.printSize, "6x4");
    assert.equal(landscape.orientation, "landscape");
});

test("print preparation writes exact landscape PNG dimensions", async () => {
    const outputPath = path.join(tempDir, "landscape.png");
    await sharp({
        create: { width: 1536, height: 1024, channels: 3, background: "#336699" },
    }).png().toFile(outputPath);

    await prepareForPrint(outputPath, settings.getOutputProfile(EVENT), EVENT);
    const metadata = await sharp(outputPath).metadata();

    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1800);
    assert.equal(metadata.height, 1200);
    assert.equal(metadata.density, 300);
});

test("portrait templates are skipped for landscape output", async () => {
    const outputPath = path.join(tempDir, "unframed-landscape.png");
    await sharp({
        create: { width: 300, height: 200, channels: 3, background: "#336699" },
    }).png().toFile(outputPath);

    settings.DEFAULTS.templateCompatibilityOverrides[TEMPLATE] = "native";
    try {
        await compositeWithTemplate(outputPath, settings.getOutputProfile(EVENT), EVENT);
    } finally {
        settings.DEFAULTS.templateCompatibilityOverrides[TEMPLATE] = "both";
    }
    const metadata = await sharp(outputPath).metadata();

    assert.equal(metadata.width, 300);
    assert.equal(metadata.height, 200);
});

test("frames marked for both orientations adapt to landscape output", async () => {
    const outputPath = path.join(tempDir, "adapted-landscape.png");
    await sharp({
        create: { width: 300, height: 200, channels: 3, background: "#336699" },
    }).png().toFile(outputPath);

    await compositeWithTemplate(outputPath, settings.getOutputProfile(EVENT_BOTH), EVENT_BOTH);
    const { data, info } = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    let left = info.width, top = info.height, right = -1, bottom = -1;
    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            const offset = (y * info.width + x) * info.channels;
            if (data[offset] < 200 || data[offset + 1] > 80 || data[offset + 2] > 100) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }

    assert.equal(settings.getTemplateCompatibility(TEMPLATE, EVENT_BOTH), "both");
    assert.equal(info.width, 1800);
    assert.equal(info.height, 1200);
    assert.ok(right > left && bottom > top, "adapted decoration should remain visible");
    assert.equal(left, 0, "left-anchored decoration should remain flush with the left edge");
    assert.equal(bottom, 1199, "bottom-anchored decoration should remain flush with the bottom edge");
    const aspectRatio = (right - left + 1) / (bottom - top + 1);
    assert.ok(aspectRatio > 1.9 && aspectRatio < 2.1, `decoration should not stretch; got ratio ${aspectRatio}`);
    assert.ok(right - left + 1 < 650, "adapted decoration should leave landscape breathing room");
});

test("global compatibility adapts a portrait frame without cover-cropping for every event", async () => {
    const outputPath = path.join(tempDir, "explicit-landscape.png");
    await sharp({
        create: { width: 300, height: 200, channels: 3, background: "#336699" },
    }).png().toFile(outputPath);

    await compositeWithTemplate(outputPath, settings.getOutputProfile(EVENT_EXPLICIT), EVENT_EXPLICIT);
    const { data, info } = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    let redPixels = 0;
    let maxX = -1;
    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            const offset = (y * info.width + x) * info.channels;
            if (data[offset] >= 200 && data[offset + 1] <= 80 && data[offset + 2] <= 100) {
                redPixels++;
                maxX = Math.max(maxX, x);
            }
        }
    }

    assert.ok(redPixels > 0, "adapted decoration should remain visible");
    assert.ok(maxX < 650, "portrait decoration should be adapted rather than cover-cropped across the landscape");
});

test("prepared templates and safe zones are reused across jobs", async () => {
    __clearTemplateCacheForTest();
    let firstPixelScans = null;
    for (const filename of ["cache-first.png", "cache-second.png"]) {
        const outputPath = path.join(tempDir, filename);
        await sharp({
            create: { width: 300, height: 200, channels: 3, background: "#336699" },
        }).png().toFile(outputPath);
        await compositeWithTemplate(outputPath, settings.getOutputProfile(EVENT_BOTH), EVENT_BOTH);
        const stats = __getTemplateCacheStatsForTest();
        if (filename === "cache-first.png") {
            assert.ok(stats.pixelScans > 0);
            assert.equal(stats.entries, 1);
            firstPixelScans = stats.pixelScans;
            continue;
        }
        assert.equal(stats.entries, 1);
        assert.equal(stats.pixelScans, firstPixelScans);
    }
});

test("landscape printing uses 4x6 media with explicit CUPS orientation", () => {
    const command = buildPrintCommand(
        "/tmp/output.png",
        "EPSON_ET_8550",
        settings.getOutputProfile(EVENT),
    );

    assert.match(command, /PageSize=EPKG\.NMgn/);
    assert.match(command, /orientation-requested=4/);
    assert.match(command, /Resolution=720x720dpi/);
});

test("portrait printing does not force landscape orientation", () => {
    const command = buildPrintCommand("/tmp/output.png", "EPSON_ET_8550", {
        ...settings.PRINT_SIZES["5x7"],
        printSize: "5x7",
        resolution: "720x720dpi",
        customPrintFlags: "",
    });

    assert.doesNotMatch(command, /orientation-requested=4/);
});
