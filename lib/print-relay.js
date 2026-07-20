// Print Relay API — allows a remote agent to poll for ready print jobs,
// claim them, download the image, and report completion.
const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR, MAX_RETRIES } = require("./config");
const settings = require("./settings");

const router = express.Router();
router.use(express.json());

// ── Relay Printer Tracking ─────────────────────────────────────────────────
// Records printer names from relay ?printer= query params with timestamps.
// Dashboard merges these with local CUPS printers so cloud deployments can
// see and manage relay printers.
const relayPrinters = new Map(); // name → { lastSeen: timestamp }
const RELAY_PRUNE_AGE = 60_000;  // 60 seconds

function recordRelayPrinter(name) {
    if (!name) return;
    relayPrinters.set(name, { lastSeen: Date.now() });
}

function getRelayPrinters() {
    const now = Date.now();
    const result = [];
    for (const [name, info] of relayPrinters) {
        if (now - info.lastSeen > RELAY_PRUNE_AGE) {
            relayPrinters.delete(name);
        } else {
            result.push({ name, lastSeen: info.lastSeen });
        }
    }
    return result;
}

let _writeCounter = 0;
async function atomicWriteJob(filePath, data) {
    const tmp = filePath + `.tmp.${process.pid}.${_writeCounter++}`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
}

// Mask a phone for the relay UI. Same shape as the maskPhone copies in
// dashboard.js / outreach.js / helpers.js — kept inline here so the
// relay route doesn't need to pull those in. Phones are masked BEFORE
// they leave the server, so a compromised relay still can't see full
// numbers.
function maskPhoneForRelay(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    if (phone.startsWith("api:")) return "Kiosk";
    const tail = phone.slice(-4);
    const ccLen = phone.length > 12 ? 4 : 2;
    return `${phone.slice(0, ccLen)}*****${tail}`;
}

// Auth middleware — require API key in x-relay-key header
function auth(req, res, next) {
    const key = settings.get("printRelayKey");
    if (!key) return res.status(503).json({ error: "Print relay not configured (no printRelayKey set)" });
    if (req.headers["x-relay-key"] !== key) return res.status(401).json({ error: "Invalid relay key" });
    next();
}

router.use(auth);

// GET /jobs — list jobs in ready state (optionally filtered by printer name)
router.get("/jobs", async (req, res) => {
    try {
        const printerFilter = req.query.printer || null;
        // Track relay printer check-in
        recordRelayPrinter(printerFilter);
        // If this printer is disabled, return empty list — relay keeps polling but gets nothing
        const disabled = settings.get("disabledPrinters") || [];
        if (printerFilter && disabled.includes(printerFilter)) {
            return res.json({ jobs: [] });
        }
        const files = (await fsp.readdir(READY_DIR)).filter(f => f.endsWith(".json")).sort();
        const jobs = [];
        for (const f of files) {
            try {
                const job = JSON.parse(await fsp.readFile(path.join(READY_DIR, f), "utf-8"));
                if (job.digitalDeliveryPendingAt) continue;
                // If job has a targetPrinter, only show to that printer (or to unfiltered requests)
                if (printerFilter && job.targetPrinter && job.targetPrinter !== printerFilter) continue;
                if (shouldHideFromPrinter(job, printerFilter, getRelayPrinters())) continue;
                jobs.push({
                    filename: f,
                    filePrefix: job.filePrefix,
                    eventName: job.eventName,
                    style: job.style,
                    readyAt: job.readyAt,
                    // Masked phone + MMS filename so the relay UI can render
                    // a row that matches the dashboard (thumbnail, masked
                    // number, style, printer). userPhone is masked here so
                    // the relay never sees the raw number.
                    userPhone: job.userPhone ? maskPhoneForRelay(job.userPhone) : null,
                    mmsFile: job.filePrefix ? `${job.filePrefix}_output_mms.jpg` : null,
                });
            } catch { /* skip unreadable */ }
        }
        res.json({ jobs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Decide whether a ready job should be hidden from the polling printer because
// it already failed there. The failedPrinters exclusion exists so a *different*
// relay can claim a job the first one jammed on — but on a single-printer booth
// (no other printer checked in), hiding the job from the only printer available
// just strands it in ready/ forever. So we only skip when a live alternative
// printer exists that hasn't itself already failed this job. The last retry
// before MAX_RETRIES opens the job to everyone regardless. Pure function (takes
// the live printer list) so it can be unit tested without the HTTP layer.
function shouldHideFromPrinter(job, printerFilter, relayPrinters) {
    if (!printerFilter) return false; // unfiltered poll sees everything
    const failed = job.failedPrinters || [];
    if (!failed.includes(printerFilter)) return false;
    if ((job.retries || 0) >= MAX_RETRIES - 1) return false; // last try: anyone may take it
    const altPrinterExists = (relayPrinters || []).some(
        (rp) => rp.name !== printerFilter && !failed.includes(rp.name),
    );
    return altPrinterExists;
}

// Reject filenames with path traversal characters
function safeName(name) {
    return name && !name.includes("..") && !name.includes("/") && !name.includes("\\") && name.endsWith(".json");
}

// POST /jobs/:filename/ack — claim a job (move ready → printing)
router.post("/jobs/:filename/ack", async (req, res) => {
    const { filename } = req.params;
    if (!safeName(filename)) return res.status(400).json({ error: "Invalid filename" });
    const readyPath = path.join(READY_DIR, filename);
    const printingPath = path.join(PRINTING_DIR, filename);

    try {
        // Atomic claim: rename FIRST to prevent race conditions.
        // Two agents hitting this endpoint simultaneously would both pass an
        // existsSync check, but only one rename can succeed — the loser gets
        // ENOENT because the source file is already gone.
        await fsp.rename(readyPath, printingPath);
    } catch (err) {
        if (err.code === "ENOENT") {
            return res.status(404).json({ error: "Job not found or already claimed by another agent" });
        }
        return res.status(500).json({ error: err.message });
    }

    try {
        // We own the job now — read, update, and write back to printingPath
        const job = JSON.parse(await fsp.readFile(printingPath, "utf-8"));
        const now = Date.now();
        job.printingAt = now;
        job.stateChangedAt = now;
        job.printerName = req.body.printerName || "relay";
        // Clear any stale heartbeat from a previous claim (e.g. a prior
        // relay died, the job was recovered, and now a new relay is
        // claiming it). An old lastHeartbeatAt would trip the
        // "heartbeats stopped" check in recoverStaleRelayJobs before the
        // new relay has a chance to beat, yanking the job back to ready
        // immediately after claim. Resetting here means the new relay
        // has HEARTBEAT_MS + one cloud poll to post its first beat
        // before the fallback printingAt-age threshold takes over.
        delete job.lastHeartbeatAt;

        // Verify the output image exists
        const downloadDir = path.join(settings.ROOT_DIR, "downloads", job.eventName);
        const imageFile = `${job.filePrefix}_output.png`;
        const imagePath = path.join(downloadDir, imageFile);
        if (!fs.existsSync(imagePath)) {
            // Undo claim — move back to ready so another attempt can try later
            await fsp.rename(printingPath, readyPath).catch(() => {});
            return res.status(400).json({ error: "Image file not found on server — job returned to queue" });
        }

        await atomicWriteJob(printingPath, JSON.stringify(job));

        res.json({
            ok: true,
            job: {
                filename,
                filePrefix: job.filePrefix,
                eventName: job.eventName,
                style: job.style,
                imageFile,
                // Extra display metadata for the relay UI's Recent Jobs list.
                // Phone is masked server-side so the relay never sees the
                // raw number. mmsFile is the already-resized jpg (a few
                // hundred KB) that the relay can fetch to show a thumbnail
                // — much cheaper than the print-resolution PNG.
                userPhone: job.userPhone ? maskPhoneForRelay(job.userPhone) : null,
                mmsFile: job.filePrefix ? `${job.filePrefix}_output_mms.jpg` : null,
            },
        });
        console.log(`🖨️  Relay claimed job: ${filename}`);
    } catch (err) {
        // Something went wrong after claiming — try to return job to ready queue
        await fsp.rename(printingPath, readyPath).catch(() => {});
        res.status(500).json({ error: err.message });
    }
});

// GET /image/:event/:file — serve the print-resolution PNG
router.get("/image/:event/:file", (req, res) => {
    const { event, file } = req.params;
    if (event.includes("..") || file.includes("..")) return res.sendStatus(400);
    const filePath = path.join(settings.ROOT_DIR, "downloads", event, file);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    res.sendFile(filePath);
});

// GET /image-mms/:event/:file — serve the MMS-sized JPG (thumbnail use).
// Mirrors /image, but intended for relay UI thumbnails where we don't want
// to ship multi-MB PNGs just to paint a 60px square. Same auth (router-level
// x-relay-key middleware); same path traversal guards. Only allows the jpg
// suffix so the endpoint can't be used to probe for arbitrary files.
router.get("/image-mms/:event/:file", (req, res) => {
    const { event, file } = req.params;
    if (event.includes("..") || file.includes("..")) return res.sendStatus(400);
    if (!file.endsWith("_output_mms.jpg")) return res.sendStatus(400);
    const filePath = path.join(settings.ROOT_DIR, "downloads", event, file);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    res.sendFile(filePath);
});

// POST /jobs/:filename/heartbeat — relay is still alive and working this job
// Called periodically (~every 20s) by the relay while it holds a claim. Lets
// recoverStaleRelayJobs distinguish "relay is actively working" (recent
// heartbeat) from "relay went dark" (no heartbeat for >60s) and recover the
// job fast instead of waiting the 15-minute stale-relay threshold.
//
// Relays that never call this endpoint (older versions) are still supported —
// recoverStaleRelayJobs falls back to the printingAt-age threshold for them.
router.post("/jobs/:filename/heartbeat", async (req, res) => {
    const { filename } = req.params;
    if (!safeName(filename)) return res.status(400).json({ error: "Invalid filename" });
    const printingPath = path.join(PRINTING_DIR, filename);
    try {
        if (!fs.existsSync(printingPath)) {
            // Job already completed/failed/recovered — tell relay to stop beating.
            return res.status(404).json({ error: "Job not in printing queue" });
        }
        const job = JSON.parse(await fsp.readFile(printingPath, "utf-8"));
        job.lastHeartbeatAt = Date.now();
        await atomicWriteJob(printingPath, JSON.stringify(job));
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /jobs/:filename/complete — report print result (move printing → done or back to ready)
router.post("/jobs/:filename/complete", async (req, res) => {
    const { filename } = req.params;
    if (!safeName(filename)) return res.status(400).json({ error: "Invalid filename" });
    const { success, error: errorMsg } = req.body;
    const printingPath = path.join(PRINTING_DIR, filename);

    try {
        if (!fs.existsSync(printingPath)) {
            // Job may have been recovered by stale detection or already completed
            const donePath = path.join(DONE_DIR, filename);
            const readyPath = path.join(READY_DIR, filename);
            if (fs.existsSync(donePath)) {
                return res.json({ ok: true, state: "already_done" });
            }
            if (fs.existsSync(readyPath)) {
                if (success) {
                    // Relay succeeded but stale recovery already moved job back.
                    // The print DID happen, so finalize it and send MMS.
                    const job = JSON.parse(await fsp.readFile(readyPath, "utf-8"));
                    job.completedAt = Date.now();
                    job.stateChangedAt = job.completedAt;
                    await atomicWriteJob(readyPath, JSON.stringify(job));
                    await fsp.rename(readyPath, path.join(DONE_DIR, filename));
                    console.log(`✅ Relay late-complete (was recovered): ${filename}`);
                    try {
                        const { sendPrintCompletionMms } = require("./queue");
                        await sendPrintCompletionMms(job, filename);
                    } catch (mmsErr) {
                        console.error(`❌ Relay MMS delivery failed (late-complete): ${filename} - ${mmsErr.message}`);
                    }
                    return res.json({ ok: true, state: "late_complete" });
                }
                return res.json({ ok: true, state: "recovered" });
            }
            return res.status(404).json({ error: "Job not found in printing queue" });
        }
        const job = JSON.parse(await fsp.readFile(printingPath, "utf-8"));

        if (success) {
            job.completedAt = Date.now();
            job.stateChangedAt = job.completedAt;
            await atomicWriteJob(printingPath, JSON.stringify(job));
            await fsp.rename(printingPath, path.join(DONE_DIR, filename));
            console.log(`✅ Relay print complete: ${filename}`);

            // Trigger MMS delivery (reuse the same logic as local print)
            try {
                const { sendPrintCompletionMms } = require("./queue");
                await sendPrintCompletionMms(job, filename);
            } catch (mmsErr) {
                console.error(`❌ Relay MMS delivery failed: ${filename} - ${mmsErr.message}`);
            }

            res.json({ ok: true, state: "done" });
        } else {
            job.retries = (job.retries || 0) + 1;
            job.stateChangedAt = Date.now();
            job.failedPrinters = [...(job.failedPrinters || []), job.printerName || "relay"];
            if (job.retries >= MAX_RETRIES) {
                job.failReason = "printer";
                const { decrementUsage, sendPrintCompletionMms: sendMmsFallback } = require("./queue");
                if (!job.reprint) decrementUsage(job.userPhone, job.eventName);
                // Send MMS as fallback — user should still get their digital portrait
                try { await sendMmsFallback(job, filename, null); } catch (e) {
                    console.error(`❌ Fallback MMS failed for ${filename}: ${e.message}`);
                }
                await atomicWriteJob(printingPath, JSON.stringify(job));
                await fsp.rename(printingPath, path.join(FAILED_DIR, filename));
                console.log(`💀 Relay print exceeded max retries (MMS sent as fallback): ${filename}`);
                res.json({ ok: true, state: "failed" });
            } else {
                delete job.targetPrinter; // Let a different printer pick it up
                await atomicWriteJob(printingPath, JSON.stringify(job));
                await fsp.rename(printingPath, path.join(READY_DIR, filename));
                console.log(`🔄 Relay print re-queued (retry ${job.retries}): ${filename} - ${errorMsg || "unknown error"}`);
                res.json({ ok: true, state: "requeued" });
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /jobs/:filename/reprint — re-queue a completed job so the relay prints
// it again on its next poll. Lets the relay operator reprint any job in their
// Recent Jobs list without touching the dashboard. Uses the SAME re-queue
// helper as the dashboard's /api/reprint-job so behaviour can't drift: the job
// must be in done/, not already queued, and its output image must still exist.
// reprint=true keeps it out of quota and (with smsSentAt) suppresses a dup SMS.
router.post("/jobs/:filename/reprint", (req, res) => {
    const { filename } = req.params;
    if (!safeName(filename)) return res.status(400).json({ error: "Invalid filename" });
    // Lazy require avoids a load-time circular dep (queue.js requires this file
    // indirectly via the complete() MMS path).
    const { requeueDoneJobForReprint } = require("./queue");
    const result = requeueDoneJobForReprint(filename, { targetPrinter: req.body.printerName || null });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    console.log(`🔄 Relay requested reprint: ${filename}`);
    res.json({ ok: true });
});

// GET /status — simple health check for relay connectivity
router.get("/status", (req, res) => {
    res.json({
        ok: true,
        enablePrinting: settings.get("enablePrinting"),
        printSize: settings.get("printSize"),
        printQuality: settings.get("printQuality"),
    });
});

function mountPrintRelay(app) {
    app.use("/api/print-relay", router);
    console.log("🖨️  Print relay API mounted at /api/print-relay");
}

module.exports = { mountPrintRelay, getRelayPrinters, shouldHideFromPrinter };
