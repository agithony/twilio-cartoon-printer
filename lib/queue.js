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
const { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage } = require("./pipeline");
const { getActivePrinters } = require("./printer");
const { DEFAULT_STYLE } = require("./styles");
const leads = require("./leads");
const nps = require("./nps");

// ── Share Links ─────────────────────────────────────────────────────────────

function buildShareLinks(imageUrl, eventName) {
    if (!settings.getForEvent("enableShareLinks", eventName) || !imageUrl) return "";
    const lines = [];
    if (settings.getForEvent("enableTwitterShare", eventName) !== false) {
        const handle = settings.getForEvent("twitterHandle", eventName) || "@twilio";
        const template = settings.getForEvent("linkedInShareText", eventName) || "Check out my AI portrait from {eventName}, powered by Twilio!";
        const shareText = template.replace(/\{eventName\}/g, eventName);
        const tweetText = encodeURIComponent(shareText + (handle ? ` ${handle}` : ""));
        lines.push(`X/Twitter: https://twitter.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(imageUrl)}`);
    }
    if (settings.getForEvent("enableLinkedInShare", eventName) !== false) {
        lines.push(`LinkedIn: https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(imageUrl)}`);
    }
    if (lines.length === 0) return "";
    return `\n\nShare it!\n${lines.join("\n")}`;
}

// ── Usage Tracking (in-memory cache) ─────────────────────────────────────────

const usageCache = new Map();
let _buildingCache = null;

function usageKey(phone, event) {
    return `${phone}:${event}`;
}

async function buildUsageCache() {
    if (_buildingCache) return _buildingCache;
    _buildingCache = _buildUsageCacheImpl();
    try { return await _buildingCache; } finally { _buildingCache = null; }
}

async function _buildUsageCacheImpl() {
    // Build into a new Map and swap atomically so getAllUsers() never
    // sees a partially-built or empty cache during the rebuild window.
    const newCache = new Map();
    // Cache per-event admin lists so we only load each event's settings once
    const eventAdminCache = new Map();
    function isEventAdmin(phone, eventName) {
        if (!eventAdminCache.has(eventName)) {
            eventAdminCache.set(eventName, new Set(settings.getForEvent("adminPhones", eventName) || []));
        }
        return eventAdminCache.get(eventName).has(phone);
    }
    for (const dir of [DONE_DIR, PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR]) {
        try {
            const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = await fsp.readFile(path.join(dir, file), "utf-8");
                    const job = JSON.parse(data);
                    if (!job.userPhone || !job.eventName) continue;
                    if (job.adminGenerated || isEventAdmin(job.userPhone, job.eventName)) continue;
                    const key = usageKey(job.userPhone, job.eventName);
                    newCache.set(key, (newCache.get(key) || 0) + 1);
                } catch {
                    // Skip malformed files
                }
            }
        } catch {
            // Directory doesn't exist, skip
        }
    }
    // Apply persistent usage overrides (from manual resets)
    const overrides = settings.get("usageOverrides") || {};
    for (const [key, offset] of Object.entries(overrides)) {
        const current = newCache.get(key) || 0;
        newCache.set(key, Math.max(0, current + offset));
    }
    // Atomic swap
    usageCache.clear();
    for (const [k, v] of newCache) usageCache.set(k, v);
    console.log(`📊 Usage cache built: ${usageCache.size} entries`);
}

function incrementUsage(phone, event) {
    if (isAdmin(phone)) return;
    const key = usageKey(phone, event);
    usageCache.set(key, (usageCache.get(key) || 0) + 1);
}

function decrementUsage(phone, event) {
    if (isAdmin(phone)) return;
    const key = usageKey(phone, event);
    const current = usageCache.get(key) || 0;
    if (current > 0) usageCache.set(key, current - 1);
}

// Move completed photos between events (done/failed jobs only)
async function moveJobsToEvent(prefixes, fromEvent, toEvent) {
    const results = [];
    const fromDir = settings.getDownloadDir(fromEvent);
    const toDir = settings.getDownloadDir(toEvent);
    await fsp.mkdir(toDir, { recursive: true });

    for (const prefix of prefixes) {
        try {
            // Validate prefix (must be a safe filename — no path traversal)
            if (!prefix || prefix.includes("..") || prefix.includes("/") || prefix.includes("\\")) {
                results.push({ prefix, success: false, error: "Invalid prefix" });
                continue;
            }

            // Find job JSON in done/ or failed/
            const filename = `${prefix}.json`;
            let jobPath;
            for (const dir of [DONE_DIR, FAILED_DIR]) {
                const p = path.join(dir, filename);
                if (fs.existsSync(p)) { jobPath = p; break; }
            }
            if (!jobPath) {
                results.push({ prefix, success: false, error: "Job not found in done/failed" });
                continue;
            }

            const job = JSON.parse(await fsp.readFile(jobPath, "utf-8"));
            if (job.eventName !== fromEvent) {
                results.push({ prefix, success: false, error: "Event mismatch" });
                continue;
            }

            // Move image files, tracking for rollback
            const suffixes = ["_input.jpg", "_output.png", "_output_mms.jpg"];
            const moved = [];
            try {
                for (const s of suffixes) {
                    const src = path.join(fromDir, prefix + s);
                    const dst = path.join(toDir, prefix + s);
                    if (fs.existsSync(dst)) throw new Error("File already exists in target event");
                    if (fs.existsSync(src)) {
                        await fsp.rename(src, dst);
                        moved.push([dst, src]);
                    }
                }
            } catch (moveErr) {
                // Rollback moved files
                for (const [dst, src] of moved) {
                    try { await fsp.rename(dst, src); } catch {}
                }
                throw moveErr;
            }

            // Update job JSON
            job.eventName = toEvent;
            job.movedFrom = fromEvent;
            job.movedAt = Date.now();
            await writeJobAsync(jobPath, job);

            results.push({ prefix, success: true });
            console.log(`📦 Moved ${prefix} from "${fromEvent}" to "${toEvent}"`);
        } catch (err) {
            results.push({ prefix, success: false, error: err.message });
            console.error(`❌ Failed to move ${prefix}: ${err.message}`);
        }
    }

    // Rebuild usage cache after all moves
    await buildUsageCache();
    return results;
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

function getAllUsers(eventFilter) {
    const userMap = new Map();
    for (const [key, count] of usageCache) {
        const lastColon = key.lastIndexOf(":");
        const phone = key.substring(0, lastColon);
        const event = key.substring(lastColon + 1);
        if (eventFilter && eventFilter !== "all" && event !== eventFilter) continue;
        if (!userMap.has(phone)) userMap.set(phone, 0);
        userMap.set(phone, userMap.get(phone) + count);
    }
    // Include admin phones that may have 0 usage (not in cache)
    // Use the viewed event's admin list, not just the active event's
    const adminPhones = eventFilter && eventFilter !== "all"
        ? settings.getForEvent("adminPhones", eventFilter)
        : settings.get("adminPhones");
    for (const phone of (adminPhones || [])) {
        if (!userMap.has(phone)) userMap.set(phone, 0);
    }
    return userMap;
}

function resetUsage(phone, event) {
    const key = usageKey(phone, event);
    const current = usageCache.get(key) || 0;
    if (current === 0) return;
    const overrides = { ...(settings.get("usageOverrides") || {}) };
    overrides[key] = (overrides[key] || 0) - current;
    settings.update({ usageOverrides: overrides });
    usageCache.set(key, 0);
}

async function toggleAdmin(phone, eventName) {
    const activeEvent = settings.get("eventName");
    const targetEvent = eventName || activeEvent;

    if (targetEvent === activeEvent) {
        // Active event — modify in-memory settings directly
        const admins = [...settings.get("adminPhones")];
        const idx = admins.indexOf(phone);
        if (idx >= 0) admins.splice(idx, 1);
        else admins.push(phone);
        settings.update({ adminPhones: admins });
    } else {
        // Non-active event — load, modify, and save its settings file
        const eventSettings = settings.loadEventSettings(targetEvent);
        const admins = [...(eventSettings.adminPhones || [])];
        const idx = admins.indexOf(phone);
        if (idx >= 0) admins.splice(idx, 1);
        else admins.push(phone);
        eventSettings.adminPhones = admins;
        const dir = path.join(settings.EVENTS_DIR, targetEvent);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const settingsPath = path.join(dir, "settings.json");
        const tmp = settingsPath + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmp, JSON.stringify(eventSettings, null, 2));
        fs.renameSync(tmp, settingsPath);
    }
    // Kick off cache rebuild in the background — don't block the response.
    // Admin status is already persisted in settings; the cache rebuild just
    // updates usage counts (which aren't needed for the immediate UI update).
    (async () => {
        try {
            if (_buildingCache) await _buildingCache.catch(() => {});
            await buildUsageCache();
        } catch (err) {
            console.error("Background cache rebuild error:", err);
        }
    })();
    const updatedAdmins = targetEvent === activeEvent
        ? settings.get("adminPhones")
        : (settings.loadEventSettings(targetEvent).adminPhones || []);
    return updatedAdmins.includes(phone);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasOutputFile(job) {
    const { outputPath } = jobPaths(job);
    return fs.existsSync(outputPath);
}

function readJob(filepath) {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

let _writeCounter = 0;
function writeJob(filepath, job) {
    const tmp = filepath + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, filepath);
}

async function readJobAsync(filepath) {
    return JSON.parse(await fsp.readFile(filepath, "utf-8"));
}

async function writeJobAsync(filepath, job) {
    const tmp = filepath + `.tmp.${process.pid}.${_writeCounter++}`;
    await fsp.writeFile(tmp, JSON.stringify(job));
    await fsp.rename(tmp, filepath);
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

// Deduplication: track recent messageSids to prevent Twilio webhook retries
// from creating duplicate jobs (Twilio retries if response takes >15s)
const recentSids = new Map();
const SID_TTL = 600_000; // 10 minutes — Twilio can retry webhooks for several minutes

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

function enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand) {
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
        brand: brand || null,
        eventName: settings.get("eventName"),
        retries: 0,
        createdAt,
        filePrefix: ts,
        pendingAt: createdAt,
        stateChangedAt: createdAt,
    };
    if (isAdmin(userPhone)) job.adminGenerated = true;
    const filename = `${ts}.json`;
    const jobPath = path.join(PENDING_DIR, filename);
    const tmpPath = jobPath + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmpPath, JSON.stringify(job));
    fs.renameSync(tmpPath, jobPath);
    incrementUsage(userPhone, settings.get("eventName"));
    console.log(`📥 Job queued: ${filename}`);
}

// ── Crash Recovery ───────────────────────────────────────────────────────────

async function recoverStaleJobs() {
    // Recover jobs that were mid-generation when the server stopped
    await recoverDirectory(GENERATING_DIR, "generating");

    // Legacy: recover jobs from old processing/ directory
    try { await fsp.access(PROCESSING_DIR); await recoverDirectory(PROCESSING_DIR, "processing (legacy)"); } catch {}

    // Recover jobs that were mid-print when the server stopped
    // These always go to ready/ since the image already exists
    try {
        const stale = (await fsp.readdir(PRINTING_DIR)).filter((f) => f.endsWith(".json"));
        for (const filename of stale) {
            const src = path.join(PRINTING_DIR, filename);
            try {
                const job = await readJobAsync(src);
                job.retries++;
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = job.failReason || "max_retries";
                    decrementUsage(job.userPhone, job.eventName);
                    // Send MMS as fallback — user should still get their digital portrait
                    try { await sendPrintCompletionMms(job, filename); } catch (e) {
                        console.error(`❌ Fallback MMS failed for stale job ${filename}: ${e.message}`);
                    }
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(FAILED_DIR, filename));
                    console.log(`💀 Stale print job exceeded retries, moved to failed (MMS sent as fallback): ${filename}`);
                } else {
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(READY_DIR, filename));
                    console.log(`♻️  Recovered stale print job (retry ${job.retries}): ${filename}`);
                }
            } catch (err) {
                console.error(`⚠️  Skipping corrupt print job ${filename}: ${err.message}`);
            }
        }
    } catch {}

    // Flush review queue — only auto-approve jobs whose event has review disabled
    try {
        const reviewJobs = (await fsp.readdir(REVIEW_DIR)).filter((f) => f.endsWith(".json"));
        for (const filename of reviewJobs) {
            const src = path.join(REVIEW_DIR, filename);
            try {
                const job = await readJobAsync(src);
                // Check this job's event setting, not just the active event
                const jobEvent = job.eventName || settings.get("eventName");
                const reviewMode = settings.getForEvent("reviewMode", jobEvent) ||
                    (settings.getForEvent("enableManualReview", jobEvent) ? "human" : "off");
                if (reviewMode === "human") continue; // leave in review queue
                // Move staged images to final downloads
                const staged = jobPaths(job, { staged: true });
                const final_ = jobPaths(job);
                for (const [s, d] of [[staged.inputPath, final_.inputPath], [staged.outputPath, final_.outputPath], [staged.mmsPath, final_.mmsPath]]) {
                    try { await fsp.rename(s, d); } catch {}
                }
                job.stateChangedAt = Date.now();
                if (settings.getForEvent("enablePrinting", jobEvent)) {
                    job.readyAt = Date.now();
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(READY_DIR, filename));
                    console.log(`♻️  Auto-approved review job (review disabled for ${jobEvent}) to print: ${filename}`);
                } else {
                    job.completedAt = Date.now();
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(DONE_DIR, filename));
                    console.log(`♻️  Auto-approved review job (review disabled for ${jobEvent}) to done: ${filename}`);
                }
            } catch (err) {
                console.error(`⚠️  Skipping corrupt review job ${filename}: ${err.message}`);
            }
        }
    } catch {}

    // Recover non-permanent failed jobs
    try {
        const failed = (await fsp.readdir(FAILED_DIR)).filter((f) => f.endsWith(".json"));
        for (const filename of failed) {
            const src = path.join(FAILED_DIR, filename);
            try {
                const job = await readJobAsync(src);
                if (job.permanent || job.failReason === "review_rejected") continue;
                job.retries = 0;

                if (hasOutputFile(job)) {
                    // Image already generated, just needs printing
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(READY_DIR, filename));
                    incrementUsage(job.userPhone, job.eventName);
                    console.log(`♻️  Recovered failed job to print queue: ${filename}`);
                } else {
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(PENDING_DIR, filename));
                    incrementUsage(job.userPhone, job.eventName);
                    console.log(`♻️  Recovered failed job for retry: ${filename}`);
                }
            } catch (err) {
                console.error(`⚠️  Skipping corrupt failed job ${filename}: ${err.message}`);
            }
        }
    } catch {}
}

async function recoverDirectory(dir, label) {
    let stale;
    try { stale = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")); } catch { return; }
    for (const filename of stale) {
        const src = path.join(dir, filename);
        try {
            const job = await readJobAsync(src);
            job.retries++;

            if (job.retries >= MAX_RETRIES) {
                job.failReason = job.failReason || "max_retries";
                await writeJobAsync(src, job);
                await fsp.rename(src, path.join(FAILED_DIR, filename));
                console.log(`💀 Stale ${label} job exceeded retries, moved to failed: ${filename}`);
            } else if (hasOutputFile(job)) {
                // Image already generated, send straight to print queue
                job.retries = 0;
                await writeJobAsync(src, job);
                await fsp.rename(src, path.join(READY_DIR, filename));
                console.log(`♻️  Recovered ${label} job to print queue (image exists): ${filename}`);
            } else {
                await writeJobAsync(src, job);
                await fsp.rename(src, path.join(PENDING_DIR, filename));
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
            // Claim the job atomically by renaming first (rename-as-lock)
            await fsp.rename(pendingPath, generatingPath);
        } catch {
            continue; // Another worker already claimed this job
        }

        try {
            // Stamp generating timestamp after claiming
            const job = await readJobAsync(generatingPath);
            const now = Date.now();
            job.generatingAt = now;
            job.stateChangedAt = now;
            await writeJobAsync(generatingPath, job);
        } catch (err) {
            console.error(`⚠️  Failed to stamp claimed job ${filename}: ${err.message}`);
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

        // Determine review mode: new reviewMode setting, or fall back to legacy enableManualReview
        const reviewMode = settings.getForEvent("reviewMode", job.eventName) ||
            (settings.getForEvent("enableManualReview", job.eventName) ? "human" : "off");

        if (reviewMode === "ai") {
            // AI review: automated quality check
            try {
                const result = await aiReviewImage(job);
                job.aiReviewResult = result.reason;
                if (result.passed) {
                    console.log(`✅ AI review passed: ${filename}`);
                    // Fall through to ready/done logic below
                } else {
                    // AI flagged — auto-reject and notify user to try again
                    console.log(`🔍 AI review flagged: ${filename} — ${result.reason}`);
                    job.failReason = "ai_review_rejected";
                    job.permanent = true;
                    await cleanupStaged(job);
                    decrementUsage(job.userPhone, job.eventName);
                    await writeJobAsync(generatingPath, job);
                    await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                    sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("reviewFailed", job.eventName))
                        .catch((err) => console.error(`❌ AI review rejection SMS failed: ${err.message}`));
                    return;
                }
            } catch (err) {
                // AI review API error — re-queue for retry instead of auto-approving
                console.error(`⚠️ AI review error, re-queuing for retry: ${err.message}`);
                job.retries = (job.retries || 0) + 1;
                job.stateChangedAt = Date.now();
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = "ai_review_error";
                    await cleanupStaged(job);
                    decrementUsage(job.userPhone, job.eventName);
                    await writeJobAsync(generatingPath, job);
                    await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                    console.log(`💀 AI review failed after max retries: ${filename}`);
                    sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("reviewFailed", job.eventName))
                        .catch((e) => console.error(`❌ AI review failure SMS failed: ${e.message}`));
                } else {
                    await writeJobAsync(generatingPath, job);
                    await fsp.rename(generatingPath, path.join(PENDING_DIR, filename));
                    console.log(`🔄 AI review error, re-queued (retry ${job.retries}): ${filename}`);
                }
                return;
            }
        } else if (reviewMode === "human") {
            // Human review: keep images staged until approved
            job.reviewAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(REVIEW_DIR, filename));
            console.log(`🔍 Generation complete, awaiting review: ${filename}`);
            return;
        }

        // No review, AI passed, or AI soft-fail — proceed to delivery
        if (settings.getForEvent("enablePrinting", job.eventName)) {
            // Printing enabled: move staged images to final downloads
            await moveStagedToFinal(job);
            job.readyAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(READY_DIR, filename));
            console.log(`✅ Generation complete: ${filename}`);
        } else {
            // Digital only: move staged images to final, send MMS, move to done
            await moveStagedToFinal(job);
            job.completedAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(DONE_DIR, filename));
            console.log(`✅ Generation complete (digital delivery): ${filename}`);

            const ev = job.eventName;
            const activeStyles = settings.getActiveStyles();
            const activeStyleList = settings.getActiveStyleList();
            const configuredDefault = settings.getForEvent("defaultStyle", ev) || DEFAULT_STYLE;
            const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
            const singleStyle = activeStyleList.length <= 1;
            const jobStyleName = singleStyle ? "" : (activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle);

            const testing = isTestingMode(ev);
            const adminShortcut = isAdmin(job.userPhone) && !testing;

            let suffix = "";
            if (!adminShortcut) {
                const maxPrints = settings.getForEvent("maxPrints", ev);
                const remaining = maxPrints - getUsageCount(job.userPhone);
                const unlimited = isAdmin(job.userPhone) && testing;
                if (remaining <= 0 && !unlimited && maxPrints > 1) {
                    suffix = ` ${settings.getMsgForEvent("lastPortrait", ev)}`;
                }
            }

            const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
            const shareLinks = buildShareLinks(imageUrl, ev);
            const mmsBody = `${settings.getMsgForEvent("deliveryDigital", ev, { styleName: jobStyleName })}${suffix}${shareLinks}`;
            const leadMode = settings.getForEvent("leadCaptureMode", ev);

            const leadSurveyStarted = leadMode === "after" && !adminShortcut
                && !leads.isCompleted(job.userPhone, ev)
                && !leads.isActive(job.userPhone);

            if (leadSurveyStarted) {
                await leads.startSurvey(job.userPhone, job.appPhone, ev, "after", {
                    body: mmsBody,
                    mediaUrl: imageUrl,
                });
            } else {
                sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl)
                    .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
            }

            if (!leadSurveyStarted) {
                // Send standalone promo after a brief delay
                const promoText = settings.getForEvent("enablePromoMessage", ev) ? settings.getForEvent("promoMessage", ev) : "";
                if (promoText && !adminShortcut) {
                    setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText).catch((e) => console.error(`❌ Promo SMS failed: ${e.message}`)), 5000);
                }

                // NPS survey after last print
                if (settings.getForEvent("enableNps", ev) && !adminShortcut && !nps.hasCompleted(job.userPhone, ev)) {
                    const remaining = settings.getForEvent("maxPrints", ev) - getUsageCount(job.userPhone);
                    const unlimited = isAdmin(job.userPhone) && testing;
                    if (remaining <= 0 && !unlimited) {
                        const delay = (settings.getForEvent("npsDelay", ev) || 30) * 1000;
                        setTimeout(() => {
                            nps.markPending(job.userPhone);
                            sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("npsPrompt", ev))
                                .catch((e) => console.error(`❌ NPS prompt SMS failed: ${e.message}`));
                        }, delay);
                    }
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
                await cleanupStaged(job);
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
                    await cleanupStaged(job);
                    decrementUsage(job.userPhone, job.eventName);
                    await writeJobAsync(generatingPath, job);
                    await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                    console.log(`💀 Generation exceeded max retries, moved to failed: ${filename}`);
                    // Notify user their image failed
                    sendSms(job.userPhone, job.appPhone,
                        "Sorry, we couldn't generate your AI portrait this time. Please try sending your photo again!")
                        .catch((err) => console.error(`❌ Failure notification failed: ${err.message}`));
                } else {
                    await cleanupStaged(job);
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
const MAX_STALE_RECOVERIES = 5; // 5 × 15 min = 75 min relay downtime tolerance

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

            job.staleRecoveries = (job.staleRecoveries || 0) + 1;
            job.stateChangedAt = now;
            if (job.staleRecoveries >= MAX_STALE_RECOVERIES) {
                job.failReason = "relay_stale";
                decrementUsage(job.userPhone, job.eventName);
                // Send MMS as fallback — user should still get their digital portrait
                try { await sendPrintCompletionMms(job, filename); } catch (e) {
                    console.error(`❌ Fallback MMS failed for stale job ${filename}: ${e.message}`);
                }
                await writeJobAsync(filePath, job);
                await fsp.rename(filePath, path.join(FAILED_DIR, filename));
                console.log(`💀 Stale relay job exceeded recovery limit (MMS sent as fallback): ${filename}`);
            } else {
                await writeJobAsync(filePath, job);
                await fsp.rename(filePath, path.join(READY_DIR, filename));
                console.log(`♻️  Recovered stale relay job (stale recovery ${job.staleRecoveries}, retries ${job.retries || 0}): ${filename}`);
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
                // Send MMS as fallback — user should still get their digital portrait
                try { await sendPrintCompletionMms(job, filename); } catch (e) {
                    console.error(`❌ Fallback MMS failed for ${filename}: ${e.message}`);
                }
                await writeJobAsync(printingPath, job);
                await fsp.rename(printingPath, path.join(FAILED_DIR, filename));
                console.log(`💀 Print exceeded max retries, moved to failed (MMS sent as fallback): ${filename}`);
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
    const ev = job.eventName;
    const activeStyles = settings.getActiveStyles();
    const activeStyleList = settings.getActiveStyleList();
    const configuredDefault = settings.getForEvent("defaultStyle", ev) || DEFAULT_STYLE;
    const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
    const singleStyle = activeStyleList.length <= 1;
    const jobStyleName = singleStyle ? "" : (activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle);

    const testing = isTestingMode(ev);
    const adminShortcut = isAdmin(job.userPhone) && !testing;

    let suffix = "";
    if (!adminShortcut) {
        const maxPrints = settings.getForEvent("maxPrints", ev);
        const remaining = maxPrints - getUsageCount(job.userPhone);
        const unlimited = isAdmin(job.userPhone) && testing;
        if (remaining > 0 || unlimited) {
            suffix = ` ${settings.getMsgForEvent("remainingCount", ev, { remaining, unit: remaining === 1 ? "print" : "prints" })}`;
        } else if (maxPrints > 1) {
            suffix = ` ${settings.getMsgForEvent("lastPortrait", ev)}`;
        }
    }

    const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
    const shareLinks = buildShareLinks(imageUrl, ev);
    const mmsBody = `${settings.getMsgForEvent("deliveryPrint", ev, { styleName: jobStyleName })}${suffix}${shareLinks}`;
    const leadMode = settings.getForEvent("leadCaptureMode", ev);

    const leadSurveyStarted = leadMode === "after" && !adminShortcut
        && !leads.isCompleted(job.userPhone, ev)
        && !leads.isActive(job.userPhone);

    if (leadSurveyStarted) {
        await leads.startSurvey(job.userPhone, job.appPhone, ev, "after", {
            body: mmsBody,
            mediaUrl: imageUrl,
        });
    } else {
        sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl)
            .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
    }

    if (!leadSurveyStarted) {
        // Send standalone promo after a brief delay
        const promoText = settings.getForEvent("enablePromoMessage", ev) ? settings.getForEvent("promoMessage", ev) : "";
        if (promoText && !adminShortcut) {
            setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText).catch((e) => console.error(`❌ Promo SMS failed: ${e.message}`)), 5000);
        }

        // NPS survey after last print
        if (settings.getForEvent("enableNps", ev) && !adminShortcut && !nps.hasCompleted(job.userPhone, ev)) {
            const remaining = settings.getForEvent("maxPrints", ev) - getUsageCount(job.userPhone);
            const unlimited = isAdmin(job.userPhone) && testing;
            if (remaining <= 0 && !unlimited) {
                const delay = (settings.getForEvent("npsDelay", ev) || 30) * 1000;
                setTimeout(() => {
                    nps.markPending(job.userPhone);
                    sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("npsPrompt", ev));
                }, delay);
            }
        }
    }
}

// ── Manual Review Queue ──────────────────────────────────────────────────────

const _reviewCache = { key: null, data: null, ts: 0 };
const REVIEW_CACHE_TTL = 10_000;

async function getReviewQueue(eventFilter) {
    const cacheKey = eventFilter || "all";
    const now = Date.now();
    if (_reviewCache.key === cacheKey && (now - _reviewCache.ts) < REVIEW_CACHE_TTL) {
        return _reviewCache.data;
    }

    try {
        const allFiles = await fsp.readdir(REVIEW_DIR);
        const files = allFiles.filter(f => f.endsWith(".json")).sort();
        const result = [];
        for (const filename of files) {
            try {
                const job = await readJobAsync(path.join(REVIEW_DIR, filename));
                if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
                result.push({
                    filename,
                    userPhone: job.userPhone,
                    style: job.style,
                    eventName: job.eventName,
                    reviewAt: job.reviewAt,
                    filePrefix: job.filePrefix,
                    retries: job.retries || 0,
                });
            } catch {}
        }

        _reviewCache.key = cacheKey;
        _reviewCache.data = result;
        _reviewCache.ts = now;

        return result;
    } catch {
        return _reviewCache.data || [];
    }
}

function invalidateReviewCache() {
    _reviewCache.ts = 0;
}

async function approveJob(filename) {
    invalidateReviewCache();
    const reviewPath = path.join(REVIEW_DIR, filename);
    if (!fs.existsSync(reviewPath)) throw new Error("Job not found in review queue");

    const job = await readJobAsync(reviewPath);
    const now = Date.now();
    job.stateChangedAt = now;
    job.approvedAt = now;

    // Move staged images to final downloads directory
    await moveStagedToFinal(job);

    const ev = job.eventName;

    if (settings.getForEvent("enablePrinting", ev)) {
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
        const configuredDefault = settings.getForEvent("defaultStyle", ev) || DEFAULT_STYLE;
        const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
        const singleStyle = activeStyleList.length <= 1;
        const jobStyleName = singleStyle ? "" : (activeStyles[jobStyle] ? activeStyles[jobStyle].name : jobStyle);

        const testing = isTestingMode(ev);
        const adminShortcut = isAdmin(job.userPhone) && !testing;

        let suffix = "";
        if (!adminShortcut) {
            const maxPrints = settings.getForEvent("maxPrints", ev);
            const remaining = maxPrints - getUsageCount(job.userPhone);
            const unlimited = isAdmin(job.userPhone) && testing;
            if (remaining <= 0 && !unlimited && maxPrints > 1) {
                suffix = ` ${settings.getMsgForEvent("lastPortrait", ev)}`;
            }
        }

        const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
        const shareLinks = buildShareLinks(imageUrl, ev);
        const mmsBody = `${settings.getMsgForEvent("deliveryDigital", ev, { styleName: jobStyleName })}${suffix}${shareLinks}`;
        const leadMode = settings.getForEvent("leadCaptureMode", ev);

        const leadSurveyStarted = leadMode === "after" && !adminShortcut
            && !leads.isCompleted(job.userPhone, ev)
            && !leads.isActive(job.userPhone);

        if (leadSurveyStarted) {
            await leads.startSurvey(job.userPhone, job.appPhone, ev, "after", {
                body: mmsBody,
                mediaUrl: imageUrl,
            });
        } else {
            sendSms(job.userPhone, job.appPhone, mmsBody, imageUrl)
                .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
        }

        if (!leadSurveyStarted) {
            const promoText = settings.getForEvent("enablePromoMessage", ev) ? settings.getForEvent("promoMessage", ev) : "";
            if (promoText && !adminShortcut) {
                setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText).catch((e) => console.error(`❌ Promo SMS failed: ${e.message}`)), 5000);
            }

            if (settings.getForEvent("enableNps", ev) && !adminShortcut && !nps.hasCompleted(job.userPhone, ev)) {
                const remaining = settings.getForEvent("maxPrints", ev) - getUsageCount(job.userPhone);
                const unlimited = isAdmin(job.userPhone) && testing;
                if (remaining <= 0 && !unlimited) {
                    const delay = (settings.getForEvent("npsDelay", ev) || 30) * 1000;
                    setTimeout(() => {
                        nps.markPending(job.userPhone);
                        sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("npsPrompt", ev));
                    }, delay);
                }
            }
        }
    }
}

async function rejectJob(filename, message, reanalyze, feedback) {
    invalidateReviewCache();
    const reviewPath = path.join(REVIEW_DIR, filename);
    if (!fs.existsSync(reviewPath)) throw new Error("Job not found in review queue");

    const job = await readJobAsync(reviewPath);
    job.stateChangedAt = Date.now();
    delete job.reviewAt;

    // Delete staged output files
    await cleanupStaged(job);

    if (reanalyze) {
        // Reject + Re-analyze: re-queue for generation with fresh scene analysis
        job.retries = (job.retries || 0) + 1;
        delete job.cachedScene;
        if (feedback) {
            job.reviewFeedback = feedback;
        } else {
            delete job.reviewFeedback;
        }

        if (job.retries >= MAX_RETRIES) {
            job.failReason = "review_rejected";
            job.permanent = true;
            decrementUsage(job.userPhone, job.eventName);
            await writeJobAsync(reviewPath, job);
            await fsp.rename(reviewPath, path.join(FAILED_DIR, filename));
            console.log(`💀 Review rejected, max retries exceeded: ${filename}`);
            sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("reviewFailed", job.eventName))
                .catch((err) => console.error(`❌ Rejection notification failed: ${err.message}`));
        } else {
            await writeJobAsync(reviewPath, job);
            await fsp.rename(reviewPath, path.join(PENDING_DIR, filename));
            console.log(`🔄 Review rejected, re-queued for re-analysis (retry ${job.retries}): ${filename}`);
        }
    } else {
        // Reject / Reject + Notify: kill the job
        job.failReason = "review_rejected";
        job.permanent = true;
        decrementUsage(job.userPhone, job.eventName);
        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(FAILED_DIR, filename));
        console.log(`🗑️  Review rejected (discarded): ${filename}`);
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
    getAllUsers,
    resetUsage,
    toggleAdmin,
    incrementUsage,
    moveJobsToEvent,
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
