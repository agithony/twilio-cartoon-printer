const fs = require("fs");
const path = require("path");
const {
    MAX_RETRIES,
    formatTimestamp,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");
const settings = require("./settings");
const { sendSms } = require("./helpers");
const { generateImage, printJob, jobPaths } = require("./pipeline");
const { STYLES, STYLE_LIST, DEFAULT_STYLE } = require("./styles");
const leads = require("./leads");

// ── Usage Tracking (in-memory cache) ─────────────────────────────────────────

const usageCache = new Map();

function usageKey(phone, event) {
    return `${phone}:${event}`;
}

function buildUsageCache() {
    usageCache.clear();
    for (const dir of [DONE_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR]) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
            try {
                const job = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
                if (job.userPhone && job.eventName) {
                    const key = usageKey(job.userPhone, job.eventName);
                    usageCache.set(key, (usageCache.get(key) || 0) + 1);
                }
            } catch {
                // Skip malformed files
            }
        }
    }
    console.log(`📊 Usage cache built: ${usageCache.size} entries`);
}

function incrementUsage(phone, event) {
    const key = usageKey(phone, event);
    usageCache.set(key, (usageCache.get(key) || 0) + 1);
}

function decrementUsage(phone, event) {
    const key = usageKey(phone, event);
    const current = usageCache.get(key) || 0;
    if (current > 0) usageCache.set(key, current - 1);
}

function isAdmin(phone) {
    return settings.get("adminPhones").includes(phone);
}

function getUsageCount(phone) {
    return usageCache.get(usageKey(phone, settings.get("eventName"))) || 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasOutputFile(job) {
    const { outputPath } = jobPaths(job);
    return fs.existsSync(outputPath);
}

function readJob(filepath) {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function writeJob(filepath, job) {
    fs.writeFileSync(filepath, JSON.stringify(job));
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

function enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl) {
    const createdAt = Date.now();
    const ts = formatTimestamp(createdAt);
    const job = {
        imageUrl,
        messageSid,
        userPhone,
        appPhone,
        style,
        baseUrl: baseUrl || "",
        eventName: settings.get("eventName"),
        retries: 0,
        createdAt,
        filePrefix: ts,
        pendingAt: createdAt,
        stateChangedAt: createdAt,
    };
    const filename = `${ts}.json`;
    fs.writeFileSync(path.join(PENDING_DIR, filename), JSON.stringify(job));
    incrementUsage(userPhone, settings.get("eventName"));
    console.log(`📥 Job queued: ${filename}`);
}

// ── Crash Recovery ───────────────────────────────────────────────────────────

function recoverStaleJobs() {
    // Recover jobs that were mid-generation when the server stopped
    recoverDirectory(GENERATING_DIR, "generating");

    // Legacy: recover jobs from old processing/ directory
    if (fs.existsSync(PROCESSING_DIR)) {
        recoverDirectory(PROCESSING_DIR, "processing (legacy)");
    }

    // Recover jobs that were mid-print when the server stopped
    // These always go to ready/ since the image already exists
    if (fs.existsSync(PRINTING_DIR)) {
        const stale = fs.readdirSync(PRINTING_DIR).filter((f) => f.endsWith(".json"));
        for (const filename of stale) {
            const src = path.join(PRINTING_DIR, filename);
            const job = readJob(src);
            job.retries++;
            if (job.retries >= MAX_RETRIES) {
                job.failReason = job.failReason || "max_retries";
                writeJob(src, job);
                fs.renameSync(src, path.join(FAILED_DIR, filename));
                console.log(`💀 Stale print job exceeded retries, moved to failed: ${filename}`);
            } else {
                writeJob(src, job);
                fs.renameSync(src, path.join(READY_DIR, filename));
                console.log(`♻️  Recovered stale print job (retry ${job.retries}): ${filename}`);
            }
        }
    }

    // Recover non-permanent failed jobs
    const failed = fs.readdirSync(FAILED_DIR).filter((f) => f.endsWith(".json"));
    for (const filename of failed) {
        const src = path.join(FAILED_DIR, filename);
        const job = readJob(src);
        if (job.permanent) continue;
        job.retries = 0;

        if (hasOutputFile(job)) {
            // Image already generated, just needs printing
            writeJob(src, job);
            fs.renameSync(src, path.join(READY_DIR, filename));
            incrementUsage(job.userPhone, job.eventName);
            console.log(`♻️  Recovered failed job to print queue: ${filename}`);
        } else {
            writeJob(src, job);
            fs.renameSync(src, path.join(PENDING_DIR, filename));
            incrementUsage(job.userPhone, job.eventName);
            console.log(`♻️  Recovered failed job for retry: ${filename}`);
        }
    }
}

function recoverDirectory(dir, label) {
    if (!fs.existsSync(dir)) return;
    const stale = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const filename of stale) {
        const src = path.join(dir, filename);
        const job = readJob(src);
        job.retries++;

        if (job.retries >= MAX_RETRIES) {
            job.failReason = job.failReason || "max_retries";
            writeJob(src, job);
            fs.renameSync(src, path.join(FAILED_DIR, filename));
            console.log(`💀 Stale ${label} job exceeded retries, moved to failed: ${filename}`);
        } else if (hasOutputFile(job)) {
            // Image already generated, send straight to print queue
            job.retries = 0;
            writeJob(src, job);
            fs.renameSync(src, path.join(READY_DIR, filename));
            console.log(`♻️  Recovered ${label} job to print queue (image exists): ${filename}`);
        } else {
            writeJob(src, job);
            fs.renameSync(src, path.join(PENDING_DIR, filename));
            console.log(`♻️  Recovered stale ${label} job (retry ${job.retries}): ${filename}`);
        }
    }
}

// ── Generation Worker (concurrent) ──────────────────────────────────────────

let generatingCount = 0;

async function processGenerationQueue() {
    if (generatingCount >= settings.get("maxConcurrentGeneration")) return;

    const pending = fs.readdirSync(PENDING_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();

    if (pending.length === 0) return;

    const slots = settings.get("maxConcurrentGeneration") - generatingCount;
    const toProcess = pending.slice(0, slots);

    for (const filename of toProcess) {
        const pendingPath = path.join(PENDING_DIR, filename);
        const generatingPath = path.join(GENERATING_DIR, filename);

        try {
            // Stamp generating timestamp before moving
            const job = readJob(pendingPath);
            const now = Date.now();
            job.generatingAt = now;
            job.stateChangedAt = now;
            writeJob(pendingPath, job);
            fs.renameSync(pendingPath, generatingPath);
        } catch {
            continue; // Another poll cycle already claimed this job
        }

        generatingCount++;
        processGeneration(filename, generatingPath).finally(() => {
            generatingCount--;
        });
    }
}

async function processGeneration(filename, generatingPath) {
    try {
        const job = readJob(generatingPath);
        console.log(`⚙️  Generating: ${filename} (attempt ${job.retries + 1})`);

        await generateImage(job);

        // Success: reset retries
        job.retries = 0;
        const genDoneAt = Date.now();
        job.stateChangedAt = genDoneAt;
        writeJob(generatingPath, job);

        if (settings.get("enablePrinting")) {
            // Printing enabled: move to ready queue for print worker
            job.readyAt = genDoneAt;
            writeJob(generatingPath, job);
            fs.renameSync(generatingPath, path.join(READY_DIR, filename));
            console.log(`✅ Generation complete: ${filename}`);
        } else {
            // Digital only: send MMS and move straight to done
            job.completedAt = genDoneAt;
            writeJob(generatingPath, job);
            fs.renameSync(generatingPath, path.join(DONE_DIR, filename));
            console.log(`✅ Generation complete (digital delivery): ${filename}`);

            const activeStyles = settings.getActiveStyles();
            const activeStyleList = settings.getActiveStyleList();
            const configuredDefault = settings.get("defaultStyle") || DEFAULT_STYLE;
            const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
            const jobStyleName = activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle;
            const otherStyles = activeStyleList
                .filter((k) => k !== jobStyle)
                .map((k) => activeStyles[k].name)
                .join(", ");

            let suffix = "";
            if (isAdmin(job.userPhone)) {
                suffix = ` Try a different style next time: ${otherStyles}.`;
            } else {
                const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
                if (remaining > 0) {
                    suffix = ` You have ${remaining} portrait${remaining === 1 ? "" : "s"} left -- try a different style next time: ${otherStyles}.`;
                } else {
                    suffix = ` That was your last free portrait -- thanks for visiting!`;
                }
            }

            const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
            const mmsBody = `✅ Your ${jobStyleName} portrait is ready!${suffix}${settings.getPromoReturning()}`;
            const leadMode = settings.get("leadCaptureMode");

            if (leadMode === "after" && !isAdmin(job.userPhone)
                && !leads.isCompleted(job.userPhone, job.eventName)
                && !leads.isActive(job.userPhone)) {
                await leads.startSurvey(job.userPhone, job.appPhone, job.eventName, "after", {
                    body: mmsBody,
                    mediaUrl: imageUrl,
                });
            } else {
                try {
                    await sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl);
                } catch (smsErr) {
                    console.error(`❌ MMS delivery failed: ${filename} - ${smsErr.message}`);
                }
            }
        }
    } catch (error) {
        console.error(`❌ Generation failed: ${filename} - ${error.message}`);
        if (error.response)
            console.error("❌ API error details:", error.response.data);

        try {
            const now = Date.now();
            if (error.permanent) {
                const job = readJob(generatingPath);
                job.permanent = true;
                job.failReason = error.failReason || "content_rejected";
                job.stateChangedAt = now;
                decrementUsage(job.userPhone, job.eventName);
                writeJob(generatingPath, job);
                fs.renameSync(generatingPath, path.join(FAILED_DIR, filename));
                console.log(`🚫 Job permanently failed: ${filename}`);
            } else {
                const job = readJob(generatingPath);
                job.retries++;
                job.stateChangedAt = now;
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = "generation";
                    decrementUsage(job.userPhone, job.eventName);
                    writeJob(generatingPath, job);
                    fs.renameSync(generatingPath, path.join(FAILED_DIR, filename));
                    console.log(`💀 Generation exceeded max retries, moved to failed: ${filename}`);
                } else {
                    writeJob(generatingPath, job);
                    fs.renameSync(generatingPath, path.join(PENDING_DIR, filename));
                    console.log(`🔄 Generation re-queued (retry ${job.retries}): ${filename}`);
                }
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    }
}

// ── Print Worker (serial) ───────────────────────────────────────────────────

let printing = false;

async function processPrintQueue() {
    if (printing) return;

    const ready = fs.readdirSync(READY_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();

    if (ready.length === 0) return;

    printing = true;
    const filename = ready[0];
    const readyPath = path.join(READY_DIR, filename);
    const printingPath = path.join(PRINTING_DIR, filename);

    try {
        // Stamp printing timestamp before moving
        const preJob = readJob(readyPath);
        const printStartAt = Date.now();
        preJob.printingAt = printStartAt;
        preJob.stateChangedAt = printStartAt;
        writeJob(readyPath, preJob);
        fs.renameSync(readyPath, printingPath);
        const job = readJob(printingPath);
        console.log(`🖨️  Printing: ${filename}`);

        await printJob(job);

        job.completedAt = Date.now();
        job.stateChangedAt = job.completedAt;
        writeJob(printingPath, job);
        fs.renameSync(printingPath, path.join(DONE_DIR, filename));
        console.log(`✅ Printed: ${filename}`);

        // Send completion MMS with the generated image
        const activeStyles = settings.getActiveStyles();
        const activeStyleList = settings.getActiveStyleList();
        const configuredDefault = settings.get("defaultStyle") || DEFAULT_STYLE;
        const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
        const jobStyleName = activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle;
        const otherStyles = activeStyleList
            .filter((k) => k !== jobStyle)
            .map((k) => activeStyles[k].name)
            .join(", ");

        let suffix = "";
        if (isAdmin(job.userPhone)) {
            suffix = ` Try a different style next time: ${otherStyles}.`;
        } else {
            const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
            if (remaining > 0) {
                suffix = ` You have ${remaining} print${remaining === 1 ? "" : "s"} left -- try a different style next time: ${otherStyles}.`;
            } else {
                suffix = ` That was your last free print -- thanks for visiting!`;
            }
        }

        const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
        const mmsBody = `✅ Your ${jobStyleName} portrait is ready! Pick it up at the Twilio booth.${suffix}${settings.getPromoReturning()}`;
        const leadMode = settings.get("leadCaptureMode");

        if (leadMode === "after" && !isAdmin(job.userPhone)
            && !leads.isCompleted(job.userPhone, job.eventName)
            && !leads.isActive(job.userPhone)) {
            await leads.startSurvey(job.userPhone, job.appPhone, job.eventName, "after", {
                body: mmsBody,
                mediaUrl: imageUrl,
            });
        } else {
            await sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl);
        }
    } catch (error) {
        console.error(`❌ Print failed: ${filename} - ${error.message}`);

        try {
            const job = readJob(printingPath);
            job.retries++;
            job.stateChangedAt = Date.now();
            if (job.retries >= MAX_RETRIES) {
                job.failReason = "printer";
                decrementUsage(job.userPhone, job.eventName);
                writeJob(printingPath, job);
                fs.renameSync(printingPath, path.join(FAILED_DIR, filename));
                console.log(`💀 Print exceeded max retries, moved to failed: ${filename}`);
            } else {
                writeJob(printingPath, job);
                fs.renameSync(printingPath, path.join(READY_DIR, filename));
                console.log(`🔄 Print re-queued (retry ${job.retries}): ${filename}`);
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    } finally {
        printing = false;
    }
}

module.exports = {
    buildUsageCache,
    isAdmin,
    getUsageCount,
    enqueueJob,
    recoverStaleJobs,
    processGenerationQueue,
    processPrintQueue,
};
