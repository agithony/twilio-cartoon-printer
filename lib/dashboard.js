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
    DONE_DIR,
    FAILED_DIR,
    openai,
} = require("./config");
const settings = require("./settings");
const paper = require("./paper");

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

function getPrinterStatus() {
    return new Promise((resolve) => {
        const baseName = process.env.PRINTER_NAME || "";
        exec("lpstat -p", (err, stdout) => {
            if (err) {
                resolve({ status: "error", message: err.message });
                return;
            }
            const lines = stdout.split("\n").filter((l) => l.startsWith("printer "));
            const match = lines.find((l) => l.split(" ")[1]?.startsWith(baseName));
            if (!match) {
                resolve({ status: "not_found", message: `No printer matching "${baseName}"` });
                return;
            }
            const lower = match.toLowerCase();
            if (lower.includes("idle")) resolve({ status: "ready", message: "Idle" });
            else if (lower.includes("printing")) resolve({ status: "printing", message: "Printing" });
            else if (lower.includes("disabled")) resolve({ status: "error", message: "Disabled" });
            else if (lower.includes("looking for printer") || lower.includes("unplugged"))
                resolve({ status: "error", message: "Disconnected" });
            else resolve({ status: "unknown", message: match.split(" ").slice(2).join(" ").trim() });
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

function computeStats(eventFilter) {
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
        !isAdmin(j.userPhone) && (eventFilter === "all" || j.eventName === eventFilter));
    const failedJobs = allFailedJobs.filter((j) =>
        !isAdmin(j.userPhone) && (eventFilter === "all" || j.eventName === eventFilter));

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
    const failureBreakdown = { moderation: 0, face_detection: 0, generation: 0, printer: 0, unknown: 0 };
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

router.get("/api/stats", async (req, res) => {
    const eventFilter = req.query.event || "all";
    const stats = computeStats(eventFilter);

    const queue = {
        pending: countFiles(PENDING_DIR),
        generating: countFiles(GENERATING_DIR),
        ready: countFiles(READY_DIR),
        printing: countFiles(PRINTING_DIR),
    };
    const printer = await getPrinterStatus();

    res.json({
        eventName: settings.get("eventName"),
        events: stats.events,
        currentEvent: stats.eventFilter,
        totals: stats.totals,
        prints24h: stats.prints24h,
        uniqueUsers: stats.uniqueUsers,
        avgPerUser: stats.avgPerUser,
        queue,
        styleCounts: stats.styleCounts,
        topUsers: stats.topUsers,
        hourlyActivity: stats.hourlyActivity,
        hourlyLabels: stats.hourlyLabels,
        paper: paper.getState(),
        printer,
        failureBreakdown: stats.failureBreakdown,
        moderationRate: stats.moderationRate,
        countryCounts: stats.countryCounts,
    });
});

// ── PDF Report ───────────────────────────────────────────────────────────────

const eventSummaryCache = new Map();

async function getEventSummary(eventName) {
    if (eventSummaryCache.has(eventName)) return eventSummaryCache.get(eventName);
    try {
        const response = await openai.responses.create({
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
    const eventFilter = req.query.event || "all";
    const stats = computeStats(eventFilter);
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
    const blue = "#4B8BF5";
    const green = "#2EBA54";
    const orange = "#E8853A";
    const purple = "#9B6FE8";
    const pink = "#E86B9E";
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

    const metricCards = [
        { label: "Total Prints", value: String(stats.totals.done), color: blue },
        { label: "Unique Users", value: String(stats.uniqueUsers), color: purple },
        { label: "Avg / User", value: stats.avgPerUser, color: green },
        { label: "Last 24h", value: String(stats.prints24h), color: orange },
        { label: "Top Style", value: mostPopularStyle ? mostPopularStyle[0] : "N/A", color: pink },
        { label: "Success Rate", value: successRate, color: blue },
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

        const failLabels = { moderation: "Moderation", face_detection: "Face Detection", generation: "Generation / API", printer: "Printer", unknown: "Unknown" };
        const failColors = { moderation: "#E04444", face_detection: orange, generation: purple, printer: blue, unknown: light };
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
    res.json({ templates, videos, printers });
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
    if (!["template", "video"].includes(type)) {
        return res.status(400).json({ error: "type must be 'template' or 'video'" });
    }

    // Validate file extension
    const ext = path.extname(filename).toLowerCase();
    const allowed = type === "template"
        ? [".png", ".jpg", ".jpeg", ".gif", ".svg"]
        : [".mp4", ".webm", ".mov"];
    if (!allowed.includes(ext)) {
        return res.status(400).json({ error: `Invalid file type. Allowed: ${allowed.join(", ")}` });
    }

    // Sanitize filename
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const targetDir = type === "template"
        ? path.join(__dirname, "..", "templates")
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
            const files = type === "template" ? settings.listTemplates() : settings.listVideos();
            res.json({ success: true, filename: safeName, files });
        });
    });

    req.on("error", (err) => {
        console.error(`❌ Upload stream error: ${err.message}`);
        fail(500, "Upload failed: " + err.message);
    });
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
<title>Admin Dashboard — Twilio + AI Photo Generator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(14px, 1.1vw, 18px); }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0B0D11;
    color: #B0B8C4;
    min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1400px; margin: 0 auto; }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: clamp(20px, 2.5vw, 36px);
    padding-bottom: clamp(14px, 1.5vw, 22px);
    border-bottom: 1px solid #1E222B;
  }
  .header h1 { font-size: clamp(18px, 1.5vw, 26px); font-weight: 700; color: #F7F8F8; letter-spacing: -0.3px; }
  .header-right { display: flex; align-items: flex-end; gap: clamp(8px, 1vw, 14px); }
  .btn-home {
    display: inline-flex; align-items: center; gap: 6px;
    background: #13161D; color: #B0B8C4; border: 1px solid #1E222B;
    border-radius: 10px; padding: 7px 16px; font-size: 13px; font-weight: 500;
    font-family: inherit; text-decoration: none; transition: border-color .15s, color .15s, background .15s;
  }
  .btn-home:hover { color: #F7F8F8; border-color: #2A3040; background: #1A1E27; }
  .btn-home svg { width: 14px; height: 14px; }
  .event-picker { display: flex; flex-direction: column; gap: 3px; }
  .event-picker-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .8px; color: #4D5562; padding-left: 2px; }
  .event-select {
    background: #13161D;
    color: #F7F8F8;
    border: 1px solid #4B8BF544;
    font-size: 13px; font-weight: 600;
    padding: 7px 14px;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  .event-select:focus { outline: none; border-color: #4B8BF5; box-shadow: 0 0 0 3px #4B8BF520; }
  .event-select option { background: #13161D; color: #B0B8C4; }
  .btn-report {
    background: #F22F46; color: #fff; border: none;
    border-radius: 10px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit; transition: background .15s, transform .1s; letter-spacing: 0.2px;
  }
  .btn-report:hover { background: #D42840; transform: translateY(-1px); }
  .btn-report:disabled { opacity: .6; cursor: default; transform: none; }
  .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(clamp(130px, 13vw, 210px), 1fr)); gap: clamp(12px, 1.2vw, 18px); margin-bottom: clamp(20px, 2.5vw, 36px); }
  .card {
    background: #13161D;
    border: 1px solid #1E222B;
    border-left: 3px solid #1E222B;
    border-radius: 14px;
    padding: clamp(16px, 1.5vw, 24px) clamp(14px, 1.2vw, 20px);
    text-align: center;
    transition: transform .15s, box-shadow .15s, border-color .15s;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(0,0,0,.25); border-color: #2A3040; }
  .card:nth-child(1) { border-left-color: #4B8BF5; }
  .card:nth-child(2) { border-left-color: #2EBA54; }
  .card:nth-child(3) { border-left-color: #9B6FE8; }
  .card:nth-child(4) { border-left-color: #E8853A; }
  .card:nth-child(5) { border-left-color: #E86B9E; }
  .card .value { font-size: clamp(22px, 2.2vw, 40px); font-weight: 700; color: #F7F8F8; font-variant-numeric: tabular-nums; }
  .card .label { font-size: clamp(9px, 0.75rem, 13px); color: #636B78; margin-top: 6px; text-transform: uppercase; letter-spacing: .6px; font-weight: 500; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(12px, 1.2vw, 18px); margin-bottom: clamp(16px, 1.8vw, 28px); }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: #13161D;
    border: 1px solid #1E222B;
    border-radius: 14px;
    padding: clamp(18px, 1.8vw, 28px);
    transition: border-color .2s;
  }
  .panel:hover { border-color: #252A34; }
  .panel h2 { font-size: 11px; font-weight: 600; color: #4D5562; text-transform: uppercase; letter-spacing: 1px; margin-bottom: clamp(12px, 1.2vw, 20px); }

  /* Paper counter */
  .paper-big { font-size: clamp(32px, 3.2vw, 56px); font-weight: 800; text-align: center; line-height: 1; font-variant-numeric: tabular-nums; }
  .paper-sub { text-align: center; font-size: 0.9rem; color: #636B78; margin: 4px 0 12px; }
  .progress-bar { height: 6px; background: #1E222B; border-radius: 3px; overflow: hidden; margin-bottom: 16px; }
  .progress-fill { height: 100%; border-radius: 3px; transition: width .5s ease, background .5s ease; }
  .paper-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .paper-controls label { font-size: 0.85rem; color: #636B78; }
  .paper-controls input {
    width: 56px; background: #0B0D11; border: 1px solid #1E222B; border-radius: 6px;
    color: #B0B8C4; padding: 4px 8px; font-size: 0.9rem; text-align: center;
  }
  .paper-controls input:focus { outline: none; border-color: #4B8BF5; }
  .btn {
    background: #1E222B; color: #B0B8C4; border: 1px solid #2A3040; border-radius: 6px;
    padding: 6px 14px; font-size: 0.9rem; cursor: pointer; transition: background .15s;
  }
  .btn:hover { background: #2A3040; }
  .btn-primary { background: #2EBA54; border-color: #2EBA54; color: #fff; }
  .btn-primary:hover { background: #26A348; }
  .btn-danger { background: #E04444; border-color: #E04444; color: #fff; }
  .btn-danger:hover { background: #F22F46; }
  .paper-alert {
    text-align: center; padding: 8px; border-radius: 6px; margin-bottom: 12px;
    font-weight: 600; font-size: 0.9rem; display: none;
  }
  .paper-alert.warning { display: block; background: #E8853A22; color: #E8853A; border: 1px solid #E8853A44; }
  .paper-alert.empty { display: block; background: #E0444422; color: #F22F46; border: 1px solid #E0444444; }

  /* Queue status */
  .queue-row { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid #1E222B; }
  .queue-row:last-child { border-bottom: none; }
  .queue-label { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
  .queue-dot { width: 8px; height: 8px; border-radius: 50%; }
  .queue-count { font-weight: 600; font-size: clamp(14px, 1.2rem, 22px); font-variant-numeric: tabular-nums; }

  /* Style bars */
  .style-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .style-name { width: clamp(60px, 6vw, 100px); font-size: 0.85rem; color: #636B78; text-align: right; flex-shrink: 0; }
  .style-bar-bg { flex: 1; height: clamp(14px, 1.3vw, 22px); background: #1E222B; border-radius: 4px; overflow: hidden; }
  .style-bar { height: 100%; border-radius: 4px; transition: width .5s ease; min-width: 2px; }
  .style-count { width: 34px; font-size: 0.85rem; font-weight: 600; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }

  /* Hourly chart */
  .hourly-bars { display: flex; align-items: flex-end; gap: 3px; height: clamp(70px, 8vw, 130px); position: relative; }
  .hourly-bar {
    flex: 1; background: #4B8BF5; border-radius: 3px 3px 0 0; min-height: 2px;
    transition: height .3s ease, background .15s; cursor: default; position: relative;
  }
  .hourly-bar:hover { background: #6BA3F7; }
  .hourly-bar:hover .hourly-tip { display: block; }
  .hourly-tip {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: #252A34; color: #F7F8F8; font-size: 0.78rem; font-weight: 600; padding: 4px 10px;
    border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 10;
  }
  .hourly-tip::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 4px solid transparent; border-top-color: #252A34;
  }
  .hourly-labels { display: flex; gap: 3px; margin-top: 6px; }
  .hourly-label { flex: 1; font-size: clamp(7px, 0.6rem, 11px); color: #4D5562; text-align: center; white-space: nowrap; }

  /* Printer */
  .printer-status { display: flex; align-items: center; gap: 10px; font-size: 0.95rem; }
  .printer-dot { width: 10px; height: 10px; border-radius: 50%; }

  /* Top users */
  .user-row { display: flex; justify-content: space-between; padding: 7px 0; font-size: 0.9rem; border-bottom: 1px solid #1E222B; }
  .user-row:last-child { border-bottom: none; }
  .user-phone { color: #636B78; font-family: monospace; font-size: 0.85rem; }
  .user-count { font-weight: 600; font-variant-numeric: tabular-nums; font-size: 0.9rem; }

  /* Failure breakdown bars (reuse style-row pattern) */
  .fail-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .fail-name { width: clamp(75px, 7vw, 110px); font-size: 0.85rem; color: #636B78; text-align: right; flex-shrink: 0; }
  .fail-bar-bg { flex: 1; height: clamp(14px, 1.3vw, 22px); background: #1E222B; border-radius: 4px; overflow: hidden; }
  .fail-bar { height: 100%; border-radius: 4px; transition: width .5s ease; min-width: 2px; }
  .fail-count { width: 34px; font-size: 0.85rem; font-weight: 600; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }

  /* Geography bars */
  .geo-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .geo-name { width: clamp(90px, 9vw, 150px); font-size: 0.85rem; color: #636B78; text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .geo-bar-bg { flex: 1; height: clamp(14px, 1.3vw, 22px); background: #1E222B; border-radius: 4px; overflow: hidden; }
  .geo-bar { height: 100%; border-radius: 4px; transition: width .5s ease; min-width: 2px; background: #3BC4CC; }
  .geo-count { width: 34px; font-size: 0.85rem; font-weight: 600; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }

  .report-row { display: flex; justify-content: flex-end; margin-bottom: clamp(16px, 1.8vw, 28px); }
  .footer { text-align: center; color: #4D5562; font-size: 12px; font-weight: 500; margin-top: 40px; padding-top: 18px; border-top: 1px solid #1E222B; }
</style>
</head>
<body>

<div class="wrap">
<div class="header">
  <h1><span class="status-dot" id="liveDot" style="background:#2EBA54"></span>Admin Dashboard</h1>
  <div class="header-right">
    <div class="event-picker"><span class="event-picker-label">Event</span><select class="event-select" id="eventSelect" onchange="onEventChange()"><option value="all">All Events</option></select></div>
    <a href="/home/" class="btn-home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
  </div>
</div>

<div class="cards">
  <div class="card"><div class="value" id="totalPrints">--</div><div class="label">Total Prints</div></div>
  <div class="card"><div class="value" id="prints24h">--</div><div class="label">Last 24h</div></div>
  <div class="card"><div class="value" id="uniqueUsers">--</div><div class="label">Unique Users</div></div>
  <div class="card"><div class="value" id="avgPerUser">--</div><div class="label">Avg / User</div></div>
  <div class="card"><div class="value" id="inQueue">--</div><div class="label">In Queue</div></div>
</div>

<div class="report-row">
  <button class="btn-report" id="reportBtn" onclick="generateReport()">Generate Report</button>
</div>

<div class="grid">
  <!-- Style Breakdown -->
  <div class="panel">
    <h2>Style Breakdown</h2>
    <div id="styleBars"></div>
  </div>

  <!-- Hourly Activity -->
  <div class="panel">
    <h2>Hourly Activity (24h)</h2>
    <div class="hourly-bars" id="hourlyBars"></div>
    <div class="hourly-labels" id="hourlyLabels"></div>
  </div>
</div>

<div class="grid">
  <!-- Top Users -->
  <div class="panel">
    <h2>Top Users</h2>
    <div id="topUsers"></div>
  </div>

  <!-- Job Health -->
  <div class="panel">
    <h2>Job Health</h2>
    <div style="display:flex;gap:clamp(16px,2vw,32px);flex-wrap:wrap">
      <div><span style="font-size:clamp(22px,2vw,36px);font-weight:700;color:#2EBA54" id="healthDone">--</span><div style="font-size:0.85rem;color:#636B78;margin-top:4px">Completed</div></div>
      <div><span style="font-size:clamp(22px,2vw,36px);font-weight:700;color:#F22F46" id="healthFailed">--</span><div style="font-size:0.85rem;color:#636B78;margin-top:4px">Failed</div></div>
      <div><span style="font-size:clamp(22px,2vw,36px);font-weight:700;color:#4B8BF5" id="healthRate">--</span><div style="font-size:0.85rem;color:#636B78;margin-top:4px">Success Rate</div></div>
      <div><span style="font-size:clamp(22px,2vw,36px);font-weight:700;color:#E8853A" id="healthModRate">--</span><div style="font-size:0.85rem;color:#636B78;margin-top:4px">Rejection Rate</div></div>
    </div>
  </div>
</div>

<div class="grid">
  <!-- Failure Breakdown -->
  <div class="panel">
    <h2>Failure Breakdown</h2>
    <div id="failBars"></div>
  </div>

  <!-- User Geography -->
  <div class="panel">
    <h2>User Geography</h2>
    <div id="geoBars"></div>
  </div>
</div>

<div class="grid">
  <!-- Queue Status -->
  <div class="panel">
    <h2>Queue Status</h2>
    <div id="queueRows"></div>
    <div style="margin-top:18px">
      <h2>Printer</h2>
      <div class="printer-status">
        <span class="printer-dot" id="printerDot"></span>
        <span id="printerMsg">--</span>
      </div>
    </div>
  </div>

  <!-- Paper Counter -->
  <div class="panel">
    <h2>Paper Counter</h2>
    <div class="paper-alert" id="paperAlert"></div>
    <div class="paper-big" id="paperRemaining">--</div>
    <div class="paper-sub" id="paperSub">-- / -- sheets</div>
    <div class="progress-bar"><div class="progress-fill" id="paperBar"></div></div>
    <div class="paper-controls">
      <button class="btn btn-primary" onclick="resetPaper()">Reset</button>
      <label>Capacity <input id="cfgCapacity" type="number" min="1" value="20" onchange="updatePaperConfig()"></label>
      <label>Warn at <input id="cfgWarning" type="number" min="0" value="2" onchange="updatePaperConfig()"></label>
    </div>
  </div>
</div>

<div class="footer">Auto-refreshes every 3s</div>
</div><!-- /.wrap -->

<script>
const STYLE_COLORS = {
  cartoon: "#4B8BF5", "pop-art": "#E8853A", watercolor: "#9B6FE8",
  anime: "#E86B9E", sketch: "#8B95A5", "pixel-art": "#2EBA54",
};
const QUEUE_META = [
  { key: "pending", label: "Pending", color: "#8B95A5" },
  { key: "generating", label: "Generating", color: "#9B6FE8" },
  { key: "ready", label: "Ready to Print", color: "#4B8BF5" },
  { key: "printing", label: "Printing", color: "#2EBA54" },
];

let selectedEvent = "all";

function eventParam() {
  return selectedEvent === "all" ? "" : "?event=" + encodeURIComponent(selectedEvent);
}

function onEventChange() {
  selectedEvent = document.getElementById("eventSelect").value;
  fetchStats();
}

async function fetchStats() {
  try {
    const r = await fetch("api/stats" + eventParam());
    const d = await r.json();
    render(d);
  } catch (e) {
    document.getElementById("liveDot").style.background = "#F22F46";
  }
}

function render(d) {
  document.getElementById("liveDot").style.background = "#2EBA54";

  // Populate event dropdown (preserve selection)
  const sel = document.getElementById("eventSelect");
  const prev = sel.value;
  sel.innerHTML = '<option value="all">All Events</option>';
  if (d.events) {
    for (const e of d.events) {
      sel.innerHTML += '<option value="'+e+'"'+(prev===e?' selected':'')+'>'+e+'</option>';
    }
  }
  if (prev && prev !== "all") sel.value = prev;

  document.getElementById("totalPrints").textContent = d.totals.done;
  document.getElementById("prints24h").textContent = d.prints24h;
  document.getElementById("uniqueUsers").textContent = d.uniqueUsers;
  document.getElementById("avgPerUser").textContent = d.avgPerUser;
  const queueTotal = d.queue.pending + d.queue.generating + d.queue.ready + d.queue.printing;
  document.getElementById("inQueue").textContent = queueTotal;

  // Paper
  const p = d.paper;
  document.getElementById("paperRemaining").textContent = p.remaining;
  document.getElementById("paperRemaining").style.color = p.isEmpty ? "#F22F46" : p.isWarning ? "#E8853A" : "#F7F8F8";
  document.getElementById("paperSub").textContent = p.remaining + " / " + p.capacity + " sheets";
  const pct = p.capacity > 0 ? (p.remaining / p.capacity * 100) : 0;
  const bar = document.getElementById("paperBar");
  bar.style.width = pct + "%";
  bar.style.background = p.isEmpty ? "#F22F46" : p.isWarning ? "#E8853A" : "#2EBA54";
  const alert = document.getElementById("paperAlert");
  if (p.isEmpty) { alert.className = "paper-alert empty"; alert.textContent = "PAPER EMPTY - Reload printer tray!"; }
  else if (p.isWarning) { alert.className = "paper-alert warning"; alert.textContent = "Paper low! " + p.remaining + " sheet" + (p.remaining===1?"":"s") + " remaining"; }
  else { alert.className = "paper-alert"; }
  document.getElementById("cfgCapacity").value = p.capacity;
  document.getElementById("cfgWarning").value = p.warningThreshold;

  // Queue
  let qhtml = "";
  for (const q of QUEUE_META) {
    qhtml += '<div class="queue-row"><span class="queue-label"><span class="queue-dot" style="background:'+q.color+'"></span>'+q.label+'</span><span class="queue-count">'+d.queue[q.key]+'</span></div>';
  }
  document.getElementById("queueRows").innerHTML = qhtml;

  // Printer
  const printerColors = { ready: "#2EBA54", printing: "#4B8BF5", error: "#F22F46", not_found: "#E8853A", unknown: "#8B95A5" };
  document.getElementById("printerDot").style.background = printerColors[d.printer.status] || "#8B95A5";
  document.getElementById("printerMsg").textContent = d.printer.message;

  // Styles
  const maxStyle = Math.max(1, ...Object.values(d.styleCounts));
  let shtml = "";
  const sortedStyles = Object.entries(d.styleCounts).sort((a,b) => b[1]-a[1]);
  for (const [name, count] of sortedStyles) {
    const pct = (count / maxStyle * 100).toFixed(1);
    const color = STYLE_COLORS[name] || "#4B8BF5";
    shtml += '<div class="style-row"><span class="style-name">'+name+'</span><div class="style-bar-bg"><div class="style-bar" style="width:'+pct+'%;background:'+color+'"></div></div><span class="style-count">'+count+'</span></div>';
  }
  document.getElementById("styleBars").innerHTML = shtml;

  // Hourly
  const maxH = Math.max(1, ...d.hourlyActivity);
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
  document.getElementById("topUsers").innerHTML = uhtml || '<div style="color:#4D5562;font-size:13px">No data yet</div>';

  // Health
  document.getElementById("healthDone").textContent = d.totals.done;
  document.getElementById("healthFailed").textContent = d.totals.failed;
  const total = d.totals.done + d.totals.failed;
  document.getElementById("healthRate").textContent = total > 0 ? (d.totals.done / total * 100).toFixed(0) + "%" : "--";
  document.getElementById("healthModRate").textContent = d.moderationRate || "--";

  // Failure breakdown
  const FAIL_META = [
    { key: "moderation", label: "Moderation", color: "#F22F46" },
    { key: "face_detection", label: "Face Detection", color: "#E8853A" },
    { key: "generation", label: "Generation/API", color: "#9B6FE8" },
    { key: "printer", label: "Printer", color: "#4B8BF5" },
    { key: "unknown", label: "Unknown", color: "#636B78" },
  ];
  const fb = d.failureBreakdown || {};
  const maxFail = Math.max(1, ...Object.values(fb));
  const totalFails = Object.values(fb).reduce((a,b) => a+b, 0);
  let fhtml = "";
  if (totalFails === 0) {
    fhtml = '<div style="color:#4D5562;font-size:13px">No failures</div>';
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
    ghtml = '<div style="color:#4D5562;font-size:13px">No data yet</div>';
  } else {
    const top10 = geo.slice(0, 10);
    for (const g of top10) {
      const pct = (g.count / maxGeo * 100).toFixed(1);
      ghtml += '<div class="geo-row"><span class="geo-name" title="'+g.country+'">'+g.country+'</span><div class="geo-bar-bg"><div class="geo-bar" style="width:'+pct+'%"></div></div><span class="geo-count">'+g.count+'</span></div>';
    }
  }
  document.getElementById("geoBars").innerHTML = ghtml;
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
  const url = "api/report" + eventParam();
  // Open in new tab so browser handles the PDF download
  const w = window.open(url, "_blank");
  // Restore button after a short delay (PDF streams immediately, but AI summary may take a moment)
  setTimeout(function() { btn.textContent = "Generate Report"; btn.disabled = false; }, 4000);
}

fetchStats();
setInterval(fetchStats, 3000);
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
