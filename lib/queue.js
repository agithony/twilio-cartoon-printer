const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const {
    MAX_RETRIES,
    formatTimestamp,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    REVIEW_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");
const settings = require("./settings");
const { sendSms } = require("./helpers");
const { generateImage, printJob, jobPaths } = require("./pipeline");
const { getActivePrinters } = require("./printer");
const { DEFAULT_STYLE } = require("./styles");
const leads = require("./leads");
const nps = require("./nps");

// ── Share Links ─────────────────────────────────────────────────────────────

function buildShareLinks(imageUrl, eventName) {
    if (!settings.get("enableShareLinks") || !imageUrl) return "";
    const lines = [];
    if (settings.get("enableTwitterShare") !== false) {
        const handle = settings.get("twitterHandle") || "@twilio";
        const template = settings.get("linkedInShareText") || "Check out my AI portrait from {eventName}, powered by Twilio!";
        const shareText = template.replace(/\{eventName\}/g, eventName);
        const tweetText = encodeURIComponent(shareText + (handle ? ` ${handle}` : ""));
        lines.push(`X/Twitter: https://twitter.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(imageUrl)}`);
    }
    if (settings.get("enableLinkedInShare") !== false) {
        lines.push(`LinkedIn: https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(imageUrl)}`);
    }
    if (lines.length === 0) return "";
    return `\n\nShare it!\n${lines.join("\n")}`;
}

// ── Usage Tracking (in-memory cache) ─────────────────────────────────────────

const usageCache = new Map();

function usageKey(phone, event) {
    return `${phone}:${event}`;
}

function buildUsageCache() {
    usageCache.clear();
    for (const dir of [DONE_DIR, PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR]) {
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

// Testing mode: admins experience the full regular-user flow with unlimited quota
function isTestingMode(eventName) {
    return (eventName || "").toLowerCase() === "testing";
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

async function readJobAsync(filepath) {
    return JSON.parse(await fsp.readFile(filepath, "utf-8"));
}

async function writeJobAsync(filepath, job) {
    await fsp.writeFile(filepath, JSON.stringify(job));
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

// Deduplication: track recent messageSids to prevent Twilio webhook retries
// from creating duplicate jobs (Twilio retries if response takes >15s)
const recentSids = new Map();
const SID_TTL = 120_000; // 2 minutes

function isDuplicate(messageSid) {
    if (!messageSid) return false;
    // Clean old entries
    const now = Date.now();
    for (const [sid, ts] of recentSids) {
        if (now - ts > SID_TTL) recentSids.delete(sid);
    }
    if (recentSids.has(messageSid)) return true;
    recentSids.set(messageSid, now);
    return false;
}

function enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background) {
    if (isDuplicate(messageSid)) {
        console.log(`⚠️  Duplicate webhook detected (${messageSid}), skipping enqueue`);
        return;
    }
    const createdAt = Date.now();
    const ts = formatTimestamp(createdAt);
    const job = {
        imageUrl,
        messageSid,
        userPhone,
        appPhone,
        style,
        baseUrl: baseUrl || "",
        background: background || null,
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
            try {
                const job = readJob(src);
                job.retries++;
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = job.failReason || "max_retries";
                    decrementUsage(job.userPhone, job.eventName);
                    writeJob(src, job);
                    fs.renameSync(src, path.join(FAILED_DIR, filename));
                    console.log(`💀 Stale print job exceeded retries, moved to failed: ${filename}`);
                } else {
                    writeJob(src, job);
                    fs.renameSync(src, path.join(READY_DIR, filename));
                    console.log(`♻️  Recovered stale print job (retry ${job.retries}): ${filename}`);
                }
            } catch (err) {
                console.error(`⚠️  Skipping corrupt print job ${filename}: ${err.message}`);
            }
        }
    }

    // Flush review queue if manual review was disabled while jobs were pending
    if (fs.existsSync(REVIEW_DIR) && !settings.get("enableManualReview")) {
        const reviewJobs = fs.readdirSync(REVIEW_DIR).filter((f) => f.endsWith(".json"));
        for (const filename of reviewJobs) {
            const src = path.join(REVIEW_DIR, filename);
            try {
                const job = readJob(src);
                job.stateChangedAt = Date.now();
                if (settings.get("enablePrinting")) {
                    job.readyAt = Date.now();
                    writeJob(src, job);
                    fs.renameSync(src, path.join(READY_DIR, filename));
                    console.log(`♻️  Auto-approved review job (review disabled) to print: ${filename}`);
                } else {
                    job.completedAt = Date.now();
                    writeJob(src, job);
                    fs.renameSync(src, path.join(DONE_DIR, filename));
                    console.log(`♻️  Auto-approved review job (review disabled) to done: ${filename}`);
                }
            } catch (err) {
                console.error(`⚠️  Skipping corrupt review job ${filename}: ${err.message}`);
            }
        }
    }

    // Recover non-permanent failed jobs
    const failed = fs.readdirSync(FAILED_DIR).filter((f) => f.endsWith(".json"));
    for (const filename of failed) {
        const src = path.join(FAILED_DIR, filename);
        try {
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
        } catch (err) {
            console.error(`⚠️  Skipping corrupt failed job ${filename}: ${err.message}`);
        }
    }
}

function recoverDirectory(dir, label) {
    if (!fs.existsSync(dir)) return;
    const stale = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const filename of stale) {
        const src = path.join(dir, filename);
        try {
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
        } catch (err) {
            console.error(`⚠️  Skipping corrupt ${label} job ${filename}: ${err.message}`);
        }
    }
}

// ── Generation Worker (concurrent) ──────────────────────────────────────────

let generatingCount = 0;

async function processGenerationQueue() {
    if (generatingCount >= settings.get("maxConcurrentGeneration")) return;

    let pending;
    try {
        pending = (await fsp.readdir(PENDING_DIR))
            .filter((f) => f.endsWith(".json"))
            .sort();
    } catch { return; }

    if (pending.length === 0) return;

    const slots = settings.get("maxConcurrentGeneration") - generatingCount;
    const toProcess = pending.slice(0, slots);

    for (const filename of toProcess) {
        const pendingPath = path.join(PENDING_DIR, filename);
        const generatingPath = path.join(GENERATING_DIR, filename);

        try {
            // Stamp generating timestamp before moving
            const job = await readJobAsync(pendingPath);
            const now = Date.now();
            job.generatingAt = now;
            job.stateChangedAt = now;
            await writeJobAsync(pendingPath, job);
            await fsp.rename(pendingPath, generatingPath);
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
        const job = await readJobAsync(generatingPath);
        console.log(`⚙️  Generating: ${filename} (attempt ${job.retries + 1})`);

        await generateImage(job);

        // Success: reset retries
        job.retries = 0;
        const genDoneAt = Date.now();
        job.stateChangedAt = genDoneAt;

        if (settings.get("enableManualReview")) {
            // Manual review enabled: hold for admin approval before delivery
            job.reviewAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(REVIEW_DIR, filename));
            console.log(`🔍 Generation complete, awaiting review: ${filename}`);
        } else if (settings.get("enablePrinting")) {
            // Printing enabled (local or relay): move to ready queue
            job.readyAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(READY_DIR, filename));
            console.log(`✅ Generation complete: ${filename}`);
        } else {
            // Digital only: send MMS and move straight to done
            job.completedAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(DONE_DIR, filename));
            console.log(`✅ Generation complete (digital delivery): ${filename}`);

            const activeStyles = settings.getActiveStyles();
            const activeStyleList = settings.getActiveStyleList();
            const configuredDefault = settings.get("defaultStyle") || DEFAULT_STYLE;
            const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
            const jobStyleName = activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle;

            const testing = isTestingMode(job.eventName);
            const adminShortcut = isAdmin(job.userPhone) && !testing;

            let suffix = "";
            if (!adminShortcut) {
                const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
                const unlimited = isAdmin(job.userPhone) && testing;
                if (remaining <= 0 && !unlimited) {
                    suffix = ` ${settings.getMsg("lastPortrait")}`;
                }
            }

            const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
            const shareLinks = buildShareLinks(imageUrl, job.eventName);
            const mmsBody = `${settings.getMsg("deliveryDigital", { styleName: jobStyleName })}${suffix}${shareLinks}`;
            const leadMode = settings.get("leadCaptureMode");

            if (leadMode === "after" && !adminShortcut
                && !leads.isCompleted(job.userPhone, job.eventName)
                && !leads.isActive(job.userPhone)) {
                await leads.startSurvey(job.userPhone, job.appPhone, job.eventName, "after", {
                    body: mmsBody,
                    mediaUrl: imageUrl,
                });
            } else {
                sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl)
                    .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
            }

            // Send standalone promo after a brief delay
            const promoText = settings.get("enablePromoMessage") ? settings.get("promoMessage") : "";
            if (promoText && !adminShortcut) {
                setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText), 5000);
            }

            // NPS survey after last print
            if (settings.get("enableNps") && !adminShortcut && !nps.hasCompleted(job.userPhone, job.eventName)) {
                const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
                const unlimited = isAdmin(job.userPhone) && testing;
                if (remaining <= 0 && !unlimited) {
                    const delay = (settings.get("npsDelay") || 30) * 1000;
                    setTimeout(() => {
                        nps.markPending(job.userPhone);
                        sendSms(job.userPhone, job.appPhone, settings.getMsg("npsPrompt"));
                    }, delay);
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
                const job = await readJobAsync(generatingPath);
                job.permanent = true;
                job.failReason = error.failReason || "content_rejected";
                job.stateChangedAt = now;
                decrementUsage(job.userPhone, job.eventName);
                await writeJobAsync(generatingPath, job);
                await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                console.log(`🚫 Job permanently failed: ${filename}`);
            } else {
                const job = await readJobAsync(generatingPath);
                job.retries++;
                job.stateChangedAt = now;
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = "generation";
                    decrementUsage(job.userPhone, job.eventName);
                    await writeJobAsync(generatingPath, job);
                    await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                    console.log(`💀 Generation exceeded max retries, moved to failed: ${filename}`);
                    // Notify user their image failed
                    sendSms(job.userPhone, job.appPhone,
                        "Sorry, we couldn't generate your AI portrait this time. Please try sending your photo again!")
                        .catch((err) => console.error(`❌ Failure notification failed: ${err.message}`));
                } else {
                    await writeJobAsync(generatingPath, job);
                    await fsp.rename(generatingPath, path.join(PENDING_DIR, filename));
                    console.log(`🔄 Generation re-queued (retry ${job.retries}): ${filename}`);
                }
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    }
}

// ── Print Worker (concurrent, one job per printer) ──────────────────────────

const printerBusy = new Map();

function getPrinterBusyState() {
    const state = {};
    for (const [name, busy] of printerBusy) {
        state[name] = busy;
    }
    return state;
}

// ── Stale relay job recovery (runs periodically) ─────────────────────────────

const RELAY_STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes
const LOCAL_STALE_THRESHOLD = 10 * 60 * 1000; // 10 minutes

async function recoverStaleRelayJobs() {
    let printing;
    try {
        printing = (await fsp.readdir(PRINTING_DIR)).filter(f => f.endsWith(".json"));
    } catch { return; }

    const now = Date.now();
    for (const filename of printing) {
        const filePath = path.join(PRINTING_DIR, filename);
        try {
            const job = JSON.parse(await fsp.readFile(filePath, "utf-8"));
            if (!job.printingAt) continue;

            // Skip jobs being printed locally (tracked in printerBusy)
            if (job.printerName && printerBusy.get(job.printerName)) continue;

            // Relay mode uses longer threshold (relay agent may retry on its own)
            const isRelayMode = !!settings.get("printRelayKey");
            const threshold = isRelayMode ? RELAY_STALE_THRESHOLD : LOCAL_STALE_THRESHOLD;
            if ((now - job.printingAt) < threshold) continue;

            job.retries = (job.retries || 0) + 1;
            job.stateChangedAt = now;
            if (job.retries >= MAX_RETRIES) {
                job.failReason = "printer";
                decrementUsage(job.userPhone, job.eventName);
                await fsp.writeFile(filePath, JSON.stringify(job));
                await fsp.rename(filePath, path.join(FAILED_DIR, filename));
                console.log(`💀 Stale relay job exceeded retries: ${filename}`);
            } else {
                await fsp.writeFile(filePath, JSON.stringify(job));
                await fsp.rename(filePath, path.join(READY_DIR, filename));
                console.log(`♻️  Recovered stale relay job (retry ${job.retries}): ${filename}`);
            }
        } catch { /* skip unreadable */ }
    }
}

async function processPrintQueue() {
    // If relay mode is active, skip local printing — relay agent handles it
    if (settings.get("printRelayKey")) return;

    let printers;
    try {
        printers = await getActivePrinters();
    } catch {
        return; // No printers available
    }
    if (printers.length === 0) return;

    const idlePrinters = printers.filter((p) => !printerBusy.get(p));
    if (idlePrinters.length === 0) return;

    let ready;
    try {
        ready = (await fsp.readdir(READY_DIR))
            .filter((f) => f.endsWith(".json"))
            .sort();
    } catch { return; }

    if (ready.length === 0) return;

    const toDispatch = Math.min(idlePrinters.length, ready.length);
    for (let i = 0; i < toDispatch; i++) {
        const printer = idlePrinters[i];
        const filename = ready[i];
        printerBusy.set(printer, true);
        processSinglePrint(filename, printer).finally(() => {
            printerBusy.set(printer, false);
        });
    }
}

async function processSinglePrint(filename, printerName) {
    const readyPath = path.join(READY_DIR, filename);
    const printingPath = path.join(PRINTING_DIR, filename);

    try {
        // Stamp printing timestamp and printer name before moving
        const preJob = await readJobAsync(readyPath);
        const printStartAt = Date.now();
        preJob.printingAt = printStartAt;
        preJob.stateChangedAt = printStartAt;
        preJob.printerName = printerName;
        await writeJobAsync(readyPath, preJob);
        await fsp.rename(readyPath, printingPath);
        const job = await readJobAsync(printingPath);
        console.log(`🖨️  Printing on ${printerName}: ${filename}`);

        await printJob(job, printerName);

        job.completedAt = Date.now();
        job.stateChangedAt = job.completedAt;
        await writeJobAsync(printingPath, job);
        await fsp.rename(printingPath, path.join(DONE_DIR, filename));
        console.log(`✅ Printed on ${printerName}: ${filename}`);

        await sendPrintCompletionMms(job, filename);
    } catch (error) {
        console.error(`❌ Print failed on ${printerName}: ${filename} - ${error.message}`);

        try {
            const job = await readJobAsync(printingPath);
            job.retries++;
            job.stateChangedAt = Date.now();
            if (job.retries >= MAX_RETRIES) {
                job.failReason = "printer";
                decrementUsage(job.userPhone, job.eventName);
                await writeJobAsync(printingPath, job);
                await fsp.rename(printingPath, path.join(FAILED_DIR, filename));
                console.log(`💀 Print exceeded max retries, moved to failed: ${filename}`);
            } else {
                await writeJobAsync(printingPath, job);
                await fsp.rename(printingPath, path.join(READY_DIR, filename));
                console.log(`🔄 Print re-queued (retry ${job.retries}): ${filename}`);
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    }
}

// ── Print completion MMS (shared by local print worker and relay) ────────────

async function sendPrintCompletionMms(job, filename) {
    const activeStyles = settings.getActiveStyles();
    const activeStyleList = settings.getActiveStyleList();
    const configuredDefault = settings.get("defaultStyle") || DEFAULT_STYLE;
    const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
    const jobStyleName = activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle;

    const testing = isTestingMode(job.eventName);
    const adminShortcut = isAdmin(job.userPhone) && !testing;

    let suffix = "";
    if (!adminShortcut) {
        const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
        const unlimited = isAdmin(job.userPhone) && testing;
        if (remaining > 0 || unlimited) {
            suffix = ` ${settings.getMsg("remainingCount", { remaining, unit: remaining === 1 ? "print" : "prints" })}`;
        } else {
            suffix = ` ${settings.getMsg("lastPortrait")}`;
        }
    }

    const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
    const shareLinks = buildShareLinks(imageUrl, job.eventName);
    const mmsBody = `${settings.getMsg("deliveryPrint", { styleName: jobStyleName })}${suffix}${shareLinks}`;
    const leadMode = settings.get("leadCaptureMode");

    if (leadMode === "after" && !adminShortcut
        && !leads.isCompleted(job.userPhone, job.eventName)
        && !leads.isActive(job.userPhone)) {
        await leads.startSurvey(job.userPhone, job.appPhone, job.eventName, "after", {
            body: mmsBody,
            mediaUrl: imageUrl,
        });
    } else {
        sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl)
            .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
    }

    // Send standalone promo after a brief delay
    const promoText = settings.get("enablePromoMessage") ? settings.get("promoMessage") : "";
    if (promoText && !adminShortcut) {
        setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText), 5000);
    }

    // NPS survey after last print
    if (settings.get("enableNps") && !adminShortcut && !nps.hasCompleted(job.userPhone, job.eventName)) {
        const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
        const unlimited = isAdmin(job.userPhone) && testing;
        if (remaining <= 0 && !unlimited) {
            const delay = (settings.get("npsDelay") || 30) * 1000;
            setTimeout(() => {
                nps.markPending(job.userPhone);
                sendSms(job.userPhone, job.appPhone, settings.getMsg("npsPrompt"));
            }, delay);
        }
    }
}

// ── Manual Review Queue ──────────────────────────────────────────────────────

function getReviewQueue(eventFilter) {
    if (!fs.existsSync(REVIEW_DIR)) return [];
    const files = fs.readdirSync(REVIEW_DIR).filter(f => f.endsWith(".json")).sort();
    return files.map(filename => {
        try {
            const job = readJob(path.join(REVIEW_DIR, filename));
            if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) return null;
            return {
                filename,
                userPhone: job.userPhone,
                style: job.style,
                eventName: job.eventName,
                reviewAt: job.reviewAt,
                filePrefix: job.filePrefix,
                retries: job.retries || 0,
            };
        } catch { return null; }
    }).filter(Boolean);
}

async function approveJob(filename) {
    const reviewPath = path.join(REVIEW_DIR, filename);
    if (!fs.existsSync(reviewPath)) throw new Error("Job not found in review queue");

    const job = await readJobAsync(reviewPath);
    const now = Date.now();
    job.stateChangedAt = now;
    job.approvedAt = now;

    if (settings.get("enablePrinting")) {
        job.readyAt = now;
        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(READY_DIR, filename));
        console.log(`✅ Review approved (to print): ${filename}`);
    } else {
        job.completedAt = now;
        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(DONE_DIR, filename));
        console.log(`✅ Review approved (digital delivery): ${filename}`);

        // Send MMS — same logic as digital-only in processGeneration
        const activeStyles = settings.getActiveStyles();
        const activeStyleList = settings.getActiveStyleList();
        const configuredDefault = settings.get("defaultStyle") || DEFAULT_STYLE;
        const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
        const jobStyleName = activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle;

        const testing = isTestingMode(job.eventName);
        const adminShortcut = isAdmin(job.userPhone) && !testing;

        let suffix = "";
        if (!adminShortcut) {
            const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
            const unlimited = isAdmin(job.userPhone) && testing;
            if (remaining <= 0 && !unlimited) {
                suffix = ` ${settings.getMsg("lastPortrait")}`;
            }
        }

        const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
        const shareLinks = buildShareLinks(imageUrl, job.eventName);
        const mmsBody = `${settings.getMsg("deliveryDigital", { styleName: jobStyleName })}${suffix}${shareLinks}`;
        const leadMode = settings.get("leadCaptureMode");

        if (leadMode === "after" && !adminShortcut
            && !leads.isCompleted(job.userPhone, job.eventName)
            && !leads.isActive(job.userPhone)) {
            await leads.startSurvey(job.userPhone, job.appPhone, job.eventName, "after", {
                body: mmsBody,
                mediaUrl: imageUrl,
            });
        } else {
            sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl)
                .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
        }

        const promoText = settings.get("enablePromoMessage") ? settings.get("promoMessage") : "";
        if (promoText && !adminShortcut) {
            setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText), 5000);
        }

        if (settings.get("enableNps") && !adminShortcut && !nps.hasCompleted(job.userPhone, job.eventName)) {
            const remaining = settings.get("maxPrints") - getUsageCount(job.userPhone);
            const unlimited = isAdmin(job.userPhone) && testing;
            if (remaining <= 0 && !unlimited) {
                const delay = (settings.get("npsDelay") || 30) * 1000;
                setTimeout(() => {
                    nps.markPending(job.userPhone);
                    sendSms(job.userPhone, job.appPhone, settings.getMsg("npsPrompt"));
                }, delay);
            }
        }
    }
}

async function rejectJob(filename, message) {
    const reviewPath = path.join(REVIEW_DIR, filename);
    if (!fs.existsSync(reviewPath)) throw new Error("Job not found in review queue");

    const job = await readJobAsync(reviewPath);
    job.retries = (job.retries || 0) + 1;
    job.stateChangedAt = Date.now();
    delete job.reviewAt;

    // Delete existing output files so generation starts fresh
    const { outputPath, mmsPath } = jobPaths(job);
    try { await fsp.unlink(outputPath); } catch {}
    try { await fsp.unlink(mmsPath); } catch {}

    if (job.retries >= MAX_RETRIES) {
        job.failReason = "review_rejected";
        decrementUsage(job.userPhone, job.eventName);
        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(FAILED_DIR, filename));
        console.log(`💀 Review rejected, max retries exceeded: ${filename}`);
        sendSms(job.userPhone, job.appPhone, settings.getMsg("reviewFailed"))
            .catch((err) => console.error(`❌ Rejection notification failed: ${err.message}`));
    } else {
        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(PENDING_DIR, filename));
        console.log(`🔄 Review rejected, re-queued (retry ${job.retries}): ${filename}`);
        if (message) {
            sendSms(job.userPhone, job.appPhone, message)
                .catch((err) => console.error(`❌ Review SMS failed: ${err.message}`));
        }
    }
}

module.exports = {
    buildUsageCache,
    isAdmin,
    getUsageCount,
    incrementUsage,
    enqueueJob,
    recoverStaleJobs,
    processGenerationQueue,
    processPrintQueue,
    getPrinterBusyState,
    sendPrintCompletionMms,
    recoverStaleRelayJobs,
    getReviewQueue,
    approveJob,
    rejectJob,
};
