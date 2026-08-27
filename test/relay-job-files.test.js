const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    RELAY_TEMP_DIR,
    autoSaveRelayImage,
    cleanupOldRelayFiles,
    copyRelayImage,
    isRelayTempFile,
} = require("../relay-app/job-files");

const testId = `relay-files-${process.pid}-${Date.now()}`;
const source = path.join(RELAY_TEMP_DIR, `${testId}.png`);
const oldCacheFile = path.join(RELAY_TEMP_DIR, `${testId}-old.png`);
const freshCacheFile = path.join(RELAY_TEMP_DIR, `${testId}-fresh.png`);
const destination = path.join(os.tmpdir(), `${testId}-manual.png`);
const outputDirectory = path.join(os.tmpdir(), `${testId}-output`, "nested");

after(() => {
    try { fs.unlinkSync(source); } catch {}
    try { fs.unlinkSync(oldCacheFile); } catch {}
    try { fs.unlinkSync(freshCacheFile); } catch {}
    try { fs.unlinkSync(destination); } catch {}
    fs.rmSync(path.join(os.tmpdir(), `${testId}-output`), { recursive: true, force: true });
});

test("save helper only copies full-resolution files from relay cache", async () => {
    fs.mkdirSync(RELAY_TEMP_DIR, { recursive: true });
    fs.writeFileSync(source, "PNGDATA");
    assert.equal(isRelayTempFile(source), true);
    assert.equal(isRelayTempFile(path.join(os.tmpdir(), "outside.png")), false);
    await copyRelayImage(source, destination);
    assert.equal(fs.readFileSync(destination, "utf8"), "PNGDATA");
    await assert.rejects(() => copyRelayImage(path.join(os.tmpdir(), "outside.png"), destination), /Invalid relay image path/);
});

test("automatic output-folder saves create directories without overwriting portraits", async () => {
    fs.mkdirSync(RELAY_TEMP_DIR, { recursive: true });
    fs.writeFileSync(source, "PNGDATA");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const originalPath = path.join(outputDirectory, path.basename(source));
    fs.writeFileSync(originalPath, "KEEP");

    const secondPath = await autoSaveRelayImage(source, outputDirectory);
    const thirdPath = await autoSaveRelayImage(source, outputDirectory);

    assert.equal(secondPath, path.join(outputDirectory, `${testId} (2).png`));
    assert.equal(thirdPath, path.join(outputDirectory, `${testId} (3).png`));
    assert.equal(fs.readFileSync(originalPath, "utf8"), "KEEP");
    assert.equal(fs.readFileSync(secondPath, "utf8"), "PNGDATA");
    assert.equal(fs.readFileSync(thirdPath, "utf8"), "PNGDATA");
    assert.equal(await autoSaveRelayImage(source, ""), null);
    await assert.rejects(
        () => autoSaveRelayImage(path.join(os.tmpdir(), "outside.png"), outputDirectory),
        /Invalid relay image path/,
    );
});

test("relay cache cleanup removes files older than 24 hours and keeps fresh files", async () => {
    const now = Date.now();
    fs.mkdirSync(RELAY_TEMP_DIR, { recursive: true });
    fs.writeFileSync(oldCacheFile, "OLD");
    fs.writeFileSync(freshCacheFile, "FRESH");
    const oldTime = new Date(now - (24 * 60 * 60 * 1000) - 1000);
    fs.utimesSync(oldCacheFile, oldTime, oldTime);

    await cleanupOldRelayFiles(now);

    assert.equal(fs.existsSync(oldCacheFile), false);
    assert.equal(fs.readFileSync(freshCacheFile, "utf8"), "FRESH");
});
