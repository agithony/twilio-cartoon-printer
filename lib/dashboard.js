const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const express = require("express");
const {
    EVENT_NAME,
    ADMIN_PHONES,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");
const paper = require("./paper");
const { sendSms } = require("./helpers");

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

// ── API Routes ───────────────────────────────────────────────────────────────

router.get("/api/stats", async (req, res) => {
    const isAdmin = (phone) => ADMIN_PHONES.includes(phone);
    const allDoneJobs = readJobs(DONE_DIR);
    const allFailedJobs = readJobs(FAILED_DIR);

    // Exclude admin jobs from all metrics
    const doneJobs = allDoneJobs.filter((j) => !isAdmin(j.userPhone));
    const failedJobs = allFailedJobs.filter((j) => !isAdmin(j.userPhone));

    // Queue counts
    const queue = {
        pending: countFiles(PENDING_DIR),
        generating: countFiles(GENERATING_DIR),
        ready: countFiles(READY_DIR),
        printing: countFiles(PRINTING_DIR),
    };

    // 24h filter
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Use createdAt from job data for accurate timestamps
    const doneIn24h = doneJobs.filter((j) => j.createdAt && j.createdAt > oneDayAgo);

    // Unique users
    const userCounts = {};
    for (const job of doneJobs) {
        const phone = job.userPhone || "unknown";
        userCounts[phone] = (userCounts[phone] || 0) + 1;
    }
    const uniqueUsers = Object.keys(userCounts).length;
    const avgPerUser = uniqueUsers > 0 ? (doneJobs.length / uniqueUsers).toFixed(1) : "0";

    // Style breakdown
    const styleCounts = {};
    for (const job of doneJobs) {
        const style = job.style || "cartoon";
        styleCounts[style] = (styleCounts[style] || 0) + 1;
    }

    // Top users (top 5, masked)
    const topUsers = Object.entries(userCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([phone, count]) => ({ phone: maskPhone(phone), count }));

    // Hourly activity (last 24h)
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

    // Printer status
    const printer = await getPrinterStatus();

    res.json({
        eventName: EVENT_NAME,
        totals: { done: doneJobs.length, failed: failedJobs.length },
        prints24h: doneIn24h.length,
        uniqueUsers,
        avgPerUser,
        queue,
        styleCounts,
        topUsers,
        hourlyActivity: hourlyBuckets,
        hourlyLabels,
        paper: paper.getState(),
        printer,
    });
});

router.post("/api/paper/reset", (req, res) => {
    res.json(paper.reset());
});

router.post("/api/paper/config", (req, res) => {
    const { capacity, warningThreshold } = req.body || {};
    res.json(paper.updateConfig({ capacity, warningThreshold }));
});

// ── User Directory ───────────────────────────────────────────────────────────

function phoneHash(phone) {
    let h = 0;
    for (let i = 0; i < phone.length; i++) h = ((h << 5) - h + phone.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function buildUserDirectory() {
    const doneJobs = readJobs(DONE_DIR);
    const userMap = {};
    for (const job of doneJobs) {
        const phone = job.userPhone;
        if (!phone || ADMIN_PHONES.includes(phone)) continue;
        if (!userMap[phone]) {
            userMap[phone] = { phone, appPhone: job.appPhone, count: 0, styles: new Set(), lastActive: 0 };
        }
        userMap[phone].count++;
        if (job.style) userMap[phone].styles.add(job.style);
        if (job.createdAt > userMap[phone].lastActive) {
            userMap[phone].lastActive = job.createdAt;
            userMap[phone].appPhone = job.appPhone; // use most recent appPhone
        }
    }
    return Object.values(userMap)
        .sort((a, b) => b.lastActive - a.lastActive)
        .map((u) => ({ ...u, id: phoneHash(u.phone), styles: [...u.styles] }));
}

router.get("/api/users", (req, res) => {
    const users = buildUserDirectory();
    res.json(users.map((u) => ({
        id: u.id,
        phone: maskPhone(u.phone),
        count: u.count,
        styles: u.styles,
        lastActive: u.lastActive,
    })));
});

router.post("/api/send-message", async (req, res) => {
    const { ids, message } = req.body || {};
    if (!message || !ids || !ids.length) {
        return res.status(400).json({ error: "ids and message are required" });
    }
    const users = buildUserDirectory();
    const byId = new Map(users.map((u) => [u.id, u]));
    let sent = 0;
    let failed = 0;
    for (const id of ids) {
        const user = byId.get(id);
        if (!user || !user.phone || !user.appPhone) { failed++; continue; }
        try {
            await sendSms(user.phone, user.appPhone, message);
            sent++;
        } catch {
            failed++;
        }
    }
    console.log(`📨 Broadcast: ${sent} sent, ${failed} failed`);
    res.json({ sent, failed });
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
<title>Photobooth Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1117;
    color: #e1e4e8;
    min-height: 100vh;
    padding: 20px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #21262d;
  }
  .header h1 { font-size: 22px; font-weight: 600; color: #f0f6fc; }
  .header .event {
    font-size: 14px;
    color: #f0883e;
    background: #f0883e18;
    padding: 4px 12px;
    border-radius: 12px;
  }
  .header .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 10px;
    padding: 16px;
    text-align: center;
  }
  .card .value { font-size: 32px; font-weight: 700; color: #f0f6fc; }
  .card .label { font-size: 12px; color: #8b949e; margin-top: 4px; text-transform: uppercase; letter-spacing: .5px; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 10px;
    padding: 20px;
  }
  .panel h2 { font-size: 14px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 16px; }

  /* Paper counter */
  .paper-big { font-size: 48px; font-weight: 800; text-align: center; line-height: 1; }
  .paper-sub { text-align: center; font-size: 14px; color: #8b949e; margin: 4px 0 12px; }
  .progress-bar { height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; margin-bottom: 16px; }
  .progress-fill { height: 100%; border-radius: 4px; transition: width .5s ease, background .5s ease; }
  .paper-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .paper-controls label { font-size: 12px; color: #8b949e; }
  .paper-controls input {
    width: 60px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    color: #e1e4e8; padding: 4px 8px; font-size: 13px; text-align: center;
  }
  .paper-controls input:focus { outline: none; border-color: #58a6ff; }
  .btn {
    background: #21262d; color: #e1e4e8; border: 1px solid #30363d; border-radius: 6px;
    padding: 6px 14px; font-size: 13px; cursor: pointer; transition: background .15s;
  }
  .btn:hover { background: #30363d; }
  .btn-primary { background: #238636; border-color: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-danger { background: #da3633; border-color: #da3633; color: #fff; }
  .btn-danger:hover { background: #f85149; }
  .paper-alert {
    text-align: center; padding: 8px; border-radius: 6px; margin-bottom: 12px;
    font-weight: 600; font-size: 13px; display: none;
  }
  .paper-alert.warning { display: block; background: #f0883e22; color: #f0883e; border: 1px solid #f0883e44; }
  .paper-alert.empty { display: block; background: #da363322; color: #f85149; border: 1px solid #da363344; }

  /* Queue status */
  .queue-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #21262d; }
  .queue-row:last-child { border-bottom: none; }
  .queue-label { display: flex; align-items: center; gap: 8px; }
  .queue-dot { width: 10px; height: 10px; border-radius: 50%; }
  .queue-count { font-weight: 600; font-size: 18px; }

  /* Style bars */
  .style-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .style-name { width: 80px; font-size: 13px; color: #8b949e; text-align: right; flex-shrink: 0; }
  .style-bar-bg { flex: 1; height: 20px; background: #21262d; border-radius: 4px; overflow: hidden; }
  .style-bar { height: 100%; border-radius: 4px; transition: width .5s ease; min-width: 2px; }
  .style-count { width: 30px; font-size: 13px; font-weight: 600; text-align: right; flex-shrink: 0; }

  /* Hourly chart */
  .hourly-bars { display: flex; align-items: flex-end; gap: 3px; height: 100px; position: relative; }
  .hourly-bar {
    flex: 1; background: #58a6ff; border-radius: 2px 2px 0 0; min-height: 2px;
    transition: height .3s ease; cursor: default; position: relative;
  }
  .hourly-bar:hover { background: #79c0ff; }
  .hourly-bar:hover .hourly-tip { display: block; }
  .hourly-tip {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: #30363d; color: #f0f6fc; font-size: 11px; font-weight: 600; padding: 3px 8px;
    border-radius: 4px; white-space: nowrap; pointer-events: none; z-index: 10;
  }
  .hourly-tip::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 4px solid transparent; border-top-color: #30363d;
  }
  .hourly-labels { display: flex; gap: 3px; margin-top: 4px; }
  .hourly-label { flex: 1; font-size: 9px; color: #484f58; text-align: center; white-space: nowrap; }

  /* Printer */
  .printer-status { display: flex; align-items: center; gap: 10px; font-size: 15px; }
  .printer-dot { width: 12px; height: 12px; border-radius: 50%; }

  /* Top users */
  .user-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
  .user-phone { color: #8b949e; font-family: monospace; }
  .user-count { font-weight: 600; }

  /* Outreach section */
  .outreach-panel { background: #161b22; border: 1px solid #21262d; border-radius: 10px; margin-bottom: 24px; overflow: hidden; }
  .outreach-header {
    display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none;
    padding: 16px 20px; background: #161b22; transition: background .15s;
  }
  .outreach-header:hover { background: #1c2128; }
  .outreach-header h2 { margin: 0; font-size: 14px; font-weight: 600; color: #e1e4e8; text-transform: uppercase; letter-spacing: .5px; }
  .outreach-badge { background: #58a6ff22; color: #58a6ff; font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 10px; }
  .outreach-toggle { margin-left: auto; font-size: 12px; color: #8b949e; transition: transform .2s; }
  .outreach-toggle.open { transform: rotate(180deg); }
  .outreach-body { display: none; padding: 0 20px 20px; }
  .outreach-body.open { display: block; }
  .outreach-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .outreach-toolbar label { font-size: 13px; color: #8b949e; display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .outreach-sel-count { font-size: 12px; color: #58a6ff; }
  .outreach-list { max-height: 360px; overflow-y: auto; border: 1px solid #21262d; border-radius: 8px; }
  .outreach-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    border-bottom: 1px solid #21262d; font-size: 13px; transition: background .15s;
  }
  .outreach-row:last-child { border-bottom: none; }
  .outreach-row:hover { background: #1c2128; }
  .outreach-row.winner { background: #f0883e18; border-left: 3px solid #f0883e; }
  .outreach-row input[type=checkbox] { accent-color: #58a6ff; cursor: pointer; flex-shrink: 0; }
  .outreach-phone { font-family: monospace; color: #e1e4e8; min-width: 120px; }
  .outreach-count { color: #8b949e; min-width: 70px; }
  .outreach-styles { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  .outreach-pill { font-size: 10px; padding: 2px 8px; border-radius: 8px; color: #fff; white-space: nowrap; font-weight: 500; }
  .outreach-time { color: #484f58; font-size: 11px; min-width: 60px; text-align: right; flex-shrink: 0; }
  .outreach-actions { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
  .outreach-compose { margin-top: 14px; }
  .outreach-compose-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px; }
  .outreach-compose-row { display: flex; gap: 8px; align-items: flex-start; }
  .outreach-compose textarea {
    flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
    color: #e1e4e8; padding: 10px 14px; font-size: 13px; font-family: inherit; resize: vertical; min-height: 68px;
  }
  .outreach-compose textarea:focus { outline: none; border-color: #58a6ff; }
  .outreach-compose textarea::placeholder { color: #484f58; }
  .outreach-result { font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-top: 10px; display: none; }
  .outreach-result.success { display: block; background: #23863622; color: #3fb950; border: 1px solid #23863644; }
  .outreach-result.error { display: block; background: #da363322; color: #f85149; border: 1px solid #da363344; }
  .outreach-result.info { display: block; background: #f0883e18; color: #f0883e; border: 1px solid #f0883e44; }
  .btn-raffle { background: #f0883e22; color: #f0883e; border: 1px solid #f0883e44; }
  .btn-raffle:hover { background: #f0883e33; }

  .footer { text-align: center; color: #484f58; font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>

<div class="header">
  <h1><span class="status-dot" id="liveDot" style="background:#3fb950"></span> Photobooth Dashboard</h1>
  <span class="event" id="eventName">--</span>
</div>

<div class="cards">
  <div class="card"><div class="value" id="totalPrints">--</div><div class="label">Total Prints</div></div>
  <div class="card"><div class="value" id="prints24h">--</div><div class="label">Last 24h</div></div>
  <div class="card"><div class="value" id="uniqueUsers">--</div><div class="label">Unique Users</div></div>
  <div class="card"><div class="value" id="avgPerUser">--</div><div class="label">Avg / User</div></div>
  <div class="card"><div class="value" id="inQueue">--</div><div class="label">In Queue</div></div>
</div>

<div class="grid">
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

  <!-- Queue Status -->
  <div class="panel">
    <h2>Queue Status</h2>
    <div id="queueRows"></div>
    <div style="margin-top:16px">
      <h2>Printer</h2>
      <div class="printer-status">
        <span class="printer-dot" id="printerDot"></span>
        <span id="printerMsg">--</span>
      </div>
    </div>
  </div>

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

  <!-- Failures -->
  <div class="panel">
    <h2>Job Health</h2>
    <div style="display:flex;gap:24px">
      <div><span style="font-size:28px;font-weight:700;color:#3fb950" id="healthDone">--</span><div style="font-size:12px;color:#8b949e;margin-top:2px">Completed</div></div>
      <div><span style="font-size:28px;font-weight:700;color:#f85149" id="healthFailed">--</span><div style="font-size:12px;color:#8b949e;margin-top:2px">Failed</div></div>
      <div><span style="font-size:28px;font-weight:700;color:#58a6ff" id="healthRate">--</span><div style="font-size:12px;color:#8b949e;margin-top:2px">Success Rate</div></div>
    </div>
  </div>
</div>

<!-- SMS Outreach -->
<div class="outreach-panel">
  <div class="outreach-header" onclick="toggleOutreach()">
    <h2 style="margin-bottom:0">SMS Outreach</h2>
    <span class="outreach-badge" id="outreachCount">0 recipients</span>
    <span class="outreach-toggle" id="outreachToggle">&#9660;</span>
  </div>
  <div class="outreach-body" id="outreachBody">
    <div class="outreach-actions">
      <label style="font-size:13px;color:#8b949e;display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="outreachSelectAll" onchange="toggleSelectAll()"> Select All</label>
      <span class="outreach-sel-count" id="outreachSelCount"></span>
      <span style="flex:1"></span>
      <button class="btn btn-raffle" onclick="pickWinner()">Pick a Winner</button>
    </div>
    <div class="outreach-list" id="outreachList"></div>
    <div class="outreach-compose">
      <div class="outreach-compose-label">Broadcast Message</div>
      <div class="outreach-compose-row">
        <textarea id="outreachMessage" placeholder="Type a message to send to selected recipients..." rows="3"></textarea>
        <button class="btn btn-primary" id="outreachSendBtn" onclick="sendBroadcast()" style="align-self:stretch;min-width:80px">Send</button>
      </div>
    </div>
    <div class="outreach-result" id="outreachResult"></div>
  </div>
</div>

<div class="footer">Auto-refreshes every 3s</div>

<script>
const STYLE_COLORS = {
  cartoon: "#58a6ff", "pop-art": "#f0883e", watercolor: "#a371f7",
  anime: "#f778ba", sketch: "#8b949e", "pixel-art": "#3fb950",
};
const QUEUE_META = [
  { key: "pending", label: "Pending", color: "#8b949e" },
  { key: "generating", label: "Generating", color: "#a371f7" },
  { key: "ready", label: "Ready to Print", color: "#58a6ff" },
  { key: "printing", label: "Printing", color: "#3fb950" },
];

async function fetchStats() {
  try {
    const r = await fetch("api/stats");
    const d = await r.json();
    render(d);
  } catch (e) {
    document.getElementById("liveDot").style.background = "#f85149";
  }
}

function render(d) {
  document.getElementById("liveDot").style.background = "#3fb950";
  document.getElementById("eventName").textContent = d.eventName;
  document.getElementById("totalPrints").textContent = d.totals.done;
  document.getElementById("prints24h").textContent = d.prints24h;
  document.getElementById("uniqueUsers").textContent = d.uniqueUsers;
  document.getElementById("avgPerUser").textContent = d.avgPerUser;
  const queueTotal = d.queue.pending + d.queue.generating + d.queue.ready + d.queue.printing;
  document.getElementById("inQueue").textContent = queueTotal;

  // Paper
  const p = d.paper;
  document.getElementById("paperRemaining").textContent = p.remaining;
  document.getElementById("paperRemaining").style.color = p.isEmpty ? "#f85149" : p.isWarning ? "#f0883e" : "#f0f6fc";
  document.getElementById("paperSub").textContent = p.remaining + " / " + p.capacity + " sheets";
  const pct = p.capacity > 0 ? (p.remaining / p.capacity * 100) : 0;
  const bar = document.getElementById("paperBar");
  bar.style.width = pct + "%";
  bar.style.background = p.isEmpty ? "#f85149" : p.isWarning ? "#f0883e" : "#3fb950";
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
  const printerColors = { ready: "#3fb950", printing: "#58a6ff", error: "#f85149", not_found: "#f0883e", unknown: "#8b949e" };
  document.getElementById("printerDot").style.background = printerColors[d.printer.status] || "#8b949e";
  document.getElementById("printerMsg").textContent = d.printer.message;

  // Styles
  const maxStyle = Math.max(1, ...Object.values(d.styleCounts));
  let shtml = "";
  const sortedStyles = Object.entries(d.styleCounts).sort((a,b) => b[1]-a[1]);
  for (const [name, count] of sortedStyles) {
    const pct = (count / maxStyle * 100).toFixed(1);
    const color = STYLE_COLORS[name] || "#58a6ff";
    shtml += '<div class="style-row"><span class="style-name">'+name+'</span><div class="style-bar-bg"><div class="style-bar" style="width:'+pct+'%;background:'+color+'"></div></div><span class="style-count">'+count+'</span></div>';
  }
  document.getElementById("styleBars").innerHTML = shtml;

  // Hourly
  const maxH = Math.max(1, ...d.hourlyActivity);
  let barsHtml = "";
  let labelsHtml = "";
  for (let i = 0; i < d.hourlyActivity.length; i++) {
    const h = d.hourlyActivity[i];
    const hpx = Math.max(2, Math.round(h / maxH * 100));
    const lbl = d.hourlyLabels ? d.hourlyLabels[i] : "";
    const showLabel = (i % 3 === 0) || i === 23;
    barsHtml += '<div class="hourly-bar" style="height:'+hpx+'px"><span class="hourly-tip">'+lbl+': '+h+'</span></div>';
    labelsHtml += '<span class="hourly-label">'+(showLabel ? lbl : "")+'</span>';
  }
  document.getElementById("hourlyBars").innerHTML = barsHtml;
  document.getElementById("hourlyLabels").innerHTML = labelsHtml;

  // Top users
  let uhtml = "";
  for (const u of d.topUsers) {
    uhtml += '<div class="user-row"><span class="user-phone">'+u.phone+'</span><span class="user-count">'+u.count+' prints</span></div>';
  }
  document.getElementById("topUsers").innerHTML = uhtml || '<div style="color:#484f58;font-size:13px">No data yet</div>';

  // Health
  document.getElementById("healthDone").textContent = d.totals.done;
  document.getElementById("healthFailed").textContent = d.totals.failed;
  const total = d.totals.done + d.totals.failed;
  document.getElementById("healthRate").textContent = total > 0 ? (d.totals.done / total * 100).toFixed(0) + "%" : "--";

  // Update outreach badge count
  document.getElementById("outreachCount").textContent = d.uniqueUsers + " recipient" + (d.uniqueUsers === 1 ? "" : "s");
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

// ── SMS Outreach ──
let outreachUsers = [];
let outreachOpen = false;

function toggleOutreach() {
  outreachOpen = !outreachOpen;
  document.getElementById("outreachBody").className = "outreach-body" + (outreachOpen ? " open" : "");
  document.getElementById("outreachToggle").className = "outreach-toggle" + (outreachOpen ? " open" : "");
  if (outreachOpen && outreachUsers.length === 0) fetchUsers();
}

async function fetchUsers() {
  try {
    const r = await fetch("api/users");
    outreachUsers = await r.json();
    renderUsers();
  } catch(e) { console.error(e); }
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

function renderUsers() {
  document.getElementById("outreachCount").textContent = outreachUsers.length + " recipient" + (outreachUsers.length === 1 ? "" : "s");
  const prevChecked = new Set(getSelectedIds());
  let html = "";
  for (const u of outreachUsers) {
    let pills = "";
    for (const s of u.styles) {
      const c = STYLE_COLORS[s] || "#58a6ff";
      pills += '<span class="outreach-pill" style="background:'+c+'">'+s+'</span>';
    }
    const chk = prevChecked.has(u.id) ? " checked" : "";
    html += '<div class="outreach-row" id="row-'+u.id+'">'
      + '<input type="checkbox" class="outreach-cb" data-id="'+u.id+'"'+chk+' onchange="updateSelCount()">'
      + '<span class="outreach-phone">'+u.phone+'</span>'
      + '<span class="outreach-count">'+u.count+' print'+(u.count===1?"":"s")+'</span>'
      + '<span class="outreach-styles">'+pills+'</span>'
      + '<span class="outreach-time">'+relativeTime(u.lastActive)+'</span>'
      + '</div>';
  }
  document.getElementById("outreachList").innerHTML = html || '<div style="padding:16px;color:#484f58;text-align:center">No recipients yet</div>';
  updateSelCount();
}

function toggleSelectAll() {
  const checked = document.getElementById("outreachSelectAll").checked;
  document.querySelectorAll(".outreach-cb").forEach(cb => cb.checked = checked);
  updateSelCount();
}

function updateSelCount() {
  const checked = document.querySelectorAll(".outreach-cb:checked").length;
  const total = document.querySelectorAll(".outreach-cb").length;
  const el = document.getElementById("outreachSelCount");
  el.textContent = checked > 0 ? checked + " of " + total + " selected" : "";
  document.getElementById("outreachSelectAll").checked = total > 0 && checked === total;
  document.getElementById("outreachSelectAll").indeterminate = checked > 0 && checked < total;
}

function getSelectedIds() {
  return [...document.querySelectorAll(".outreach-cb:checked")].map(cb => parseInt(cb.dataset.id));
}

function pickWinner() {
  if (outreachUsers.length === 0) return;
  const result = document.getElementById("outreachResult");
  // Clear previous winner highlight
  document.querySelectorAll(".outreach-row.winner").forEach(r => r.classList.remove("winner"));
  // Uncheck all, then check the winner
  document.querySelectorAll(".outreach-cb").forEach(cb => cb.checked = false);
  // Animate through a few random picks before landing
  let ticks = 0;
  const totalTicks = 12;
  const interval = setInterval(function() {
    document.querySelectorAll(".outreach-row.winner").forEach(r => r.classList.remove("winner"));
    const rand = Math.floor(Math.random() * outreachUsers.length);
    const row = document.getElementById("row-" + outreachUsers[rand].id);
    if (row) row.classList.add("winner");
    ticks++;
    if (ticks >= totalTicks) {
      clearInterval(interval);
      // Final pick
      const winnerIdx = Math.floor(Math.random() * outreachUsers.length);
      const winner = outreachUsers[winnerIdx];
      document.querySelectorAll(".outreach-row.winner").forEach(r => r.classList.remove("winner"));
      const winnerRow = document.getElementById("row-" + winner.id);
      if (winnerRow) {
        winnerRow.classList.add("winner");
        winnerRow.scrollIntoView({ behavior: "smooth", block: "center" });
        const cb = winnerRow.querySelector(".outreach-cb");
        if (cb) cb.checked = true;
      }
      updateSelCount();
      result.className = "outreach-result info";
      result.textContent = "Winner: " + winner.phone + " -- select them and type a congratulations message!";
    }
  }, 80);
}

async function sendBroadcast() {
  const ids = getSelectedIds();
  const message = document.getElementById("outreachMessage").value.trim();
  if (!ids.length || !message) return;
  const btn = document.getElementById("outreachSendBtn");
  const result = document.getElementById("outreachResult");
  btn.disabled = true;
  btn.textContent = "Sending...";
  result.className = "outreach-result";
  try {
    const r = await fetch("api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, message }),
    });
    const d = await r.json();
    if (d.error) {
      result.className = "outreach-result error";
      result.textContent = d.error;
    } else {
      result.className = "outreach-result success";
      let msg = "Sent to " + d.sent + " recipient" + (d.sent === 1 ? "" : "s");
      if (d.failed > 0) msg += ", " + d.failed + " failed";
      result.textContent = msg;
    }
  } catch(e) {
    result.className = "outreach-result error";
    result.textContent = "Network error: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Send";
  }
}

fetchStats();
setInterval(fetchStats, 3000);
// Refresh recipient list periodically when outreach is open
setInterval(function() { if (outreachOpen) fetchUsers(); }, 10000);
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
