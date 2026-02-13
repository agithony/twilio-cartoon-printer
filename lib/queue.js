const fs = require("fs");
const path = require("path");
const {
    MAX_RETRIES,
    MAX_CONCURRENT_GENERATION,
    EVENT_NAME,
    ADMIN_PHONES,
    MAX_PRINTS,
    PROMO_RETURNING,
    formatTimestamp,
    DOWNLOAD_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");
const { sendSms } = require("./helpers");
const { generateImage, printJob, jobPaths } = require("./pipeline");
const { STYLES, STYLE_LIST, DEFAULT_STYLE } = require("./styles");

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
    return ADMIN_PHONES.includes(phone);
}

function getUsageCount(phone) {
    return usageCache.get(usageKey(phone, EVENT_NAME)) || 0;
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
        eventName: EVENT_NAME,
        retries: 0,
        createdAt,
        filePrefix: ts,
    };
    const filename = `${ts}.json`;
    fs.writeFileSync(path.join(PENDING_DIR, filename), JSON.stringify(job));
    incrementUsage(userPhone, EVENT_NAME);
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
    if (generatingCount >= MAX_CONCURRENT_GENERATION) return;

    const pending = fs.readdirSync(PENDING_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();

    if (pending.length === 0) return;

    const slots = MAX_CONCURRENT_GENERATION - generatingCount;
    const toProcess = pending.slice(0, slots);

    for (const filename of toProcess) {
        const pendingPath = path.join(PENDING_DIR, filename);
        const generatingPath = path.join(GENERATING_DIR, filename);

        try {
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

        // Success: reset retries and move to ready for printing
        job.retries = 0;
        writeJob(generatingPath, job);
        fs.renameSync(generatingPath, path.join(READY_DIR, filename));
        console.log(`✅ Generation complete: ${filename}`);
    } catch (error) {
        console.error(`❌ Generation failed: ${filename} - ${error.message}`);
        if (error.response)
            console.error("❌ API error details:", error.response.data);

        try {
            if (error.permanent) {
                const job = readJob(generatingPath);
                job.permanent = true;
                decrementUsage(job.userPhone, job.eventName);
                writeJob(generatingPath, job);
                fs.renameSync(generatingPath, path.join(FAILED_DIR, filename));
                console.log(`🚫 Job permanently failed: ${filename}`);
            } else {
                const job = readJob(generatingPath);
                job.retries++;
                if (job.retries >= MAX_RETRIES) {
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
        fs.renameSync(readyPath, printingPath);
        const job = readJob(printingPath);
        console.log(`🖨️  Printing: ${filename}`);

        await printJob(job);

        fs.renameSync(printingPath, path.join(DONE_DIR, filename));
        console.log(`✅ Printed: ${filename}`);

        // Send completion MMS with the generated image
        const jobStyle = job.style && STYLES[job.style] ? job.style : DEFAULT_STYLE;
        const jobStyleName = STYLES[jobStyle].name;
        const otherStyles = STYLE_LIST
            .filter((k) => k !== jobStyle)
            .map((k) => STYLES[k].name)
            .join(", ");

        let suffix = "";
        if (isAdmin(job.userPhone)) {
            suffix = ` Try a different style next time: ${otherStyles}.`;
        } else {
            const remaining = MAX_PRINTS - getUsageCount(job.userPhone);
            if (remaining > 0) {
                suffix = ` You have ${remaining} print${remaining === 1 ? "" : "s"} left -- try a different style next time: ${otherStyles}.`;
            } else {
                suffix = ` That was your last free print -- thanks for visiting!`;
            }
        }

        const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
        await sendSms(
            job.userPhone,
            job.appPhone,
            `✅ Your ${jobStyleName} portrait is ready! Pick it up at the Twilio booth.${suffix}${PROMO_RETURNING}`,
            imageUrl,
        );
    } catch (error) {
        console.error(`❌ Print failed: ${filename} - ${error.message}`);

        try {
            const job = readJob(printingPath);
            job.retries++;
            if (job.retries >= MAX_RETRIES) {
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
