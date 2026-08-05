const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RELAY_TEMP_DIR, copyRelayImage, isRelayTempFile } = require("../relay-app/job-files");

const source = path.join(RELAY_TEMP_DIR, `save-test-${process.pid}.png`);
const destination = path.join(os.tmpdir(), `saved-portrait-${process.pid}.png`);

after(() => {
    try { fs.unlinkSync(source); } catch {}
    try { fs.unlinkSync(destination); } catch {}
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
