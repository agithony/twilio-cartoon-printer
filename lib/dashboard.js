const fs = require("fs");
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
const paper = require("./paper");
const { getPrinterBusyState, incrementUsage, getReviewQueue, approveJob, rejectJob } = require("./queue");
const { jobPaths } = require("./pipeline");
const nps = require("./nps");

const router = express.Router();
router.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────

function countFiles(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
        return 0;
    }
}

function readJobs(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
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

function computeStats(eventFilter, excludeAdmin) {
    const isAdmin = (phone) => settings.get("adminPhones").includes(phone);
    const allDoneJobs = readJobs(DONE_DIR);
    const allFailedJobs = readJobs(FAILED_DIR);

    // Merge events from job files + downloads directory
    const jobEvents = [...allDoneJobs, ...allFailedJobs].map((j) => j.eventName).filter(Boolean);
    let dlEvents = [];
    try {
        const dlRoot = path.join(__dirname, "..", "downloads");
        dlEvents = fs.readdirSync(dlRoot, { withFileTypes: true })
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
    const failureBreakdown = { moderation: 0, face_detection: 0, generation: 0, printer: 0, review_rejected: 0, max_retries: 0, unknown: 0 };
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

function getStuckJobs() {
    const now = Date.now();
    const GENERATING_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const PRINTING_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    const stuck = [];

    const REVIEW_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    for (const [dir, label, threshold] of [
        [GENERATING_DIR, "generating", GENERATING_THRESHOLD],
        [REVIEW_DIR, "review", REVIEW_THRESHOLD],
        [PRINTING_DIR, "printing", PRINTING_THRESHOLD],
    ]) {
        const jobs = readJobs(dir);
        for (const job of jobs) {
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

router.get("/api/stats", async (req, res) => {
    try {
        const eventFilter = req.query.e || "all";
        const excludeAdmin = req.query.xa === "1";
        const stats = computeStats(eventFilter, excludeAdmin);

        const queue = {
            pending: countFiles(PENDING_DIR),
            generating: countFiles(GENERATING_DIR),
            review: countFiles(REVIEW_DIR),
            ready: countFiles(READY_DIR),
            printing: countFiles(PRINTING_DIR),
        };
        const printers = await getAllPrinterStatuses();
        const stuckJobs = getStuckJobs();
        const durations = computeDurations(eventFilter, excludeAdmin);

        res.json({
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
            paper: paper.getState(),
            printers,
            failureBreakdown: stats.failureBreakdown,
            moderationRate: stats.moderationRate,
            countryCounts: stats.countryCounts,
            queuePaused: settings.get("queuePaused") || false,
            nps: nps.getStats(eventFilter === "all" ? null : eventFilter),
        });
    } catch (err) {
        console.error("Stats API error:", err);
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
    const stats = computeStats(eventFilter, true);
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
    const red = "#F22F46";
    const dark = "#0F1419";
    const mid = "#374151";
    const muted = "#6B7280";
    const light = "#9CA3AF";
    const veryLight = "#F3F4F6";
    const white = "#FFFFFF";
    const blue = "#6199f5";
    const green = "#3cc968";
    const orange = "#f0983a";
    const purple = "#a87fee";
    const pink = "#f07aab";
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
            { barCol: 1, barMax: maxGeo, barColor: "#3BC4CC" }
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
        const npsColors = { 5: "#3cc968", 4: "#7BC74D", 3: "#E8C53A", 2: "#f0983a", 1: "#F22F46" };
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

router.post("/api/paper/reset", (req, res) => {
    res.json(paper.reset());
});

router.post("/api/paper/config", (req, res) => {
    const { capacity, warningThreshold } = req.body || {};
    res.json(paper.updateConfig({ capacity, warningThreshold }));
});

// ── Review Queue API ─────────────────────────────────────────────────────────

router.get("/api/review-queue", (req, res) => {
    const jobs = getReviewQueue();
    res.json(jobs);
});

router.post("/api/review-job", async (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    const action = (req.body || {}).action;
    if (!filename || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filename and action (approve|reject) required" });
    }
    try {
        if (action === "approve") {
            await approveJob(filename);
        } else {
            await rejectJob(filename);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Failed Jobs API ──────────────────────────────────────────────────────────

router.get("/api/failed-jobs", (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = readJobs(FAILED_DIR).map((j) => {
        const filename = `${j.filePrefix}.json`;
        if (eventFilter !== "all" && j.eventName !== eventFilter) return null;
        return {
            filename,
            filePrefix: j.filePrefix,
            phone: maskPhone(j.userPhone),
            style: j.style || "unknown",
            failReason: j.failReason || "unknown",
            retries: j.retries || 0,
            createdAt: j.createdAt,
            canRetry: j.failReason !== "moderation",
        };
    }).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(jobs);
});

router.post("/api/retry-job", (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    if (!filename) return res.status(400).json({ error: "filename required" });

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

        // If review-rejected, delete old output so it re-generates fresh
        const { outputPath, mmsPath } = jobPaths(job);
        if (wasReviewRejected) {
            try { fs.unlinkSync(outputPath); } catch {}
            try { fs.unlinkSync(mmsPath); } catch {}
        }

        // Check if output already exists — skip to print queue if so
        const targetDir = fs.existsSync(outputPath) && settings.get("enablePrinting") ? READY_DIR : PENDING_DIR;

        fs.writeFileSync(srcPath, JSON.stringify(job, null, 2));
        fs.renameSync(srcPath, path.join(targetDir, filename));

        // Restore usage count
        if (job.userPhone && job.eventName) {
            incrementUsage(job.userPhone, job.eventName);
        }

        const target = targetDir === READY_DIR ? "print queue" : "generation queue";
        console.log(`🔄 Retrying job ${filename} → ${target}`);
        res.json({ ok: true, target });
    } catch (err) {
        console.error(`Failed to retry job ${filename}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ── Style Preview API ────────────────────────────────────────────────────────

router.get("/api/style-preview", (req, res) => {
    const style = req.query.style;
    if (!style) return res.status(400).json({ error: "style required" });
    const doneJobs = readJobs(DONE_DIR);
    const downloadDir = settings.getDownloadDir();
    const match = doneJobs.find((j) => {
        if (j.style !== style || !j.filePrefix) return false;
        const mmsPath = path.join(downloadDir, `${j.filePrefix}_output_mms.jpg`);
        return fs.existsSync(mmsPath);
    });
    if (!match) return res.json({ image: null });
    res.json({ image: `/images/${match.filePrefix}_output_mms.jpg` });
});

// ── Settings API ─────────────────────────────────────────────────────────────

router.get("/api/settings", (req, res) => {
    res.json(settings.getAll());
});

router.post("/api/settings", (req, res) => {
    const result = settings.update(req.body);
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
    const eventProfiles = settings.listEventProfiles();
    res.json({ templates, videos, printers, events, brandReferences, eventProfiles });
});

router.post("/api/settings/reset", (req, res) => {
    const result = settings.reset();
    res.json(result);
});

// File upload for templates and videos (streams to disk, no size buffering limit)
router.post("/api/settings/upload", (req, res) => {
    const filename = req.query.filename;
    const type = req.query.type;

    if (!filename || !type) {
        return res.status(400).json({ error: "filename and type query params are required" });
    }
    if (!["template", "video", "brand-reference"].includes(type)) {
        return res.status(400).json({ error: "type must be 'template', 'video', or 'brand-reference'" });
    }

    // Validate file extension
    const ext = path.extname(filename).toLowerCase();
    const allowed = type === "template"
        ? [".png", ".jpg", ".jpeg", ".gif", ".svg"]
        : type === "brand-reference"
        ? [".png", ".jpg", ".jpeg", ".gif"]
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
        : path.join(__dirname, "..", "assets");

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
        writeStream.write(chunk);
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
            const files = type === "template" ? settings.listTemplates() : type === "brand-reference" ? settings.listBrandReferences() : settings.listVideos();
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

    res.json({ success: true, files: settings.listBrandReferences() });
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
        Connection: "keep-alive",
    });
    res.write(":\n\n");
    const onEntry = (entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Dashboard — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(15px, 1.2vw, 19px); }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1219;
    color: #b8c0cc;
    min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
    scrollbar-width: thin; scrollbar-color: #2e3744 #0f1219;
  }
  .wrap { max-width: 1400px; margin: 0 auto; }

  /* Section group dividers */
  .section-group { margin-bottom: clamp(20px, 2.5vw, 36px); }
  .section-label {
    font-size: 11px; font-weight: 700; color: #6b7585;
    text-transform: uppercase; letter-spacing: 1.5px;
    padding: 0 0 14px 0;
    display: flex; align-items: center; gap: 12px;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: #252d3a; }

  /* Header */
  .header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: clamp(20px, 2.5vw, 36px);
    padding-bottom: clamp(14px, 1.5vw, 22px);
    border-bottom: 1px solid #252d3a;
    gap: 16px; flex-wrap: wrap;
  }
  .header h1 {
    font-size: clamp(20px, 1.6vw, 28px); font-weight: 700; color: #edf0f5;
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
    background: rgba(23,28,37,.8); backdrop-filter: blur(8px);
    border: 1px solid #252d3a; border-radius: 10px;
    padding: 8px 14px; font-size: 13px; font-weight: 500; color: #b8c0cc;
    font-family: inherit; cursor: pointer; white-space: nowrap;
    transition: all .2s ease;
    text-decoration: none;
  }
  .hdr-item:hover { color: #edf0f5; border-color: #364050; background: rgba(28,34,48,.9); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .hdr-item svg { width: 14px; height: 14px; flex-shrink: 0; }
  .hdr-item select {
    background: transparent; border: none; color: #edf0f5;
    font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer; outline: none; padding: 0; margin: 0;
    -webkit-appearance: none; appearance: none;
  }
  .hdr-item select option { background: #171c25; color: #b8c0cc; }
  .hdr-item input[type=checkbox] { accent-color: #F22F46; cursor: pointer; margin: 0; }
  .hdr-item.hdr-action {
    background: linear-gradient(135deg, #F22F46, #e0283e); border-color: #F22F46; color: #fff; font-weight: 600;
    letter-spacing: .2px; box-shadow: 0 2px 8px rgba(242,47,70,.2);
  }
  .hdr-item.hdr-action:hover { background: linear-gradient(135deg, #ff3a52, #F22F46); border-color: #ff3a52; box-shadow: 0 4px 16px rgba(242,47,70,.3); }
  .hdr-item.hdr-action:disabled { opacity: .6; cursor: default; box-shadow: none; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(clamp(130px, 13vw, 210px), 1fr)); gap: clamp(12px, 1.2vw, 18px); margin-bottom: clamp(8px, 1vw, 16px); }
  .card {
    background: linear-gradient(145deg, #1a2030, #171c25);
    border: 1px solid #252d3a;
    border-top: 3px solid #252d3a;
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
  .card:hover { transform: translateY(-3px); box-shadow: 0 12px 40px rgba(0,0,0,.25); border-color: #364050; }
  .card:nth-child(1) { border-top-color: #6199f5; }
  .card:nth-child(2) { border-top-color: #3cc968; }
  .card:nth-child(3) { border-top-color: #a87fee; }
  .card:nth-child(4) { border-top-color: #f0983a; }
  .card:nth-child(5) { border-top-color: #f07aab; }
  .card:nth-child(1)::before { background: linear-gradient(180deg, rgba(75,139,245,.06) 0%, transparent 100%); }
  .card:nth-child(2)::before { background: linear-gradient(180deg, rgba(46,186,84,.06) 0%, transparent 100%); }
  .card:nth-child(3)::before { background: linear-gradient(180deg, rgba(155,111,232,.06) 0%, transparent 100%); }
  .card:nth-child(4)::before { background: linear-gradient(180deg, rgba(232,133,58,.06) 0%, transparent 100%); }
  .card:nth-child(5)::before { background: linear-gradient(180deg, rgba(232,107,158,.06) 0%, transparent 100%); }
  .card .value { font-size: clamp(24px, 2.4vw, 42px); font-weight: 700; color: #edf0f5; font-variant-numeric: tabular-nums; position: relative; transition: color .3s; }
  .card .label { font-size: 12px; color: #6b7585; margin-top: 6px; text-transform: uppercase; letter-spacing: .6px; font-weight: 500; position: relative; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(12px, 1.2vw, 18px); }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: linear-gradient(160deg, #1a2030, #171c25);
    border: 1px solid #252d3a;
    border-radius: 16px;
    padding: clamp(24px, 2.2vw, 36px);
    position: relative;
    overflow: hidden;
    transition: border-color .2s ease, box-shadow .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  .panel::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: #252d3a;
  }
  .panel:hover { border-color: #2e3744; box-shadow: 0 8px 32px rgba(0,0,0,.2); }
  .panel h2 {
    font-size: 13px; font-weight: 700; color: #94a0b0;
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: clamp(14px, 1.4vw, 22px);
    padding-left: 12px; border-left: 3px solid #6199f5;
    line-height: 1; padding-top: 1px; padding-bottom: 1px;
  }
  /* Panel accent colors by section */
  .sg-analytics .panel::before { background: linear-gradient(90deg, #6199f5, #6199f500); }
  .sg-analytics .panel h2 { border-left-color: #6199f5; }
  .sg-users .panel::before { background: linear-gradient(90deg, #3cc968, #3cc96800); }
  .sg-users .panel h2 { border-left-color: #3cc968; }
  .sg-failures .panel::before { background: linear-gradient(90deg, #f0983a, #f0983a00); }
  .sg-failures .panel h2 { border-left-color: #f0983a; }
  .sg-operations .panel::before { background: linear-gradient(90deg, #a87fee, #a87fee00); }
  .sg-operations .panel h2 { border-left-color: #a87fee; }

  /* Paper counter */
  .paper-big { font-size: clamp(36px, 3.5vw, 60px); font-weight: 800; text-align: center; line-height: 1; font-variant-numeric: tabular-nums; }
  .paper-sub { text-align: center; font-size: 13px; color: #6b7585; margin: 6px 0 16px; }
  .progress-bar { height: 8px; background: #252d3a; border-radius: 4px; overflow: hidden; margin-bottom: 18px; }
  .progress-fill { height: 100%; border-radius: 4px; transition: width .5s ease, background .5s ease; }
  .paper-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .paper-controls label { font-size: 13px; color: #6b7585; display: flex; align-items: center; gap: 6px; }
  .paper-controls input {
    width: 56px; background: #0f1219; border: 1px solid #252d3a; border-radius: 8px;
    color: #b8c0cc; padding: 6px 8px; font-size: 13px; text-align: center; font-family: inherit;
    transition: border-color .15s;
  }
  .paper-controls input:focus { outline: none; border-color: #a87fee; box-shadow: 0 0 0 3px rgba(155,111,232,.1); }
  .btn {
    background: #252d3a; color: #b8c0cc; border: 1px solid #364050; border-radius: 10px;
    padding: 8px 18px; font-size: 13px; font-weight: 500; font-family: inherit;
    cursor: pointer; transition: all .2s ease;
  }
  .btn:hover { background: #364050; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .btn:active { transform: translateY(0); box-shadow: none; }
  .btn-primary { background: linear-gradient(135deg, #3cc968, #30b858); border-color: #3cc968; color: #fff; font-weight: 600; box-shadow: 0 2px 8px rgba(60,201,104,.2); }
  .btn-primary:hover { background: linear-gradient(135deg, #45d674, #3cc968); box-shadow: 0 4px 16px rgba(60,201,104,.3); }
  .btn-danger { background: linear-gradient(135deg, #e04444, #d03838); border-color: #e04444; color: #fff; font-weight: 600; }
  .btn-danger:hover { background: linear-gradient(135deg, #F22F46, #e04444); box-shadow: 0 4px 16px rgba(224,68,68,.3); }
  .paper-alert, .stuck-alert {
    text-align: center; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px;
    font-weight: 600; font-size: 13px; display: none;
  }
  .paper-alert.warning, .stuck-alert.warning { display: block; background: #f0983a12; color: #f0983a; border: 1px solid #f0983a33; }
  .paper-alert.empty { display: block; background: #E0444412; color: #F22F46; border: 1px solid #E0444433; }
  .stuck-alert.error { display: block; background: #E0444412; color: #F22F46; border: 1px solid #E0444433; }

  /* Queue status */
  .queue-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; margin-bottom: 6px;
    background: #0f1219; border: 1px solid #252d3a; border-radius: 10px;
    transition: all .2s ease;
  }
  .queue-row:hover { border-color: #2e3744; background: #131820; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .queue-label { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 500; }
  .queue-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .queue-count { font-weight: 700; font-size: clamp(15px, 1.3rem, 24px); font-variant-numeric: tabular-nums; color: #edf0f5; }

  /* Style bars */
  .style-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .style-name { width: clamp(60px, 6vw, 100px); font-size: 13px; color: #94a0b0; text-align: right; flex-shrink: 0; font-weight: 500; }
  .style-bar-bg { flex: 1; height: clamp(18px, 1.5vw, 26px); background: #0f1219; border-radius: 8px; overflow: hidden; border: 1px solid #252d3a; }
  .style-bar { height: 100%; border-radius: 7px; transition: width .6s cubic-bezier(.25,.8,.25,1); min-width: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,.1); }
  .style-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: #edf0f5; }

  /* Hourly chart */
  .hourly-bars {
    display: flex; align-items: flex-end; gap: 3px; height: clamp(80px, 9vw, 140px);
    position: relative; padding: 8px 0;
    border-bottom: 1px solid #252d3a;
  }
  .hourly-bar {
    flex: 1; background: linear-gradient(180deg, #7aabf7, #5088e8); border-radius: 5px 5px 0 0; min-height: 3px;
    transition: height .4s ease, opacity .15s, transform .15s; cursor: default; position: relative;
  }
  .hourly-bar:hover { opacity: .85; transform: scaleX(1.1); }
  .hourly-bar:hover .hourly-tip { display: block; }
  .hourly-tip {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: #2e3744; color: #edf0f5; font-size: 12px; font-weight: 600; padding: 4px 10px;
    border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 10;
  }
  .hourly-tip::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 4px solid transparent; border-top-color: #2e3744;
  }
  .hourly-labels { display: flex; gap: 3px; margin-top: 6px; }
  .hourly-label { flex: 1; font-size: clamp(7px, 0.6rem, 11px); color: #525c6c; text-align: center; white-space: nowrap; }

  /* Printer */
  .printer-status {
    display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 500;
    padding: 8px 12px; margin-bottom: 4px;
    background: #0f1219; border-radius: 8px; border: 1px solid #252d3a;
  }
  .printer-status:last-child { margin-bottom: 0; }
  .printer-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

  /* Top users */
  .user-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 9px 12px; margin-bottom: 4px;
    background: #0f1219; border-radius: 8px;
    transition: background .15s;
  }
  .user-row:hover { background: #1c2230; }
  .user-phone { color: #94a0b0; font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; }
  .user-count { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 14px; color: #edf0f5; }

  /* Failure breakdown bars */
  .fail-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .fail-name { width: clamp(75px, 7vw, 110px); font-size: 13px; color: #94a0b0; text-align: right; flex-shrink: 0; font-weight: 500; }
  .fail-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: #0f1219; border-radius: 6px; overflow: hidden; border: 1px solid #252d3a; }
  .fail-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; }
  .fail-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: #edf0f5; }

  /* Geography bars */
  .geo-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .geo-name { width: clamp(90px, 9vw, 150px); font-size: 13px; color: #94a0b0; text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .geo-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: #0f1219; border-radius: 6px; overflow: hidden; border: 1px solid #252d3a; }
  .geo-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; background: #3BC4CC; }
  .geo-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: #edf0f5; }

  /* Job Health grid */
  .health-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  }
  .health-stat {
    display: flex; flex-direction: column; gap: 4px;
    padding: 14px 16px; background: #0f1219; border-radius: 12px; border: 1px solid #252d3a;
    transition: border-color .2s, box-shadow .2s;
  }
  .health-stat:hover { border-color: #2e3744; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .health-val { font-size: clamp(20px, 1.8vw, 32px); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .health-val-sm { font-size: clamp(16px, 1.4vw, 24px); }
  .health-lbl { font-size: 11px; color: #6b7585; text-transform: uppercase; letter-spacing: .5px; font-weight: 500; }
  .health-timing {
    display: flex; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #252d3a;
  }
  .health-timing .health-stat { flex: 1; }

  /* NPS panel */
  .nps-content { display: flex; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
  .nps-disabled { color: #6b7585; font-size: 13px; padding: 12px 0; }
  .nps-big { display: flex; flex-direction: column; align-items: center; min-width: 80px; }
  .nps-score { font-size: clamp(36px, 3vw, 56px); font-weight: 700; line-height: 1; }
  .nps-score-good { color: #3cc968; }
  .nps-score-ok { color: #f0983a; }
  .nps-score-bad { color: #F22F46; }
  .nps-count { font-size: 12px; color: #6b7585; margin-top: 4px; }
  .nps-bars { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 6px; }
  .nps-bar-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .nps-bar-label { width: 14px; text-align: right; color: #94a0b0; font-weight: 600; }
  .nps-bar-track { flex: 1; height: 18px; background: #0f1219; border-radius: 4px; overflow: hidden; border: 1px solid #252d3a; }
  .nps-bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
  .nps-bar-val { width: 28px; font-size: 12px; color: #6b7585; }

  /* Failed jobs list */
  .fj-list { max-height: 320px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #2e3744 #171c25; }
  .fj-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 4px;
    background: #0f1219; border-radius: 8px; border: 1px solid #252d3a; font-size: 13px;
  }
  .fj-phone { color: #94a0b0; font-family: "SF Mono", "Fira Code", monospace; min-width: 100px; }
  .fj-style { color: #6b7585; min-width: 70px; }
  .fj-reason {
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
    text-transform: uppercase; letter-spacing: .3px;
  }
  .fj-reason.moderation { background: #F22F4618; color: #F22F46; }
  .fj-reason.face_detection { background: #f0983a18; color: #f0983a; }
  .fj-reason.generation { background: #a87fee18; color: #a87fee; }
  .fj-reason.printer { background: #6199f518; color: #6199f5; }
  .fj-reason.max_retries { background: #6b758518; color: #6b7585; }
  .fj-reason.unknown { background: #6b758518; color: #6b7585; }
  .fj-time { color: #525c6c; font-size: 11px; min-width: 50px; text-align: right; flex: 1; }
  .fj-retry {
    background: #3cc96818; color: #3cc968; border: 1px solid #3cc96833; border-radius: 6px;
    padding: 4px 12px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit;
    transition: background .15s, border-color .15s;
  }
  .fj-retry:hover { background: #3cc96828; border-color: #3cc968; }
  .fj-retry:disabled { opacity: .4; cursor: default; }
  .fj-empty { color: #525c6c; font-size: 13px; padding: 16px 0; }
  .fj-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #3cc968; color: #fff; padding: 10px 20px; border-radius: 10px;
    font-size: 13px; font-weight: 600; z-index: 100; opacity: 0; transition: opacity .3s;
    pointer-events: none;
  }
  .fj-toast.show { opacity: 1; }

  .footer {
    text-align: center; color: #525c6c; font-size: 12px; font-weight: 500;
    margin-top: 56px; padding: 28px 0 12px;
    border-top: 1px solid #252d3a;
    letter-spacing: .3px;
  }
</style>
</head>
<body>

<div class="wrap">
<div class="header">
  <h1><span class="status-dot" id="liveDot" style="background:#3cc968"></span>Admin Dashboard<span id="pausedBadge" style="display:none;margin-left:10px;font-size:11px;font-weight:700;background:#f0983a22;color:#f0983a;padding:3px 10px;border-radius:6px;border:1px solid #f0983a44;text-transform:uppercase;letter-spacing:.5px;vertical-align:middle">Paused</span></h1>
  <div class="header-controls">
    <div class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;opacity:.5"><circle cx="12" cy="12" r="10"/></svg><select id="eventSelect" onchange="onEventChange()"><option value="all">All Events</option></select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;opacity:.4"><polyline points="6 9 12 15 18 9"/></svg></div>
    <label class="hdr-item" title="Exclude admin phone numbers from all metrics"><input type="checkbox" id="excludeAdminCb" onchange="onAdminToggle()">Exclude admin</label>
    <button class="hdr-item hdr-action" id="reportBtn" onclick="generateReport()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Report</button>
    <a href="/outreach/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Outreach</a>
    <a href="/dashboard/logs/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Logs</a>
    <a href="/home/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
  </div>
</div>

<div class="cards">
  <div class="card"><div class="value" id="totalPrints">--</div><div class="label">Total Prints</div></div>
  <div class="card"><div class="value" id="prints24h">--</div><div class="label">Last 24h</div></div>
  <div class="card"><div class="value" id="uniqueUsers">--</div><div class="label">Unique Users</div></div>
  <div class="card"><div class="value" id="avgPerUser">--</div><div class="label">Avg / User</div></div>
  <div class="card"><div class="value" id="inQueue">--</div><div class="label">In Queue</div></div>
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
</div>

<div class="section-group sg-users">
  <div class="section-label">Users & Health</div>
  <div class="grid">
    <div class="panel">
      <h2>Top Users</h2>
      <div id="topUsers"></div>
    </div>
    <div class="panel">
      <h2>Job Health</h2>
      <div class="health-grid">
        <div class="health-stat">
          <span class="health-val" style="color:#3cc968" id="healthDone">--</span>
          <span class="health-lbl">Completed</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:#F22F46" id="healthFailed">--</span>
          <span class="health-lbl">Failed</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:#6199f5" id="healthRate">--</span>
          <span class="health-lbl">Success Rate</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:#f0983a" id="healthModRate">--</span>
          <span class="health-lbl">Rejection Rate</span>
        </div>
      </div>
      <div class="health-timing">
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:#a87fee" id="avgGenTime">--</span>
          <span class="health-lbl">Avg Generation</span>
        </div>
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:#3cc968" id="avgPrintTime">--</span>
          <span class="health-lbl">Avg Print</span>
        </div>
      </div>
    </div>
  </div>
  <div class="panel nps-panel" style="margin-top:14px">
    <h2>NPS Score</h2>
    <div id="npsPanel" class="nps-content">
      <div class="nps-disabled">NPS survey is disabled. Enable it in Settings &gt; Engagement.</div>
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
  <div class="panel" id="reviewPanel" style="margin-top:14px;display:none">
    <h2>Pending Review <span id="reviewCount" style="font-size:12px;background:#F22F46;color:#fff;border-radius:10px;padding:2px 8px;margin-left:6px;display:none">0</span></h2>
    <div id="reviewGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px"></div>
    <div id="reviewEmpty" style="color:#6b7585;font-size:13px">No images pending review.</div>
  </div>
  <div class="panel" style="margin-top:14px">
    <h2>Failed Jobs</h2>
    <div id="failedJobsList" style="color:#6b7585;font-size:13px">Loading...</div>
  </div>
</div>

<div class="section-group sg-operations">
  <div class="section-label">Operations</div>
  <div class="grid">
    <div class="panel">
      <h2>Queue Status</h2>
      <div id="stuckAlert"></div>
      <div id="queueRows"></div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid #252d3a">
        <h2>Printers</h2>
        <div id="printerList"><span style="color:#6b7585">--</span></div>
      </div>
    </div>
    <div class="panel">
      <h2>Paper Counter <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:#6b7585">(Estimated)</span></h2>
      <div class="paper-alert" id="paperAlert"></div>
      <div class="paper-big" id="paperRemaining">--</div>
      <div class="paper-sub" id="paperSub">-- / -- sheets</div>
      <div style="text-align:center;font-size:12px;color:#525c6c;margin-bottom:14px">Based on prints sent &mdash; press Reset after reloading tray</div>
      <div class="progress-bar"><div class="progress-fill" id="paperBar"></div></div>
      <div class="paper-controls">
        <button class="btn btn-primary" onclick="resetPaper()">Reset</button>
        <label>Capacity <input id="cfgCapacity" type="number" min="1" value="20" onchange="updatePaperConfig()"></label>
        <label>Warn at <input id="cfgWarning" type="number" min="0" value="2" onchange="updatePaperConfig()"></label>
      </div>
    </div>
  </div>
</div>

<div class="fj-toast" id="fjToast"></div>
<div class="footer">Auto-refreshes every 3s &middot; Last updated <span id="lastUpdated">--</span></div>
</div><!-- /.wrap -->

<script>
const STYLE_COLORS = {
  cartoon: "#6199f5", "pop-art": "#f0983a", watercolor: "#a87fee",
  anime: "#f07aab", sketch: "#94a0b0", "pixel-art": "#3cc968",
};
const QUEUE_META = [
  { key: "pending", label: "Pending", color: "#94a0b0" },
  { key: "generating", label: "Generating", color: "#a87fee" },
  { key: "review", label: "Pending Review", color: "#f0983a" },
  { key: "ready", label: "Ready to Print", color: "#6199f5" },
  { key: "printing", label: "Printing", color: "#3cc968" },
];

let selectedEvent = "all";
let firstLoad = true;
let excludeAdmin = false;
let userActionGen = 0;

function queryParams() {
  var parts = [];
  if (selectedEvent !== "all") parts.push("e=" + encodeURIComponent(selectedEvent));
  if (excludeAdmin) parts.push("xa=1");
  return parts.length > 0 ? "?" + parts.join("&") : "";
}

function onEventChange() {
  selectedEvent = document.getElementById("eventSelect").value;
  userActionGen++;
  fetchStats();
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
    document.getElementById("liveDot").style.background = "#F22F46";
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
  d.paper = d.paper || { remaining: 0, capacity: 20, isEmpty: false, isWarning: false, warningThreshold: 2 };
  d.printers = d.printers || [];
  d.stuckJobs = d.stuckJobs || [];
  d.events = d.events || [];
  d.durations = d.durations || {};
  d.nps = d.nps || { count: 0 };

  document.getElementById("liveDot").style.background = d.queuePaused ? "#f0983a" : "#3cc968";
  document.getElementById("pausedBadge").style.display = d.queuePaused ? "" : "none";

  // Populate event dropdown (preserve selection)
  const sel = document.getElementById("eventSelect");
  const prev = sel.value;
  sel.innerHTML = '<option value="all">All Events</option>';
  if (d.events) {
    for (const e of d.events) {
      sel.innerHTML += '<option value="'+e+'"'+(prev===e?' selected':'')+'>'+e+'</option>';
    }
  }
  // On first load, default to the configured event from settings
  if (firstLoad && d.eventName && d.events && d.events.includes(d.eventName)) {
    sel.value = d.eventName;
    selectedEvent = d.eventName;
    firstLoad = false;
    fetchStats();
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

  // Paper
  const p = d.paper;
  document.getElementById("paperRemaining").textContent = p.remaining;
  document.getElementById("paperRemaining").style.color = p.isEmpty ? "#F22F46" : p.isWarning ? "#f0983a" : "#edf0f5";
  document.getElementById("paperSub").textContent = p.remaining + " / " + p.capacity + " sheets";
  const pct = p.capacity > 0 ? (p.remaining / p.capacity * 100) : 0;
  const bar = document.getElementById("paperBar");
  bar.style.width = pct + "%";
  bar.style.background = p.isEmpty ? "#F22F46" : p.isWarning ? "#f0983a" : "#3cc968";
  const alert = document.getElementById("paperAlert");
  if (p.isEmpty) { alert.className = "paper-alert empty"; alert.textContent = "PAPER EMPTY - Reload printer tray!"; }
  else if (p.isWarning) { alert.className = "paper-alert warning"; alert.textContent = "Paper low! " + p.remaining + " sheet" + (p.remaining===1?"":"s") + " remaining"; }
  else { alert.className = "paper-alert"; }
  document.getElementById("cfgCapacity").value = p.capacity;
  document.getElementById("cfgWarning").value = p.warningThreshold;

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
  const printerColors = { ready: "#3cc968", printing: "#6199f5", error: "#F22F46", not_found: "#f0983a", unknown: "#94a0b0" };
  var phtml = "";
  if (d.printers && d.printers.length > 0) {
    for (const p of d.printers) {
      phtml += '<div class="printer-status"><span class="printer-dot" style="background:' + (printerColors[p.status] || "#94a0b0") + '"></span><span>' + p.name + ' — ' + p.message + '</span></div>';
    }
  } else {
    phtml = '<div class="printer-status"><span class="printer-dot" style="background:#f0983a"></span><span>No printers active</span></div>';
  }
  document.getElementById("printerList").innerHTML = phtml;

  // Styles
  const styleVals = Object.values(d.styleCounts);
  const maxStyle = styleVals.length > 0 ? Math.max(1, ...styleVals) : 1;
  let shtml = "";
  const sortedStyles = Object.entries(d.styleCounts).sort((a,b) => b[1]-a[1]);
  for (const [name, count] of sortedStyles) {
    const pct = (count / maxStyle * 100).toFixed(1);
    const color = STYLE_COLORS[name] || "#6199f5";
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

  // Top users
  let uhtml = "";
  for (const u of d.topUsers) {
    uhtml += '<div class="user-row"><span class="user-phone">'+u.phone+'</span><span class="user-count">'+u.count+' prints</span></div>';
  }
  document.getElementById("topUsers").innerHTML = uhtml || '<div style="color:#525c6c;font-size:13px">No data yet</div>';

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
    { key: "moderation", label: "Moderation", color: "#F22F46" },
    { key: "face_detection", label: "Face Detection", color: "#f0983a" },
    { key: "generation", label: "Generation/API", color: "#a87fee" },
    { key: "printer", label: "Printer", color: "#6199f5" },
    { key: "max_retries", label: "Crash Recovery", color: "#94a0b0" },
    { key: "unknown", label: "Unknown", color: "#6b7585" },
  ];
  const fb = d.failureBreakdown || {};
  const fbVals = Object.values(fb);
  const maxFail = fbVals.length > 0 ? Math.max(1, ...fbVals) : 1;
  const totalFails = Object.values(fb).reduce((a,b) => a+b, 0);
  let fhtml = "";
  if (totalFails === 0) {
    fhtml = '<div style="color:#525c6c;font-size:13px">No failures</div>';
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
    ghtml = '<div style="color:#525c6c;font-size:13px">No data yet</div>';
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

async function resetPaper() {
  await fetch("api/paper/reset", { method: "POST" });
  fetchStats();
}

async function updatePaperConfig() {
  const capacity = parseInt(document.getElementById("cfgCapacity").value) || 20;
  const warningThreshold = parseInt(document.getElementById("cfgWarning").value) || 2;
  await fetch("api/paper/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capacity, warningThreshold }),
  });
  fetchStats();
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

// ── Failed Jobs ──
async function fetchFailedJobs() {
  try {
    var ep = "api/failed-jobs";
    if (selectedEvent !== "all") ep += "?e=" + encodeURIComponent(selectedEvent);
    const r = await fetch(ep);
    const jobs = await r.json();
    renderFailedJobs(jobs);
  } catch(e) {}
}

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
  var colors = { 1: "#F22F46", 2: "#f0983a", 3: "#E8C53A", 4: "#7BC74D", 5: "#3cc968" };
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

function renderFailedJobs(jobs) {
  var el = document.getElementById("failedJobsList");
  if (!jobs.length) { el.innerHTML = '<div class="fj-empty">No failed jobs</div>'; return; }
  var h = '<div class="fj-list">';
  for (var j of jobs) {
    h += '<div class="fj-row" id="fj-'+j.filename+'">';
    h += '<span class="fj-phone">'+j.phone+'</span>';
    h += '<span class="fj-style">'+j.style+'</span>';
    h += '<span class="fj-reason '+j.failReason+'">'+j.failReason.replace(/_/g," ")+'</span>';
    h += '<span class="fj-time">'+timeAgo(j.createdAt)+'</span>';
    if (j.canRetry) {
      h += '<button class="fj-retry" onclick="retryJob(\\''+j.filename+'\\')">Retry</button>';
    } else {
      h += '<button class="fj-retry" disabled title="Cannot retry moderation failures">Retry</button>';
    }
    h += '</div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

async function retryJob(filename) {
  try {
    var r = await fetch("api/retry-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({filename})
    });
    var d = await r.json();
    if (d.ok) {
      var row = document.getElementById("fj-"+filename);
      if (row) row.remove();
      showToast("Job requeued to " + d.target);
      fetchStats();
    } else {
      showToast(d.error || "Retry failed");
    }
  } catch(e) { showToast("Retry failed"); }
}

function showToast(msg) {
  var t = document.getElementById("fjToast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function() { t.classList.remove("show"); }, 2500);
}

fetchFailedJobs();
setInterval(fetchFailedJobs, 10000);

// ── Review Queue ──
var _reviewEnabled = false;
var _reviewTimer = null;

function checkReviewEnabled() {
  // Show/hide review panel based on whether review count > 0 or setting is on
  // We just always fetch and show if there are items
  fetchReviewQueue();
}

async function fetchReviewQueue() {
  try {
    var r = await fetch("api/review-queue");
    var jobs = await r.json();
    renderReviewQueue(jobs);
  } catch(e) {}
}

function renderReviewQueue(jobs) {
  var panel = document.getElementById("reviewPanel");
  var grid = document.getElementById("reviewGrid");
  var empty = document.getElementById("reviewEmpty");
  var badge = document.getElementById("reviewCount");

  if (!jobs.length) {
    panel.style.display = "none";
    badge.style.display = "none";
    return;
  }

  panel.style.display = "";
  badge.textContent = jobs.length;
  badge.style.display = "inline";

  var h = "";
  for (var j of jobs) {
    var fn = escHtml(j.filename);
    var fp = escHtml(j.filePrefix);
    var imgSrc = "/images/" + fp + "_output_mms.jpg";
    h += '<div class="rv-card" id="rv-'+fn+'" style="background:#1a2030;border-radius:8px;padding:10px;text-align:center">';
    h += '<img src="'+imgSrc+'" style="width:100%;border-radius:6px;margin-bottom:8px;cursor:pointer" onclick="window.open(\\'/images/'+fp+'_output.png\\',\\'_blank\\')" title="Click to view full size">';
    h += '<div style="font-size:11px;color:#94a0b0;margin-bottom:6px">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+'</div>';
    h += '<div style="display:flex;gap:6px;justify-content:center">';
    h += '<button style="background:#3cc968;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600" onclick="reviewAction(\\''+fn+'\\',\\'approve\\')">Approve</button>';
    h += '<button style="background:#F22F46;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600" onclick="reviewAction(\\''+fn+'\\',\\'reject\\')">Reject</button>';
    h += '</div></div>';
  }
  grid.innerHTML = h;
  empty.style.display = "none";
}

async function reviewAction(filename, action) {
  try {
    var r = await fetch("api/review-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({filename: filename, action: action})
    });
    var d = await r.json();
    if (d.ok) {
      var card = document.getElementById("rv-"+filename);
      if (card) card.remove();
      showToast(action === "approve" ? "Image approved" : "Image rejected, re-generating");
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

fetchReviewQueue();
setInterval(fetchReviewQueue, 3000);
</script>
</body>
</html>`;

// ── Logs HTML ─────────────────────────────────────────────────────────────────

const LOGS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Logs — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0f1219; color: #c9d1d9; min-height: 100vh;
  }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 24px 28px; }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px; flex-wrap: wrap; gap: 12px;
  }
  .header h1 { font-size: 18px; font-weight: 700; color: #e6edf3; display: flex; align-items: center; gap: 10px; }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; display: inline-block;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
  .header-links { display: flex; gap: 16px; align-items: center; }
  .header-links a {
    color: #8b949e; text-decoration: none; font-size: 13px; font-weight: 500;
    display: flex; align-items: center; gap: 5px; transition: color .15s;
  }
  .header-links a:hover { color: #e6edf3; }
  .header-links svg { width: 14px; height: 14px; }

  .toolbar {
    display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;
  }
  .tb-btn {
    background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
    padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
    font-weight: 500; transition: all .15s;
  }
  .tb-btn:hover { border-color: #58a6ff; color: #e6edf3; }
  .tb-btn.active { background: #1f6feb33; border-color: #58a6ff; color: #58a6ff; }
  .tb-btn.err.active { background: #F22F4622; border-color: #F22F46; color: #F22F46; }
  .tb-btn.wrn.active { background: #f0983a22; border-color: #f0983a; color: #f0983a; }
  .tb-select {
    background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
    padding: 5px 8px; border-radius: 6px; font-size: 12px; font-family: inherit;
  }
  .tb-search {
    background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
    padding: 5px 10px; border-radius: 6px; font-size: 12px; font-family: inherit;
    flex: 1; min-width: 120px; max-width: 260px;
  }
  .tb-search::placeholder { color: #484f58; }
  .tb-spacer { flex: 1; }

  .log-container {
    background: #0d1117; border: 1px solid #21262d; border-radius: 8px;
    height: calc(100vh - 160px); overflow-y: auto; padding: 8px 0;
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 12px; line-height: 1.6;
  }
  .log-container::-webkit-scrollbar { width: 6px; }
  .log-container::-webkit-scrollbar-track { background: transparent; }
  .log-container::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .log-entry {
    padding: 1px 12px; display: flex; gap: 8px; animation: fadeIn .15s;
    border-left: 2px solid transparent;
  }
  .log-entry:hover { background: #161b2233; }
  .log-entry.level-error { border-left-color: #F22F46; }
  .log-entry.level-warn { border-left-color: #f0983a; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .le-time { color: #484f58; white-space: nowrap; min-width: 85px; }
  .le-level {
    font-weight: 700; text-transform: uppercase; font-size: 10px;
    min-width: 38px; text-align: center; padding: 1px 0; border-radius: 3px;
    line-height: 1.8;
  }
  .le-level.info { color: #6199f5; }
  .le-level.warn { color: #f0983a; background: #f0983a11; }
  .le-level.error { color: #F22F46; background: #F22F4611; }
  .le-cat {
    color: #8b949e; font-size: 10px; min-width: 55px; opacity: .7;
    line-height: 1.9;
  }
  .le-msg { color: #c9d1d9; white-space: pre-wrap; word-break: break-word; flex: 1; }
  .le-msg.error-msg { color: #f58585; }

  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 200px; color: #484f58; font-size: 14px;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1><span class="status-dot" id="statusDot" style="background:#3cc968"></span>Application Logs</h1>
    <div class="header-links">
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
    document.getElementById('statusDot').style.background = '#f0983a';
  } else {
    connectSSE();
  }
}

function connectSSE() {
  if (_evtSource) _evtSource.close();
  _evtSource = new EventSource('/dashboard/api/logs/stream');
  _evtSource.onopen = function() {
    document.getElementById('statusDot').style.background = '#3cc968';
  };
  _evtSource.onmessage = function(e) {
    try {
      var entry = JSON.parse(e.data);
      addEntry(entry);
    } catch(_) {}
  };
  _evtSource.onerror = function() {
    document.getElementById('statusDot').style.background = '#F22F46';
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
</body>
</html>`;

// ── Start ────────────────────────────────────────────────────────────────────

function mountDashboard(app) {
    paper.load();
    app.use("/dashboard", router);
    console.log("📊 Dashboard mounted at /dashboard");
}

module.exports = { mountDashboard };
