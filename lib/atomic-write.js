const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const RETRY_DELAYS_MS = [50, 150, 350];
const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function tempPathFor(filePath, tempDir) {
    return path.join(tempDir, `${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomUUID()}`);
}

async function renameWithRetry(src, dst) {
    for (let attempt = 0; ; attempt++) {
        try {
            await fsp.rename(src, dst);
            return;
        } catch (err) {
            if (!RETRYABLE_CODES.has(err.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
    }
}

function renameWithRetrySync(src, dst) {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(src, dst);
            return;
        } catch (err) {
            if (!RETRYABLE_CODES.has(err.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAYS_MS[attempt]);
        }
    }
}

async function atomicWriteFile(filePath, data, { tempDir = path.dirname(filePath) } = {}) {
    await fsp.mkdir(tempDir, { recursive: true });
    const tmp = tempPathFor(filePath, tempDir);
    try {
        await fsp.writeFile(tmp, data);
        await renameWithRetry(tmp, filePath);
    } finally {
        await fsp.unlink(tmp).catch(() => {});
    }
}

function atomicWriteFileSync(filePath, data, { tempDir = path.dirname(filePath) } = {}) {
    fs.mkdirSync(tempDir, { recursive: true });
    const tmp = tempPathFor(filePath, tempDir);
    try {
        fs.writeFileSync(tmp, data);
        renameWithRetrySync(tmp, filePath);
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

async function cleanupTempDirectory(tempDir, maxAgeMs = 60 * 60 * 1000) {
    let entries;
    try {
        entries = await fsp.readdir(tempDir, { withFileTypes: true });
    } catch (err) {
        if (err.code === "ENOENT") return 0;
        throw err;
    }

    const cutoff = Date.now() - maxAgeMs;
    let deleted = 0;
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.includes(".tmp.")) continue;
        const filePath = path.join(tempDir, entry.name);
        try {
            const stat = await fsp.stat(filePath);
            if (stat.mtimeMs >= cutoff) continue;
            await fsp.unlink(filePath);
            deleted++;
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
    }
    return deleted;
}

module.exports = { atomicWriteFile, atomicWriteFileSync, cleanupTempDirectory };
