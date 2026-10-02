const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");

const settings = require("../lib/settings");
const helpers = require("../lib/helpers");
const { STYLE_LIST } = require("../lib/styles");

test("Voice portrait generation does not require an enabled menu style", async (t) => {
    const eventName = `__voice_style_fallback_${process.pid}__`;
    const eventDir = path.join(settings.EVENTS_DIR, eventName);
    const downloadDir = settings.getDownloadDir(eventName);
    t.after(async () => {
        await fs.rm(eventDir, { recursive: true, force: true });
        await fs.rm(downloadDir, { recursive: true, force: true });
    });
    await fs.mkdir(eventDir, { recursive: true });
    await fs.writeFile(path.join(eventDir, "settings.json"), JSON.stringify({
        defaultStyle: "cartoon",
        disabledStyles: STYLE_LIST,
    }));
    assert.deepEqual(settings.getActiveStyles(eventName), {});

    // Only the external vision calls are replaced. The real pipeline still
    // resolves event settings, builds the Voice prompt, and handles job paths.
    t.mock.method(helpers, "moderateImage", async () => ({ flagged: false }));
    t.mock.method(helpers, "detectPerson", async () => true);
    const { generateImage, jobPaths } = require("../lib/pipeline");
    const scene = { subjects: 1, pets: "none", positions: "centered" };
    const job = {
        inputMode: "voice", style: null, background: null, brand: null,
        eventName, filePrefix: "voice-style-fallback", createdAt: Date.now(),
        imageUrl: "https://example.invalid/selfie.jpg",
        userPhone: "+14155550123", appPhone: "+12065550199", locale: "en",
        voiceBrief: { visualStyle: "watercolor", setting: "a garden" },
        voiceScene: scene, cachedScene: "Subjects: 1\nPets: none\nPositions: centered",
        voiceEventSettings: { multiSubjectMode: "reject", brandReferenceFiles: [] },
        outputProfile: { orientation: "portrait" },
    };
    const paths = jobPaths(job, { staged: true });
    await fs.mkdir(path.dirname(paths.inputPath), { recursive: true });
    const image = sharp({ create: {
        width: 32, height: 32, channels: 3, background: "#cccccc",
    } });
    await fs.writeFile(paths.inputPath, await image.jpeg().toBuffer());
    await fs.writeFile(paths.outputPath, await sharp(paths.inputPath).png().toBuffer());
    await fs.writeFile(paths.mmsPath, await fs.readFile(paths.inputPath));

    await generateImage(job);
    assert.match(job.generationPrompt, /Requested visual style: watercolor/);
    assert.doesNotMatch(job.generationPrompt, /Pixar-style|Cartoon/);
});
