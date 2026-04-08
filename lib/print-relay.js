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

// Auth middleware — require API key in x-relay-key header
function auth(req, res, next) {
    const key = settings.get("printRelayKey");
    if (!key) return res.status(503).json({ error: "Print relay not configured (no printRelayKey set)" });
    if (req.headers["x-relay-key"] !== key) return res.status(401).json({ error: "Invalid relay key" });
    next();
}

router.use(auth);

// GET /jobs — list jobs in ready state
router.get("/jobs", async (req, res) => {
    try {
        const files = (await fsp.readdir(READY_DIR)).filter(f => f.endsWith(".json")).sort();
        const jobs = [];
        for (const f of files) {
            try {
                const job = JSON.parse(await fsp.readFile(path.join(READY_DIR, f), "utf-8"));
                jobs.push({
                    filename: f,
                    filePrefix: job.filePrefix,
                    eventName: job.eventName,
                    style: job.style,
                    readyAt: job.readyAt,
                });
            } catch { /* skip unreadable */ }
        }
        res.json({ jobs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        if (!fs.existsSync(readyPath)) {
            return res.status(404).json({ error: "Job not found in ready queue (may already be claimed)" });
        }
        const job = JSON.parse(await fsp.readFile(readyPath, "utf-8"));
        const now = Date.now();
        job.printingAt = now;
        job.stateChangedAt = now;
        job.printerName = req.body.printerName || "relay";
        // Verify the output image exists before claiming
        const downloadDir = path.join(settings.ROOT_DIR, "downloads", job.eventName);
        const imageFile = `${job.filePrefix}_output.png`;
        const imagePath = path.join(downloadDir, imageFile);
        if (!fs.existsSync(imagePath)) {
            return res.status(400).json({ error: "Image file not found on server — leaving job in ready queue" });
        }

        await fsp.writeFile(readyPath, JSON.stringify(job));
        await fsp.rename(readyPath, printingPath);

        res.json({
            ok: true,
            job: {
                filename,
                filePrefix: job.filePrefix,
                eventName: job.eventName,
                style: job.style,
                imageFile,
            },
        });
        console.log(`🖨️  Relay claimed job: ${filename}`);
    } catch (err) {
        // ENOENT means another agent already claimed this job
        if (err.code === "ENOENT") {
            return res.status(404).json({ error: "Job already claimed by another agent" });
        }
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
                    await fsp.writeFile(readyPath, JSON.stringify(job));
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
            await fsp.writeFile(printingPath, JSON.stringify(job));
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
            if (job.retries >= MAX_RETRIES) {
                job.failReason = "printer";
                const { decrementUsage } = require("./queue");
                decrementUsage(job.userPhone, job.eventName);
                await fsp.writeFile(printingPath, JSON.stringify(job));
                await fsp.rename(printingPath, path.join(FAILED_DIR, filename));
                console.log(`💀 Relay print exceeded max retries: ${filename}`);
                res.json({ ok: true, state: "failed" });
            } else {
                await fsp.writeFile(printingPath, JSON.stringify(job));
                await fsp.rename(printingPath, path.join(READY_DIR, filename));
                console.log(`🔄 Relay print re-queued (retry ${job.retries}): ${filename} - ${errorMsg || "unknown error"}`);
                res.json({ ok: true, state: "requeued" });
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

module.exports = { mountPrintRelay };
