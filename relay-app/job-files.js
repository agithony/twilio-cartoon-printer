const fs = require("fs");
const os = require("os");
const path = require("path");

const RELAY_TEMP_DIR = path.join(os.tmpdir(), "print-relay-temp");
const MAX_CACHE_AGE = 24 * 60 * 60 * 1000;

function isRelayTempFile(filePath) {
    if (!filePath) return false;
    const root = path.resolve(RELAY_TEMP_DIR) + path.sep;
    return path.resolve(filePath).startsWith(root);
}

async function copyRelayImage(sourcePath, destinationPath) {
    if (!isRelayTempFile(sourcePath)) throw new Error("Invalid relay image path");
    await fs.promises.access(sourcePath, fs.constants.R_OK);
    await fs.promises.copyFile(sourcePath, destinationPath);
}

async function cleanupOldRelayFiles(now = Date.now()) {
    await fs.promises.mkdir(RELAY_TEMP_DIR, { recursive: true });
    const names = await fs.promises.readdir(RELAY_TEMP_DIR);
    await Promise.all(names.map(async (name) => {
        const filePath = path.join(RELAY_TEMP_DIR, name);
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile() && now - stat.mtimeMs > MAX_CACHE_AGE) await fs.promises.unlink(filePath);
        } catch { /* another cleanup may have removed it */ }
    }));
}

module.exports = { RELAY_TEMP_DIR, cleanupOldRelayFiles, copyRelayImage, isRelayTempFile };
