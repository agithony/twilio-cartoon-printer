const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DONE_DIR, FAILED_DIR, PRINTING_DIR } = require("../lib/config");
const { recoverStaleRelayJobs, sweepPendingTerminalEffects } = require("../lib/queue");

const FILENAMES = ["29991231_235940.json", "29991231_235941.json"];
for (const dir of [DONE_DIR, FAILED_DIR, PRINTING_DIR]) fs.mkdirSync(dir, { recursive: true });

function cleanup() {
    for (const dir of [DONE_DIR, FAILED_DIR, PRINTING_DIR]) {
        for (const filename of FILENAMES) {
            try { fs.unlinkSync(path.join(dir, filename)); } catch {}
        }
    }
}

after(cleanup);

test("stale recovery does not reread settled terminal history", async () => {
    cleanup();
    fs.writeFileSync(path.join(DONE_DIR, FILENAMES[0]), JSON.stringify({ completedAt: 1 }));
    fs.writeFileSync(path.join(FAILED_DIR, FILENAMES[1]), JSON.stringify({ failReason: "printer" }));
    const originalReadFile = fs.promises.readFile;
    let terminalReads = 0;
    fs.promises.readFile = async function patchedReadFile(filePath, ...args) {
        const dir = path.dirname(String(filePath));
        if (dir === DONE_DIR || dir === FAILED_DIR) terminalReads++;
        return originalReadFile.call(this, filePath, ...args);
    };

    try {
        await recoverStaleRelayJobs();
    } finally {
        fs.promises.readFile = originalReadFile;
    }

    assert.equal(terminalReads, 0);
});

test("terminal effect scan reports directory failures for a prompt retry", async () => {
    cleanup();
    const originalReaddir = fs.promises.readdir;
    fs.promises.readdir = async function patchedReaddir(dir, ...args) {
        if (String(dir) === DONE_DIR) throw Object.assign(new Error("temporary Azure Files failure"), { code: "EIO" });
        return originalReaddir.call(this, dir, ...args);
    };

    let complete;
    try {
        complete = await sweepPendingTerminalEffects();
    } finally {
        fs.promises.readdir = originalReaddir;
    }

    assert.equal(complete, false);
});
