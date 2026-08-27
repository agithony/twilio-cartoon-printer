const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");

// Queue integration tests use far-future synthetic prefixes so they cannot
// collide with real jobs. Delivery tests use noDelivery to avoid external SMS.
const { DONE_DIR, FAILED_DIR, READY_DIR, PRINTING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const {
    buildUsageCache,
    decrementUsage,
    getUsageCount,
    incrementUsage,
    recoverStaleRelayJobs,
    requeueDoneJobForReprint,
    sweepPendingRelayEffects,
} = require("../lib/queue");
const { mountPrintRelay } = require("../lib/print-relay");

// Queue dirs are gitignored runtime dirs; ensure they exist in fresh checkouts.
for (const d of [DONE_DIR, FAILED_DIR, READY_DIR, PRINTING_DIR]) fs.mkdirSync(d, { recursive: true });

const EVENT = "__reprint_test__";
const PREFIX = "29991231_235957";
const FNAME = `${PREFIX}.json`;
const DONE_COMPLETE_FNAME = "29991231_235956.json";
const FAILED_COMPLETE_FNAME = "29991231_235955.json";
const RECOVERED_FNAME = "29991231_235954.json";
const RECOVERED_PREFIX = RECOVERED_FNAME.replace(/\.json$/, "");
const PENDING_EFFECT_FNAME = "29991231_235952.json";
const RELAY_KEY = "reprint-test-key";

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
    for (const dir of [DONE_DIR, FAILED_DIR, READY_DIR, PRINTING_DIR]) {
        for (const filename of [FNAME, DONE_COMPLETE_FNAME, FAILED_COMPLETE_FNAME, RECOVERED_FNAME, PENDING_EFFECT_FNAME]) {
            try { fs.unlinkSync(path.join(dir, filename)); } catch {}
        }
    }
    // Remove the synthetic event's download dir + any output image left in it.
    try { fs.rmSync(settings.getDownloadDir(EVENT), { recursive: true, force: true }); } catch {}
    setImmediate(() => process.exit(0));
});

function writeDone(job) {
    fs.writeFileSync(track(path.join(DONE_DIR, FNAME)), JSON.stringify(job));
}
function writeFailed(job) {
    fs.writeFileSync(track(path.join(FAILED_DIR, FNAME)), JSON.stringify(job));
}
function writeOutputImage() {
    const dir = settings.getDownloadDir(EVENT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(track(path.join(dir, `${PREFIX}_output.png`)), "PNGDATA");
}
function cleanupQueues() {
    for (const dir of [DONE_DIR, FAILED_DIR, READY_DIR, PRINTING_DIR]) {
        for (const filename of [FNAME, DONE_COMPLETE_FNAME, FAILED_COMPLETE_FNAME, RECOVERED_FNAME, PENDING_EFFECT_FNAME]) {
            try { fs.unlinkSync(path.join(dir, filename)); } catch {}
        }
    }
    // Also clear the output image so each test controls image presence itself
    // (it persists in the download dir otherwise and leaks across tests).
    try { fs.unlinkSync(path.join(settings.getDownloadDir(EVENT), `${PREFIX}_output.png`)); } catch {}
}

function postRelay(urlPath, body) {
    const app = express();
    mountPrintRelay(app);
    const originalGet = settings.get;
    settings.get = function patchedGet(key, ...args) {
        if (key === "printRelayKey") return RELAY_KEY;
        return originalGet.call(settings, key, ...args);
    };
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const data = JSON.stringify(body);
            const req = http.request({
                port: server.address().port,
                method: "POST",
                path: `/api/print-relay${urlPath}`,
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(data),
                    "x-relay-key": RELAY_KEY,
                    "x-relay-version": "1.3.1",
                },
            }, (res) => {
                let chunks = "";
                res.on("data", (chunk) => { chunks += chunk; });
                res.on("end", () => {
                    server.close(() => {
                        settings.get = originalGet;
                        resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
                    });
                });
            });
            req.on("error", (err) => {
                server.close(() => {
                    settings.get = originalGet;
                    reject(err);
                });
            });
            req.write(data);
            req.end();
        });
    });
}

test("requeue: done job with image moves done → ready with reprint metadata", () => {
    cleanupQueues();
    writeOutputImage();
    writeDone(doneJob());
    const usageBefore = getUsageCount(doneJob().userPhone, EVENT);

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
    assert.equal(job.countUsageOnRebuild, true);
    assert.ok(!("completedAt" in job), "completedAt cleared");
    assert.equal(getUsageCount(job.userPhone, EVENT), usageBefore, "completed reprints do not consume quota");
});

test("requeue: failed print job with image moves failed → ready", () => {
    cleanupQueues();
    writeOutputImage();
    const failedJob = { ...doneJob(), failReason: "printer", retries: 3 };
    delete failedJob.smsSentAt;
    writeFailed(failedJob);
    const usageBefore = getUsageCount(failedJob.userPhone, EVENT);

    const res = requeueDoneJobForReprint(FNAME, { targetPrinter: "Dai_Nippon_Printing_DS_RX1" });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(path.join(FAILED_DIR, FNAME)), false);
    const job = JSON.parse(fs.readFileSync(path.join(READY_DIR, FNAME), "utf-8"));
    assert.equal(job.targetPrinter, "Dai_Nippon_Printing_DS_RX1");
    assert.equal(job.retries, 0);
    assert.ok(!("failReason" in job));
    assert.ok(!("smsSentAt" in job), "failed originals still deliver after a successful reprint");
    assert.equal(job.countUsageOnRebuild, true);
    assert.equal(getUsageCount(job.userPhone, EVENT), usageBefore + 1, "failed original quota is restored once");
    decrementUsage(job.userPhone, EVENT);
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

test("requeue: stale target and claim metadata are cleared when no printer is requested", () => {
    cleanupQueues();
    writeOutputImage();
    writeDone({ ...doneJob(), targetPrinter: "old-printer", claimId: "active", terminalClaimId: "terminal" });

    const res = requeueDoneJobForReprint(FNAME, {});

    assert.equal(res.ok, true);
    const job = JSON.parse(fs.readFileSync(path.join(READY_DIR, FNAME), "utf-8"));
    assert.ok(!("targetPrinter" in job));
    assert.ok(!("claimId" in job));
    assert.ok(!("terminalClaimId" in job));
});

test("requeue: pending terminal delivery effects block a duplicate print", () => {
    cleanupQueues();
    writeOutputImage();
    writeDone({ ...doneJob(), deliveryPending: true });

    const res = requeueDoneJobForReprint(FNAME, {});

    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.match(res.error, /pending terminal delivery effects/i);
    assert.equal(fs.existsSync(path.join(DONE_DIR, FNAME)), true);
    assert.equal(fs.existsSync(path.join(READY_DIR, FNAME)), false);
});

test("requeue: rejects invalid filename", () => {
    const res = requeueDoneJobForReprint("../../etc/passwd", {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
});

test("relay completion is idempotent in done and preserves quota after delivery", async () => {
    cleanupQueues();
    const eventName = "__relay_done_completion_test__";
    const userPhone = "+10000000001";
    const claimId = "done-claim";
    const usageBefore = getUsageCount(userPhone, eventName);
    incrementUsage(userPhone, eventName);
    fs.writeFileSync(path.join(PRINTING_DIR, DONE_COMPLETE_FNAME), JSON.stringify({
        filePrefix: DONE_COMPLETE_FNAME.replace(/\.json$/, ""),
        eventName,
        userPhone,
        noDelivery: true,
        claimId,
        retries: 0,
        printerName: "EPSON_ET_8550_Series",
    }));

    const first = await postRelay(`/jobs/${DONE_COMPLETE_FNAME}/complete`, { success: true, claimId });
    assert.deepEqual(first, { status: 200, body: { ok: true, state: "done" } });
    const done = JSON.parse(fs.readFileSync(path.join(DONE_DIR, DONE_COMPLETE_FNAME), "utf-8"));
    assert.equal(done.terminalClaimId, claimId);
    assert.ok(!("claimId" in done));
    assert.equal(done.deliveryPending, false);
    assert.ok(done.smsSentAt, "completion delivery is recorded before acknowledging the relay");
    assert.equal(getUsageCount(userPhone, eventName), usageBefore + 1);

    const repeated = await postRelay(`/jobs/${DONE_COMPLETE_FNAME}/complete`, { success: true, claimId });
    assert.deepEqual(repeated, { status: 200, body: { ok: true, state: "already_done" } });
    assert.equal(getUsageCount(userPhone, eventName), usageBefore + 1);
    decrementUsage(userPhone, eventName);
});

test("terminal relay failure releases quota and completes fallback delivery only once", async () => {
    cleanupQueues();
    const eventName = "__relay_failed_completion_test__";
    const userPhone = "+10000000002";
    const claimId = "failed-claim";
    const usageBefore = getUsageCount(userPhone, eventName);
    incrementUsage(userPhone, eventName);
    fs.writeFileSync(path.join(PRINTING_DIR, FAILED_COMPLETE_FNAME), JSON.stringify({
        filePrefix: FAILED_COMPLETE_FNAME.replace(/\.json$/, ""),
        eventName,
        userPhone,
        noDelivery: true,
        claimId,
        retries: 2,
        printerName: "Dai_Nippon_Printing_DS_RX1",
    }));

    const first = await postRelay(`/jobs/${FAILED_COMPLETE_FNAME}/complete`, {
        success: false,
        error: "Printer is offline",
        claimId,
    });
    assert.deepEqual(first, { status: 200, body: { ok: true, state: "failed" } });
    const failed = JSON.parse(fs.readFileSync(path.join(FAILED_DIR, FAILED_COMPLETE_FNAME), "utf-8"));
    assert.equal(failed.failReason, "printer");
    assert.equal(failed.terminalClaimId, claimId);
    assert.equal(failed.failureEffectsPending, false);
    assert.ok(failed.usageDecrementedAt);
    assert.ok(failed.smsSentAt, "fallback delivery is recorded");
    assert.equal(getUsageCount(userPhone, eventName), usageBefore);

    const repeated = await postRelay(`/jobs/${FAILED_COMPLETE_FNAME}/complete`, { success: false, claimId });
    assert.deepEqual(repeated, { status: 200, body: { ok: true, state: "already_failed" } });
    assert.equal(getUsageCount(userPhone, eventName), usageBefore, "retrying completion does not release quota twice");
});

test("stale recovery revokes the old claim before a new relay ACK", async () => {
    cleanupQueues();
    const outputPath = path.join(settings.getDownloadDir(EVENT), `${RECOVERED_PREFIX}_output.png`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(track(outputPath), "PNGDATA");
    fs.writeFileSync(path.join(PRINTING_DIR, RECOVERED_FNAME), JSON.stringify({
        filePrefix: RECOVERED_PREFIX,
        eventName: EVENT,
        userPhone: "+10000000003",
        noDelivery: true,
        claimId: "old-claim",
        printingAt: Date.now() - (16 * 60 * 1000),
        staleRecoveries: 0,
        retries: 0,
        outputProfile: { printSize: "5x7", printQuality: "high", orientation: "portrait" },
    }));

    const originalGet = settings.get;
    settings.get = function patchedGet(key, ...args) {
        if (key === "printRelayKey") return RELAY_KEY;
        return originalGet.call(settings, key, ...args);
    };
    try {
        await recoverStaleRelayJobs();
    } finally {
        settings.get = originalGet;
    }

    const recovered = JSON.parse(fs.readFileSync(path.join(READY_DIR, RECOVERED_FNAME), "utf-8"));
    assert.ok(!("claimId" in recovered));
    assert.ok(recovered.claimRevokedAt);

    const oldBeforeAck = await postRelay(`/jobs/${RECOVERED_FNAME}/complete`, { success: true, claimId: "old-claim" });
    assert.equal(oldBeforeAck.status, 409);

    const ack = await postRelay(`/jobs/${RECOVERED_FNAME}/ack`, { printerName: "EPSON_ET_8550_Series" });
    assert.equal(ack.status, 200);
    assert.notEqual(ack.body.job.claimId, "old-claim");

    const oldAfterAck = await postRelay(`/jobs/${RECOVERED_FNAME}/complete`, { success: true, claimId: "old-claim" });
    assert.equal(oldAfterAck.status, 409);

    const current = await postRelay(`/jobs/${RECOVERED_FNAME}/complete`, {
        success: true,
        claimId: ack.body.job.claimId,
    });
    assert.deepEqual(current, { status: 200, body: { ok: true, state: "done" } });
});

test("pending failed-reprint effects release restored quota across restart", async () => {
    cleanupQueues();
    const eventName = "__failed_reprint_restart_test__";
    const userPhone = "+10000000004";
    incrementUsage(userPhone, eventName);
    assert.equal(getUsageCount(userPhone, eventName), 1);
    fs.writeFileSync(path.join(FAILED_DIR, PENDING_EFFECT_FNAME), JSON.stringify({
        filePrefix: PENDING_EFFECT_FNAME.replace(/\.json$/, ""),
        eventName,
        userPhone,
        noDelivery: true,
        reprint: true,
        reprintRestoredUsage: true,
        countUsageOnRebuild: false,
        failureEffectsPending: true,
        usageReleasePending: true,
        failReason: "printer",
    }));

    // A restarted process rebuilds quota before the effect sweeper runs.
    await buildUsageCache();
    assert.equal(getUsageCount(userPhone, eventName), 0);
    await sweepPendingRelayEffects();

    const failed = JSON.parse(fs.readFileSync(path.join(FAILED_DIR, PENDING_EFFECT_FNAME), "utf-8"));
    assert.equal(failed.failureEffectsPending, false);
    assert.equal(failed.countUsageOnRebuild, false);
    assert.ok(failed.usageDecrementedAt);
    assert.ok(failed.smsSentAt);

    await buildUsageCache();
    assert.equal(getUsageCount(userPhone, eventName), 0);
});
