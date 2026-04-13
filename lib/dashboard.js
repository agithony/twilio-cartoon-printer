const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { exec } = require("child_process");
const express = require("express");
const PDFDocument = require("pdfkit");
const {
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    REVIEW_DIR,
    DONE_DIR,
    FAILED_DIR,
    getOpenAI,
} = require("./config");
const settings = require("./settings");
const { getPrinterBusyState, incrementUsage, getReviewQueue, approveJob, rejectJob, isAdmin, getAllUsers, resetUsage, toggleAdmin } = require("./queue");
const { jobPaths } = require("./pipeline");
const audit = require("./audit");
const leads = require("./leads");
const nps = require("./nps");
const { userBarSnippet } = require("./auth");
const QRCode = require("qrcode");
const { getRelayPrinters } = require("./print-relay");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

// ── Reference analysis cache invalidation ────────────────────────────────────
// When a reference file is uploaded or deleted, clear cached analysis so it
// regenerates on the next generation. Brands are global; styles and backgrounds
// are per-event (current event only — other events regenerate on demand).
function invalidateRefAnalysis(refType) {
    if (refType === "brand-reference") {
        const brands = settings.get("customBrands") || {};
        let changed = false;
        for (const key of Object.keys(brands)) {
            if (brands[key].analysis) { brands[key].analysis = ""; changed = true; }
        }
        if (changed) settings.update({ customBrands: brands });
    } else if (refType === "style-reference") {
        const customs = settings.get("customStyles") || {};
        let changed = false;
        for (const key of Object.keys(customs)) {
            if (customs[key].analysis) { customs[key].analysis = ""; changed = true; }
        }
        if (changed) settings.update({ customStyles: customs });
    } else if (refType === "background-reference") {
        const bgs = settings.get("backgroundChoices") || [];
        let changed = false;
        for (const bg of bgs) {
            if (bg.analysis) { bg.analysis = ""; changed = true; }
        }
        if (changed) settings.update({ backgroundChoices: bgs });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Async cache for directory reads — avoids blocking the event loop while
// reading hundreds of files from Azure File Share (each read has network latency).
const _dirCache = new Map();
const _jobsCache = new Map();
const _pendingRefresh = new Set(); // dedup guard for concurrent refreshes
const DIR_CACHE_TTL = 30_000; // 30 seconds

// Trigger a background refresh of a directory listing (non-blocking, deduped)
function _refreshReaddir(dir) {
    const key = "dir:" + dir;
    if (_pendingRefresh.has(key)) return;
    _pendingRefresh.add(key);
    fsp.readdir(dir).then((all) => {
        const files = all.filter((f) => f.endsWith(".json"));
        _dirCache.set(dir, { files, ts: Date.now() });
    }).catch(() => {}).finally(() => _pendingRefresh.delete(key));
}

// Trigger a background refresh of all jobs in a directory (non-blocking, deduped)
function _refreshJobs(dir) {
    const key = "jobs:" + dir;
    if (_pendingRefresh.has(key)) return;
    _pendingRefresh.add(key);
    fsp.readdir(dir).then(async (all) => {
        const files = all.filter((f) => f.endsWith(".json"));
        _dirCache.set(dir, { files, ts: Date.now() });
        const jobs = [];
        for (const f of files) {
            try {
                const data = await fsp.readFile(path.join(dir, f), "utf-8");
                const job = JSON.parse(data);
                if (job) jobs.push(job);
            } catch {}
        }
        _jobsCache.set(dir, { jobs, ts: Date.now() });
    }).catch(() => {}).finally(() => _pendingRefresh.delete(key));
}

// Returns cached jobs instantly (stale-while-revalidate). Never blocks.
function readJobs(dir) {
    const now = Date.now();
    const cached = _jobsCache.get(dir);
    if (cached && (now - cached.ts) < DIR_CACHE_TTL) return cached.jobs;
    // Trigger async refresh in background
    _refreshJobs(dir);
    // Return stale data (or empty on first call)
    return cached ? cached.jobs : [];
}

function countFiles(dir) {
    const now = Date.now();
    const cached = _dirCache.get(dir);
    if (cached && (now - cached.ts) < DIR_CACHE_TTL) return cached.files.length;
    _refreshReaddir(dir);
    return cached ? cached.files.length : 0;
}

// Pre-warm caches on module load so first request has data
for (const dir of [DONE_DIR, FAILED_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR]) {
    _refreshJobs(dir);
}

function maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    // Keep country code (+1, +44, +353, etc.) and last 4 digits
    // E.164: +{1-3 digit CC}{subscriber}. For +1 (NANP) keep 2 chars, else keep 3-4.
    const tail = phone.slice(-4);
    let ccLen = 2; // +1
    if (phone.length > 12) ccLen = 4; // +353, +852, etc.
    else if (phone.length > 11) ccLen = 3; // +44, +91, etc.
    const cc = phone.slice(0, ccLen);
    const maskLen = phone.length - ccLen - 4;
    return cc + "*".repeat(Math.max(1, maskLen)) + tail;
}

function parseFilenameTimestamp(filename) {
    // Format: YYYYMMDD_HHMMSS.json
    const m = filename.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function getAllPrinterStatuses() {
    return new Promise((resolve) => {
        const activePrinters = settings.get("activePrinters") || [];
        const baseName = settings.get("printerName") || "";
        const busyState = getPrinterBusyState();

        exec("lpstat -p", (err, stdout) => {
            if (err) {
                resolve([]);
                return;
            }
            const lines = stdout.split("\n").filter((l) => l.startsWith("printer "));
            const results = [];

            for (const line of lines) {
                const name = line.split(" ")[1];
                if (!name) continue;

                // Filter to active printers, or fall back to prefix match
                if (activePrinters.length > 0) {
                    if (!activePrinters.includes(name)) continue;
                } else if (baseName) {
                    if (!name.startsWith(baseName)) continue;
                } else {
                    continue;
                }

                const lower = line.toLowerCase();
                let status, message;
                if (lower.includes("idle")) { status = "ready"; message = "Idle"; }
                else if (lower.includes("printing")) { status = "printing"; message = "Printing"; }
                else if (lower.includes("disabled")) { status = "error"; message = "Disabled"; }
                else if (lower.includes("looking for printer") || lower.includes("unplugged")) { status = "error"; message = "Disconnected"; }
                else { status = "unknown"; message = line.split(" ").slice(2).join(" ").trim(); }

                if (busyState[name]) { status = "printing"; message = "Printing job"; }

                results.push({ name, status, message });
            }
            resolve(results);
        });
    });
}

// ── Country Code Map ─────────────────────────────────────────────────────────

const COUNTRY_CODES = {
    "1": "United States/Canada", "7": "Russia",
    "20": "Egypt", "27": "South Africa", "30": "Greece", "31": "Netherlands",
    "32": "Belgium", "33": "France", "34": "Spain", "36": "Hungary",
    "39": "Italy", "40": "Romania", "41": "Switzerland", "43": "Austria",
    "44": "United Kingdom", "45": "Denmark", "46": "Sweden", "47": "Norway",
    "48": "Poland", "49": "Germany", "51": "Peru", "52": "Mexico",
    "53": "Cuba", "54": "Argentina", "55": "Brazil", "56": "Chile",
    "57": "Colombia", "58": "Venezuela", "60": "Malaysia", "61": "Australia",
    "62": "Indonesia", "63": "Philippines", "64": "New Zealand", "65": "Singapore",
    "66": "Thailand", "81": "Japan", "82": "South Korea", "84": "Vietnam",
    "86": "China", "90": "Turkey", "91": "India", "92": "Pakistan",
    "93": "Afghanistan", "94": "Sri Lanka", "95": "Myanmar",
    "212": "Morocco", "213": "Algeria", "216": "Tunisia", "218": "Libya",
    "220": "Gambia", "221": "Senegal", "233": "Ghana", "234": "Nigeria",
    "254": "Kenya", "255": "Tanzania", "256": "Uganda", "260": "Zambia",
    "263": "Zimbabwe", "351": "Portugal", "352": "Luxembourg", "353": "Ireland",
    "354": "Iceland", "358": "Finland", "370": "Lithuania", "371": "Latvia",
    "372": "Estonia", "380": "Ukraine", "381": "Serbia", "385": "Croatia",
    "386": "Slovenia", "420": "Czech Republic", "421": "Slovakia",
    "852": "Hong Kong", "853": "Macau", "855": "Cambodia", "856": "Laos",
    "880": "Bangladesh", "886": "Taiwan", "960": "Maldives", "961": "Lebanon",
    "962": "Jordan", "963": "Syria", "964": "Iraq", "965": "Kuwait",
    "966": "Saudi Arabia", "968": "Oman", "971": "UAE", "972": "Israel",
    "973": "Bahrain", "974": "Qatar", "977": "Nepal", "992": "Tajikistan",
    "993": "Turkmenistan", "994": "Azerbaijan", "995": "Georgia", "998": "Uzbekistan",
};

function parseCountry(phone) {
    if (!phone || !phone.startsWith("+")) return "Unknown";
    const digits = phone.slice(1);
    // Try 3-digit, then 2-digit, then 1-digit prefix (longest match first)
    for (const len of [3, 2, 1]) {
        const prefix = digits.slice(0, len);
        if (COUNTRY_CODES[prefix]) return COUNTRY_CODES[prefix];
    }
    return "Other";
}

// ── Shared Stats ─────────────────────────────────────────────────────────────

async function computeStats(eventFilter, excludeAdmin) {
    const isAdmin = (phone) => settings.get("adminPhones").includes(phone);
    const allDoneJobs = readJobs(DONE_DIR);
    const allFailedJobs = readJobs(FAILED_DIR);

    // Merge events from job files + downloads directory
    const jobEvents = [...allDoneJobs, ...allFailedJobs].map((j) => j.eventName).filter(Boolean);
    let dlEvents = [];
    try {
        const dlRoot = path.join(__dirname, "..", "downloads");
        dlEvents = (await fsp.readdir(dlRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch {}
    const events = [...new Set([...jobEvents, ...dlEvents])].sort();

    const doneJobs = allDoneJobs.filter((j) =>
        (!excludeAdmin || !isAdmin(j.userPhone)) && (eventFilter === "all" || j.eventName === eventFilter));
    const failedJobs = allFailedJobs.filter((j) =>
        (!excludeAdmin || !isAdmin(j.userPhone)) && (eventFilter === "all" || j.eventName === eventFilter));

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const doneIn24h = doneJobs.filter((j) => j.createdAt && j.createdAt > oneDayAgo);

    const userCounts = {};
    for (const job of doneJobs) {
        const phone = job.userPhone || "unknown";
        userCounts[phone] = (userCounts[phone] || 0) + 1;
    }
    const uniqueUsers = Object.keys(userCounts).length;
    const avgPerUser = uniqueUsers > 0 ? (doneJobs.length / uniqueUsers).toFixed(1) : "0";

    const styleCounts = {};
    for (const job of doneJobs) {
        const style = job.style || "cartoon";
        styleCounts[style] = (styleCounts[style] || 0) + 1;
    }

    const topUsers = Object.entries(userCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([phone, count]) => ({ phone: maskPhone(phone), count }));

    const hourlyBuckets = new Array(24).fill(0);
    const hourlyLabels = new Array(24);
    const currentHour = new Date(now).getHours();
    for (let i = 0; i < 24; i++) {
        const hr = (currentHour - 23 + i + 24) % 24;
        const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
        hourlyLabels[i] = h12 + (hr < 12 ? "a" : "p");
    }
    for (const job of doneIn24h) {
        const hoursAgo = Math.floor((now - job.createdAt) / (60 * 60 * 1000));
        if (hoursAgo >= 0 && hoursAgo < 24) hourlyBuckets[23 - hoursAgo]++;
    }

    // Date range
    let earliest = Infinity, latest = 0;
    for (const job of doneJobs) {
        if (job.createdAt < earliest) earliest = job.createdAt;
        if (job.createdAt > latest) latest = job.createdAt;
    }

    // Failure breakdown
    const failureBreakdown = { moderation: 0, face_detection: 0, multi_subject: 0, generation: 0, printer: 0, review_rejected: 0, max_retries: 0, unknown: 0 };
    for (const job of failedJobs) {
        if (job.failReason && failureBreakdown.hasOwnProperty(job.failReason)) {
            failureBreakdown[job.failReason]++;
        } else if (job.permanent && !job.failReason) {
            // Backward compat: old permanent failures without failReason
            failureBreakdown.moderation++; // Most permanent failures were moderation/face_detection
        } else {
            failureBreakdown.unknown++;
        }
    }

    // Moderation rate: moderation rejections / total attempts (done + failed)
    const totalAttempts = doneJobs.length + failedJobs.length;
    const moderationRejects = failureBreakdown.moderation + failureBreakdown.face_detection;
    const moderationRate = totalAttempts > 0
        ? ((moderationRejects / totalAttempts) * 100).toFixed(1) + "%"
        : "0%";

    // Country breakdown (from successful prints only -- unique users)
    const countryUserSet = {};
    for (const phone of Object.keys(userCounts)) {
        const country = parseCountry(phone);
        if (!countryUserSet[country]) countryUserSet[country] = new Set();
        countryUserSet[country].add(phone);
    }
    const countryCounts = Object.entries(countryUserSet)
        .map(([country, phones]) => ({ country, count: phones.size }))
        .sort((a, b) => b.count - a.count);

    return {
        events, eventFilter,
        totals: { done: doneJobs.length, failed: failedJobs.length },
        prints24h: doneIn24h.length,
        uniqueUsers, avgPerUser,
        styleCounts, topUsers,
        hourlyActivity: hourlyBuckets, hourlyLabels,
        dateRange: doneJobs.length > 0 ? { earliest, latest } : null,
        failureBreakdown, moderationRate, countryCounts,
    };
}

// ── API Routes ───────────────────────────────────────────────────────────────

function getStuckJobs(eventFilter) {
    const now = Date.now();
    const GENERATING_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const PRINTING_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    const stuck = [];

    const REVIEW_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    const checks = [
        [GENERATING_DIR, "generating", GENERATING_THRESHOLD],
        [PRINTING_DIR, "printing", PRINTING_THRESHOLD],
    ];
    // Only report review as stuck if human review is enabled
    const reviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
    if (reviewMode === "human") {
        checks.push([REVIEW_DIR, "review", REVIEW_THRESHOLD]);
    }
    for (const [dir, label, threshold] of checks) {
        const jobs = readJobs(dir);
        for (const job of jobs) {
            if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
            const enteredAt = job.stateChangedAt || job.generatingAt || job.createdAt;
            if (enteredAt && (now - enteredAt) > threshold) {
                stuck.push({
                    stage: label,
                    phone: maskPhone(job.userPhone),
                    style: job.style || "unknown",
                    stuckFor: Math.round((now - enteredAt) / 60000), // minutes
                });
            }
        }
    }
    return stuck;
}

function computeDurations(eventFilter, excludeAdmin) {
    const isAdmin = (phone) => settings.get("adminPhones").includes(phone);
    const doneJobs = readJobs(DONE_DIR).filter((j) =>
        (!excludeAdmin || !isAdmin(j.userPhone)) && (eventFilter === "all" || j.eventName === eventFilter));

    let genTimes = [];
    let printTimes = [];

    for (const job of doneJobs) {
        // Generation time: generatingAt → readyAt or completedAt (digital mode)
        if (job.generatingAt) {
            const genEnd = job.readyAt || job.completedAt;
            if (genEnd && genEnd > job.generatingAt) {
                genTimes.push(genEnd - job.generatingAt);
            }
        }
        // Print time: printingAt → completedAt
        if (job.printingAt && job.completedAt && job.completedAt > job.printingAt) {
            printTimes.push(job.completedAt - job.printingAt);
        }
    }

    const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length / 1000) : null;

    return {
        avgGenerationSec: avg(genTimes),
        avgPrintSec: avg(printTimes),
        genSamples: genTimes.length,
        printSamples: printTimes.length,
    };
}

// ── Stats response cache (avoids re-reading hundreds of job files every poll) ─
const _statsCache = { key: null, data: null, ts: 0 };
const STATS_CACHE_TTL = 30_000; // 30 seconds

router.get("/api/stats", async (req, res) => {
    try {
        const eventFilter = req.query.e || "all";
        const excludeAdmin = req.query.xa === "1";

        // Auto-approve stale review items (side effect — always runs)
        const staleReview = await getReviewQueue("all");
        for (const job of staleReview) {
            const jobReviewMode = settings.getForEvent("reviewMode", job.eventName) ||
                (settings.getForEvent("enableManualReview", job.eventName) ? "human" : "off");
            if (jobReviewMode !== "human") {
                try {
                    await approveJob(job.filename);
                    console.log(`✅ Auto-approved (review disabled for ${job.eventName}): ${job.filename}`);
                } catch (err) {
                    console.error(`❌ Auto-approve failed: ${job.filename} - ${err.message}`);
                }
            }
        }

        // Return cached response if fresh enough (same query params)
        const cacheKey = `${eventFilter}:${excludeAdmin}`;
        const now = Date.now();
        if (_statsCache.key === cacheKey && (now - _statsCache.ts) < STATS_CACHE_TTL) {
            return res.json(_statsCache.data);
        }

        const stats = await computeStats(eventFilter, excludeAdmin);
        const queue = {
            pending: countFiles(PENDING_DIR),
            generating: countFiles(GENERATING_DIR),
            review: (await getReviewQueue(eventFilter)).length,
            ready: countFiles(READY_DIR),
            printing: countFiles(PRINTING_DIR),
        };
        const localPrinters = await getAllPrinterStatuses();
        // Merge relay-reported printers (cloud deployments have no local CUPS)
        const relayList = getRelayPrinters();
        const localNames = new Set(localPrinters.map(p => p.name));
        // Check which relay printers are actively printing (have a job in PRINTING_DIR)
        const relayBusy = new Set();
        try {
            const printingFiles = fs.readdirSync(PRINTING_DIR).filter(f => f.endsWith(".json"));
            for (const f of printingFiles) {
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(PRINTING_DIR, f), "utf-8"));
                    if (j.printerName) relayBusy.add(j.printerName);
                } catch {}
            }
        } catch {}
        const relayEntries = relayList
            .filter(rp => !localNames.has(rp.name)) // avoid duplicates if same name in CUPS
            .map(rp => {
                const busy = relayBusy.has(rp.name);
                return { name: rp.name, status: busy ? "printing" : "ready", message: busy ? "Printing job" : "Relay", source: "relay" };
            });
        const printers = [...localPrinters, ...relayEntries];
        const stuckJobs = getStuckJobs(eventFilter);
        const durations = computeDurations(eventFilter, excludeAdmin);

        const disabledPrinters = settings.get("disabledPrinters") || [];
        const payload = {
            eventName: settings.get("eventName"),
            events: stats.events,
            currentEvent: stats.eventFilter,
            totals: stats.totals,
            prints24h: stats.prints24h,
            uniqueUsers: stats.uniqueUsers,
            avgPerUser: stats.avgPerUser,
            queue,
            stuckJobs,
            durations,
            styleCounts: stats.styleCounts,
            topUsers: stats.topUsers,
            hourlyActivity: stats.hourlyActivity,
            hourlyLabels: stats.hourlyLabels,
            printers,
            disabledPrinters,
            failureBreakdown: stats.failureBreakdown,
            moderationRate: stats.moderationRate,
            countryCounts: stats.countryCounts,
            queuePaused: settings.get("queuePaused") || false,
            hasReviewPin: !!settings.get("reviewPin"),
            enablePrinting: settings.get("enablePrinting"),
            immediateDigitalDelivery: settings.get("immediateDigitalDelivery"),
            nps: nps.getStats(eventFilter === "all" ? null : eventFilter),
        };

        _statsCache.key = cacheKey;
        _statsCache.data = payload;
        _statsCache.ts = now;

        res.json(payload);
    } catch (err) {
        console.error("Stats API error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ── Review QR Code ──────────────────────────────────────────────────────────

let _qrCache = { url: null, svg: null };

router.get("/api/review-qr", async (req, res) => {
    try {
        const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
        const reviewUrl = `${baseUrl}/review`;

        if (_qrCache.url !== reviewUrl) {
            _qrCache.svg = await QRCode.toString(reviewUrl, {
                type: "svg",
                margin: 1,
                color: { dark: "#000000", light: "#00000000" },
                errorCorrectionLevel: "M",
            });
            _qrCache.url = reviewUrl;
        }

        res.json({ svg: _qrCache.svg, url: reviewUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let _staffQrCache = { url: null, dataUrl: null };

router.get("/api/staff-qr", async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).send("url required");

        if (_staffQrCache.url !== url) {
            _staffQrCache.dataUrl = await QRCode.toDataURL(url, {
                margin: 2,
                width: 320,
                color: { dark: "#000000", light: "#ffffff" },
                errorCorrectionLevel: "M",
            });
            _staffQrCache.url = url;
        }

        // Return as PNG image
        const base64 = _staffQrCache.dataUrl.split(",")[1];
        const buf = Buffer.from(base64, "base64");
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=3600");
        res.send(buf);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PDF Report ───────────────────────────────────────────────────────────────

const eventSummaryCache = new Map();

async function getEventSummary(eventName) {
    if (eventSummaryCache.has(eventName)) return eventSummaryCache.get(eventName);
    try {
        const response = await getOpenAI().responses.create({
            model: "gpt-4o-mini",
            input: [{ role: "user", content: [{ type: "input_text", text:
                `Write a 2-3 sentence summary of the event "${eventName}". What is it, who attends, and what's its focus? If you don't recognize the event, write a brief generic description for a tech conference or developer event booth activation. Do not use markdown formatting.`
            }] }],
        });
        const summary = response.output_text.trim();
        eventSummaryCache.set(eventName, summary);
        return summary;
    } catch (err) {
        console.error(`📊 Event summary generation failed: ${err.message}`);
        return `Booth activation at ${eventName}.`;
    }
}

router.get("/api/report", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const stats = await computeStats(eventFilter, true);
    const durations = computeDurations(eventFilter, true);
    const eventLabel = eventFilter === "all" ? "All Events" : eventFilter;

    // AI summary
    const summary = await getEventSummary(eventLabel);

    // Build PDF
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 0, bottom: 40, left: 0, right: 0 }, bufferPages: true });
    const filename = eventLabel.replace(/[^a-zA-Z0-9]/g, "_") + "_Report.pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    // ── Design tokens ──
    const red = "#EF223A";
    const dark = "#000D25";
    const mid = "#38425E";
    const muted = "#656E87";
    const light = "#9AA0B4";
    const veryLight = "#F3F4F7";
    const white = "#FFFFFF";
    const blue = "#2188EF";
    const green = "#19ABF3";
    const orange = "#1866EE";
    const purple = "#3ACEFA";
    const pink = "#F83D53";
    const styleColors = { cartoon: blue, "pop-art": orange, watercolor: purple, anime: pink, sketch: light, "pixel-art": green };

    const pw = doc.page.width;   // 612
    const ph = doc.page.height;  // 792
    const mx = 56;               // margin x
    const contentW = pw - mx * 2; // 500

    // ── Helper: section heading with accent bar ──
    function sectionHead(title, y) {
        if (y === undefined) y = doc.y;
        doc.save();
        doc.roundedRect(mx, y, 4, 18, 2).fill(red);
        doc.restore();
        doc.font("Helvetica-Bold").fontSize(13).fillColor(dark).text(title, mx + 14, y + 2, { width: contentW - 14 });
        doc.y = y + 28;
        doc.x = mx;
    }

    // ── Helper: table with alternating rows ──
    function drawTable(headers, rows, colWidths, options = {}) {
        const { barCol, barMax, barColor } = options; // optional bar chart column
        const y0 = doc.y;
        const totalW = colWidths.reduce((a, b) => a + b, 0);
        const rowH = 24;
        const headerH = 22;

        // Header background
        doc.save();
        doc.roundedRect(mx, y0, totalW, headerH, 4).fill("#E8EAED");
        doc.restore();

        let cx = mx;
        for (let i = 0; i < headers.length; i++) {
            const align = i === 0 ? "left" : "right";
            const padL = i === 0 ? 10 : 0;
            const padR = i === headers.length - 1 ? 10 : 0;
            doc.font("Helvetica-Bold").fontSize(8.5).fillColor(mid)
                .text(headers[i].toUpperCase(), cx + padL, y0 + 6, { width: colWidths[i] - padL - padR, align });
            cx += colWidths[i];
        }

        let ry = y0 + headerH;
        for (let r = 0; r < rows.length; r++) {
            // Alternating row shading
            if (r % 2 === 0) {
                doc.save();
                const rr = r === rows.length - 1 ? 4 : 0;
                if (rr) doc.roundedRect(mx, ry, totalW, rowH, rr).fill(veryLight);
                else doc.rect(mx, ry, totalW, rowH).fill(veryLight);
                doc.restore();
            }

            cx = mx;
            for (let i = 0; i < rows[r].length; i++) {
                const align = i === 0 ? "left" : "right";
                const padL = i === 0 ? 10 : 0;
                const padR = i === rows[r].length - 1 ? 10 : 0;
                const isFirst = i === 0;
                doc.font(isFirst ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(isFirst ? dark : mid)
                    .text(String(rows[r][i]), cx + padL, ry + 7, { width: colWidths[i] - padL - padR, align });

                // Draw inline bar if this column has a bar
                if (barCol !== undefined && i === barCol && barMax > 0) {
                    const val = parseFloat(rows[r][i]) || 0;
                    const barW = Math.max(2, (val / barMax) * (colWidths[i] - 20));
                    const color = barColor ? (typeof barColor === "function" ? barColor(rows[r][0]) : barColor) : blue;
                    doc.save();
                    doc.roundedRect(cx + 4, ry + rowH - 5, barW, 3, 1.5).fill(color);
                    doc.restore();
                }
                cx += colWidths[i];
            }
            ry += rowH;
        }

        doc.y = ry + 6;
        doc.x = mx;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PAGE 1: Cover header + summary + key metrics + style breakdown
    // ══════════════════════════════════════════════════════════════════════════

    // ── Header banner ──
    doc.save();
    doc.rect(0, 0, pw, 110).fill(dark);
    // Red accent bar at very top
    doc.rect(0, 0, pw, 4).fill(red);
    doc.restore();

    // Title
    doc.font("Helvetica-Bold").fontSize(26).fillColor(white).text("Event Report", mx, 28, { width: contentW });
    doc.font("Helvetica").fontSize(14).fillColor("#D1D5DB").text(eventLabel, mx, 60, { width: contentW });

    // Date info on the right side of the header
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    doc.font("Helvetica").fontSize(9).fillColor("#9CA3AF").text(dateStr, mx, 88, { width: contentW, align: "right" });
    if (stats.dateRange) {
        const fmt = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        doc.font("Helvetica").fontSize(8).fillColor("#6B7280")
            .text("Data: " + fmt(stats.dateRange.earliest) + " — " + fmt(stats.dateRange.latest), mx, 100, { width: contentW, align: "right" });
    }

    doc.y = 130;
    doc.x = mx;

    // ── Event Summary ──
    sectionHead("About This Event");
    doc.font("Helvetica").fontSize(10).fillColor(mid).text(summary, mx, doc.y, { lineGap: 4, width: contentW });
    doc.moveDown(1.2);

    // ── Key Metrics (card grid) ──
    sectionHead("Key Metrics");

    const mostPopularStyle = Object.entries(stats.styleCounts).sort((a, b) => b[1] - a[1])[0];
    const successRate = (stats.totals.done + stats.totals.failed) > 0
        ? ((stats.totals.done / (stats.totals.done + stats.totals.failed)) * 100).toFixed(0) + "%"
        : "N/A";

    const fmtSec = (sec) => {
        if (sec === null || sec === undefined) return "N/A";
        if (sec < 60) return sec + "s";
        return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
    };

    const metricCards = [
        { label: "Total Prints", value: String(stats.totals.done), color: blue },
        { label: "Unique Users", value: String(stats.uniqueUsers), color: purple },
        { label: "Avg / User", value: stats.avgPerUser, color: green },
        { label: "Last 24h", value: String(stats.prints24h), color: orange },
        { label: "Top Style", value: mostPopularStyle ? mostPopularStyle[0] : "N/A", color: pink },
        { label: "Success Rate", value: successRate, color: blue },
        { label: "Avg Generation", value: fmtSec(durations.avgGenerationSec), color: purple },
        { label: "Avg Print", value: fmtSec(durations.avgPrintSec), color: green },
        { label: "Failed Jobs", value: String(stats.totals.failed), color: "#E04444" },
        { label: "Rejection Rate", value: stats.moderationRate || "0%", color: orange },
    ];

    const cardCols = 4;
    const cardGap = 10;
    const cardW = (contentW - cardGap * (cardCols - 1)) / cardCols;
    const cardH = 58;
    const cardStartY = doc.y;

    for (let i = 0; i < metricCards.length; i++) {
        const col = i % cardCols;
        const row = Math.floor(i / cardCols);
        const cx = mx + col * (cardW + cardGap);
        const cy = cardStartY + row * (cardH + cardGap);
        const m = metricCards[i];

        // Card background
        doc.save();
        doc.roundedRect(cx, cy, cardW, cardH, 6).fill(veryLight);
        // Left accent stripe
        doc.roundedRect(cx, cy, 3, cardH, 1.5).fill(m.color);
        doc.restore();

        // Value
        doc.font("Helvetica-Bold").fontSize(18).fillColor(dark)
            .text(m.value, cx + 12, cy + 10, { width: cardW - 18 });
        // Label
        doc.font("Helvetica").fontSize(8).fillColor(muted)
            .text(m.label.toUpperCase(), cx + 12, cy + 34, { width: cardW - 18 });
    }

    const metricsRows = Math.ceil(metricCards.length / cardCols);
    doc.y = cardStartY + metricsRows * (cardH + cardGap) + 10;
    doc.x = mx;

    doc.moveDown(0.4);

    // ── Style Breakdown ──
    sectionHead("Style Breakdown");

    const sortedStyles = Object.entries(stats.styleCounts).sort((a, b) => b[1] - a[1]);
    const totalPrints = stats.totals.done || 1;
    const maxStyleCount = sortedStyles.length > 0 ? sortedStyles[0][1] : 1;

    if (sortedStyles.length === 0) {
        doc.font("Helvetica").fontSize(10).fillColor(muted).text("No data yet", mx, doc.y);
        doc.moveDown(0.5);
    } else {
        const styleRows = sortedStyles.map(([style, count]) => [
            style,
            String(count),
            ((count / totalPrints) * 100).toFixed(0) + "%",
        ]);
        drawTable(
            ["Style", "Count", "Share"],
            styleRows,
            [240, 130, 130],
            { barCol: 1, barMax: maxStyleCount, barColor: (name) => styleColors[name] || blue }
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PAGE 2: Top users, failures, geography
    // ══════════════════════════════════════════════════════════════════════════
    doc.addPage({ margins: { top: 48, bottom: 40, left: 0, right: 0 } });
    doc.y = 48;
    doc.x = mx;

    // ── Top Users ──
    if (stats.topUsers.length > 0) {
        sectionHead("Top Users");
        const userRows = stats.topUsers.map((u) => [u.phone, String(u.count)]);
        drawTable(["Phone", "Prints"], userRows, [340, 160], { barCol: 1, barMax: stats.topUsers[0]?.count || 1, barColor: purple });
    }

    doc.moveDown(0.5);

    // ── Failure Analysis ──
    const fb = stats.failureBreakdown;
    const totalFails = Object.values(fb).reduce((a, b) => a + b, 0);
    if (totalFails > 0) {
        sectionHead("Failure Analysis");

        const failLabels = { moderation: "Moderation", face_detection: "Face Detection", generation: "Generation / API", printer: "Printer", max_retries: "Crash Recovery", unknown: "Unknown" };
        const failColors = { moderation: "#E04444", face_detection: orange, generation: purple, printer: blue, max_retries: "#94a0b0", unknown: light };
        const failRows = Object.entries(fb)
            .filter(([, c]) => c > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => [
                failLabels[reason] || reason,
                String(count),
                ((count / totalFails) * 100).toFixed(0) + "%",
            ]);
        const maxFail = Math.max(...Object.values(fb));
        drawTable(
            ["Reason", "Count", "Share"],
            failRows,
            [240, 130, 130],
            { barCol: 1, barMax: maxFail, barColor: (name) => {
                const key = Object.entries(failLabels).find(([, v]) => v === name)?.[0];
                return failColors[key] || "#E04444";
            }}
        );

        doc.font("Helvetica").fontSize(8.5).fillColor(muted)
            .text("Rejection rate (moderation + face detection): " + stats.moderationRate, mx);
        doc.moveDown(0.8);
    } else {
        sectionHead("Failure Analysis");
        doc.font("Helvetica").fontSize(10).fillColor(muted).text("No failures recorded.", mx);
        doc.moveDown(1);
    }

    // ── User Geography ──
    if (stats.countryCounts.length > 0) {
        sectionHead("User Geography");

        const top10Countries = stats.countryCounts.slice(0, 10);
        const totalGeoUsers = stats.countryCounts.reduce((a, b) => a + b.count, 0);
        const maxGeo = top10Countries[0]?.count || 1;
        const geoRows = top10Countries.map(({ country, count }) => [
            country,
            String(count),
            totalGeoUsers > 0 ? ((count / totalGeoUsers) * 100).toFixed(0) + "%" : "0%",
        ]);
        drawTable(
            ["Country", "Users", "Share"],
            geoRows,
            [240, 130, 130],
            { barCol: 1, barMax: maxGeo, barColor: "#3ACEFA" }
        );
    }

    // ── NPS Score ──
    const npsStats = nps.getStats(eventFilter === "all" ? null : eventFilter);
    if (npsStats.count > 0) {
        sectionHead("NPS Score");
        doc.font("Helvetica-Bold").fontSize(28).fillColor(dark)
            .text(String(npsStats.average), mx);
        doc.font("Helvetica").fontSize(9).fillColor(muted)
            .text("Average score from " + npsStats.count + " responses", mx);
        doc.moveDown(0.4);
        const npsBarW = 200;
        const npsMaxCount = Math.max(1, ...Object.values(npsStats.distribution));
        const npsColors = { 5: "#2188EF", 4: "#19ABF3", 3: "#3ACEFA", 2: "#1866EE", 1: "#EF223A" };
        for (let s = 5; s >= 1; s--) {
            const count = npsStats.distribution[s] || 0;
            const barW = (count / npsMaxCount) * npsBarW;
            const y = doc.y;
            doc.font("Helvetica-Bold").fontSize(9).fillColor(dark).text(String(s), mx, y, { width: 14 });
            doc.save();
            doc.roundedRect(mx + 20, y, npsBarW, 12, 2).fillColor("#F3F4F6").fill();
            if (barW > 0) doc.roundedRect(mx + 20, y, barW, 12, 2).fillColor(npsColors[s]).fill();
            doc.restore();
            doc.font("Helvetica").fontSize(8).fillColor(muted).text(String(count), mx + 20 + npsBarW + 8, y + 1);
            doc.y = y + 18;
        }
        doc.moveDown(0.8);
    }

    // ── Footer on every page ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(pages.start + i);
        // Footer line
        doc.save();
        doc.moveTo(mx, ph - 36).lineTo(pw - mx, ph - 36).strokeColor("#E5E7EB").lineWidth(0.5).stroke();
        doc.restore();
        // Left: branding
        doc.font("Helvetica").fontSize(7.5).fillColor(light)
            .text("Twilio + AI Photo Generator", mx, ph - 28, { width: contentW / 2, align: "left" });
        // Right: page number
        doc.font("Helvetica").fontSize(7.5).fillColor(light)
            .text("Page " + (i + 1) + " of " + pages.count, mx + contentW / 2, ph - 28, { width: contentW / 2, align: "right" });
    }

    doc.end();
});

// ── Review Queue API ─────────────────────────────────────────────────────────

router.get("/api/review-queue", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = await getReviewQueue(eventFilter);
    res.json(jobs);
});

router.get("/api/review-count", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = await getReviewQueue(eventFilter);
    res.json({ count: jobs.length });
});

router.post("/api/review-job", async (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    const action = (req.body || {}).action;
    const notify = !!(req.body || {}).notify;
    const reanalyze = !!(req.body || {}).reanalyze;
    if (!filename || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filename and action (approve|reject) required" });
    }
    try {
        if (action === "approve") {
            await approveJob(filename);
        } else {
            // Read job to get eventName for event-scoped message
            const jobData = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, filename), "utf-8"));
            const message = notify ? settings.getMsgForEvent("reviewReject", jobData.eventName) : null;
            const feedback = (req.body || {}).feedback || "";
            await rejectJob(filename, message, reanalyze, feedback);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/review-bulk", async (req, res) => {
    const filenames = Array.isArray((req.body || {}).filenames) ? req.body.filenames : [];
    const action = (req.body || {}).action;
    if (!filenames.length || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filenames array and action (approve|reject) required" });
    }
    const results = [];
    for (const raw of filenames) {
        const filename = path.basename(raw || "");
        if (!filename) { results.push({ filename: raw, ok: false, error: "invalid" }); continue; }
        try {
            if (action === "approve") {
                await approveJob(filename);
            } else {
                await rejectJob(filename, null, false);
            }
            results.push({ filename, ok: true });
        } catch (err) {
            results.push({ filename, ok: false, error: err.message });
        }
    }
    res.json({ ok: true, results });
});

// ── Failed Jobs API ──────────────────────────────────────────────────────────

router.get("/api/failed-jobs", (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = readJobs(FAILED_DIR).map((j) => {
        const filename = `${j.filePrefix}.json`;
        if (eventFilter !== "all" && j.eventName !== eventFilter) return null;
        const evName = j.eventName || eventFilter;
        return {
            filename,
            filePrefix: j.filePrefix,
            phone: maskPhone(j.userPhone),
            name: leads.getLeadName(j.userPhone, evName) || null,
            style: j.style || "unknown",
            failReason: j.failReason || "unknown",
            retries: j.retries || 0,
            createdAt: j.createdAt,
            canRetry: j.failReason !== "moderation",
            printerName: j.printerName || null,
            failedPrinters: j.failedPrinters || [],
            // Detail fields for failure context
            aiReviewResult: j.aiReviewResult || null,
            detectedSubjects: j.detectedSubjects || null,
        };
    }).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(jobs);
});

router.post("/api/retry-job", (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    if (!filename) return res.status(400).json({ error: "filename required" });
    const targetPrinter = (req.body || {}).targetPrinter || null;
    const clearPrinterHistory = (req.body || {}).clearPrinterHistory || false;

    const srcPath = path.join(FAILED_DIR, filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "Job not found" });

    try {
        const job = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
        if (job.failReason === "moderation") {
            return res.status(400).json({ error: "Cannot retry moderation failures" });
        }

        // Reset retry state
        const wasReviewRejected = job.failReason === "review_rejected";
        job.retries = 0;
        delete job.failReason;
        delete job.permanent;
        delete job.completedAt;
        job.stateChangedAt = Date.now();

        // Printer targeting
        if (targetPrinter) job.targetPrinter = targetPrinter;
        else delete job.targetPrinter;
        if (clearPrinterHistory) delete job.failedPrinters;

        // If review-rejected, delete old output so it re-generates fresh
        const { outputPath, mmsPath } = jobPaths(job);
        if (wasReviewRejected) {
            try { fs.unlinkSync(outputPath); } catch {}
            try { fs.unlinkSync(mmsPath); } catch {}
        }

        // Check if output already exists — skip to print queue if so
        const targetDir = fs.existsSync(outputPath) && settings.getForEvent("enablePrinting", job.eventName) ? READY_DIR : PENDING_DIR;

        const tmpPath = srcPath + `.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
        fs.renameSync(tmpPath, srcPath);
        fs.renameSync(srcPath, path.join(targetDir, filename));

        // Restore usage count
        if (job.userPhone && job.eventName) {
            incrementUsage(job.userPhone, job.eventName);
        }

        const target = targetDir === READY_DIR ? "print queue" : "generation queue";
        console.log(`🔄 Retrying job ${filename} → ${target}${targetPrinter ? ` (targeting ${targetPrinter})` : ""}`);
        res.json({ ok: true, target });
    } catch (err) {
        if (err.code === "ENOENT") return res.status(409).json({ error: "Job was already moved (concurrent request)" });
        console.error(`Failed to retry job ${filename}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ── Printer Management API ──────────────────────────────────────────────────

router.post("/api/toggle-printer", (req, res) => {
    const printerName = (req.body || {}).printer;
    if (!printerName) return res.status(400).json({ error: "printer required" });

    const disabled = settings.get("disabledPrinters") || [];
    const idx = disabled.indexOf(printerName);
    if (idx >= 0) {
        disabled.splice(idx, 1);
        settings.update({ disabledPrinters: disabled });
        console.log(`✅ Printer enabled: ${printerName}`);
        res.json({ ok: true, enabled: true });
    } else {
        disabled.push(printerName);
        settings.update({ disabledPrinters: disabled });
        console.log(`🚫 Printer disabled: ${printerName}`);

        // Clear targetPrinter on any ready jobs aimed at this printer
        // so they can be picked up by a working printer instead of sitting stuck
        try {
            const readyFiles = fs.readdirSync(READY_DIR).filter(f => f.endsWith(".json"));
            let cleared = 0;
            for (const f of readyFiles) {
                const fp = path.join(READY_DIR, f);
                try {
                    const job = JSON.parse(fs.readFileSync(fp, "utf-8"));
                    if (job.targetPrinter === printerName) {
                        delete job.targetPrinter;
                        const tmp = fp + `.tmp.${process.pid}.${Date.now()}`;
                        fs.writeFileSync(tmp, JSON.stringify(job));
                        // Guard: if the original was claimed (renamed away) between read and write,
                        // discard the tmp to avoid creating a ghost duplicate in READY_DIR
                        try {
                            fs.accessSync(fp);
                            fs.renameSync(tmp, fp);
                            cleared++;
                        } catch {
                            try { fs.unlinkSync(tmp); } catch {}
                        }
                    }
                } catch (e) {
                    if (e.code !== "ENOENT") console.error(`Failed to clear targetPrinter on ${f}: ${e.message}`);
                }
            }
            if (cleared > 0) console.log(`   ↳ Cleared targetPrinter on ${cleared} ready job(s)`);
        } catch (e) { /* READY_DIR read failed — non-fatal */ }

        res.json({ ok: true, enabled: false });
    }
});

// ── Done Jobs & Reprint API ──────────────────────────────────────────────────

router.get("/api/done-jobs", (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = readJobs(DONE_DIR).map((j) => {
        const filename = `${j.filePrefix}.json`;
        if (eventFilter !== "all" && j.eventName !== eventFilter) return null;
        const { outputPath } = jobPaths(j);
        const evName = j.eventName || eventFilter;
        return {
            filename,
            filePrefix: j.filePrefix,
            phone: maskPhone(j.userPhone),
            name: leads.getLeadName(j.userPhone, evName) || null,
            style: j.style || "unknown",
            printerName: j.printerName || null,
            completedAt: j.completedAt,
            canReprint: fs.existsSync(outputPath),
        };
    }).filter(Boolean).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    res.json(jobs);
});

router.post("/api/reprint-job", (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    if (!filename) return res.status(400).json({ error: "filename required" });
    const targetPrinter = (req.body || {}).targetPrinter || null;

    const srcPath = path.join(DONE_DIR, filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "Job not found in done queue" });

    // Prevent double-queuing
    if (fs.existsSync(path.join(READY_DIR, filename)) || fs.existsSync(path.join(PRINTING_DIR, filename))) {
        return res.status(400).json({ error: "Job is already queued for printing" });
    }

    try {
        const job = JSON.parse(fs.readFileSync(srcPath, "utf-8"));

        // Verify output image still exists
        const { outputPath } = jobPaths(job);
        if (!fs.existsSync(outputPath)) {
            return res.status(400).json({ error: "Output image no longer exists" });
        }

        // Set reprint metadata
        job.reprint = true;
        job.reprintAt = Date.now();
        job.retries = 0;
        job.stateChangedAt = Date.now();
        delete job.printingAt;
        delete job.completedAt;
        delete job.failReason;
        delete job.failedPrinters;
        delete job.permanent;
        // Keep smsSentAt so no SMS is sent on reprint completion
        if (targetPrinter) job.targetPrinter = targetPrinter;
        else delete job.targetPrinter;

        const tmpPath = srcPath + `.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
        fs.renameSync(tmpPath, srcPath);
        fs.renameSync(srcPath, path.join(READY_DIR, filename));

        // Do NOT call incrementUsage — reprints don't affect quota
        console.log(`🔄 Reprint queued: ${filename}${targetPrinter ? ` (targeting ${targetPrinter})` : ""}`);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ENOENT") return res.status(409).json({ error: "Job was already moved (concurrent request)" });
        console.error(`Failed to reprint job ${filename}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ── User Management API ─────────────────────────────────────────────────────

function phoneHash(phone) {
    let h = 0;
    for (let i = 0; i < phone.length; i++) {
        h = ((h << 5) - h + phone.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

router.get("/api/dashboard-users", (req, res) => {
    const eventFilter = req.query.e || "all";
    const userMap = getAllUsers(eventFilter);
    const eventName = eventFilter !== "all" ? eventFilter : settings.get("eventName");
    const maxPrints = settings.getForEvent("maxPrints", eventName);
    const adminPhones = settings.getForEvent("adminPhones", eventName);
    const users = [];
    const showLeadData = eventFilter !== "all";
    for (const [phone, count] of userMap) {
        users.push({
            id: phoneHash(phone),
            phone: maskPhone(phone),
            name: showLeadData ? (leads.getLeadName(phone, eventName) || null) : null,
            count,
            maxPrints,
            isAdmin: adminPhones.includes(phone),
            leadCompleted: showLeadData ? leads.isCompleted(phone, eventName) : false,
        });
    }
    users.sort((a, b) => (b.isAdmin - a.isAdmin) || (b.count - a.count));
    res.json({ users });
});

router.post("/api/dashboard-users/reset-usage", (req, res) => {
    const { id, event } = req.body || {};
    if (id == null || !event || event === "all") return res.status(400).json({ error: "id and specific event required" });
    const userMap = getAllUsers(event);
    let targetPhone = null;
    for (const [phone] of userMap) {
        if (phoneHash(phone) === id) { targetPhone = phone; break; }
    }
    if (!targetPhone) return res.status(404).json({ error: "User not found" });
    resetUsage(targetPhone, event);
    _statsCache.ts = 0;
    console.log(`📊 Usage reset for ${maskPhone(targetPhone)} on ${event}`);
    res.json({ ok: true });
});

router.post("/api/dashboard-users/reset-survey", (req, res) => {
    const { id, event } = req.body || {};
    if (id == null || !event || event === "all") return res.status(400).json({ error: "id and specific event required" });
    const userMap = getAllUsers(event);
    let targetPhone = null;
    for (const [phone] of userMap) {
        if (phoneHash(phone) === id) { targetPhone = phone; break; }
    }
    if (!targetPhone) return res.status(404).json({ error: "User not found" });
    const deleted = leads.deleteByPhone(targetPhone, event);
    console.log(`📋 Lead survey reset for ${maskPhone(targetPhone)} on ${event} (${deleted} record${deleted !== 1 ? "s" : ""} removed)`);
    res.json({ ok: true });
});

router.post("/api/dashboard-users/toggle-admin", async (req, res) => {
    try {
        const { id, event } = req.body || {};
        if (id == null) return res.status(400).json({ error: "id required" });
        const targetEvent = event || settings.get("eventName");
        const userMap = getAllUsers("all");
        let targetPhone = null;
        for (const [phone] of userMap) {
            if (phoneHash(phone) === id) { targetPhone = phone; break; }
        }
        if (!targetPhone) return res.status(404).json({ error: "User not found" });
        const nowAdmin = await toggleAdmin(targetPhone, targetEvent);
        _statsCache.ts = 0;
        console.log(`👤 ${maskPhone(targetPhone)} ${nowAdmin ? "added to" : "removed from"} admins for ${targetEvent}`);
        res.json({ ok: true, isAdmin: nowAdmin });
    } catch (err) {
        console.error("toggle-admin error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

// ── Style Preview API ────────────────────────────────────────────────────────

router.get("/api/style-preview", (req, res) => {
    const style = req.query.style;
    if (!style) return res.status(400).json({ error: "style required" });
    const eventFilter = req.query.e || settings.get("eventName") || "all";
    const doneJobs = readJobs(DONE_DIR);
    let match = null;
    for (let i = doneJobs.length - 1; i >= 0; i--) {
        const j = doneJobs[i];
        if (j.style !== style || !j.filePrefix) continue;
        if (eventFilter !== "all" && j.eventName !== eventFilter) continue;
        const mmsPath = path.join(settings.getDownloadDir(j.eventName), `${j.filePrefix}_output_mms.jpg`);
        if (!fs.existsSync(mmsPath)) continue;
        if (!match || (j.createdAt || 0) > (match.createdAt || 0)) match = j;
    }
    if (!match) return res.json({ image: null });
    res.json({ image: `/images/${match.filePrefix}_output_mms.jpg` });
});

// ── Settings API ─────────────────────────────────────────────────────────────

router.get("/api/settings", (req, res) => {
    res.json(settings.getAllForUser(req.user.email));
});

router.post("/api/settings", async (req, res) => {
    // Capture before values for audit
    const beforeValues = {};
    for (const key of Object.keys(req.body)) {
        const current = settings.get(key);
        if (current !== undefined) beforeValues[key] = current;
    }

    const wasReviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
    const result = settings.updateForUser(req.user.email, req.body);

    if (req.body.backgroundChoices) {
        const savedBg = settings.get("backgroundChoices") || [];
        console.log(`⚙️  Backgrounds saved: ${savedBg.length} choices (received ${req.body.backgroundChoices.length})`);
    }

    // Capture after values and log audit entry
    const afterValues = {};
    let hasChanges = false;
    for (const key of Object.keys(beforeValues)) {
        const newVal = settings.get(key);
        if (JSON.stringify(newVal) !== JSON.stringify(beforeValues[key])) {
            afterValues[key] = newVal;
            hasChanges = true;
        }
    }
    if (hasChanges) {
        // Only include changed keys in before
        const changedBefore = {};
        for (const key of Object.keys(afterValues)) changedBefore[key] = beforeValues[key];
        audit.logSettingsChange(req.user.email, settings.get("eventName"), changedBefore, afterValues).catch(err => {
            console.error("📝 Audit log error:", err.message);
        });
    }
    const newReviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");

    // Auto-approve pending review items for current event when human review is turned OFF
    if (wasReviewMode === "human" && newReviewMode !== "human") {
        const eventName = settings.get("eventName");
        const reviewJobs = await getReviewQueue(eventName);
        for (const job of reviewJobs) {
            try {
                await approveJob(job.filename);
                console.log(`✅ Auto-approved (review disabled for ${eventName}): ${job.filename}`);
            } catch (err) {
                console.error(`❌ Auto-approve failed: ${job.filename} - ${err.message}`);
            }
        }
    }

    res.json(result);
});

router.get("/api/settings/files", async (req, res) => {
    const [templates, videos, printers] = await Promise.all([
        Promise.resolve(settings.listTemplates()),
        Promise.resolve(settings.listVideos()),
        settings.listPrinters(),
    ]);
    const events = settings.listEvents();
    const brandReferences = settings.listBrandReferences();
    const styleReferences = settings.listStyleReferences();
    const backgroundReferences = settings.listBackgroundReferences();
    const eventProfiles = settings.listEventProfiles();
    res.json({ templates, videos, printers, events, brandReferences, styleReferences, backgroundReferences, eventProfiles });
});

router.post("/api/settings/reset", (req, res) => {
    settings.resetUser(req.user.email);
    const result = settings.getAll();
    res.json(result);
});

router.post("/api/settings/reset-all", (req, res) => {
    settings.resetUser(req.user.email);
    const result = settings.reset();
    res.json(result);
});

// ── Audit Log ──────────────────────────────────────────────────────────────

router.get("/api/audit", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const result = await audit.getAuditLog(limit, offset);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/audit/revert/:id", async (req, res) => {
    try {
        const result = await audit.revertEntry(req.params.id, req.user.email);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Legacy endpoint — save is now always global, kept for backwards compatibility
router.post("/api/settings/save-global", (req, res) => {
    const result = settings.saveUserToGlobal(req.user.email);
    res.json(result);
});

router.get("/api/settings/global", (req, res) => {
    res.json(settings.getAll());
});

// Read another event's style prompts (overrides + custom styles) for importing into current event
router.get("/api/settings/event-styles/:eventName", (req, res) => {
    const eventName = req.params.eventName;
    const validEvents = settings.listEventProfiles();
    if (!validEvents.includes(eventName)) {
        return res.status(404).json({ error: "Event not found" });
    }
    const eventSettings = settings.loadEventSettings(eventName);
    res.json({
        stylePromptOverrides: eventSettings.stylePromptOverrides || {},
        customStyles: eventSettings.customStyles || {},
    });
});

// File upload for templates and videos (streams to disk, no size buffering limit)
router.post("/api/settings/upload", (req, res) => {
    const filename = req.query.filename;
    const type = req.query.type;

    if (!filename || !type) {
        return res.status(400).json({ error: "filename and type query params are required" });
    }
    if (!["template", "video", "brand-reference", "style-reference", "background-reference", "booth-image"].includes(type)) {
        return res.status(400).json({ error: "type must be 'template', 'video', 'brand-reference', 'style-reference', 'background-reference', or 'booth-image'" });
    }

    // Validate file extension
    const ext = path.extname(filename).toLowerCase();
    const allowed = type === "template"
        ? [".png", ".jpg", ".jpeg", ".gif", ".svg"]
        : (type === "brand-reference" || type === "style-reference" || type === "background-reference")
        ? [".png", ".jpg", ".jpeg", ".gif"]
        : type === "booth-image"
        ? [".png", ".jpg", ".jpeg", ".svg", ".webp"]
        : [".mp4", ".webm", ".mov"];
    if (!allowed.includes(ext)) {
        return res.status(400).json({ error: `Invalid file type. Allowed: ${allowed.join(", ")}` });
    }

    // Sanitize filename
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const targetDir = type === "template"
        ? path.join(__dirname, "..", "templates")
        : type === "brand-reference"
        ? path.join(__dirname, "..", "brand-references")
        : type === "style-reference"
        ? path.join(__dirname, "..", "style-references")
        : type === "background-reference"
        ? path.join(__dirname, "..", "background-references")
        : path.join(__dirname, "..", "assets"); // video and booth-image both go to assets

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, safeName);
    const writeStream = fs.createWriteStream(targetPath);
    let size = 0;
    let finished = false;

    function fail(status, msg) {
        if (finished) return;
        finished = true;
        writeStream.destroy();
        try { fs.unlinkSync(targetPath); } catch (_) {}
        res.status(status).json({ error: msg });
    }

    req.on("data", (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > 500 * 1024 * 1024) {
            fail(413, "File too large (max 500MB)");
            return;
        }
        const canContinue = writeStream.write(chunk);
        if (!canContinue) {
            req.pause();
            writeStream.once("drain", () => { if (!finished) req.resume(); });
        }
    });

    req.on("end", () => {
        if (finished) return;
        finished = true;
        writeStream.end(() => {
            if (size === 0) {
                try { fs.unlinkSync(targetPath); } catch (_) {}
                return res.status(400).json({ error: "No file data received" });
            }
            console.log(`📁 Uploaded ${type}: ${safeName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
            if (["style-reference", "brand-reference", "background-reference"].includes(type)) {
                invalidateRefAnalysis(type);
            }
            const files = type === "template" ? settings.listTemplates() : type === "brand-reference" ? settings.listBrandReferences() : type === "style-reference" ? settings.listStyleReferences() : type === "background-reference" ? settings.listBackgroundReferences() : type === "video" ? settings.listVideos() : [];
            res.json({ success: true, filename: safeName, files });
        });
    });

    req.on("error", (err) => {
        console.error(`❌ Upload stream error: ${err.message}`);
        fail(500, "Upload failed: " + err.message);
    });
});

router.delete("/api/settings/brand-reference", (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeName = path.basename(filename);
    const filePath = path.join(settings.BRAND_REFS_DIR, safeName);
    try { fs.unlinkSync(filePath); } catch (_) {}

    // Remove from brandReferenceFiles setting
    const current = settings.get("brandReferenceFiles") || [];
    settings.update({ brandReferenceFiles: current.filter((f) => f !== safeName) });
    invalidateRefAnalysis("brand-reference");

    res.json({ success: true, files: settings.listBrandReferences() });
});

router.delete("/api/settings/style-reference", (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeName = path.basename(filename);
    const filePath = path.join(settings.STYLE_REFS_DIR, safeName);
    try { fs.unlinkSync(filePath); } catch (_) {}
    invalidateRefAnalysis("style-reference");

    res.json({ success: true, files: settings.listStyleReferences() });
});

router.delete("/api/settings/background-reference", (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeName = path.basename(filename);
    const filePath = path.join(settings.BG_REFS_DIR, safeName);
    try { fs.unlinkSync(filePath); } catch (_) {}
    invalidateRefAnalysis("background-reference");

    res.json({ success: true, files: settings.listBackgroundReferences() });
});

// ── Logs API + Page ──────────────────────────────────────────────────────────

router.get("/api/logs", (req, res) => {
    const logBuffer = require("./log-buffer");
    const since = parseInt(req.query.since) || 0;
    const level = req.query.level || null;
    let entries = logBuffer.getEntries();
    if (since) entries = entries.filter((e) => e.id > since);
    if (level) entries = entries.filter((e) => e.level === level);
    res.json(entries);
});

router.get("/api/logs/stream", (req, res) => {
    const logBuffer = require("./log-buffer");
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
    });
    res.write(":\n\n");
    if (typeof res.flush === "function") res.flush();
    const onEntry = (entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
        if (typeof res.flush === "function") res.flush();
    };
    logBuffer.subscribe(onEntry);
    req.on("close", () => logBuffer.unsubscribe(onEntry));
});

router.get("/logs", (req, res) => {
    res.type("html").send(LOGS_HTML);
});

// ── Dashboard HTML ───────────────────────────────────────────────────────────

router.get("/", (req, res) => {
    // Ensure trailing slash so relative fetch URLs resolve correctly
    if (!req.originalUrl.endsWith("/")) return res.redirect(req.originalUrl + "/");
    res.type("html").send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Dashboard — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(15px, 1.2vw, 19px); }
  body {
    background: var(--th-bg);
    color: var(--th-text-dim);
    min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
    scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-bg);
  }
  .wrap { max-width: 1400px; margin: 0 auto; }

  /* Section group dividers */
  .section-group { margin-bottom: clamp(20px, 2.5vw, 36px); }
  .section-label {
    font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1.5px;
    font-family: 'Twilio Sans Mono', monospace;
    padding: 0 0 14px 0;
    display: flex; align-items: center; gap: 12px;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: var(--th-card-border); }

  /* Header */
  .header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: clamp(20px, 2.5vw, 36px);
    padding-bottom: clamp(14px, 1.5vw, 22px);
    border-bottom: 1px solid var(--th-card-border);
    gap: 16px; flex-wrap: wrap;
  }
  .header h1 {
    font-size: clamp(20px, 1.6vw, 28px); font-weight: 700; color: var(--th-text);
    letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px;
    padding-top: 6px;
  }
  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    animation: pulse 2s infinite; flex-shrink: 0;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

  .header-controls {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .hdr-item {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--th-card); backdrop-filter: blur(8px);
    border: 1px solid var(--th-card-border); border-radius: 10px;
    padding: 8px 14px; font-size: 13px; font-weight: 400; color: var(--th-text-dim);
    font-family: inherit; cursor: pointer; white-space: nowrap;
    transition: all .2s ease;
    text-decoration: none;
  }
  .hdr-item:hover { color: var(--th-text); border-color: var(--th-input-border); background: var(--th-raised); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .hdr-item svg { width: 14px; height: 14px; flex-shrink: 0; }
  .hdr-item select {
    background: transparent; border: none; color: var(--th-text);
    font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer; outline: none; padding: 0; margin: 0;
    -webkit-appearance: none; appearance: none;
  }
  .hdr-item select option { background: var(--th-card); color: var(--th-text-dim); }
  .hdr-item input[type=checkbox] { accent-color: var(--brand-red); cursor: pointer; margin: 0; }
  .hdr-item.hdr-action {
    background: linear-gradient(135deg, var(--brand-red), #e0283e); border-color: var(--brand-red); color: #fff; font-weight: 700;
    letter-spacing: .2px; box-shadow: 0 2px 8px rgba(242,47,70,.2);
  }
  .hdr-item.hdr-action:hover { background: linear-gradient(135deg, #ff3a52, var(--brand-red)); border-color: #ff3a52; box-shadow: 0 4px 16px rgba(242,47,70,.3); }
  .hdr-item.hdr-action:disabled { opacity: .6; cursor: default; box-shadow: none; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(clamp(130px, 13vw, 210px), 1fr)); gap: clamp(12px, 1.2vw, 18px); margin-bottom: clamp(8px, 1vw, 16px); }
  .card {
    background: linear-gradient(145deg, var(--th-card), var(--th-card));
    border: 1px solid var(--th-card-border);
    border-top: 3px solid var(--th-card-border);
    border-radius: 16px;
    padding: clamp(20px, 2vw, 32px) clamp(16px, 1.4vw, 24px);
    text-align: center;
    position: relative;
    overflow: hidden;
    transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 80px;
    background: linear-gradient(180deg, rgba(255,255,255,.03) 0%, transparent 100%);
    pointer-events: none;
  }
  .card:hover { transform: translateY(-3px); box-shadow: 0 12px 40px rgba(0,0,0,.25); border-color: var(--th-input-border); }
  .card:nth-child(1) { border-top-color: var(--blue-400); }
  .card:nth-child(2) { border-top-color: var(--blue-400); }
  .card:nth-child(3) { border-top-color: var(--blue-500); }
  .card:nth-child(4) { border-top-color: var(--blue-300); }
  .card:nth-child(5) { border-top-color: var(--red-400); }
  .card:nth-child(1)::before { background: linear-gradient(180deg, rgba(33,136,239,.06) 0%, transparent 100%); }
  .card:nth-child(2)::before { background: linear-gradient(180deg, rgba(33,136,239,.06) 0%, transparent 100%); }
  .card:nth-child(3)::before { background: linear-gradient(180deg, rgba(24,102,238,.06) 0%, transparent 100%); }
  .card:nth-child(4)::before { background: linear-gradient(180deg, rgba(25,171,243,.06) 0%, transparent 100%); }
  .card:nth-child(5)::before { background: linear-gradient(180deg, rgba(248,61,83,.06) 0%, transparent 100%); }
  .card .value { font-size: clamp(24px, 2.4vw, 42px); font-weight: 800; color: var(--th-text); font-variant-numeric: tabular-nums; position: relative; transition: color .3s; font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .card .label { font-size: 12px; color: var(--th-text-muted); margin-top: 6px; text-transform: uppercase; letter-spacing: .6px; font-weight: 400; position: relative; font-family: 'Twilio Sans Mono', monospace; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(12px, 1.2vw, 18px); }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: linear-gradient(160deg, var(--th-card), var(--th-card));
    border: 1px solid var(--th-card-border);
    border-radius: 16px;
    padding: clamp(24px, 2.2vw, 36px);
    position: relative;
    overflow: hidden;
    transition: border-color .2s ease, box-shadow .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  .panel::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: var(--th-card-border);
  }
  .panel:hover { border-color: var(--th-input-border); box-shadow: 0 8px 32px rgba(0,0,0,.2); }
  .panel h2 {
    font-size: 13px; font-weight: 700; color: var(--th-text-secondary);
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: clamp(14px, 1.4vw, 22px);
    padding-left: 12px; border-left: 3px solid var(--blue-400);
    font-family: 'Twilio Sans Mono', monospace;
    line-height: 1; padding-top: 1px; padding-bottom: 1px;
  }
  /* Panel accent colors by section */
  .sg-analytics .panel::before { background: linear-gradient(90deg, var(--blue-400), transparent); }
  .sg-analytics .panel h2 { border-left-color: var(--blue-400); }
  .sg-users .panel::before { background: linear-gradient(90deg, var(--blue-400), transparent); }
  .sg-users .panel h2 { border-left-color: var(--blue-400); }
  .sg-failures .panel::before { background: linear-gradient(90deg, var(--blue-300), transparent); }
  .sg-failures .panel h2 { border-left-color: var(--blue-300); }
  .sg-operations .panel::before { background: linear-gradient(90deg, var(--blue-500), transparent); }
  .sg-operations .panel h2 { border-left-color: var(--blue-500); }
  .sg-audit .panel::before { background: linear-gradient(90deg, var(--blue-300), transparent); }
  .sg-audit .panel h2 { border-left-color: var(--blue-300); }
  .audit-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--th-card-border); font-size: 13px; }
  .audit-row:last-child { border-bottom: none; }
  .audit-time { color: var(--th-text-muted); white-space: nowrap; min-width: 140px; }
  .audit-actor { color: var(--th-text-muted); min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .audit-detail { flex: 1; color: var(--th-text); }
  .audit-detail .key { color: var(--blue-400); font-weight: 600; }
  .audit-detail .old { color: #F83D53; text-decoration: line-through; }
  .audit-detail .new { color: #34D399; }
  .audit-revert { flex-shrink: 0; }
  .audit-revert button { font-size: 11px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--th-input-border); background: transparent; color: var(--th-text-muted); cursor: pointer; }
  .audit-revert button:hover { border-color: var(--blue-400); color: var(--blue-400); }
  .audit-revert button:disabled { opacity: 0.4; cursor: default; }
  .audit-reverted { font-size: 11px; color: var(--th-text-muted); font-style: italic; }

  .btn {
    background: var(--th-card-border); color: var(--th-text-dim); border: 1px solid #364050; border-radius: 10px;
    padding: 8px 18px; font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer; transition: all .2s ease;
  }
  .btn:hover { background: var(--th-input-border); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .btn:active { transform: translateY(0); box-shadow: none; }
  .btn-primary { background: var(--brand-red); border-color: var(--brand-red); color: #fff; font-weight: 700; box-shadow: 0 2px 8px rgba(239,34,58,.2); }
  .btn-primary:hover { background: #F83D53; box-shadow: 0 4px 16px rgba(239,34,58,.3); }
  .btn-danger { background: var(--red-600); border-color: var(--red-600); color: #fff; font-weight: 700; }
  .btn-danger:hover { background: #C91229; box-shadow: 0 4px 16px rgba(177,15,35,.3); }
  .stuck-alert {
    text-align: center; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px;
    font-weight: 700; font-size: 13px; display: none;
  }
  .stuck-alert.warning { display: block; background: rgba(25,171,243,.07); color: var(--blue-300); border: 1px solid rgba(25,171,243,.2); }
  .stuck-alert.error { display: block; background: rgba(239,34,58,.07); color: var(--brand-red); border: 1px solid rgba(239,34,58,.2); }

  /* Queue status */
  .queue-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; margin-bottom: 6px;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 10px;
    transition: all .2s ease;
  }
  .queue-row:hover { border-color: var(--th-input-border); background: var(--th-bg-subtle); box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .queue-label { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 400; }
  .queue-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .queue-count { font-weight: 700; font-size: clamp(15px, 1.3rem, 24px); font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Style bars */
  .style-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .style-name { width: clamp(60px, 6vw, 100px); font-size: 13px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; font-weight: 400; }
  .style-bar-bg { flex: 1; height: clamp(18px, 1.5vw, 26px); background: var(--th-bg); border-radius: 8px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .style-bar { height: 100%; border-radius: 7px; transition: width .6s cubic-bezier(.25,.8,.25,1); min-width: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,.1); }
  .style-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Hourly chart */
  .hourly-bars {
    display: flex; align-items: flex-end; gap: 3px; height: clamp(80px, 9vw, 140px);
    position: relative; padding: 8px 0;
    border-bottom: 1px solid var(--th-card-border);
  }
  .hourly-bar {
    flex: 1; background: linear-gradient(180deg, var(--blue-300), var(--blue-400)); border-radius: 5px 5px 0 0; min-height: 3px;
    transition: height .4s ease, opacity .15s, transform .15s; cursor: default; position: relative;
  }
  .hourly-bar:hover { opacity: .85; transform: scaleX(1.1); }
  .hourly-bar:hover .hourly-tip { display: block; }
  .hourly-tip {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--th-raised); color: var(--th-text); font-size: 12px; font-weight: 700; padding: 4px 10px;
    border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 10;
  }
  .hourly-tip::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 4px solid transparent; border-top-color: var(--th-raised);
  }
  .hourly-labels { display: flex; gap: 3px; margin-top: 6px; }
  .hourly-label { flex: 1; font-size: clamp(7px, 0.6rem, 11px); color: var(--th-text-muted); text-align: center; white-space: nowrap; }

  /* Printer */
  .printer-status {
    display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 400;
    padding: 8px 12px; margin-bottom: 4px;
    background: var(--th-bg); border-radius: 8px; border: 1px solid var(--th-card-border);
  }
  .printer-status:last-child { margin-bottom: 0; }
  .printer-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .ptr-btn {
    font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 6px; cursor: pointer;
    font-family: inherit; border: 1px solid; transition: background .15s, border-color .15s;
  }
  .ptr-btn-disable { background: rgba(239,34,58,.09); color: var(--brand-red); border-color: rgba(239,34,58,.2); }
  .ptr-btn-disable:hover { background: rgba(239,34,58,.16); border-color: var(--brand-red); }
  .ptr-btn-enable { background: rgba(33,136,239,.09); color: var(--blue-400); border-color: rgba(33,136,239,.2); }
  .ptr-btn-enable:hover { background: rgba(33,136,239,.16); border-color: var(--blue-400); }
  .fj-printer-select {
    font-size: 11px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--th-input-border);
    background: var(--th-input-bg); color: var(--th-text); font-family: inherit; cursor: pointer;
  }
  /* Combined jobs panel */
  .jb-tabs { display: flex; gap: 4px; }
  .jb-tab {
    font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 6px; cursor: pointer;
    font-family: inherit; border: 1px solid var(--th-card-border); background: var(--th-bg); color: var(--th-text-muted);
    transition: background .15s, border-color .15s, color .15s;
  }
  .jb-tab:hover { background: var(--th-raised); }
  .jb-tab.active { background: rgba(33,136,239,.09); color: var(--blue-400); border-color: rgba(33,136,239,.2); }
  .jb-list { max-height: 500px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-card); }
  .jb-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px 12px; margin-bottom: 4px;
    background: var(--th-bg); border-radius: 8px; border: 1px solid var(--th-card-border); font-size: 13px;
  }
  .jb-phone { color: var(--th-text-secondary); font-family: 'Twilio Sans Mono', monospace; min-width: 100px; }
  .jb-name { color: var(--th-text); font-weight: 600; font-size: 12px; }
  .jb-style { color: var(--th-text-muted); min-width: 70px; }
  .jb-printer { color: var(--th-text-muted); font-size: 11px; }
  .jb-time { color: var(--th-text-muted); font-size: 11px; min-width: 50px; text-align: right; flex: 1; }
  .jb-status {
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px;
    text-transform: uppercase; letter-spacing: .3px;
  }
  .jb-status.done { background: rgba(33,186,69,.09); color: #21ba45; }
  .jb-status.moderation { background: rgba(239,34,58,.09); color: var(--brand-red); }
  .jb-status.face_detection { background: rgba(25,171,243,.09); color: var(--blue-300); }
  .jb-status.multi_subject { background: rgba(206,147,37,.09); color: #ce9325; }
  .jb-status.ai_review_rejected { background: rgba(164,94,229,.09); color: #a45ee5; }
  .jb-status.review_rejected { background: rgba(164,94,229,.09); color: #a45ee5; }
  .jb-status.content_rejected { background: rgba(239,34,58,.09); color: var(--brand-red); }
  .jb-status.generation { background: rgba(24,102,238,.09); color: var(--blue-500); }
  .jb-status.printer { background: rgba(33,136,239,.09); color: var(--blue-400); }
  .jb-status.relay_stale { background: rgba(33,136,239,.09); color: var(--blue-400); }
  .jb-status.max_retries { background: rgba(107,117,133,.09); color: var(--th-text-muted); }
  .jb-status.unknown { background: rgba(107,117,133,.09); color: var(--th-text-muted); }
  .jb-btn {
    background: rgba(33,136,239,.09); color: var(--blue-400); border: 1px solid rgba(33,136,239,.2); border-radius: 6px;
    padding: 4px 12px; font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit;
    transition: background .15s, border-color .15s;
  }
  .jb-btn:hover { background: rgba(33,136,239,.16); border-color: var(--blue-400); }
  .jb-btn:disabled { opacity: .4; cursor: default; }
  .jb-detail {
    width: 100%; font-size: 11px; color: var(--th-text-muted); line-height: 1.5;
    padding: 4px 0 0; border-top: 1px solid var(--th-card-border); margin-top: 2px;
  }
  .jb-empty { color: var(--th-text-muted); font-size: 13px; padding: 16px 0; }

  /* Top users */
  .user-row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; margin-bottom: 4px;
    background: var(--th-bg); border-radius: 8px;
    transition: background .15s;
  }
  .user-row:hover { background: var(--th-raised); }
  .user-phone { color: var(--th-text-secondary); font-family: 'Twilio Sans Mono', monospace; font-size: 13px; min-width: 100px; }
  .user-name { color: var(--th-text); font-weight: 600; font-size: 13px; flex: 1; min-width: 0; }
  .user-count { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 13px; color: var(--th-text); font-family: 'Twilio Sans Mono', monospace; white-space: nowrap; }
  .du-badges { display: flex; gap: 4px; flex-shrink: 0; }
  .du-badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
  .du-badge-admin { background: rgba(239,34,58,0.15); color: var(--brand-red); }
  .du-badge-lead { background: rgba(33,136,239,0.15); color: var(--blue-400); }
  .du-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .btn-xs { padding: 4px 10px; font-size: 11px; border-radius: 6px; }

  /* Failure breakdown bars */
  .fail-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .fail-name { width: clamp(75px, 7vw, 110px); font-size: 13px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; font-weight: 400; }
  .fail-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: var(--th-bg); border-radius: 6px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .fail-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; }
  .fail-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Geography bars */
  .geo-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .geo-name { width: clamp(90px, 9vw, 150px); font-size: 13px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .geo-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: var(--th-bg); border-radius: 6px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .geo-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; background: var(--blue-200); }
  .geo-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Job Health grid */
  .health-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  }
  .health-stat {
    display: flex; flex-direction: column; gap: 4px;
    padding: 14px 16px; background: var(--th-bg); border-radius: 12px; border: 1px solid var(--th-card-border);
    transition: border-color .2s, box-shadow .2s;
  }
  .health-stat:hover { border-color: var(--th-input-border); box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .health-val { font-size: clamp(20px, 1.8vw, 32px); font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .health-val-sm { font-size: clamp(16px, 1.4vw, 24px); }
  .health-lbl { font-size: 11px; color: var(--th-text-muted); text-transform: uppercase; letter-spacing: .5px; font-weight: 400; font-family: 'Twilio Sans Mono', monospace; }
  .health-timing {
    display: flex; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--th-card-border);
  }
  .health-timing .health-stat { flex: 1; }

  /* NPS panel */
  .nps-content { display: flex; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
  .nps-disabled { color: var(--th-text-muted); font-size: 13px; padding: 12px 0; }
  .nps-big { display: flex; flex-direction: column; align-items: center; min-width: 80px; }
  .nps-score { font-size: clamp(36px, 3vw, 56px); font-weight: 800; line-height: 1; font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .nps-score-good { color: var(--blue-400); }
  .nps-score-ok { color: var(--blue-300); }
  .nps-score-bad { color: var(--brand-red); }
  .nps-count { font-size: 12px; color: var(--th-text-muted); margin-top: 4px; }
  .nps-bars { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 6px; }
  .nps-bar-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .nps-bar-label { width: 14px; text-align: right; color: var(--th-text-secondary); font-weight: 700; }
  .nps-bar-track { flex: 1; height: 18px; background: var(--th-bg); border-radius: 4px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .nps-bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
  .nps-bar-val { width: 28px; font-size: 12px; color: var(--th-text-muted); }

  .fj-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--blue-400); color: #fff; padding: 10px 20px; border-radius: 10px;
    font-size: 13px; font-weight: 700; z-index: 100; opacity: 0; transition: opacity .3s;
    pointer-events: none;
  }
  .fj-toast.show { opacity: 1; }

  .footer {
    text-align: center; color: var(--th-text-muted); font-size: 12px; font-weight: 400;
    margin-top: 56px; padding: 28px 0 12px;
    border-top: 1px solid var(--th-card-border);
    letter-spacing: .3px;
  }

  /* Review banner */
  @keyframes review-pulse {
    0%, 100% { border-color: var(--blue-300); box-shadow: 0 0 8px rgba(25,171,243,0.15); }
    50% { border-color: var(--brand-red); box-shadow: 0 0 20px rgba(239,34,58,0.25); }
  }
  .review-banner {
    background: var(--th-card); border: 2px solid var(--blue-300); border-radius: 12px;
    padding: 20px 24px; margin-bottom: 20px;
    animation: review-pulse 2s ease-in-out infinite;
  }
  .review-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
  }
  .review-header h2 { margin: 0; font-size: 16px; }
  .review-icon { font-size: 22px; color: var(--blue-300); }
  .review-badge {
    font-size: 12px; background: var(--brand-red); color: #fff;
    border-radius: 10px; padding: 2px 10px; margin-left: 8px;
    font-weight: 700;
  }
  /* QR review block */
  .qr-review-block {
    display: flex; align-items: center; gap: 20px;
    background: var(--th-bg-subtle, var(--th-bg));
    border: 1px dashed var(--th-card-border); border-radius: 10px;
    padding: 16px 20px; margin-bottom: 16px;
  }
  .qr-review-block.qr-review-hint-only { justify-content: center; padding: 12px 16px; }
  .qr-review-code { flex-shrink: 0; width: 120px; height: 120px; }
  .qr-review-code svg { width: 100%; height: 100%; }
  [data-theme="dark"] .qr-review-code svg path { stroke: #FFFFFF; }
  [data-theme="light"] .qr-review-code svg path { stroke: #000D25; }
  .qr-review-info { flex: 1; min-width: 0; }
  .qr-review-title {
    font-family: 'Twilio Sans Display', sans-serif; font-size: 15px;
    font-weight: 700; color: var(--th-text); margin-bottom: 6px;
  }
  .qr-review-url {
    font-family: 'Twilio Sans Mono', monospace; font-size: 12px;
    color: var(--blue-300); word-break: break-all; margin-bottom: 6px;
  }
  .qr-review-hint { font-size: 12px; color: var(--th-text-muted); }
  @media (max-width: 500px) {
    .qr-review-block { flex-direction: column; text-align: center; }
    .qr-review-code { width: 100px; height: 100px; }
  }

  .review-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 220px)); gap: 14px;
  }
  .rv-card {
    background: var(--th-bg-subtle); border-radius: 8px; padding: 12px; text-align: center;
    border: 1px solid var(--th-card-border); transition: border-color .2s;
  }
  .rv-card:hover { border-color: var(--blue-300); }
  .rv-images { display: flex; gap: 4px; margin-bottom: 8px; }
  .rv-images img { width: 100%; border-radius: 4px; cursor: pointer; display: block; }
  .rv-images .rv-img-label {
    position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
    font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
    background: rgba(0,0,0,.6); color: #fff; padding: 1px 5px; border-radius: 3px;
    pointer-events: none;
  }
  .rv-img-wrap { position: relative; flex: 1; min-width: 0; }
  .rv-meta { font-size: 11px; color: var(--th-text-secondary); margin-bottom: 10px; }
  .rv-actions { display: flex; flex-direction: column; gap: 6px; }
  .rv-btn {
    border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer;
    font-size: 12px; font-weight: 700; color: #fff; transition: all .15s;
    width: 100%; text-align: center;
  }
  .rv-btn:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .rv-btn:active { transform: translateY(0); }
  .rv-btn-approve { background: var(--blue-400); font-size: 13px; padding: 10px 12px; }
  .rv-reject-row { display: flex; gap: 6px; }
  .rv-reject-row .rv-btn { font-size: 11px; padding: 6px 8px; }
  .rv-btn-reject { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }
  .rv-btn-reject:hover { border-color: var(--brand-red); color: var(--brand-red); background: rgba(239,34,58,.08); }
  .rv-btn-notify { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }
  .rv-btn-notify:hover { border-color: var(--blue-300); color: var(--blue-300); background: rgba(25,171,243,.08); }
  .rv-btn-reanalyze { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }
  .rv-btn-reanalyze:hover { border-color: var(--blue-500); color: var(--blue-500); background: rgba(24,102,238,.08); }

  /* Re-analyze feedback panel */
  .rv-feedback {
    display: none; margin-top: 8px; text-align: left;
  }
  .rv-feedback.open { display: block; }
  .rv-feedback textarea {
    width: 100%; box-sizing: border-box; min-height: 60px; padding: 8px; border-radius: 6px;
    border: 1px solid var(--th-input-border); background: var(--th-bg); color: var(--th-text);
    font-size: 12px; font-family: inherit; resize: vertical;
  }
  .rv-feedback textarea:focus { outline: none; border-color: var(--blue-400); }
  .rv-feedback-hint { font-size: 10px; color: var(--th-text-muted); margin: 4px 0 6px; }
  .rv-feedback-btns { display: flex; gap: 6px; }
  .rv-feedback-btns .rv-btn { font-size: 11px; padding: 6px 12px; }
  .rv-fb-submit { background: var(--blue-500); }
  .rv-fb-cancel { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }

  /* Bulk selection */
  .rv-card-check {
    position: absolute; top: 8px; left: 8px; z-index: 2;
    width: 20px; height: 20px; accent-color: var(--blue-400); cursor: pointer;
  }
  .rv-card { position: relative; }
  .rv-card.rv-selected { border-color: var(--blue-400); box-shadow: 0 0 0 1px var(--blue-400); }
  .rv-bulk-bar {
    display: none; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px; padding: 10px 14px;
    background: var(--th-bg-subtle); border: 1px solid var(--th-card-border); border-radius: 8px;
  }
  .rv-bulk-bar.active { display: flex; }
  .rv-bulk-bar label { font-size: 13px; color: var(--th-text-secondary); cursor: pointer; display: flex; align-items: center; gap: 6px; }
  .rv-bulk-bar label input { accent-color: var(--blue-400); cursor: pointer; }
  .rv-bulk-count { font-size: 12px; color: var(--blue-300); font-weight: 700; }
  .rv-bulk-actions { display: flex; gap: 6px; margin-left: auto; }
  .rv-bulk-actions .rv-btn { width: auto; padding: 6px 14px; font-size: 12px; }

  /* Review modal */
  .rv-modal {
    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,.85); z-index: 9999;
    align-items: center; justify-content: center;
  }
  .rv-modal.open { display: flex; }
  .rv-modal-content { position: relative; max-width: 92vw; max-height: 90vh; display: flex; gap: 16px; align-items: center; }
  .rv-modal-pane { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .rv-modal-pane img {
    max-width: 44vw; max-height: 82vh; border-radius: 10px;
    box-shadow: 0 8px 40px rgba(0,0,0,.5);
  }
  .rv-modal-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: rgba(255,255,255,.7); }
  @media (max-width: 700px) {
    .rv-modal-content { flex-direction: column; gap: 10px; }
    .rv-modal-pane img { max-width: 88vw; max-height: 40vh; }
  }
  .rv-modal-close {
    position: absolute; top: -12px; right: -12px;
    background: var(--th-card); color: #fff; border: 2px solid var(--th-text-muted);
    width: 32px; height: 32px; border-radius: 50%; font-size: 18px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }
  .rv-modal-close:hover { background: var(--brand-red); border-color: var(--brand-red); }

  /* Theme toggle */
  .theme-toggle {
    background: none; border: 1px solid var(--th-card-border); border-radius: 10px;
    padding: 8px; cursor: pointer; color: var(--th-text-dim);
    display: inline-flex; align-items: center; justify-content: center;
    transition: color .2s, border-color .2s;
  }
  .theme-toggle:hover { color: var(--th-text); border-color: var(--th-input-border); }
  .theme-toggle svg { width: 16px; height: 16px; }
  [data-theme="dark"] .icon-sun { display: none; }
  [data-theme="dark"] .icon-moon { display: block; }
  [data-theme="light"] .icon-sun { display: block; }
  [data-theme="light"] .icon-moon { display: none; }
</style>
</head>
<body>

<div class="wrap">
<div class="header">
  <h1><span class="status-dot" id="liveDot" style="background:var(--blue-400)"></span>Admin Dashboard<span id="pausedBadge" style="display:none;margin-left:10px;font-size:11px;font-weight:700;background:rgba(25,171,243,.13);color:var(--blue-300);padding:3px 10px;border-radius:6px;border:1px solid rgba(25,171,243,.27);text-transform:uppercase;letter-spacing:.5px;vertical-align:middle">Paused</span></h1>
  <div class="header-controls">
    <div class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;opacity:.5"><circle cx="12" cy="12" r="10"/></svg><select id="eventSelect" onchange="onEventChange()"><option value="all">All Events</option></select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;opacity:.4"><polyline points="6 9 12 15 18 9"/></svg></div>
    <label class="hdr-item" title="Exclude admin phone numbers from all metrics"><input type="checkbox" id="excludeAdminCb" onchange="onAdminToggle()">Exclude admin</label>
    <a href="/home/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
    <a href="/outreach/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Outreach</a>
    <a href="/dashboard/logs/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Logs</a>
    <button class="hdr-item hdr-action" id="reportBtn" onclick="generateReport()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Report</button>
    <button class="theme-toggle" onclick="toggleTheme()">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
    </button>
  </div>
</div>

<div class="cards">
  <div class="card"><div class="value" id="totalPrints">--</div><div class="label">Total Prints</div></div>
  <div class="card"><div class="value" id="prints24h">--</div><div class="label">Last 24h</div></div>
  <div class="card"><div class="value" id="uniqueUsers">--</div><div class="label">Unique Users</div></div>
  <div class="card"><div class="value" id="avgPerUser">--</div><div class="label">Avg / User</div></div>
  <div class="card"><div class="value" id="inQueue">--</div><div class="label">In Queue</div></div>
</div>

<div class="review-banner" id="reviewPanel" style="display:none">
  <div class="review-header">
    <span class="review-icon">&#9888;</span>
    <h2>Pending Review <span id="reviewCount" class="review-badge">0</span></h2>
  </div>
  <div class="qr-review-block" id="qrReviewBlock" style="display:none">
    <div class="qr-review-code" id="qrReviewSvg"></div>
    <div class="qr-review-info">
      <div class="qr-review-title">Scan to review from your phone</div>
      <div class="qr-review-url" id="qrReviewUrl"></div>
      <div class="qr-review-hint">Staff enter the Review PIN to access the queue</div>
    </div>
  </div>
  <div class="qr-review-block qr-review-hint-only" id="qrReviewHint" style="display:none">
    <div class="qr-review-hint">Set a Review PIN in <a href="/home/" style="color:var(--blue-300)">Settings</a> to let staff review from their phones</div>
  </div>
  <div class="rv-bulk-bar" id="rvBulkBar">
    <label title="Select or deselect all items"><input type="checkbox" id="rvSelectAll" onchange="toggleSelectAll(this.checked)"> Select All</label>
    <span class="rv-bulk-count" id="rvBulkCount"></span>
    <div class="rv-bulk-actions">
      <button class="rv-btn rv-btn-approve" onclick="bulkReviewAction('approve')" title="Approve all selected images">Approve Selected</button>
      <button class="rv-btn rv-btn-reject" onclick="bulkReviewAction('reject')" title="Discard all selected images silently — users are not notified">Reject Selected</button>
    </div>
  </div>
  <div id="reviewGrid" class="review-grid"></div>
</div>

<div id="reviewModal" class="rv-modal" onclick="closeReviewModal(event)">
  <div class="rv-modal-content">
    <div class="rv-modal-pane"><span class="rv-modal-label">Original</span><img id="reviewModalOrig" src=""></div>
    <div class="rv-modal-pane"><span class="rv-modal-label">Generated</span><img id="reviewModalImg" src=""></div>
    <button class="rv-modal-close" onclick="closeReviewModal()">&times;</button>
  </div>
</div>

<div class="section-group sg-operations">
  <div class="section-label">Operations</div>
  <div class="grid">
    <div class="panel">
      <h2>Queue Status</h2>
      <div id="stuckAlert"></div>
      <div id="printerWarning"></div>
      <div id="queueRows"></div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--th-card-border)">
        <h2>Printers</h2>
        <div id="printerList"><span style="color:var(--th-text-muted)">--</span></div>
      </div>
    </div>
    <div class="panel">
      <h2>Job Health</h2>
      <div class="health-grid">
        <div class="health-stat">
          <span class="health-val" style="color:var(--blue-400)" id="healthDone">--</span>
          <span class="health-lbl">Completed</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:var(--brand-red)" id="healthFailed">--</span>
          <span class="health-lbl">Failed</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:var(--blue-400)" id="healthRate">--</span>
          <span class="health-lbl">Success Rate</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:var(--blue-300)" id="healthModRate">--</span>
          <span class="health-lbl">Rejection Rate</span>
        </div>
      </div>
      <div class="health-timing">
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:var(--blue-500)" id="avgGenTime">--</span>
          <span class="health-lbl">Avg Generation</span>
        </div>
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:var(--blue-400)" id="avgPrintTime">--</span>
          <span class="health-lbl">Avg Print</span>
        </div>
      </div>
    </div>
  </div>
  <div class="panel" style="margin-top:14px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <h2 style="margin:0">Jobs</h2>
      <div class="jb-tabs" id="jobTabs">
        <button class="jb-tab active" data-filter="all" onclick="setJobFilter(&apos;all&apos;)">All</button>
        <button class="jb-tab" data-filter="failed" onclick="setJobFilter(&apos;failed&apos;)">Failed</button>
        <button class="jb-tab" data-filter="done" onclick="setJobFilter(&apos;done&apos;)">Completed</button>
      </div>
    </div>
    <div id="jobsList" style="color:var(--th-text-muted);font-size:13px">Loading...</div>
  </div>
</div>

<div class="section-group sg-users">
  <div class="section-label">Users</div>
  <div class="grid">
    <div class="panel" style="grid-column: 1 / -1">
      <h2>Users</h2>
      <div id="dashboardUsers" style="max-height:420px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--th-input-border) var(--th-card)"></div>
    </div>
  </div>
</div>

<div class="section-group sg-failures">
  <div class="section-label">Diagnostics</div>
  <div class="grid">
    <div class="panel">
      <h2>Failure Breakdown</h2>
      <div id="failBars"></div>
    </div>
    <div class="panel">
      <h2>User Geography</h2>
      <div id="geoBars"></div>
    </div>
  </div>
</div>

<div class="section-group sg-analytics">
  <div class="section-label">Analytics</div>
  <div class="grid">
    <div class="panel">
      <h2>Style Breakdown</h2>
      <div id="styleBars"></div>
    </div>
    <div class="panel">
      <h2>Hourly Activity (24h)</h2>
      <div class="hourly-bars" id="hourlyBars"></div>
      <div class="hourly-labels" id="hourlyLabels"></div>
    </div>
  </div>
  <div class="panel nps-panel" style="margin-top:14px">
    <h2>NPS Score</h2>
    <div id="npsPanel" class="nps-content">
      <div class="nps-disabled">NPS survey is disabled. Enable it in Settings &gt; Engagement.</div>
    </div>
  </div>
</div>

<div class="section-group sg-audit">
  <div class="section-label">Activity Log</div>
  <div class="grid">
    <div class="panel" style="grid-column: 1 / -1">
      <h2>Recent Settings Changes</h2>
      <div id="auditLog" style="font-size:13px;color:var(--th-text-muted);max-height:420px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--th-input-border) var(--th-card)">Loading...</div>
      <div style="margin-top:12px;text-align:center">
        <button class="btn btn-secondary" id="auditLoadMore" style="display:none" onclick="loadMoreAudit()">Load More</button>
      </div>
    </div>
  </div>
</div>

<div class="fj-toast" id="fjToast"></div>
<div class="footer">Auto-refreshes every 3s &middot; Last updated <span id="lastUpdated">--</span></div>
</div><!-- /.wrap -->

<script>
const STYLE_COLORS = {
  cartoon: "#2188EF", "pop-art": "#19ABF3", watercolor: "#1866EE",
  anime: "#F83D53", sketch: "#94a0b0", "pixel-art": "#2188EF",
};
const QUEUE_META = [
  { key: "pending", label: "Pending", color: "#94a0b0" },
  { key: "generating", label: "Generating", color: "#1866EE" },
  { key: "review", label: "Pending Review", color: "#19ABF3" },
  { key: "ready", label: "Ready to Print", color: "#2188EF" },
  { key: "printing", label: "Printing", color: "#2188EF" },
];

let selectedEvent = "all";
let firstLoad = true;
let excludeAdmin = false;
let userActionGen = 0;

function queryParams() {
  var parts = ["e=" + encodeURIComponent(selectedEvent)];
  if (excludeAdmin) parts.push("xa=1");
  return "?" + parts.join("&");
}

function onEventChange() {
  selectedEvent = document.getElementById("eventSelect").value;
  userActionGen++;
  fetchStats();
  fetchDashboardUsers();
}

function onAdminToggle() {
  excludeAdmin = document.getElementById("excludeAdminCb").checked;
  userActionGen++;
  fetchStats();
}

async function fetchStats() {
  var gen = userActionGen;
  try {
    const r = await fetch("api/stats" + queryParams());
    const d = await r.json();
    if (gen !== userActionGen) return;
    render(d);
  } catch (e) {
    console.error("fetchStats error:", e);
    document.getElementById("liveDot").style.background = "#EF223A";
  }
}

function render(d) {
  if (!d) return;
  d.totals = d.totals || { done: 0, failed: 0 };
  d.styleCounts = d.styleCounts || {};
  d.hourlyActivity = d.hourlyActivity || new Array(24).fill(0);
  d.hourlyLabels = d.hourlyLabels || [];
  d.failureBreakdown = d.failureBreakdown || {};
  d.countryCounts = d.countryCounts || [];
  d.topUsers = d.topUsers || [];
  d.queue = d.queue || { pending: 0, generating: 0, review: 0, ready: 0, printing: 0 };
  d.printers = d.printers || [];
  d.stuckJobs = d.stuckJobs || [];
  d.events = d.events || [];
  d.durations = d.durations || {};
  d.nps = d.nps || { count: 0 };

  var _prevPin = _hasReviewPin;
  _hasReviewPin = !!d.hasReviewPin;
  if (_hasReviewPin !== _prevPin && document.getElementById("reviewPanel").style.display !== "none") {
    updateQrBlock();
  }
  document.getElementById("liveDot").style.background = d.queuePaused ? "#19ABF3" : "#2188EF";
  document.getElementById("pausedBadge").style.display = d.queuePaused ? "" : "none";

  // Populate event dropdown (preserve selection)
  const sel = document.getElementById("eventSelect");
  const prev = sel.value;
  sel.innerHTML = '<option value="all">All Events</option>';
  if (d.events) {
    for (const e of d.events) {
      sel.innerHTML += '<option value="'+escHtml(e)+'"'+(prev===e?' selected':'')+'>'+escHtml(e)+'</option>';
    }
  }
  // On first load, default to the configured event from settings
  if (firstLoad && d.eventName && d.events && d.events.includes(d.eventName)) {
    sel.value = d.eventName;
    selectedEvent = d.eventName;
    firstLoad = false;
    fetchStats();
    fetchReviewQueue();
    fetchDashboardUsers();
    return;
  }
  firstLoad = false;
  if (prev && prev !== "all") sel.value = prev;

  document.getElementById("totalPrints").textContent = d.totals.done;
  document.getElementById("prints24h").textContent = d.prints24h;
  document.getElementById("uniqueUsers").textContent = d.uniqueUsers;
  document.getElementById("avgPerUser").textContent = d.avgPerUser;
  const queueTotal = d.queue.pending + d.queue.generating + d.queue.review + d.queue.ready + d.queue.printing;
  document.getElementById("inQueue").textContent = queueTotal;

  // Stuck job warnings
  const stuckEl = document.getElementById("stuckAlert");
  if (d.stuckJobs && d.stuckJobs.length > 0) {
    const msgs = d.stuckJobs.map(function(s) { return s.stage + " stuck for " + s.stuckFor + "m (" + s.phone + ")"; });
    stuckEl.className = "stuck-alert error";
    stuckEl.textContent = "STUCK: " + msgs.join("; ");
    stuckEl.style.display = "block";
  } else {
    stuckEl.className = "stuck-alert";
    stuckEl.style.display = "none";
  }

  // Queue
  let qhtml = "";
  for (const q of QUEUE_META) {
    qhtml += '<div class="queue-row"><span class="queue-label"><span class="queue-dot" style="background:'+q.color+'"></span>'+q.label+'</span><span class="queue-count">'+d.queue[q.key]+'</span></div>';
  }
  document.getElementById("queueRows").innerHTML = qhtml;

  // Printers
  const printerColors = { ready: "#2188EF", printing: "#1866EE", error: "#EF223A", not_found: "#19ABF3", unknown: "#94a0b0" };
  var disabledSet = new Set(d.disabledPrinters || []);
  window._activePrinterNames = (d.printers || []).map(function(p) { return p.name; }).filter(function(n) { return !disabledSet.has(n); });
  var phtml = "";
  if (d.printers && d.printers.length > 0) {
    for (const p of d.printers) {
      var isDisabled = disabledSet.has(p.name);
      var dotColor = isDisabled ? "#94a0b0" : (printerColors[p.status] || "#94a0b0");
      var label = isDisabled ? "Disabled" : p.message;
      var btnClass = isDisabled ? "ptr-btn ptr-btn-enable" : "ptr-btn ptr-btn-disable";
      var btnLabel = isDisabled ? "Enable" : "Disable";
      phtml += '<div class="printer-status"><span class="printer-dot" style="background:' + dotColor + (isDisabled ? ";opacity:.4" : "") + '"></span><span style="flex:1">' + escHtml(p.name) + ' — ' + escHtml(label) + '</span><button class="' + btnClass + '" onclick="togglePrinter(&apos;' + escHtml(p.name) + '&apos;)">' + btnLabel + '</button></div>';
    }
  } else {
    phtml = '<div class="printer-status"><span class="printer-dot" style="background:#19ABF3"></span><span>No printers active</span></div>';
  }
  document.getElementById("printerList").innerHTML = phtml;

  // Printer warnings
  var pwEl = document.getElementById("printerWarning");
  var noPrinters = !d.printers || d.printers.length === 0;
  var allDisabled = !noPrinters && d.printers.every(function(p) { return disabledSet.has(p.name); });
  var readyCount = d.queue ? d.queue.ready : 0;
  var pwMsg = "";
  if (noPrinters && readyCount > 0 && d.enablePrinting) {
    pwMsg = readyCount + " job" + (readyCount > 1 ? "s" : "") + " waiting but no printers are connected.";
    if (d.immediateDigitalDelivery === false) {
      pwMsg += " Digital delivery is also paused until print — users won't receive their portraits.";
    }
  } else if (allDisabled && readyCount > 0 && d.enablePrinting) {
    pwMsg = readyCount + " job" + (readyCount > 1 ? "s" : "") + " waiting but all printers are disabled.";
    if (d.immediateDigitalDelivery === false) {
      pwMsg += " Digital delivery is also paused until print — users won't receive their portraits.";
    }
  }
  if (pwMsg) {
    pwEl.className = "stuck-alert error";
    pwEl.textContent = pwMsg;
    pwEl.style.display = "block";
  } else {
    pwEl.style.display = "none";
  }

  // Styles
  const styleVals = Object.values(d.styleCounts);
  const maxStyle = styleVals.length > 0 ? Math.max(1, ...styleVals) : 1;
  let shtml = "";
  const sortedStyles = Object.entries(d.styleCounts).sort((a,b) => b[1]-a[1]);
  for (const [name, count] of sortedStyles) {
    const pct = (count / maxStyle * 100).toFixed(1);
    const color = STYLE_COLORS[name] || "#2188EF";
    shtml += '<div class="style-row"><span class="style-name">'+name+'</span><div class="style-bar-bg"><div class="style-bar" style="width:'+pct+'%;background:'+color+'"></div></div><span class="style-count">'+count+'</span></div>';
  }
  document.getElementById("styleBars").innerHTML = shtml;

  // Hourly
  const maxH = d.hourlyActivity.length > 0 ? Math.max(1, ...d.hourlyActivity) : 1;
  let barsHtml = "";
  let labelsHtml = "";
  for (let i = 0; i < d.hourlyActivity.length; i++) {
    const h = d.hourlyActivity[i];
    const hpct = Math.max(2, Math.round(h / maxH * 100));
    const lbl = d.hourlyLabels ? d.hourlyLabels[i] : "";
    const showLabel = (i % 3 === 0) || i === 23;
    barsHtml += '<div class="hourly-bar" style="height:'+hpct+'%"><span class="hourly-tip">'+lbl+': '+h+'</span></div>';
    labelsHtml += '<span class="hourly-label">'+(showLabel ? lbl : "")+'</span>';
  }
  document.getElementById("hourlyBars").innerHTML = barsHtml;
  document.getElementById("hourlyLabels").innerHTML = labelsHtml;

  // Users — fetched on separate interval (see below)

  // Health
  document.getElementById("healthDone").textContent = d.totals.done;
  document.getElementById("healthFailed").textContent = d.totals.failed;
  const total = d.totals.done + d.totals.failed;
  document.getElementById("healthRate").textContent = total > 0 ? (d.totals.done / total * 100).toFixed(0) + "%" : "--";
  document.getElementById("healthModRate").textContent = d.moderationRate || "--";

  // Durations
  if (d.durations) {
    var fmtTime = function(sec) {
      if (sec === null || sec === undefined) return "--";
      if (sec < 60) return sec + "s";
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + "m " + s + "s";
    };
    document.getElementById("avgGenTime").textContent = fmtTime(d.durations.avgGenerationSec);
    document.getElementById("avgPrintTime").textContent = fmtTime(d.durations.avgPrintSec);
  }

  // Failure breakdown
  const FAIL_META = [
    { key: "moderation", label: "Moderation", color: "#EF223A" },
    { key: "face_detection", label: "Face Detection", color: "#19ABF3" },
    { key: "multi_subject", label: "Multi-Subject", color: "#9AA0B4" },
    { key: "generation", label: "Generation/API", color: "#1866EE" },
    { key: "printer", label: "Printer", color: "#2188EF" },
    { key: "max_retries", label: "Crash Recovery", color: "#94a0b0" },
    { key: "unknown", label: "Unknown", color: "#656E87" },
  ];
  const fb = d.failureBreakdown || {};
  const fbVals = Object.values(fb);
  const maxFail = fbVals.length > 0 ? Math.max(1, ...fbVals) : 1;
  const totalFails = Object.values(fb).reduce((a,b) => a+b, 0);
  let fhtml = "";
  if (totalFails === 0) {
    fhtml = '<div style="color:var(--th-text-muted);font-size:13px">No failures</div>';
  } else {
    for (const fm of FAIL_META) {
      const c = fb[fm.key] || 0;
      if (c === 0) continue;
      const pct = (c / maxFail * 100).toFixed(1);
      fhtml += '<div class="fail-row"><span class="fail-name">'+fm.label+'</span><div class="fail-bar-bg"><div class="fail-bar" style="width:'+pct+'%;background:'+fm.color+'"></div></div><span class="fail-count">'+c+'</span></div>';
    }
  }
  document.getElementById("failBars").innerHTML = fhtml;

  // Geography
  const geo = d.countryCounts || [];
  const maxGeo = geo.length > 0 ? Math.max(1, geo[0].count) : 1;
  let ghtml = "";
  if (geo.length === 0) {
    ghtml = '<div style="color:var(--th-text-muted);font-size:13px">No data yet</div>';
  } else {
    const top10 = geo.slice(0, 10);
    for (const g of top10) {
      const pct = (g.count / maxGeo * 100).toFixed(1);
      ghtml += '<div class="geo-row"><span class="geo-name" title="'+g.country+'">'+g.country+'</span><div class="geo-bar-bg"><div class="geo-bar" style="width:'+pct+'%"></div></div><span class="geo-count">'+g.count+'</span></div>';
    }
  }
  document.getElementById("geoBars").innerHTML = ghtml;

  // NPS
  renderNps(d.nps);

  // Last updated timestamp
  var now = new Date();
  document.getElementById("lastUpdated").textContent = now.toLocaleTimeString();
}


function generateReport() {
  const btn = document.getElementById("reportBtn");
  btn.textContent = "Generating...";
  btn.disabled = true;
  const url = "api/report" + queryParams();
  // Open in new tab so browser handles the PDF download
  const w = window.open(url, "_blank");
  // Restore button after a short delay (PDF streams immediately, but AI summary may take a moment)
  setTimeout(function() { btn.textContent = "Generate Report"; btn.disabled = false; }, 4000);
}

fetchStats();
setInterval(fetchStats, 3000);
setInterval(function() { fetchAuditLog(false); }, 15000);
document.addEventListener("visibilitychange", function() {
  if (!document.hidden) { fetchStats(); fetchJobs(); fetchReviewQueue(); fetchAuditLog(false); fetchDashboardUsers(); }
});

// ── User Management ──
var _duGen = 0;
async function fetchDashboardUsers() {
  var gen = ++_duGen;
  try {
    var ep = "api/dashboard-users?e=" + encodeURIComponent(selectedEvent);
    var r = await fetch(ep);
    var d = await r.json();
    if (gen !== _duGen) return; // stale response — a newer fetch superseded this one
    renderDashboardUsers(d.users || []);
  } catch(e) { /* retry next poll */ }
}

function renderDashboardUsers(users) {
  var el = document.getElementById("dashboardUsers");
  if (!users.length) { el.innerHTML = '<div style="color:var(--th-text-muted);font-size:13px">No users yet</div>'; return; }
  var html = "";
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var badges = "";
    if (u.isAdmin) badges += '<span class="du-badge du-badge-admin">Admin</span>';
    if (u.leadCompleted) badges += '<span class="du-badge du-badge-lead">Lead</span>';
    var countText = u.isAdmin ? u.count + " (unlimited)" : u.count + " / " + u.maxPrints;
    var nameHtml = u.name ? '<span class="user-name">' + escHtml(u.name) + '</span>' : '';
    var phoneStyle = u.name ? '' : ' style="flex:1"';
    html += '<div class="user-row">'
      + '<span class="user-phone"' + phoneStyle + '>' + u.phone + '</span>'
      + nameHtml
      + '<span class="du-badges">' + badges + '</span>'
      + '<span class="user-count">' + countText + '</span>'
      + '<span class="du-actions">'
      + '<button class="btn btn-xs" onclick="resetUserUsage('+u.id+')" title="Reset this user&#39;s portrait count to 0">Reset Portraits</button>'
      + '<button class="btn btn-xs" onclick="resetUserSurvey('+u.id+')" title="Clear lead capture so this user can retake the survey">Reset Survey</button>'
      + '<button class="btn btn-xs' + (u.isAdmin ? ' btn-primary' : '') + '" onclick="toggleUserAdmin('+u.id+')" title="' + (u.isAdmin ? 'Remove admin' : 'Make admin') + '">' + (u.isAdmin ? 'Admin' : 'Admin') + '</button>'
      + '</span>'
      + '</div>';
  }
  el.innerHTML = html;
}

function resetUserUsage(id) {
  if (selectedEvent === "all") { showToast("Select a specific event to reset portraits"); return; }
  var ev = selectedEvent;
  if (!confirm("Reset this user's portrait count to 0 for " + ev + "?")) return;
  fetch("api/dashboard-users/reset-usage", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: id, event: ev }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) { showToast("Portrait count reset"); fetchDashboardUsers(); fetchStats(); } else { showToast("Error: " + (d.error || "unknown")); } })
    .catch(function() { showToast("Failed to reset portraits"); });
}

function resetUserSurvey(id) {
  if (selectedEvent === "all") { showToast("Select a specific event to reset survey"); return; }
  var ev = selectedEvent;
  if (!confirm("Clear lead capture survey for this user on " + ev + "? They will be asked to fill it out again.")) return;
  fetch("api/dashboard-users/reset-survey", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: id, event: ev }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) { showToast("Survey reset"); fetchDashboardUsers(); } else { showToast("Error: " + (d.error || "unknown")); } })
    .catch(function() { showToast("Failed to reset survey"); });
}

function toggleUserAdmin(id) {
  var ev = selectedEvent !== "all" ? selectedEvent : null;
  fetch("api/dashboard-users/toggle-admin", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: id, event: ev }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) { showToast(d.isAdmin ? "Admin added" : "Admin removed"); fetchDashboardUsers(); fetchStats(); } else { showToast("Error: " + (d.error || "unknown")); } })
    .catch(function() { showToast("Failed to toggle admin"); });
}

fetchDashboardUsers();
setInterval(fetchDashboardUsers, 10000);

// ── Combined Jobs Panel ──
var _jobFilter = "all";
var _failedJobs = [];
var _doneJobs = [];

function timeAgo(ts) {
  if (!ts) return "";
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}

function renderNps(npsData) {
  var el = document.getElementById("npsPanel");
  if (!npsData || npsData.count === 0) {
    el.innerHTML = '<div class="nps-disabled">No NPS responses yet.</div>';
    return;
  }
  var avg = npsData.average;
  var cls = avg >= 4 ? "nps-score-good" : avg >= 3 ? "nps-score-ok" : "nps-score-bad";
  var maxCount = Math.max(1, Math.max(npsData.distribution[1]||0, npsData.distribution[2]||0, npsData.distribution[3]||0, npsData.distribution[4]||0, npsData.distribution[5]||0));
  var colors = { 1: "#EF223A", 2: "#F83D53", 3: "#19ABF3", 4: "#2188EF", 5: "#1866EE" };
  var h = '<div class="nps-big"><span class="nps-score '+cls+'">'+avg+'</span><span class="nps-count">'+npsData.count+' responses</span></div>';
  h += '<div class="nps-bars">';
  for (var i = 5; i >= 1; i--) {
    var c = npsData.distribution[i] || 0;
    var pct = Math.round((c / maxCount) * 100);
    h += '<div class="nps-bar-row"><span class="nps-bar-label">'+i+'</span><div class="nps-bar-track"><div class="nps-bar-fill" style="width:'+pct+'%;background:'+colors[i]+'"></div></div><span class="nps-bar-val">'+c+'</span></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function failDetail(j) {
  switch (j.failReason) {
    case "moderation":
      return "Image was flagged by content moderation and blocked automatically.";
    case "face_detection":
      return "No face was detected in the photo. The user may have sent a non-selfie image.";
    case "multi_subject":
      return "Detected " + (j.detectedSubjects || "multiple") + " people in the photo. This event only allows 1 person per photo.";
    case "ai_review_rejected":
      return j.aiReviewResult ? escHtml(j.aiReviewResult.replace(/^FAIL:\s*/i, "AI flagged: ")) : "AI quality review rejected this image.";
    case "review_rejected":
      return "Rejected by a human reviewer during manual review.";
    case "content_rejected":
      return "Content was permanently rejected during generation.";
    case "generation":
      return "Image generation failed after " + (j.retries || "max") + " retries.";
    case "printer":
      return "Print failed after " + (j.retries || "max") + " retries.";
    case "max_retries":
      return "Exceeded maximum retry attempts.";
    default:
      return "";
  }
}

function printerDropdown(id, defaultLabel) {
  var printers = window._activePrinterNames || [];
  var h = '<select id="' + id + '" class="fj-printer-select">';
  h += '<option value="">' + escHtml(defaultLabel || "Any printer") + '</option>';
  for (var p of printers) h += '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>';
  h += '</select>';
  return h;
}

function setJobFilter(f) {
  _jobFilter = f;
  var tabs = document.querySelectorAll(".jb-tab");
  for (var t of tabs) { t.classList.toggle("active", t.getAttribute("data-filter") === f); }
  renderJobs();
}

async function fetchJobs() {
  var evParam = "?e=" + encodeURIComponent(selectedEvent);
  try { var r1 = await fetch("api/failed-jobs" + evParam); _failedJobs = await r1.json(); } catch(e) {}
  try { var r2 = await fetch("api/done-jobs" + evParam); _doneJobs = await r2.json(); } catch(e) {}
  renderJobs();
}

function renderJobs() {
  var el = document.getElementById("jobsList");
  // Merge and sort by time (most recent first)
  var all = [];
  for (var j of _failedJobs) {
    all.push({ type: "failed", ts: j.createdAt || 0, data: j });
  }
  for (var j of _doneJobs) {
    all.push({ type: "done", ts: j.completedAt || 0, data: j });
  }
  // Apply filter
  var filtered = all;
  if (_jobFilter === "failed") filtered = all.filter(function(x) { return x.type === "failed"; });
  else if (_jobFilter === "done") filtered = all.filter(function(x) { return x.type === "done"; });
  filtered.sort(function(a, b) { return b.ts - a.ts; });

  // Update tab counts
  var failCount = _failedJobs.length;
  var doneCount = _doneJobs.length;
  var tabs = document.querySelectorAll(".jb-tab");
  for (var t of tabs) {
    var f = t.getAttribute("data-filter");
    if (f === "all") t.textContent = "All (" + all.length + ")";
    else if (f === "failed") t.textContent = "Failed (" + failCount + ")";
    else if (f === "done") t.textContent = "Completed (" + doneCount + ")";
  }

  if (!filtered.length) {
    var msg = _jobFilter === "failed" ? "No failed jobs" : _jobFilter === "done" ? "No completed jobs" : "No jobs";
    el.innerHTML = '<div class="jb-empty">' + msg + '</div>';
    return;
  }
  var oldList = el.querySelector(".jb-list");
  var scrollTop = oldList ? oldList.scrollTop : 0;
  var h = '<div class="jb-list">';
  for (var item of filtered) {
    var j = item.data;
    if (item.type === "failed") {
      h += renderFailedRow(j);
    } else {
      h += renderDoneRow(j);
    }
  }
  h += '</div>';
  el.innerHTML = h;
  var newList = el.querySelector(".jb-list");
  if (newList && scrollTop) newList.scrollTop = scrollTop;
}

function renderFailedRow(j) {
  var detail = failDetail(j);
  var isPrinterFail = j.failReason === "printer" || j.failReason === "relay_stale" || j.failReason === "max_retries";
  var h = '<div class="jb-row" id="jb-'+escHtml(j.filename)+'">';
  h += '<span class="jb-phone">'+escHtml(j.phone)+'</span>';
  if (j.name) h += '<span class="jb-name">'+escHtml(j.name)+'</span>';
  h += '<span class="jb-style">'+escHtml(j.style)+'</span>';
  h += '<span class="jb-status '+escHtml(j.failReason)+'">'+escHtml(j.failReason).replace(/_/g," ")+'</span>';
  if (j.printerName) h += '<span class="jb-printer">'+escHtml(j.printerName)+'</span>';
  h += '<span class="jb-time">'+timeAgo(j.createdAt)+'</span>';
  if (j.canRetry && isPrinterFail) {
    h += printerDropdown("jb-ptr-"+escHtml(j.filename), "Any printer");
    h += '<button class="jb-btn" onclick="retryJob(&apos;'+escHtml(j.filename)+'&apos;,true)" title="Re-queue directly to print — image already exists">Retry Print</button>';
  } else if (j.canRetry) {
    h += '<button class="jb-btn" onclick="retryJob(&apos;'+escHtml(j.filename)+'&apos;,false)" title="Re-queue this job for fresh generation — the user is not notified">Retry</button>';
  } else {
    h += '<button class="jb-btn" disabled title="Cannot retry moderation failures">Retry</button>';
  }
  if (detail) h += '<div class="jb-detail">'+detail+'</div>';
  h += '</div>';
  return h;
}

function renderDoneRow(j) {
  var h = '<div class="jb-row" id="jb-'+escHtml(j.filename)+'">';
  h += '<span class="jb-phone">'+escHtml(j.phone)+'</span>';
  if (j.name) h += '<span class="jb-name">'+escHtml(j.name)+'</span>';
  h += '<span class="jb-style">'+escHtml(j.style)+'</span>';
  h += '<span class="jb-status done">done</span>';
  if (j.printerName) h += '<span class="jb-printer">'+escHtml(j.printerName)+'</span>';
  h += '<span class="jb-time">'+timeAgo(j.completedAt)+'</span>';
  if (j.canReprint) {
    h += printerDropdown("jb-ptr-"+escHtml(j.filename), "Any printer");
    h += '<button class="jb-btn" onclick="reprintJob(&apos;'+escHtml(j.filename)+'&apos;)">Reprint</button>';
  } else {
    h += '<button class="jb-btn" disabled title="Output image no longer exists">Reprint</button>';
  }
  h += '</div>';
  return h;
}

async function retryJob(filename, isPrintRetry) {
  try {
    var body = { filename };
    if (isPrintRetry) {
      var sel = document.getElementById("jb-ptr-" + filename);
      if (sel && sel.value) body.targetPrinter = sel.value;
    }
    var r = await fetch("api/retry-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d.ok) {
      showToast("Job requeued to " + d.target);
      fetchJobs();
      fetchStats();
    } else {
      showToast(d.error || "Retry failed");
    }
  } catch(e) { showToast("Retry failed"); }
}

async function reprintJob(filename) {
  try {
    var body = { filename };
    var sel = document.getElementById("jb-ptr-" + filename);
    if (sel && sel.value) {
      body.targetPrinter = sel.value;
    }
    var r = await fetch("api/reprint-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d.ok) {
      showToast("Reprint queued" + (body.targetPrinter ? " to " + body.targetPrinter : ""));
      fetchJobs();
      fetchStats();
    } else {
      showToast(d.error || "Reprint failed");
    }
  } catch(e) { showToast("Reprint failed"); }
}

async function togglePrinter(name) {
  try {
    var r = await fetch("api/toggle-printer", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ printer: name })
    });
    var d = await r.json();
    if (d.ok) {
      showToast(name + (d.enabled ? " enabled" : " disabled"));
      fetchStats();
    } else { showToast(d.error || "Failed"); }
  } catch(e) { showToast("Failed to toggle printer"); }
}

function showToast(msg) {
  var t = document.getElementById("fjToast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function() { t.classList.remove("show"); }, 2500);
}

fetchJobs();
setInterval(fetchJobs, 5000);

// ── Review Queue ──
var _reviewEnabled = false;
var _reviewTimer = null;
var _rvSelected = new Set();
var _openFeedback = {};  // { filename: textareaValue }
var _hasReviewPin = false;
var _qrFetched = false;
var _qrSvg = "";
var _qrUrl = "";

function checkReviewEnabled() {
  fetchReviewQueue();
}

async function fetchReviewQueue() {
  try {
    var ep = "api/review-queue?e=" + encodeURIComponent(selectedEvent);
    var r = await fetch(ep);
    var jobs = await r.json();
    renderReviewQueue(jobs);
  } catch(e) {}
}

function updateQrBlock() {
  var qrBlock = document.getElementById("qrReviewBlock");
  var hintBlock = document.getElementById("qrReviewHint");
  if (_hasReviewPin) {
    hintBlock.style.display = "none";
    qrBlock.style.display = "";
    if (!_qrFetched) {
      _qrFetched = true;
      fetch("api/review-qr").then(function(r){return r.json()}).then(function(d){
        _qrSvg = d.svg; _qrUrl = d.url;
        document.getElementById("qrReviewSvg").innerHTML = d.svg;
        document.getElementById("qrReviewUrl").textContent = d.url;
      }).catch(function(){ _qrFetched = false; });
    }
  } else {
    qrBlock.style.display = "none";
    hintBlock.style.display = "";
  }
}

function renderReviewQueue(jobs) {
  var panel = document.getElementById("reviewPanel");
  var grid = document.getElementById("reviewGrid");
  var badge = document.getElementById("reviewCount");

  if (!jobs.length) {
    panel.style.display = "none";
    _rvSelected.clear();
    updateBulkBar(0);
    return;
  }

  panel.style.display = "";
  badge.textContent = jobs.length;
  updateQrBlock();

  // Prune selection to only current filenames
  var current = new Set(jobs.map(function(j){return j.filename}));
  _rvSelected.forEach(function(f){ if (!current.has(f)) _rvSelected.delete(f); });

  var h = "";
  for (var j of jobs) {
    var fn = escHtml(j.filename);
    var fp = escHtml(j.filePrefix);
    var imgSrc = "/images/staging/" + fp + "_output_mms.jpg";
    var sel = _rvSelected.has(j.filename);
    h += '<div class="rv-card'+(sel?" rv-selected":"")+'" id="rv-'+fn+'">';
    var origSrc = "/images/staging/" + fp + "_input.jpg";
    h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect(\\''+fn+'\\',this.checked)" title="Select for bulk action">';
    h += '<div class="rv-images">';
    h += '<div class="rv-img-wrap"><img src="'+origSrc+'" onclick="openReviewModal(\\''+origSrc+'\\',\\'/images/staging/'+fp+'_output.png\\')" title="Click to compare"><span class="rv-img-label">Original</span></div>';
    h += '<div class="rv-img-wrap"><img src="'+imgSrc+'" onclick="openReviewModal(\\''+origSrc+'\\',\\'/images/staging/'+fp+'_output.png\\')" title="Click to compare"><span class="rv-img-label">Generated</span></div>';
    h += '</div>';
    h += '<div class="rv-meta">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+'</div>';
    h += '<div class="rv-actions">';
    h += '<button class="rv-btn rv-btn-approve" onclick="reviewAction(\\''+fn+'\\',\\'approve\\')" title="Deliver this image to the user via MMS">Approve</button>';
    h += '<div class="rv-reject-row">';
    h += '<button class="rv-btn rv-btn-notify" onclick="reviewAction(\\''+fn+'\\',\\'reject\\',{notify:true})" title="Discard and send the user an SMS asking them to try a different photo">Reject + Notify</button>';
    h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback(\\''+fn+'\\')" title="Re-generate with fresh analysis — optionally add instructions">Re-analyze</button>';
    h += '<button class="rv-btn rv-btn-reject" onclick="reviewAction(\\''+fn+'\\',\\'reject\\')" title="Discard this image silently — the user is not notified">Reject</button>';
    h += '</div></div>';
    h += '<div class="rv-feedback" id="rvfb-'+fn+'">';
    h += '<textarea placeholder="Optional: describe what to fix (e.g. fix the logo, include the dog, remove the hat)"></textarea>';
    h += '<div class="rv-feedback-hint">Leave blank to re-generate with fresh analysis only.</div>';
    h += '<div class="rv-feedback-btns">';
    h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedback(\\''+fn+'\\')">Re-generate</button>';
    h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback(\\''+fn+'\\')">Cancel</button>';
    h += '</div></div>';
    h += '</div>';
  }
  // Skip DOM replace while a feedback panel is open (preserves focus and text)
  if (Object.keys(_openFeedback).length > 0) { badge.textContent = jobs.length; return; }
  grid.innerHTML = h;
  updateBulkBar(jobs.length);
}

function toggleSelect(filename, checked) {
  if (checked) _rvSelected.add(filename); else _rvSelected.delete(filename);
  var card = document.getElementById("rv-"+filename);
  if (card) { if (checked) card.classList.add("rv-selected"); else card.classList.remove("rv-selected"); }
  var total = document.querySelectorAll(".rv-card-check").length;
  document.getElementById("rvSelectAll").checked = _rvSelected.size === total && total > 0;
  updateBulkBar(total);
}

function toggleSelectAll(checked) {
  document.querySelectorAll(".rv-card-check").forEach(function(cb) {
    cb.checked = checked;
    var card = cb.closest(".rv-card");
    var fn = card ? card.id.replace("rv-","") : null;
    if (fn) { if (checked) { _rvSelected.add(fn); card.classList.add("rv-selected"); } else { _rvSelected.delete(fn); card.classList.remove("rv-selected"); } }
  });
  var total = document.querySelectorAll(".rv-card-check").length;
  updateBulkBar(total);
}

function updateBulkBar(total) {
  var bar = document.getElementById("rvBulkBar");
  var countEl = document.getElementById("rvBulkCount");
  if (total > 0) {
    bar.classList.add("active");
    countEl.textContent = _rvSelected.size ? _rvSelected.size + " of " + total + " selected" : "";
  } else {
    bar.classList.remove("active");
  }
}

async function bulkReviewAction(action) {
  if (!_rvSelected.size) { showToast("No items selected"); return; }
  var filenames = Array.from(_rvSelected);
  var count = filenames.length;
  var label = action === "approve" ? "approve" : "reject";
  if (!confirm("Are you sure you want to " + label + " " + count + " item" + (count>1?"s":"") + "?")) return;
  try {
    var r = await fetch("api/review-bulk", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({filenames: filenames, action: action})
    });
    var d = await r.json();
    _rvSelected.clear();
    document.getElementById("rvSelectAll").checked = false;
    var ok = d.results ? d.results.filter(function(x){return x.ok}).length : 0;
    var fail = count - ok;
    showToast(ok + " " + label + (action==="approve"?"d":"ed") + (fail ? ", " + fail + " failed" : ""));
    fetchReviewQueue();
    fetchStats();
  } catch(e) { showToast("Bulk action failed"); }
}

async function reviewAction(filename, action, opts) {
  try {
    opts = opts || {};
    var payload = {filename: filename, action: action};
    if (opts.notify) payload.notify = true;
    if (opts.reanalyze) {
      payload.reanalyze = true;
      if (opts.feedback) payload.feedback = opts.feedback;
    }
    var r = await fetch("api/review-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    var d = await r.json();
    if (d.ok) {
      _rvSelected.delete(filename);
      var card = document.getElementById("rv-"+filename);
      if (card) card.remove();
      var msg = action === "approve" ? "Image approved" : opts.reanalyze ? (payload.feedback ? "Re-generating with feedback" : "Re-generating with fresh analysis") : opts.notify ? "Image rejected, user notified" : "Image rejected";
      showToast(msg);
      fetchReviewQueue();
      fetchStats();
    } else {
      showToast(d.error || "Action failed");
    }
  } catch(e) { showToast("Action failed"); }
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function openReviewModal(origSrc, genSrc) {
  document.getElementById("reviewModalOrig").src = origSrc;
  document.getElementById("reviewModalImg").src = genSrc;
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _modalEsc);
}
function closeReviewModal(e) {
  if (e && e.target && e.target.tagName === "IMG") return;
  document.getElementById("reviewModal").classList.remove("open");
  document.removeEventListener("keydown", _modalEsc);
}
function _modalEsc(e) { if (e.key === "Escape") closeReviewModal(); }

function showFeedback(fn) {
  _openFeedback[fn] = _openFeedback[fn] || "";
  var panel = document.getElementById("rvfb-"+fn);
  if (panel) {
    panel.classList.add("open");
    var ta = panel.querySelector("textarea");
    ta.value = _openFeedback[fn];
    ta.focus();
    ta.oninput = function() { _openFeedback[fn] = ta.value; };
  }
}
function hideFeedback(fn) {
  delete _openFeedback[fn];
  var panel = document.getElementById("rvfb-"+fn);
  if (panel) { panel.classList.remove("open"); panel.querySelector("textarea").value = ""; }
}
function submitFeedback(fn) {
  var panel = document.getElementById("rvfb-"+fn);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[fn];
  reviewAction(fn, "reject", { reanalyze: true, feedback: fb || undefined });
}

fetchReviewQueue();
setInterval(fetchReviewQueue, 3000);

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('twilio-theme', next);
}

// ── Audit Log ──
var auditOffset = 0;
var auditLimit = 20;

function fmtAuditTime(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function esc(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function fmtValue(v) {
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "object") return esc(JSON.stringify(v));
  return esc(String(v));
}

function renderAuditEntry(e) {
  var changes = "";
  if (e.action === "settings.update" && e.before && e.after) {
    var keys = Object.keys(e.after);
    changes = keys.map(function(k) {
      return '<span class="key">' + esc(k) + '</span>: <span class="old">' + fmtValue(e.before[k]) + '</span> &rarr; <span class="new">' + fmtValue(e.after[k]) + '</span>';
    }).join("<br>");
  } else if (e.action === "settings.revert") {
    changes = '<em>Reverted change ' + esc((e.originalId || "").slice(0, 8)) + '</em>';
  }
  var revertHtml = "";
  if (e.action === "settings.update") {
    if (e.reverted) {
      revertHtml = '<span class="audit-reverted">Reverted</span>';
    } else {
      revertHtml = '<button onclick="revertAudit(\\\'' + esc(e.id) + '\\\', this)">Revert</button>';
    }
  }
  return '<div class="audit-row">'
    + '<div class="audit-time">' + fmtAuditTime(e.ts) + '</div>'
    + '<div class="audit-actor">' + esc((e.actor || "").split("@")[0]) + '</div>'
    + '<div class="audit-detail">' + changes + '</div>'
    + '<div class="audit-revert">' + revertHtml + '</div>'
    + '</div>';
}

async function fetchAuditLog(append) {
  try {
    var r = await fetch("api/audit?limit=" + auditLimit + "&offset=" + (append ? auditOffset : 0));
    var d = await r.json();
    var container = document.getElementById("auditLog");
    if (!append) { container.innerHTML = ""; auditOffset = 0; }
    if (d.entries.length === 0 && !append) {
      container.innerHTML = '<span style="color:var(--th-text-muted)">No activity logged yet.</span>';
    } else {
      d.entries.forEach(function(e) { container.innerHTML += renderAuditEntry(e); });
    }
    auditOffset += d.entries.length;
    var btn = document.getElementById("auditLoadMore");
    btn.style.display = auditOffset < d.total ? "" : "none";
  } catch(e) {
    document.getElementById("auditLog").innerHTML = '<span style="color:var(--th-text-muted)">Failed to load audit log.</span>';
  }
}

function loadMoreAudit() { fetchAuditLog(true); }

async function revertAudit(id, btn) {
  if (!confirm("Revert this settings change?")) return;
  btn.disabled = true;
  btn.textContent = "Reverting...";
  try {
    var r = await fetch("api/audit/revert/" + id, { method: "POST" });
    var d = await r.json();
    if (d.error) { alert("Revert failed: " + d.error); btn.disabled = false; btn.textContent = "Revert"; return; }
    btn.parentElement.innerHTML = '<span class="audit-reverted">Reverted</span>';
    fetchStats();
  } catch(e) {
    alert("Revert failed");
    btn.disabled = false;
    btn.textContent = "Revert";
  }
}

fetchAuditLog(false);
</script>
${userBarSnippet()}
</body>
</html>`;

// ── Logs HTML ─────────────────────────────────────────────────────────────────

const LOGS_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Logs — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
  }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 24px 28px; }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px; flex-wrap: wrap; gap: 12px;
  }
  .header h1 { font-size: 18px; font-weight: 700; color: var(--th-text); display: flex; align-items: center; gap: 10px; }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; display: inline-block;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
  .header-links { display: flex; gap: 16px; align-items: center; }
  .header-links a {
    color: var(--th-text-dim); text-decoration: none; font-size: 13px; font-weight: 400;
    display: flex; align-items: center; gap: 5px; transition: color .15s;
  }
  .header-links a:hover { color: var(--th-text); }
  .header-links svg { width: 14px; height: 14px; }

  .toolbar {
    display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;
  }
  .tb-btn {
    background: var(--th-bg-subtle); border: 1px solid var(--th-card-border); color: var(--th-text-dim);
    padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
    font-weight: 400; transition: all .15s;
  }
  .tb-btn:hover { border-color: var(--blue-400); color: var(--th-text); }
  .tb-btn.active { background: rgba(33,136,239,.2); border-color: var(--blue-400); color: #2188EF; }
  .tb-btn.err.active { background: rgba(239,34,58,.13); border-color: var(--brand-red); color: #EF223A; }
  .tb-btn.wrn.active { background: rgba(25,171,243,.13); border-color: var(--blue-300); color: #19ABF3; }
  .tb-select {
    background: var(--th-bg-subtle); border: 1px solid var(--th-card-border); color: var(--th-text-dim);
    padding: 5px 8px; border-radius: 6px; font-size: 12px; font-family: inherit;
  }
  .tb-search {
    background: var(--th-bg-subtle); border: 1px solid var(--th-card-border); color: var(--th-text-dim);
    padding: 5px 10px; border-radius: 6px; font-size: 12px; font-family: inherit;
    flex: 1; min-width: 120px; max-width: 260px;
  }
  .tb-search::placeholder { color: var(--th-text-muted); }
  .tb-spacer { flex: 1; }

  .log-container {
    background: var(--th-bg-subtle); border: 1px solid var(--th-card-border); border-radius: 8px;
    height: calc(100vh - 160px); overflow-y: auto; padding: 8px 0;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 12px; line-height: 1.6;
  }
  .log-container::-webkit-scrollbar { width: 6px; }
  .log-container::-webkit-scrollbar-track { background: transparent; }
  .log-container::-webkit-scrollbar-thumb { background: var(--th-card-border); border-radius: 3px; }

  .log-entry {
    padding: 1px 12px; display: flex; gap: 8px; animation: fadeIn .15s;
    border-left: 2px solid transparent;
  }
  .log-entry:hover { background: #161b2233; }
  .log-entry.level-error { border-left-color: var(--brand-red); }
  .log-entry.level-warn { border-left-color: var(--blue-300); }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .le-time { color: var(--th-text-muted); white-space: nowrap; min-width: 85px; }
  .le-level {
    font-weight: 700; text-transform: uppercase; font-size: 10px;
    min-width: 38px; text-align: center; padding: 1px 0; border-radius: 3px;
    line-height: 1.8;
  }
  .le-level.info { color: #2188EF; }
  .le-level.warn { color: #19ABF3; background: rgba(25,171,243,.07); }
  .le-level.error { color: #EF223A; background: rgba(239,34,58,.07); }
  .le-cat {
    color: var(--th-text-dim); font-size: 10px; min-width: 55px; opacity: .7;
    line-height: 1.9;
  }
  .le-msg { color: var(--th-text-dim); white-space: pre-wrap; word-break: break-word; flex: 1; }
  .le-msg.error-msg { color: #F83D53; }

  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 200px; color: var(--th-text-muted); font-size: 14px;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1><span class="status-dot" id="statusDot" style="background:#2188EF"></span>Application Logs</h1>
    <div class="header-links header-controls">
      <a href="/dashboard/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Dashboard</a>
      <a href="/home/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
    </div>
  </div>

  <div class="toolbar">
    <button class="tb-btn active" onclick="setLevel('')" id="btnAll">All</button>
    <button class="tb-btn" onclick="setLevel('info')" id="btnInfo">Info</button>
    <button class="tb-btn wrn" onclick="setLevel('warn')" id="btnWarn">Warn</button>
    <button class="tb-btn err" onclick="setLevel('error')" id="btnError">Error</button>
    <select class="tb-select" id="catFilter" onchange="applyFilters()">
      <option value="">All Categories</option>
      <option value="queue">Queue</option>
      <option value="pipeline">Pipeline</option>
      <option value="print">Print</option>
      <option value="sms">SMS</option>
      <option value="safety">Safety</option>
      <option value="system">System</option>
      <option value="error">Error</option>
      <option value="app">App</option>
    </select>
    <input class="tb-search" id="searchBox" type="text" placeholder="Search logs..." oninput="applyFilters()">
    <div class="tb-spacer"></div>
    <button class="tb-btn" id="pauseBtn" onclick="togglePause()">Pause</button>
    <button class="tb-btn" onclick="clearLogs()">Clear</button>
  </div>

  <div class="log-container" id="logContainer">
    <div class="empty-state" id="emptyState">Connecting...</div>
  </div>
</div>

<script>
var _entries = [];
var _levelFilter = '';
var _paused = false;
var _autoScroll = true;
var _evtSource = null;
var _lastId = 0;
var MAX_DOM = 1000;

var container = document.getElementById('logContainer');
var emptyState = document.getElementById('emptyState');

container.addEventListener('scroll', function() {
  var atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  _autoScroll = atBottom;
});

function fmtTime(ts) {
  var d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function shouldShow(entry) {
  if (_levelFilter && entry.level !== _levelFilter) return false;
  var cat = document.getElementById('catFilter').value;
  if (cat && entry.category !== cat) return false;
  var q = document.getElementById('searchBox').value.toLowerCase();
  if (q && entry.message.toLowerCase().indexOf(q) === -1) return false;
  return true;
}

function renderEntry(entry) {
  var div = document.createElement('div');
  div.className = 'log-entry level-' + entry.level;
  div.dataset.level = entry.level;
  div.dataset.cat = entry.category;
  if (!shouldShow(entry)) div.classList.add('hidden');
  div.innerHTML =
    '<span class="le-time">' + fmtTime(entry.ts) + '</span>' +
    '<span class="le-level ' + entry.level + '">' + entry.level + '</span>' +
    '<span class="le-cat">' + entry.category + '</span>' +
    '<span class="le-msg' + (entry.level === 'error' ? ' error-msg' : '') + '">' + escHtml(entry.message) + '</span>';
  return div;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addEntry(entry) {
  _entries.push(entry);
  if (entry.id > _lastId) _lastId = entry.id;
  emptyState.style.display = 'none';
  var el = renderEntry(entry);
  container.appendChild(el);
  // Prune oldest DOM nodes
  while (container.children.length > MAX_DOM + 1) {
    container.removeChild(container.children[0]);
  }
  if (_autoScroll) container.scrollTop = container.scrollHeight;
}

function setLevel(level) {
  _levelFilter = level;
  document.querySelectorAll('.toolbar .tb-btn').forEach(function(b) {
    if (b.id === 'pauseBtn') return;
    b.classList.remove('active');
  });
  var id = level ? 'btn' + level.charAt(0).toUpperCase() + level.slice(1) : 'btnAll';
  var el = document.getElementById(id);
  if (el) el.classList.add('active');
  applyFilters();
}

function applyFilters() {
  var entries = container.querySelectorAll('.log-entry');
  var q = document.getElementById('searchBox').value.toLowerCase();
  var cat = document.getElementById('catFilter').value;
  entries.forEach(function(el) {
    var show = true;
    if (_levelFilter && el.dataset.level !== _levelFilter) show = false;
    if (cat && el.dataset.cat !== cat) show = false;
    if (q && el.querySelector('.le-msg').textContent.toLowerCase().indexOf(q) === -1) show = false;
    el.classList.toggle('hidden', !show);
  });
}

function clearLogs() {
  _entries = [];
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(emptyState);
  emptyState.textContent = 'Logs cleared';
  emptyState.style.display = '';
}

function togglePause() {
  _paused = !_paused;
  document.getElementById('pauseBtn').textContent = _paused ? 'Resume' : 'Pause';
  document.getElementById('pauseBtn').classList.toggle('active', _paused);
  if (_paused) {
    if (_evtSource) { _evtSource.close(); _evtSource = null; }
    document.getElementById('statusDot').style.background = '#19ABF3';
  } else {
    connectSSE();
  }
}

function connectSSE() {
  if (_evtSource) _evtSource.close();
  _evtSource = new EventSource('/dashboard/api/logs/stream');
  _evtSource.onopen = function() {
    document.getElementById('statusDot').style.background = '#2188EF';
  };
  _evtSource.onmessage = function(e) {
    try {
      var entry = JSON.parse(e.data);
      addEntry(entry);
    } catch(_) {}
  };
  _evtSource.onerror = function() {
    document.getElementById('statusDot').style.background = '#EF223A';
  };
}

// Load initial buffer, then start SSE
fetch('/dashboard/api/logs')
  .then(function(r) { return r.json(); })
  .then(function(entries) {
    emptyState.style.display = entries.length ? 'none' : '';
    if (!entries.length) emptyState.textContent = 'No logs yet — waiting for activity...';
    entries.forEach(function(e) { addEntry(e); });
    connectSSE();
  })
  .catch(function() {
    emptyState.textContent = 'Failed to load logs';
    emptyState.style.display = '';
    // Try SSE anyway
    connectSSE();
  });
</script>
${userBarSnippet()}
</body>
</html>`;

// ── Start ────────────────────────────────────────────────────────────────────

function mountDashboard(app) {
    app.use("/dashboard", router);
    console.log("📊 Dashboard mounted at /dashboard");
}

module.exports = { mountDashboard };
