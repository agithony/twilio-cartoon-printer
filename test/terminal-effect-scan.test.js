const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DONE_DIR, FAILED_DIR, PRINTING_DIR, READY_DIR } = require("../lib/config");
const {
    buildUsageCache,
    getUsageCount,
    recoverStaleRelayJobs,
    sweepPendingRelayEffects,
    sweepPendingTerminalEffects,
} = require("../lib/queue");

const FILENAMES = [
    "29991231_235940.json",
    "29991231_235941.json",
    "29991231_235942.json",
    "29991231_235943.json",
    "29991231_235944.json",
    "29991231_235945.json",
    "29991231_235939.json",
];
for (const dir of [DONE_DIR, FAILED_DIR, PRINTING_DIR, READY_DIR]) fs.mkdirSync(dir, { recursive: true });

function cleanup() {
    for (const dir of [DONE_DIR, FAILED_DIR, PRINTING_DIR, READY_DIR]) {
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

test("relay transition scan finalizes completed records from printing and ready", async () => {
    cleanup();
    const completed = { completedAt: 123, smsSentAt: 100, deliveryPending: false };
    fs.writeFileSync(path.join(PRINTING_DIR, FILENAMES[2]), JSON.stringify(completed));
    const userPhone = "+19999999943";
    const eventName = "__completed_transition_usage_test__";
    fs.writeFileSync(path.join(READY_DIR, FILENAMES[3]), JSON.stringify({
        ...completed,
        userPhone,
        eventName,
        claimRevokedAt: 124,
        failureEffectsPending: true,
        usageReleasePending: true,
    }));

    await buildUsageCache();
    assert.equal(getUsageCount(userPhone, eventName), 1, "physical completion still counts toward usage");

    await sweepPendingRelayEffects();

    for (const filename of [FILENAMES[2], FILENAMES[3]]) {
        assert.equal(fs.existsSync(path.join(PRINTING_DIR, filename)), false);
        assert.equal(fs.existsSync(path.join(READY_DIR, filename)), false);
        assert.equal(fs.existsSync(path.join(DONE_DIR, filename)), true);
    }
    const recovered = JSON.parse(fs.readFileSync(path.join(DONE_DIR, FILENAMES[3]), "utf-8"));
    assert.equal(recovered.failureEffectsPending, false);
    assert.equal("usageReleasePending" in recovered, false);
    assert.equal("failReason" in recovered, false);
    assert.equal(getUsageCount(userPhone, eventName), 1);
});

test("digital delivery alone does not finalize an active print job", async () => {
    cleanup();
    const delivered = { smsSentAt: 100, deliveryPending: false };
    fs.writeFileSync(path.join(PRINTING_DIR, FILENAMES[4]), JSON.stringify(delivered));
    fs.writeFileSync(path.join(READY_DIR, FILENAMES[5]), JSON.stringify(delivered));

    await sweepPendingRelayEffects();

    assert.equal(fs.existsSync(path.join(PRINTING_DIR, FILENAMES[4])), true);
    assert.equal(fs.existsSync(path.join(READY_DIR, FILENAMES[5])), true);
    assert.equal(fs.existsSync(path.join(DONE_DIR, FILENAMES[4])), false);
    assert.equal(fs.existsSync(path.join(DONE_DIR, FILENAMES[5])), false);
});

test("terminal scan moves a physically completed failed record to done", async () => {
    cleanup();
    fs.writeFileSync(path.join(FAILED_DIR, FILENAMES[6]), JSON.stringify({
        completedAt: 123,
        smsSentAt: 100,
        failReason: "relay_stale",
        failureEffectsPending: true,
        usageReleasePending: true,
    }));

    const complete = await sweepPendingTerminalEffects();

    assert.equal(complete, true);
    assert.equal(fs.existsSync(path.join(FAILED_DIR, FILENAMES[6])), false);
    assert.equal(fs.existsSync(path.join(DONE_DIR, FILENAMES[6])), true);
    const recovered = JSON.parse(fs.readFileSync(path.join(DONE_DIR, FILENAMES[6]), "utf-8"));
    assert.equal(recovered.failureEffectsPending, false);
    assert.equal("failReason" in recovered, false);
});
