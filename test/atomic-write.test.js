const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { atomicWriteFile, atomicWriteFileSync, cleanupTempDirectory } = require("../lib/atomic-write");

async function withTempDir(fn) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-write-"));
    try { await fn(root); } finally { await fsp.rm(root, { recursive: true, force: true }); }
}

test("atomic writes leave no temporary files", async () => {
    await withTempDir(async (root) => {
        const tempDir = path.join(root, ".tmp");
        const asyncTarget = path.join(root, "async.json");
        const syncTarget = path.join(root, "sync.json");

        await atomicWriteFile(asyncTarget, "async", { tempDir });
        atomicWriteFileSync(syncTarget, "sync", { tempDir });

        assert.equal(await fsp.readFile(asyncTarget, "utf8"), "async");
        assert.equal(await fsp.readFile(syncTarget, "utf8"), "sync");
        assert.deepEqual(await fsp.readdir(tempDir), []);
    });
});

test("failed atomic writes clean up their temporary files", async () => {
    await withTempDir(async (root) => {
        const tempDir = path.join(root, ".tmp");
        const invalidTarget = path.join(root, "target-directory");
        await fsp.mkdir(invalidTarget);

        await assert.rejects(atomicWriteFile(invalidTarget, "data", { tempDir }));
        assert.deepEqual(await fsp.readdir(tempDir), []);
    });
});

test("temp cleanup removes only stale temporary files", async () => {
    await withTempDir(async (root) => {
        const stale = path.join(root, "job.json.tmp.old");
        const fresh = path.join(root, "job.json.tmp.fresh");
        const unrelated = path.join(root, "keep.json");
        await Promise.all([fsp.writeFile(stale, ""), fsp.writeFile(fresh, ""), fsp.writeFile(unrelated, "")]);
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await fsp.utimes(stale, old, old);

        assert.equal(await cleanupTempDirectory(root), 1);
        assert.deepEqual((await fsp.readdir(root)).sort(), ["job.json.tmp.fresh", "keep.json"]);
    });
});
