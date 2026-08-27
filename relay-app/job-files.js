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

async function autoSaveRelayImage(sourcePath, outputDirectory) {
    if (!outputDirectory) return null;
    if (!isRelayTempFile(sourcePath)) throw new Error("Invalid relay image path");
    const directory = path.resolve(outputDirectory);
    await fs.promises.mkdir(directory, { recursive: true });
    const parsed = path.parse(sourcePath);
    for (let copyNumber = 1; ; copyNumber++) {
        const suffix = copyNumber === 1 ? "" : ` (${copyNumber})`;
        const destinationPath = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
        try {
            await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
            return destinationPath;
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
        }
    }
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

module.exports = { RELAY_TEMP_DIR, cleanupOldRelayFiles, copyRelayImage, autoSaveRelayImage, isRelayTempFile };
