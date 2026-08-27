const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { resolveReanalysisOutputProfile } = require("../lib/queue");

const EVENT = "__landscape_reanalyze_test__";
const eventDir = settings.getDownloadDir(EVENT);

after(() => {
    fs.rmSync(eventDir, { recursive: true, force: true });
    // Queue imports leave a keep-alive handle open after assertions complete.
    setImmediate(() => process.exit(0));
});

test("reanalyzed variants preserve the original landscape output profile", async () => {
    const originalProfile = {
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
    };
    const profile = await resolveReanalysisOutputProfile([{
        job: {
            eventName: EVENT,
            filePrefix: "29991231_235953-v1",
            outputProfile: originalProfile,
        },
    }]);

    assert.deepEqual(profile, originalProfile);
    assert.notEqual(profile, originalProfile, "profile should be cloned");
});

test("legacy reanalysis infers its profile from the staged output", async () => {
    const filePrefix = "29991231_235952-v1";
    const stagingDir = path.join(eventDir, ".staging");
    fs.mkdirSync(stagingDir, { recursive: true });
    await sharp({
        create: { width: 1500, height: 2100, channels: 3, background: "#336699" },
    }).png().toFile(path.join(stagingDir, `${filePrefix}_output.png`));

    const profile = await resolveReanalysisOutputProfile([{
        job: { eventName: EVENT, filePrefix },
    }]);

    assert.equal(profile.printSize, "5x7");
    assert.equal(profile.orientation, "portrait");
    assert.equal(profile.width, 1500);
    assert.equal(profile.height, 2100);
});
