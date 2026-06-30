const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Unit test for requeueDoneJobForReprint against the real queue dirs. Uses a
// far-future synthetic prefix so it can never collide with real jobs, and
// reprint=true + smsSentAt so the requeue takes no usage/MMS side effects.
const { DONE_DIR, READY_DIR, PRINTING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const { requeueDoneJobForReprint } = require("../lib/queue");

// Queue dirs are gitignored runtime dirs; ensure they exist in fresh checkouts.
for (const d of [DONE_DIR, READY_DIR, PRINTING_DIR]) fs.mkdirSync(d, { recursive: true });

const EVENT = "__reprint_test__";
const PREFIX = "29991231_235957";
const FNAME = `${PREFIX}.json`;

function doneJob() {
    return {
        filePrefix: PREFIX,
        eventName: EVENT,
        style: "cartoon",
        userPhone: "+10000000000",
        smsSentAt: 1,         // suppress any completion SMS
        completedAt: 123,
        printingAt: 100,
    };
}

const created = [];
function track(p) { created.push(p); return p; }

after(() => {
    for (const p of created) { try { fs.unlinkSync(p); } catch {} }
    for (const dir of [DONE_DIR, READY_DIR, PRINTING_DIR]) {
        try { fs.unlinkSync(path.join(dir, FNAME)); } catch {}
    }
    // Remove the synthetic event's download dir + any output image left in it.
    try { fs.rmSync(settings.getDownloadDir(EVENT), { recursive: true, force: true }); } catch {}
    setImmediate(() => process.exit(0));
});

function writeDone(job) {
    fs.writeFileSync(track(path.join(DONE_DIR, FNAME)), JSON.stringify(job));
}
function writeOutputImage() {
    const dir = settings.getDownloadDir(EVENT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(track(path.join(dir, `${PREFIX}_output.png`)), "PNGDATA");
}
function cleanupQueues() {
    for (const dir of [DONE_DIR, READY_DIR, PRINTING_DIR]) {
        try { fs.unlinkSync(path.join(dir, FNAME)); } catch {}
    }
    // Also clear the output image so each test controls image presence itself
    // (it persists in the download dir otherwise and leaks across tests).
    try { fs.unlinkSync(path.join(settings.getDownloadDir(EVENT), `${PREFIX}_output.png`)); } catch {}
}

test("requeue: done job with image moves done → ready with reprint metadata", () => {
    cleanupQueues();
    writeOutputImage();
    writeDone(doneJob());

    const res = requeueDoneJobForReprint(FNAME, {});
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(DONE_DIR, FNAME)), false, "should leave done/");
    const readyPath = path.join(READY_DIR, FNAME);
    assert.equal(fs.existsSync(readyPath), true, "should land in ready/");
    const job = JSON.parse(fs.readFileSync(readyPath, "utf-8"));
    assert.equal(job.reprint, true);
    assert.equal(job.retries, 0);
    assert.equal(job.smsSentAt, 1, "smsSentAt preserved so no dup SMS");
    assert.ok(!("completedAt" in job), "completedAt cleared");
});

test("requeue: 404 when job not in done/", () => {
    cleanupQueues();
    const res = requeueDoneJobForReprint(FNAME, {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
});

test("requeue: 400 when output image is gone", () => {
    cleanupQueues();
    // done job present but NO output png on disk
    writeDone(doneJob());
    const res = requeueDoneJobForReprint(FNAME, {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.match(res.error, /image/i);
    // job should remain in done/ (not moved)
    assert.equal(fs.existsSync(path.join(DONE_DIR, FNAME)), true);
});

test("requeue: 400 when already queued in ready/", () => {
    cleanupQueues();
    writeOutputImage();
    writeDone(doneJob());
    fs.writeFileSync(path.join(READY_DIR, FNAME), JSON.stringify(doneJob()));
    const res = requeueDoneJobForReprint(FNAME, {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.match(res.error, /already queued/i);
});

test("requeue: targetPrinter is recorded when provided", () => {
    cleanupQueues();
    writeOutputImage();
    writeDone(doneJob());
    const res = requeueDoneJobForReprint(FNAME, { targetPrinter: "EPSON_ET_8550_Series" });
    assert.equal(res.ok, true);
    const job = JSON.parse(fs.readFileSync(path.join(READY_DIR, FNAME), "utf-8"));
    assert.equal(job.targetPrinter, "EPSON_ET_8550_Series");
});

test("requeue: rejects invalid filename", () => {
    const res = requeueDoneJobForReprint("../../etc/passwd", {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
});
