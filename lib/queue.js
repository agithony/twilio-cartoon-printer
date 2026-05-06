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
const { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage, aiPickBestVariant } = require("./pipeline");
const { getActivePrinters } = require("./printer");
const { DEFAULT_STYLE } = require("./styles");
const leads = require("./leads");
const nps = require("./nps");
const audit = require("./audit");
const stillWorking = require("./still-working");

// ── Share Links ─────────────────────────────────────────────────────────────

const dub = require("./dub");

async function buildShareMessage(job) {
    const ev = job.eventName || settings.get("eventName");
    if (!settings.getForEvent("enableShareLinks", ev)) return "";
    if (!job.baseUrl || !job.filePrefix) return "";

    const sharePageUrl = `${job.baseUrl}/s/${job.filePrefix}?e=${encodeURIComponent(ev)}`;
    const prefix = settings.getForEvent("dubSlugPrefix", ev) || "p";
    const counter = settings.incrementEventCounter("dubSlugCounter", ev);
    const slug = `${prefix}-${counter}`;
    const shortLink = await dub.shortenUrl(sharePageUrl, slug);
    const url = shortLink ? shortLink.replace(/^https?:\/\//, "") : sharePageUrl;

    // Store short link on job for use by share page
    if (shortLink) job.shareUrl = shortLink;

    const template = settings.getForEvent("shareMessageText", ev) || "Share your portrait: {url}";
    return `\n\n${template.replace(/\{url\}/g, url)}`;
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
                    if (job.reprint) continue; // Don't count reprints toward usage
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

function enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand, extras) {
    if (isDuplicate(messageSid)) {
        console.log(`⚠️  Duplicate webhook detected (${messageSid}), skipping enqueue`);
        return;
    }
    const createdAt = Date.now();
    const ts = formatTimestamp(createdAt);
    const eventName = settings.get("eventName");

    // Multi-variant review: spawn N siblings sharing a parentJobId.
    // Active when variantsPerReview > 1 AND review is on (either human or AI).
    // When review is off, there's no reviewer to pick a variant and no AI to
    // auto-select, so fan-out is pointless — stay single-variant.
    const reviewMode = settings.getForEvent("reviewMode", eventName) ||
        (settings.getForEvent("enableManualReview", eventName) ? "human" : "off");
    const variantsRequested = (reviewMode === "human" || reviewMode === "ai")
        ? Math.max(1, Math.min(3, Number(settings.getForEvent("variantsPerReview", eventName)) || 1))
        : 1;
    const isMultiVariant = variantsRequested > 1;
    console.log(`📥 enqueueJob: event=${eventName} reviewMode=${reviewMode} variantsPerReview=${settings.getForEvent("variantsPerReview", eventName)} → ${variantsRequested} variant(s)`);

    const baseJob = {
        imageUrl,
        messageSid,
        userPhone,
        appPhone,
        style,
        baseUrl: baseUrl || "",
        background: background || null,
        brand: brand || null,
        eventName,
        retries: 0,
        createdAt,
        pendingAt: createdAt,
        stateChangedAt: createdAt,
        ...(extras || {}),
    };
    if (isAdmin(userPhone)) baseJob.adminGenerated = true;

    if (!isMultiVariant) {
        // Single-variant (legacy) path — unchanged behavior
        const job = { ...baseJob, filePrefix: ts };
        const filename = `${ts}.json`;
        const jobPath = path.join(PENDING_DIR, filename);
        const tmpPath = jobPath + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmpPath, JSON.stringify(job));
        fs.renameSync(tmpPath, jobPath);
        incrementUsage(userPhone, eventName);
        console.log(`📥 Job queued: ${filename}`);
        return { filePrefix: ts, parentJobId: null };
    }

    // Multi-variant: one parentJobId, N sibling job files, usage counted ONCE
    const parentJobId = ts;
    for (let i = 1; i <= variantsRequested; i++) {
        const variantPrefix = `${ts}-v${i}`;
        const job = {
            ...baseJob,
            filePrefix: variantPrefix,
            parentJobId,
            variantId: variantPrefix,
            variantIndex: i,
            variantCount: variantsRequested,
        };
        const filename = `${variantPrefix}.json`;
        const jobPath = path.join(PENDING_DIR, filename);
        const tmpPath = jobPath + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmpPath, JSON.stringify(job));
        fs.renameSync(tmpPath, jobPath);
    }
    incrementUsage(userPhone, eventName); // count ONCE for the parent
    console.log(`📥 Multi-variant job queued: ${parentJobId} (${variantsRequested} variants)`);
    return { filePrefix: `${parentJobId}-v1`, parentJobId };
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
                    if (!job.reprint) decrementUsage(job.userPhone, job.eventName);
                    // Send MMS as fallback — user should still get their digital portrait
                    try { await sendPrintCompletionMms(job, filename, null); } catch (e) {
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

    // NOTE: Previously this block auto-approved every pending review item
    // whose event had reviewMode !== "human" at boot. That caused a real
    // data-loss incident — a container restart (e.g. deploy) silently
    // flushed 12 pending reviews because getForEvent returned "off" for
    // an event the operator believed was "human". Whether that was due
    // to stale overrides, a race in settings.load, or a human edit
    // elsewhere, the correct behavior at boot is to leave the queue
    // alone. In-session toggles (admin flipping review off) are handled
    // explicitly by lib/review-settings.js, which is the only path that
    // should ever trigger a bulk auto-approve.
    //
    // If you really need to clear a stale review queue, do it from the
    // dashboard UI — not automatically on restart.

    // Recover non-permanent failed jobs
    try {
        const failed = (await fsp.readdir(FAILED_DIR)).filter((f) => f.endsWith(".json"));
        for (const filename of failed) {
            const src = path.join(FAILED_DIR, filename);
            try {
                const job = await readJobAsync(src);
                if (job.permanent || job.failReason) continue;
                job.retries = 0;

                if (hasOutputFile(job)) {
                    // Image already generated, just needs printing
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(READY_DIR, filename));
                    console.log(`♻️  Recovered failed job to print queue: ${filename}`);
                } else {
                    await writeJobAsync(src, job);
                    await fsp.rename(src, path.join(PENDING_DIR, filename));
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

// Sweep GENERATING_DIR for jobs whose worker has clearly died or hung. A
// healthy generation call returns within ~30-60s; anything much older is a
// stuck job that will never resolve on its own.
//
// Why this exists: recoverStaleJobs only runs at boot. If the server stays
// up but a generation call hangs indefinitely (TCP black-hole, OpenAI
// timeout with no error bubble-up, worker promise orphaned by an uncaught
// rejection), the job file stays in GENERATING_DIR forever with no one
// processing it. Users see "REGENERATING" spinner forever on the review
// card; operators have to hand-fix the file share.
//
// Called from the existing generation poll (index.js) alongside
// processGenerationQueue. Idempotent, safe to call every poll.
const GENERATING_STALE_MS = 5 * 60 * 1000; // 5 minutes

async function sweepStaleGenerating() {
    let files;
    try { files = (await fsp.readdir(GENERATING_DIR)).filter((f) => f.endsWith(".json")); } catch { return; }
    if (files.length === 0) return;
    const now = Date.now();
    for (const filename of files) {
        const src = path.join(GENERATING_DIR, filename);
        try {
            const job = await readJobAsync(src);
            const startedAt = job.generatingAt || job.stateChangedAt || 0;
            if (!startedAt || (now - startedAt) < GENERATING_STALE_MS) continue;
            console.log(`⏰ Stale generating job (${Math.round((now - startedAt) / 1000)}s old): ${filename}`);
            // Route through the same recovery path used at boot — increments
            // retries, re-queues to pending or moves to failed after
            // MAX_RETRIES, restores staged output to ready if it already
            // exists. Consistent semantics with crash recovery.
            job.retries++;
            if (job.retries >= MAX_RETRIES) {
                job.failReason = job.failReason || "stale_generating";
                await writeJobAsync(src, job);
                await fsp.rename(src, path.join(FAILED_DIR, filename));
                console.log(`💀 Stale generating job exceeded retries, moved to failed: ${filename}`);
            } else if (hasOutputFile(job)) {
                job.retries = 0;
                await writeJobAsync(src, job);
                await fsp.rename(src, path.join(READY_DIR, filename));
                console.log(`♻️  Recovered stale generating job to print queue (image exists): ${filename}`);
            } else {
                await writeJobAsync(src, job);
                await fsp.rename(src, path.join(PENDING_DIR, filename));
                console.log(`♻️  Recovered stale generating job (retry ${job.retries}): ${filename}`);
            }
        } catch (err) {
            console.error(`⚠️  Sweep stale generating error for ${filename}: ${err.message}`);
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

        // Did a sibling pickVariant/rejectParent run while we were generating?
        // If so, the parent decision has already happened and this output is
        // stale. Re-read the on-disk job to pick up any SUPERSEDED flag
        // written by pickVariant — the in-memory `job` was read before
        // generation started and wouldn't see it.
        if (job.parentJobId) {
            try {
                const fresh = await readJobAsync(generatingPath);
                if (fresh.variantStatus === "SUPERSEDED") {
                    // Preserve the supersede metadata the picker wrote, merge
                    // in our failure reason, drop the staged output, and park
                    // the job in FAILED_DIR. The user already got their image
                    // from whichever sibling was picked.
                    fresh.stateChangedAt = genDoneAt;
                    await cleanupStaged(fresh);
                    await writeJobAsync(generatingPath, fresh);
                    await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                    invalidateReviewCache();
                    console.log(`⏭️  Generation discarded — sibling already picked: ${filename}`);
                    return;
                }
            } catch (readErr) {
                // Non-fatal: fall through to normal flow. The worst case is
                // the ghost-card bug we already tolerated before this check.
                console.error(`⚠️  Supersede-check read failed for ${filename}: ${readErr.message}`);
            }
        }

        // Determine review mode: new reviewMode setting, or fall back to legacy enableManualReview
        const reviewMode = settings.getForEvent("reviewMode", job.eventName) ||
            (settings.getForEvent("enableManualReview", job.eventName) ? "human" : "off");

        if (reviewMode === "ai") {
            // Multi-variant AI mode: defer the AI pick until all siblings are
            // terminal, then run a single best-of-N comparison across the whole
            // parent group. Each sibling parks in REVIEW_DIR (same as human
            // mode) while it waits.
            if (job.parentJobId) {
                job.reviewAt = genDoneAt;
                job.variantStatus = "READY";
                await writeJobAsync(generatingPath, job);
                await fsp.rename(generatingPath, path.join(REVIEW_DIR, filename));
                invalidateReviewCache();
                console.log(`🤖 Variant ready, awaiting AI best-of-N: ${filename}`);
                // Fire-and-forget: if this is the last sibling, the coordinator
                // picks the winner and promotes it; otherwise it's a no-op.
                maybeRunAiBestOfN(job.parentJobId).catch((err) => {
                    console.error(`❌ AI best-of-N coordinator error: ${err.message}`);
                });
                return;
            }
            // AI review: automated quality check (legacy single-variant path)
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
                    stillWorking.cancel(job.userPhone);
                    if (!job.noDelivery) {
                        sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("reviewFailed", job.eventName))
                            .catch((err) => console.error(`❌ AI review rejection SMS failed: ${err.message}`));
                    }
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
                    stillWorking.cancel(job.userPhone);
                    if (!job.noDelivery) {
                        sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("reviewFailed", job.eventName))
                            .catch((e) => console.error(`❌ AI review failure SMS failed: ${e.message}`));
                    }
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
            if (job.parentJobId) job.variantStatus = "READY";
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(REVIEW_DIR, filename));
            invalidateReviewCache();
            console.log(`\n🚨🚨🚨 AWAITING MANUAL REVIEW — ${filename} 🚨🚨🚨\n`);
            return;
        }

        // No review, AI passed, or AI soft-fail — proceed to delivery
        if (settings.getForEvent("enablePrinting", job.eventName)) {
            // Printing enabled: move staged images to final downloads
            await moveStagedToFinal(job);
            job.readyAt = genDoneAt;

            // Set smsSentAt BEFORE rename so the print queue can't pick up
            // the job without the flag (prevents duplicate SMS)
            if (settings.getForEvent("immediateDigitalDelivery", job.eventName)) {
                job.smsSentAt = Date.now();
            }

            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(READY_DIR, filename));
            console.log(`✅ Generation complete: ${filename}`);

            // Send digital copy immediately if enabled (don't wait for print)
            if (job.smsSentAt) {
                try {
                    await sendDigitalDelivery(job, filename, "deliveryDigital", READY_DIR);
                } catch (smsErr) {
                    // Clear smsSentAt so print-completion MMS still fires as fallback.
                    // Only write if the job is still in READY_DIR (print queue may have claimed it).
                    console.error(`❌ Immediate digital delivery failed for ${filename}: ${smsErr.message}`);
                    const readyPath = path.join(READY_DIR, filename);
                    if (fs.existsSync(readyPath)) {
                        job.smsSentAt = undefined;
                        await writeJobAsync(readyPath, job).catch(() => {});
                    }
                }
            }
        } else {
            // Digital only: move staged images to final, send MMS, move to done
            await moveStagedToFinal(job);
            job.completedAt = genDoneAt;
            await writeJobAsync(generatingPath, job);
            await fsp.rename(generatingPath, path.join(DONE_DIR, filename));
            console.log(`✅ Generation complete (digital delivery): ${filename}`);

            try {
                await sendDigitalDelivery(job, filename, "deliveryDigital", DONE_DIR);
            } catch (smsErr) {
                console.error(`❌ Digital delivery failed for ${filename}: ${smsErr.message}`);
            }
        }
    } catch (error) {
        console.error(`❌ Generation failed: ${filename} - ${error.message}`);
        if (error.response)
            console.error("❌ API error details:", error.response.data);

        try {
            const now = Date.now();
            const jobRead = await readJobAsync(generatingPath);
            const isVariantSibling = !!jobRead.parentJobId;

            if (error.permanent) {
                jobRead.permanent = true;
                jobRead.failReason = error.failReason || "content_rejected";
                jobRead.stateChangedAt = now;
                await cleanupStaged(jobRead);
                if (isVariantSibling) {
                    // Variant sibling: keep in REVIEW_DIR as FAILED so aggregation
                    // can show the card when all siblings are terminal. Usage is
                    // counted/decremented at parent level (when card is rejected).
                    jobRead.variantStatus = "FAILED";
                    jobRead.reviewAt = jobRead.reviewAt || now;
                    await writeJobAsync(generatingPath, jobRead);
                    await fsp.rename(generatingPath, path.join(REVIEW_DIR, filename));
                    invalidateReviewCache();
                    console.log(`⚠️  Variant failed (kept in review for aggregation): ${filename}`);
                } else {
                    decrementUsage(jobRead.userPhone, jobRead.eventName);
                    await writeJobAsync(generatingPath, jobRead);
                    await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                    stillWorking.cancel(jobRead.userPhone);
                    console.log(`🚫 Job permanently failed: ${filename}`);
                }
            } else {
                jobRead.retries++;
                jobRead.stateChangedAt = now;
                if (jobRead.retries >= MAX_RETRIES) {
                    jobRead.failReason = "generation";
                    await cleanupStaged(jobRead);
                    if (isVariantSibling) {
                        jobRead.variantStatus = "FAILED";
                        jobRead.reviewAt = jobRead.reviewAt || now;
                        await writeJobAsync(generatingPath, jobRead);
                        await fsp.rename(generatingPath, path.join(REVIEW_DIR, filename));
                        invalidateReviewCache();
                        console.log(`⚠️  Variant failed after retries (kept in review): ${filename}`);
                    } else {
                        decrementUsage(jobRead.userPhone, jobRead.eventName);
                        await writeJobAsync(generatingPath, jobRead);
                        await fsp.rename(generatingPath, path.join(FAILED_DIR, filename));
                        console.log(`💀 Generation exceeded max retries, moved to failed: ${filename}`);
                        // Cancel the reassurance timer BEFORE sending the
                        // failure SMS so the user never gets "still working"
                        // after "couldn't generate" (minute-later contradiction).
                        stillWorking.cancel(jobRead.userPhone);
                        // Notify user their image failed
                        if (!jobRead.noDelivery) {
                            sendSms(jobRead.userPhone, jobRead.appPhone,
                                "Sorry, we couldn't generate your AI portrait this time. Please try sending your photo again!")
                                .catch((err) => console.error(`❌ Failure notification failed: ${err.message}`));
                        }
                    }
                } else {
                    await cleanupStaged(jobRead);
                    await writeJobAsync(generatingPath, jobRead);
                    await fsp.rename(generatingPath, path.join(PENDING_DIR, filename));
                    console.log(`🔄 Generation re-queued (retry ${jobRead.retries}): ${filename}`);
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

const RELAY_STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes — fallback for heartbeat-less relays
const RELAY_HEARTBEAT_STALE = 60 * 1000;      // 60 seconds — fast recovery when heartbeats stop
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

            // Two-tier threshold for relay mode:
            // 1. If heartbeats are present (relay ≥ v1.1), recover as soon as
            //    beats stop for >60s — the relay is dead or wedged.
            // 2. If no heartbeats (old relay or first-beat not arrived yet),
            //    fall back to the original 15-min age-of-printingAt. This
            //    keeps older deployed relays working without regression.
            const isRelayMode = !!settings.get("printRelayKey");
            if (isRelayMode) {
                if (job.lastHeartbeatAt) {
                    if ((now - job.lastHeartbeatAt) < RELAY_HEARTBEAT_STALE) continue;
                } else {
                    if ((now - job.printingAt) < RELAY_STALE_THRESHOLD) continue;
                }
            } else {
                if ((now - job.printingAt) < LOCAL_STALE_THRESHOLD) continue;
            }

            job.staleRecoveries = (job.staleRecoveries || 0) + 1;
            job.stateChangedAt = now;
            if (job.staleRecoveries >= MAX_STALE_RECOVERIES) {
                job.failReason = "relay_stale";
                if (!job.reprint) decrementUsage(job.userPhone, job.eventName);
                // Send MMS as fallback — user should still get their digital portrait
                try { await sendPrintCompletionMms(job, filename, null); } catch (e) {
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

// Auto-clear targetPrinter on ready jobs aimed at relay printers that went offline.
// Prevents jobs from sitting stuck when a relay laptop disconnects.
const RELAY_TARGET_STALE_AGE = 2 * 60 * 1000; // 2 minutes
async function clearStaleRelayTargets() {
    if (!settings.get("printRelayKey")) return; // only relevant in relay mode
    let relayList;
    try {
        const { getRelayPrinters } = require("./print-relay");
        relayList = getRelayPrinters();
    } catch { return; }

    const aliveNames = new Set(relayList.map(rp => rp.name));
    let ready;
    try { ready = (await fsp.readdir(READY_DIR)).filter(f => f.endsWith(".json")); } catch { return; }

    for (const filename of ready) {
        const fp = path.join(READY_DIR, filename);
        try {
            const job = JSON.parse(await fsp.readFile(fp, "utf-8"));
            if (!job.targetPrinter) continue;
            if (aliveNames.has(job.targetPrinter)) continue;
            // Target printer hasn't checked in — check if the job has been waiting long enough
            if (job.stateChangedAt && (Date.now() - job.stateChangedAt) < RELAY_TARGET_STALE_AGE) continue;
            delete job.targetPrinter;
            // Guard: if the file was claimed (renamed away) between read and write,
            // discard the tmp to avoid creating a ghost duplicate in READY_DIR
            const tmp = fp + `.tmp.${process.pid}.${Date.now()}`;
            await fsp.writeFile(tmp, JSON.stringify(job));
            try {
                await fsp.access(fp);
                await fsp.rename(tmp, fp);
            } catch {
                await fsp.unlink(tmp).catch(() => {});
                continue;
            }
            console.log(`🔓 Cleared stale targetPrinter on ${filename} (relay printer offline)`);
        } catch (e) {
            if (e.code !== "ENOENT") { /* skip */ }
        }
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

    // Smart dispatch: read job metadata to avoid failed printers and respect targetPrinter
    const usedPrinters = new Set();
    for (const filename of ready) {
        if (usedPrinters.size >= idlePrinters.length) break;

        let job;
        try { job = JSON.parse(await fsp.readFile(path.join(READY_DIR, filename), "utf-8")); } catch { continue; }

        const failed = job.failedPrinters || [];
        const target = job.targetPrinter || null;

        // Find the best idle printer for this job
        let bestPrinter = null;
        for (const p of idlePrinters) {
            if (usedPrinters.has(p)) continue;
            if (target && p !== target) continue; // targetPrinter set but doesn't match
            if (!target && failed.includes(p)) continue; // skip printers that failed this job
            bestPrinter = p;
            break;
        }

        // If no preferred printer found, fall back to any idle printer (even previously failed)
        if (!bestPrinter && !target) {
            for (const p of idlePrinters) {
                if (usedPrinters.has(p)) continue;
                bestPrinter = p;
                break;
            }
        }

        if (!bestPrinter) continue; // no printer available for this job (e.g., target printer is busy)

        usedPrinters.add(bestPrinter);
        printerBusy.set(bestPrinter, true);
        processSinglePrint(filename, bestPrinter).finally(() => {
            printerBusy.set(bestPrinter, false);
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
        delete job.targetPrinter; // Clear targeting after successful print
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
            job.failedPrinters = [...(job.failedPrinters || []), printerName];
            if (job.retries >= MAX_RETRIES) {
                job.failReason = "printer";
                if (!job.reprint) decrementUsage(job.userPhone, job.eventName);
                // Send MMS as fallback — user should still get their digital portrait
                try { await sendPrintCompletionMms(job, filename, null); } catch (e) {
                    console.error(`❌ Fallback MMS failed for ${filename}: ${e.message}`);
                }
                await writeJobAsync(printingPath, job);
                await fsp.rename(printingPath, path.join(FAILED_DIR, filename));
                console.log(`💀 Print exceeded max retries, moved to failed (MMS sent as fallback): ${filename}`);
            } else {
                delete job.targetPrinter; // Let smart dispatch pick a different printer
                await writeJobAsync(printingPath, job);
                await fsp.rename(printingPath, path.join(READY_DIR, filename));
                console.log(`🔄 Print re-queued (retry ${job.retries}): ${filename}`);
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    }
}

// ── Digital delivery helper (shared by generation, print completion, and review approval) ──

async function sendDigitalDelivery(job, filename, templateKey, jobDir) {
    const ev = job.eventName;
    // API / kiosk jobs have no real recipient — skip every SMS side effect
    // (delivery MMS, promo, NPS, lead survey). The generated image is served
    // via /images/<prefix>_output_mms.jpg and the share page handles handoff.
    if (job.noDelivery) return;
    // Cancel any pending "still working" SMS BEFORE we send delivery — prevents
    // the user getting both messages back-to-back if the timer fires mid-send.
    stillWorking.cancel(job.userPhone);
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
        const quotaUnlimited = settings.isUnlimitedQuota(maxPrints);
        const remaining = maxPrints - (usageCache.get(usageKey(job.userPhone, ev)) || 0);
        const unlimited = (isAdmin(job.userPhone) && testing) || quotaUnlimited;
        // Unlimited quota suppresses all count-related suffixes (remaining,
        // lastPortrait). Users never see counts or "last one" notes when
        // quota is effectively infinite.
        if (!quotaUnlimited) {
            if (templateKey === "deliveryPrint") {
                if (remaining > 0 || unlimited) {
                    suffix = ` ${settings.getMsgForEvent("remainingCount", ev, { remaining, unit: remaining === 1 ? "print" : "prints" })}`;
                } else if (maxPrints > 1) {
                    suffix = ` ${settings.getMsgForEvent("lastPortrait", ev)}`;
                }
            } else {
                if (remaining <= 0 && !unlimited && maxPrints > 1) {
                    suffix = ` ${settings.getMsgForEvent("lastPortrait", ev)}`;
                }
            }
        }
    }

    const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
    const shareLinks = await buildShareMessage(job);
    const skipMms = shareLinks && settings.getForEvent("sharePageOnly", ev) === true;
    const mmsBody = `${settings.getMsgForEvent(templateKey, ev, { styleName: jobStyleName })}${suffix}${shareLinks}`;
    const leadMode = settings.getForEvent("leadCaptureMode", ev);

    const leadSurveyStarted = leadMode === "after" && !adminShortcut
        && !leads.isCompleted(job.userPhone, ev)
        && !leads.isActive(job.userPhone);

    if (leadSurveyStarted) {
        await leads.startSurvey(job.userPhone, job.appPhone, ev, "after", {
            body: mmsBody,
            mediaUrl: skipMms ? null : imageUrl,
        });
    } else {
        await sendSms(job.userPhone, job.appPhone, mmsBody, skipMms ? null : imageUrl)
            .catch((err) => console.error(`❌ MMS delivery failed: ${filename} - ${err.message}`));
    }

    // Persist shareUrl to job so share page can use the short link
    if (job.shareUrl && jobDir) {
        await writeJobAsync(path.join(jobDir, filename), job);
    }

    if (!leadSurveyStarted) {
        // Send standalone promo after a brief delay
        const promoText = settings.getForEvent("enablePromoMessage", ev) ? settings.getForEvent("promoMessage", ev) : "";
        if (promoText && !adminShortcut) {
            setTimeout(() => sendSms(job.userPhone, job.appPhone, promoText).catch((e) => console.error(`❌ Promo SMS failed: ${e.message}`)), 15000);
        }

        // NPS survey after last print (skip entirely when quota is unlimited —
        // there is no "last print" to trigger on)
        if (settings.getForEvent("enableNps", ev) && !adminShortcut && !nps.hasCompleted(job.userPhone, ev)) {
            const maxPrintsNps = settings.getForEvent("maxPrints", ev);
            const quotaUnlimited = settings.isUnlimitedQuota(maxPrintsNps);
            const remaining = maxPrintsNps - (usageCache.get(usageKey(job.userPhone, ev)) || 0);
            const unlimited = (isAdmin(job.userPhone) && testing) || quotaUnlimited;
            if (remaining <= 0 && !unlimited) {
                const delay = (settings.getForEvent("npsDelay", ev) || 30) * 1000;
                setTimeout(() => {
                    nps.markPending(job.userPhone);
                    sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("npsPrompt", ev))
                        .catch((e) => console.error(`❌ NPS SMS failed: ${e.message}`));
                }, delay);
            }
        }
    }
}

// ── Print completion MMS (shared by local print worker and relay) ────────────

async function sendPrintCompletionMms(job, filename, jobDir) {
    if (job.smsSentAt) return; // SMS already sent via immediate digital delivery
    // jobDir defaults to DONE_DIR for normal completion; callers from failure
    // paths should pass null to avoid writing a ghost file to the wrong directory
    await sendDigitalDelivery(job, filename, "deliveryPrint", jobDir !== undefined ? jobDir : DONE_DIR);
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
        // Load all sibling/singleton jobs from REVIEW_DIR (the primary source).
        const reviewFiles = (await fsp.readdir(REVIEW_DIR)).filter(f => f.endsWith(".json")).sort();
        const singletons = [];
        const variantGroups = new Map(); // parentJobId -> [{ ...job, _filename, _location: "review" }]
        for (const filename of reviewFiles) {
            try {
                const job = await readJobAsync(path.join(REVIEW_DIR, filename));
                if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
                if (job.parentJobId) {
                    if (!variantGroups.has(job.parentJobId)) variantGroups.set(job.parentJobId, []);
                    variantGroups.get(job.parentJobId).push({ ...job, _filename: filename, _location: "review" });
                } else {
                    singletons.push({ ...job, _filename: filename });
                }
            } catch {}
        }

        // ALSO scan PENDING_DIR and GENERATING_DIR for variant siblings whose
        // parent is already partially surfaced. This is what makes per-variant
        // Regen show a loading placeholder instead of hiding the entire card:
        // the regenerating variant lives temporarily in pending/generating, but
        // we still want the card to show its other siblings.
        for (const [dir, loc] of [[PENDING_DIR, "pending"], [GENERATING_DIR, "generating"]]) {
            let list;
            try { list = (await fsp.readdir(dir)).filter(f => f.endsWith(".json")); } catch { continue; }
            for (const filename of list) {
                try {
                    const job = await readJobAsync(path.join(dir, filename));
                    if (!job.parentJobId) continue; // only siblings — plain pending jobs aren't review items
                    if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
                    // Only surface if the parent already has at least one sibling in review.
                    // This avoids showing cards that haven't had their first reviewable
                    // variant land yet (initial fan-out still in progress).
                    if (!variantGroups.has(job.parentJobId)) continue;
                    variantGroups.get(job.parentJobId).push({ ...job, _filename: filename, _location: loc });
                } catch {}
            }
        }

        const result = [];

        // Singletons render as legacy single-variant cards (parentJobId absent on response)
        for (const job of singletons) {
            result.push({
                filename: job._filename,
                userPhone: job.userPhone,
                style: job.style,
                eventName: job.eventName,
                reviewAt: job.reviewAt,
                filePrefix: job.filePrefix,
                retries: job.retries || 0,
            });
        }

        // Variant groups: one parent-level card each. Card surfaces once at
        // least one sibling has reached terminal state (READY or FAILED) in
        // REVIEW_DIR. Slots for siblings currently mid-regen (in pending or
        // generating) render as REGENERATING placeholders so the reviewer sees
        // the card continuously during a regen rather than having it disappear.
        for (const [parentJobId, siblings] of variantGroups) {
            const expectedCount = siblings[0].variantCount || siblings.length;
            // Hide the card only during the INITIAL fan-out — when no siblings
            // have reached REVIEW_DIR yet. Once any sibling is in review, show
            // the card with placeholders for the others.
            const anyInReview = siblings.some((s) => s._location === "review");
            if (!anyInReview) continue;
            // If the total sibling count doesn't match expected (e.g., a
            // variant failed and got deleted permanently outside of the normal
            // regen flow), still render with what we have.
            const variants = siblings
                .sort((a, b) => (a.variantIndex || 0) - (b.variantIndex || 0))
                .map((v) => ({
                    variantId: v.variantId || v.filePrefix,
                    variantIndex: v.variantIndex,
                    filename: v._filename,
                    filePrefix: v.filePrefix,
                    // A sibling in REVIEW_DIR is terminal (READY / FAILED /
                    // SUPERSEDED). A sibling in pending/generating is still
                    // in flight — "REGENERATING" only if the reviewer
                    // actually clicked Regen (regenCount > 0), otherwise
                    // it's the initial fan-out still completing and we
                    // should say so. The two states use different
                    // placeholder copy in the UI.
                    status: v._location === "review"
                        ? (v.variantStatus || "READY")
                        : ((v.regenCount || 0) > 0 ? "REGENERATING" : "GENERATING"),
                    failReason: v.failReason || null,
                    generatedAt: v.reviewAt || null,
                    regenCount: v.regenCount || 0,
                }));

            const reviewSiblings = siblings.filter((s) => s._location === "review");
            const first = reviewSiblings[0] || siblings[0];
            const earliestReviewAt = Math.min(...siblings.map((s) => s.reviewAt || Infinity));
            const regenLimit = Math.max(1, Math.min(5,
                Number(settings.getForEvent("regenerationLimit", first.eventName)) || 2));
            result.push({
                parentJobId,
                userPhone: first.userPhone,
                style: first.style,
                eventName: first.eventName,
                reviewAt: Number.isFinite(earliestReviewAt) ? earliestReviewAt : null,
                filePrefix: first.filePrefix,
                variantCount: expectedCount,
                regenerationLimit: regenLimit,
                variants,
            });
        }

        result.sort((a, b) => (a.reviewAt || 0) - (b.reviewAt || 0));

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

        // Set smsSentAt BEFORE rename so the print queue can't pick up
        // the job without the flag (prevents duplicate SMS)
        if (settings.getForEvent("immediateDigitalDelivery", ev)) {
            job.smsSentAt = Date.now();
        }

        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(READY_DIR, filename));
        console.log(`✅ Review approved (to print): ${filename}`);

        // Send digital copy immediately if enabled (don't wait for print)
        if (job.smsSentAt) {
            try {
                await sendDigitalDelivery(job, filename, "deliveryDigital", READY_DIR);
            } catch (smsErr) {
                // Clear smsSentAt so print-completion MMS still fires as fallback.
                // Only write if the job is still in READY_DIR (print queue may have claimed it).
                console.error(`❌ Immediate digital delivery failed for ${filename}: ${smsErr.message}`);
                const readyPath = path.join(READY_DIR, filename);
                if (fs.existsSync(readyPath)) {
                    job.smsSentAt = undefined;
                    await writeJobAsync(readyPath, job).catch(() => {});
                }
            }
        }
    } else {
        job.completedAt = now;
        await writeJobAsync(reviewPath, job);
        await fsp.rename(reviewPath, path.join(DONE_DIR, filename));
        console.log(`✅ Review approved (digital delivery): ${filename}`);

        try {
            await sendDigitalDelivery(job, filename, "deliveryDigital", DONE_DIR);
        } catch (smsErr) {
            console.error(`❌ Digital delivery failed for ${filename}: ${smsErr.message}`);
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
            if (!job.noDelivery) {
                sendSms(job.userPhone, job.appPhone, settings.getMsgForEvent("reviewFailed", job.eventName))
                    .catch((err) => console.error(`❌ Rejection notification failed: ${err.message}`));
            }
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
        if (message && !job.noDelivery) {
            sendSms(job.userPhone, job.appPhone, message)
                .catch((err) => console.error(`❌ Review SMS failed: ${err.message}`));
        }
    }
}

// ── Multi-variant Review Operations ─────────────────────────────────────────

// Find every sibling of a parent job, no matter where in the pipeline it is.
// A variant can legitimately be in:
//   REVIEW_DIR     — ready, awaiting reviewer decision
//   PENDING_DIR    — queued for generation (e.g. regen just requested)
//   GENERATING_DIR — actively being generated by the worker right now
// Callers that act on the parent (pickVariant, regenerateVariant, rejectParent)
// must see siblings in all three so they can't miss an in-flight regen and
// produce a ghost review card when it finishes.
async function _findVariantSiblings(parentJobId) {
    const out = [];
    const dirs = [
        { dir: REVIEW_DIR, location: "review" },
        { dir: PENDING_DIR, location: "pending" },
        { dir: GENERATING_DIR, location: "generating" },
    ];
    for (const { dir, location } of dirs) {
        try {
            const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
            for (const filename of files) {
                try {
                    const job = await readJobAsync(path.join(dir, filename));
                    if (job.parentJobId === parentJobId) {
                        out.push({ filename, job, location });
                    }
                } catch {}
            }
        } catch {}
    }
    return out;
}

// Mark a sibling as terminal (superseded / rejected / reanalyzed) no matter
// where it is in the pipeline. Sibling location matters:
//   review    — safe to move out of REVIEW_DIR → FAILED_DIR
//   pending   — queued but not claimed; move before the worker can pick it up
//   generating— worker owns the file; only flip the flag in place. The
//              worker's processGeneration success path re-reads the job and
//              drops the output when variantStatus === "SUPERSEDED".
// Staged output is cleaned up for review/pending (where no one is actively
// writing to it) but left alone for generating (the worker is).
async function _markSiblingTerminal(sib, failReason, now) {
    // "SUPERSEDED" covers both picked-another-variant (failReason="superseded")
    // and re-analyze-the-parent (failReason="reanalyzed") — the variant still
    // exists in lineage, just no longer relevant. "REJECTED" is reserved for
    // the reviewer explicitly discarding all variants (failReason=
    // "review_rejected").
    sib.job.variantStatus = failReason === "review_rejected" ? "REJECTED" : "SUPERSEDED";
    sib.job.failReason = failReason;
    sib.job.permanent = true;
    sib.job.stateChangedAt = now;
    const srcDir = sib.location === "review" ? REVIEW_DIR
        : sib.location === "pending" ? PENDING_DIR
        : GENERATING_DIR;
    const src = path.join(srcDir, sib.filename);
    await writeJobAsync(src, sib.job);
    if (sib.location === "generating") return;
    await cleanupStaged(sib.job);
    await fsp.rename(src, path.join(FAILED_DIR, sib.filename));
}

// Approve one variant of a multi-variant review card. Promotes the chosen
// variant through the normal approve path and supersedes its siblings (staged
// files deleted, job files moved to FAILED_DIR with failReason="superseded").
// Usage is NOT decremented for superseded siblings — the parent counts once.
async function pickVariant(parentJobId, variantId) {
    invalidateReviewCache();
    const siblings = await _findVariantSiblings(parentJobId);
    if (siblings.length === 0) {
        const err = new Error("Parent job not found or already decided");
        err.code = "ALREADY_DECIDED";
        throw err;
    }
    const chosen = siblings.find((s) => (s.job.variantId || s.job.filePrefix) === variantId);
    if (!chosen) {
        const err = new Error("Variant not found in parent job");
        err.code = "VARIANT_NOT_FOUND";
        throw err;
    }
    if (chosen.job.variantStatus === "FAILED") {
        const err = new Error("Cannot pick a failed variant");
        err.code = "VARIANT_FAILED";
        throw err;
    }
    if (chosen.location !== "review") {
        // The chosen variant is mid-regeneration or freshly re-queued. Its
        // staged output doesn't exist yet (or is partial), so we can't
        // promote it. The reviewer can pick it once the regen lands in
        // REVIEW_DIR.
        const err = new Error("Cannot approve a variant that is still regenerating");
        err.code = "VARIANT_NOT_READY";
        throw err;
    }

    // Supersede siblings first. Do this BEFORE promoting the winner so that
    // any concurrent call sees an empty sibling set.
    const now = Date.now();
    for (const sib of siblings) {
        if (sib.filename === chosen.filename) continue;
        try {
            await _markSiblingTerminal(sib, "superseded", now);
        } catch (err) {
            console.error(`⚠️  Failed to supersede sibling ${sib.filename}: ${err.message}`);
        }
    }

    // Promote the winner via the standard approve flow
    await approveJob(chosen.filename);
    console.log(`🏆 Variant picked: ${chosen.filename} (parent=${parentJobId})`);

    // Audit: record which variant won + decision latency + regen counts.
    // Training data for future AI-picks-best-of-N.
    const pickedJob = chosen.job;
    const timeToDecisionMs = pickedJob.reviewAt ? (now - pickedJob.reviewAt) : null;
    const regenerationsPerVariant = {};
    let regenerationsUsed = 0;
    for (const sib of siblings) {
        const idx = sib.job.variantIndex || 0;
        const count = sib.job.regenCount || 0;
        regenerationsPerVariant["v" + idx] = count;
        regenerationsUsed += count;
    }
    audit.logEvent("variant.pick", pickedJob.eventName, {
        parentJobId,
        pickedVariantId: chosen.job.variantId || chosen.job.filePrefix,
        pickedVariantIndex: chosen.job.variantIndex,
        siblingVariantIds: siblings
            .filter((s) => s.filename !== chosen.filename)
            .map((s) => s.job.variantId || s.job.filePrefix),
        variantCount: siblings[0].job.variantCount || siblings.length,
        style: pickedJob.style,
        brand: pickedJob.brand || null,
        background: pickedJob.background || null,
        timeToDecisionMs,
        regenerationsUsed,
        regenerationsPerVariant,
    }).catch(() => {});
}

// Regenerate a single variant of a multi-variant review card. Deletes the
// staged output, clears failure/cached state, and moves the job back to
// PENDING_DIR so the generation worker picks it up. Siblings are untouched.
// Enforces per-variant regenerationLimit to prevent runaway loops.
async function regenerateVariant(parentJobId, variantId) {
    invalidateReviewCache();
    const siblings = await _findVariantSiblings(parentJobId);
    const target = siblings.find((s) => (s.job.variantId || s.job.filePrefix) === variantId);
    if (!target) {
        const err = new Error("Variant not found in review queue");
        err.code = "VARIANT_NOT_FOUND";
        throw err;
    }
    if (target.location !== "review") {
        // The variant is already being regenerated — don't stack a second
        // regen on top of an in-flight one. The reviewer can regen again
        // once the current pass lands in REVIEW_DIR.
        const err = new Error("Variant is already regenerating");
        err.code = "VARIANT_ALREADY_REGENERATING";
        throw err;
    }

    const src = path.join(REVIEW_DIR, target.filename);
    const job = target.job;

    const limit = Math.max(1, Math.min(5,
        Number(settings.getForEvent("regenerationLimit", job.eventName)) || 2));
    const usedSoFar = job.regenCount || 0;
    if (usedSoFar >= limit) {
        const err = new Error("Regeneration limit reached for this variant");
        err.code = "REGEN_LIMIT_REACHED";
        throw err;
    }

    await cleanupStaged(job);
    delete job.cachedScene;
    delete job.failReason;
    delete job.permanent;
    delete job.variantStatus;
    delete job.reviewAt;
    job.retries = 0;
    job.regenCount = usedSoFar + 1;
    job.stateChangedAt = Date.now();

    await writeJobAsync(src, job);
    await fsp.rename(src, path.join(PENDING_DIR, target.filename));
    console.log(`🔄 Variant regenerate requested: ${target.filename} (${job.regenCount}/${limit})`);

    audit.logEvent("variant.regenerate", job.eventName, {
        parentJobId,
        variantId: job.variantId || job.filePrefix,
        variantIndex: job.variantIndex,
        regenerationIndex: job.regenCount,
        regenerationLimit: limit,
    }).catch(() => {});
}

// Reject an entire multi-variant card. If reanalyze=true, a fresh set of
// variants is queued (new parentJobId); the old siblings are superseded.
// Usage is decremented ONCE at the parent level.
async function rejectParent(parentJobId, message, reanalyze, feedback) {
    invalidateReviewCache();
    const siblings = await _findVariantSiblings(parentJobId);
    if (siblings.length === 0) {
        const err = new Error("Parent job not found or already decided");
        err.code = "ALREADY_DECIDED";
        throw err;
    }

    const firstJob = siblings[0].job;
    const now = Date.now();

    if (reanalyze) {
        // Re-queue fresh siblings under a NEW parentJobId, preserving lineage
        // via reanalyzedFrom. Supersede all existing siblings.
        for (const sib of siblings) {
            try {
                await _markSiblingTerminal(sib, "reanalyzed", now);
            } catch (err) {
                console.error(`⚠️  Failed to supersede sibling ${sib.filename}: ${err.message}`);
            }
        }

        const newParentId = formatTimestamp(now);
        const variantCount = firstJob.variantCount || siblings.length;
        for (let i = 1; i <= variantCount; i++) {
            const variantPrefix = `${newParentId}-v${i}`;
            const newJob = {
                imageUrl: firstJob.imageUrl,
                messageSid: `${firstJob.messageSid}-reanalyze-${now}`,
                userPhone: firstJob.userPhone,
                appPhone: firstJob.appPhone,
                style: firstJob.style,
                baseUrl: firstJob.baseUrl || "",
                background: firstJob.background || null,
                brand: firstJob.brand || null,
                eventName: firstJob.eventName,
                retries: 0,
                createdAt: now,
                pendingAt: now,
                stateChangedAt: now,
                filePrefix: variantPrefix,
                parentJobId: newParentId,
                variantId: variantPrefix,
                variantIndex: i,
                variantCount,
                reanalyzedFrom: parentJobId,
                reviewFeedback: feedback || undefined,
            };
            if (firstJob.adminGenerated) newJob.adminGenerated = true;
            const filename = `${variantPrefix}.json`;
            const jobPath = path.join(PENDING_DIR, filename);
            const tmpPath = jobPath + `.tmp.${process.pid}.${_writeCounter++}`;
            fs.writeFileSync(tmpPath, JSON.stringify(newJob));
            fs.renameSync(tmpPath, jobPath);
        }
        // Usage is NOT re-incremented — the parent was counted once at original enqueue
        console.log(`🔄 Re-analyzed: ${parentJobId} → ${newParentId} (${variantCount} new variants)`);

        audit.logEvent("parent.reanalyze", firstJob.eventName, {
            oldParentJobId: parentJobId,
            newParentJobId: newParentId,
            variantCount,
            feedback: feedback || "",
            style: firstJob.style,
            brand: firstJob.brand || null,
        }).catch(() => {});
        return;
    }

    // Reject (with or without notify): kill all siblings, decrement usage once
    for (const sib of siblings) {
        try {
            await _markSiblingTerminal(sib, "review_rejected", now);
        } catch (err) {
            console.error(`⚠️  Failed to reject sibling ${sib.filename}: ${err.message}`);
        }
    }
    decrementUsage(firstJob.userPhone, firstJob.eventName);
    console.log(`🗑️  Parent rejected: ${parentJobId}`);
    if (message && !firstJob.noDelivery) {
        sendSms(firstJob.userPhone, firstJob.appPhone, message)
            .catch((err) => console.error(`❌ Review SMS failed: ${err.message}`));
    }

    audit.logEvent("parent.reject", firstJob.eventName, {
        parentJobId,
        variantCount: siblings.length,
        notified: !!message,
        style: firstJob.style,
    }).catch(() => {});
}

// In-memory guard: prevents multiple concurrent AI best-of-N coordinators
// racing for the same parent group. A single process instance can rely on
// this; multi-instance deployments would need a disk-backed flag, but the
// app currently runs as a single container.
const _aiBestOfNLocks = new Set();

// Called after each sibling lands in REVIEW_DIR under AI multi-variant mode.
// No-op until all expected siblings are terminal, at which point the best
// variant is auto-picked (or all are rejected). Errors are logged, never
// thrown — AI coordination must never break the user-facing flow.
async function maybeRunAiBestOfN(parentJobId) {
    if (_aiBestOfNLocks.has(parentJobId)) return;
    _aiBestOfNLocks.add(parentJobId);
    try {
        const siblings = await _findVariantSiblings(parentJobId);
        if (siblings.length === 0) return;
        const expected = siblings[0].job.variantCount || siblings.length;
        if (siblings.length < expected) return; // still generating

        // All terminal — mark the group as decided (on disk, for visibility
        // across restarts) and run the comparison.
        const first = siblings[0].job;
        if (first.aiBestOfNDecided) return; // already decided
        first.aiBestOfNDecided = true;
        await writeJobAsync(path.join(REVIEW_DIR, siblings[0].filename), first);

        console.log(`🤖 Running AI best-of-N for parent ${parentJobId} (${siblings.length} variants)`);

        const jobsInOrder = siblings
            .sort((a, b) => (a.job.variantIndex || 0) - (b.job.variantIndex || 0))
            .map((s) => s.job);

        let pickResult;
        try {
            pickResult = await aiPickBestVariant(jobsInOrder);
        } catch (err) {
            console.error(`❌ AI best-of-N call failed: ${err.message} — falling back to variant 1`);
            // Fallback: pick the first non-failed variant so the user still gets
            // something. This preserves the "AI mode never leaves a user hanging"
            // guarantee — AI infra failures should not stall delivery.
            const firstOk = jobsInOrder.find((j) => j.variantStatus !== "FAILED");
            if (firstOk) {
                pickResult = { winnerIndex: jobsInOrder.indexOf(firstOk), reason: `AI error: ${err.message} (fell back to first variant)` };
            } else {
                pickResult = { allFailed: true, reason: `AI error: ${err.message}` };
            }
        }

        audit.logEvent("variant.ai_pick", first.eventName, {
            parentJobId,
            variantCount: jobsInOrder.length,
            outcome: pickResult.allFailed ? "all_failed" : "picked",
            pickedVariantIndex: pickResult.winnerIndex != null ? (jobsInOrder[pickResult.winnerIndex]?.variantIndex || null) : null,
            reason: pickResult.reason,
            style: first.style,
        }).catch(() => {});

        if (pickResult.allFailed) {
            await rejectParent(parentJobId,
                settings.getMsgForEvent("reviewFailed", first.eventName),
                false, null);
            return;
        }

        const winner = jobsInOrder[pickResult.winnerIndex];
        const winnerVariantId = winner.variantId || winner.filePrefix;
        await pickVariant(parentJobId, winnerVariantId);
    } catch (err) {
        console.error(`❌ AI best-of-N coordinator failed for ${parentJobId}: ${err.message}`);
    } finally {
        _aiBestOfNLocks.delete(parentJobId);
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
    decrementUsage,
    moveJobsToEvent,
    enqueueJob,
    recoverStaleJobs,
    sweepStaleGenerating,
    processGenerationQueue,
    processPrintQueue,
    getPrinterBusyState,
    sendPrintCompletionMms,
    recoverStaleRelayJobs,
    clearStaleRelayTargets,
    getReviewQueue,
    pickVariant,
    regenerateVariant,
    rejectParent,
    approveJob,
    rejectJob,
};
