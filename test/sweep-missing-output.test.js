const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Integration test for sweepMissingOutputJobs against the real queue dirs.
// Uses uniquely-named synthetic jobs so it can never collide with real data,
// and sets reprint:true + smsSentAt so the sweep takes no usage/MMS side
// effects (decrementUsage is skipped for reprints; sendPrintCompletionMms
// early-returns when smsSentAt is set).
const { READY_DIR, FAILED_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const { sweepMissingOutputJobs } = require("../lib/queue");

const STAMP = "29991231_235959"; // far-future prefix — cannot match a real job
const ORPHAN = `${STAMP}.json`;
const HEALTHY = `29991231_235958.json`;
const HEALTHY_PREFIX = "29991231_235958";

function makeJob(filePrefix) {
    return {
        filePrefix,
        eventName: "__sweep_test__",
        style: "cartoon",
        userPhone: "+10000000000",
        reprint: true,        // skip decrementUsage
        smsSentAt: 1,         // skip fallback MMS send
        readyAt: 1,
        createdAt: 1,
    };
}

// Ensure the queue dirs exist — they're gitignored runtime dirs and may be
// absent in a fresh checkout (e.g. a worktree or CI), which would otherwise
// make the writes below fail with ENOENT.
fs.mkdirSync(READY_DIR, { recursive: true });
fs.mkdirSync(FAILED_DIR, { recursive: true });

// Track everything we create so cleanup is exhaustive even on failure.
const created = [];
function track(p) { created.push(p); return p; }

after(() => {
    for (const p of created) { try { fs.unlinkSync(p); } catch {} }
    // The orphan gets renamed READY->FAILED; make sure both possible homes are clean.
    for (const dir of [READY_DIR, FAILED_DIR]) {
        try { fs.unlinkSync(path.join(dir, ORPHAN)); } catch {}
        try { fs.unlinkSync(path.join(dir, HEALTHY)); } catch {}
    }
    // Requiring lib/queue pulls in the messaging/Twilio chain, which opens a
    // keep-alive Socket that holds the event loop open after tests finish (a
    // pre-existing trait of every test that imports that chain). Force a clean
    // exit so this file doesn't sit until the runner's timeout. Assertions have
    // already run and reported by the time after() fires.
    setImmediate(() => process.exit(0));
});

test("sweepMissingOutputJobs moves a ready job with no output PNG to FAILED_DIR", async () => {
    fs.writeFileSync(track(path.join(READY_DIR, ORPHAN)), JSON.stringify(makeJob(STAMP)));

    await sweepMissingOutputJobs();

    assert.equal(fs.existsSync(path.join(READY_DIR, ORPHAN)), false, "orphan should leave ready/");
    const failedPath = path.join(FAILED_DIR, ORPHAN);
    assert.equal(fs.existsSync(failedPath), true, "orphan should land in failed/");
    const failed = JSON.parse(fs.readFileSync(failedPath, "utf-8"));
    assert.equal(failed.failReason, "missing_output");
});

test("sweepMissingOutputJobs leaves a ready job WITH its output PNG in place", async () => {
    const job = makeJob(HEALTHY_PREFIX);
    const downloadDir = settings.getDownloadDir(job.eventName);
    fs.mkdirSync(downloadDir, { recursive: true });
    const png = track(path.join(downloadDir, `${HEALTHY_PREFIX}_output.png`));
    fs.writeFileSync(png, "PNGDATA");
    fs.writeFileSync(track(path.join(READY_DIR, HEALTHY)), JSON.stringify(job));

    await sweepMissingOutputJobs();

    assert.equal(fs.existsSync(path.join(READY_DIR, HEALTHY)), true, "healthy job must stay in ready/");
    assert.equal(fs.existsSync(path.join(FAILED_DIR, HEALTHY)), false, "healthy job must NOT be failed");
});
