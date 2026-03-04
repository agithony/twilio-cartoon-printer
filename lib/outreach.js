const fs = require("fs");
const path = require("path");
const express = require("express");
const { DONE_DIR } = require("./config");
const settings = require("./settings");
const { sendSms } = require("./helpers");

const router = express.Router();
router.use(express.json());

const DATA_DIR = path.join(__dirname, "..", "data");
const RAFFLE_FILE = path.join(DATA_DIR, "raffle.json");

// Raffle persistence
let raffleHistory = [];

function loadRaffle() {
    try {
        if (fs.existsSync(RAFFLE_FILE)) {
            raffleHistory = JSON.parse(fs.readFileSync(RAFFLE_FILE, "utf-8"));
        }
    } catch (err) {
        console.error("Failed to load raffle history:", err);
        raffleHistory = [];
    }
}

function saveRaffle() {
    try {
        fs.writeFileSync(RAFFLE_FILE, JSON.stringify(raffleHistory, null, 2), "utf-8");
    } catch (err) {
        console.error("Failed to save raffle history:", err);
    }
}

// Helper functions
function readJobs(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); }
                catch { return null; }
            })
            .filter(Boolean);
    } catch { return []; }
}

function maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    const tail = phone.slice(-4);
    let ccLen = 2;
    if (phone.length > 12) ccLen = 4;
    else if (phone.length > 11) ccLen = 3;
    const cc = phone.slice(0, ccLen);
    const maskLen = phone.length - ccLen - 4;
    return cc + "*".repeat(Math.max(1, maskLen)) + tail;
}

function phoneHash(phone) {
    let h = 0;
    for (let i = 0; i < phone.length; i++) h = ((h << 5) - h + phone.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function buildUserDirectory(eventFilter) {
    const doneJobs = readJobs(DONE_DIR);
    const userMap = {};
    for (const job of doneJobs) {
        const phone = job.userPhone;
        if (!phone || settings.get("adminPhones").includes(phone)) continue;
        if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
        if (!userMap[phone]) {
            userMap[phone] = { phone, appPhone: job.appPhone, count: 0, styles: new Set(), lastActive: 0 };
        }
        userMap[phone].count++;
        if (job.style) userMap[phone].styles.add(job.style);
        if (job.createdAt > userMap[phone].lastActive) {
            userMap[phone].lastActive = job.createdAt;
            userMap[phone].appPhone = job.appPhone;
        }
    }
    return Object.values(userMap)
        .sort((a, b) => b.lastActive - a.lastActive)
        .map((u) => ({ ...u, id: phoneHash(u.phone), styles: [...u.styles] }));
}

// ── HTML Page ────────────────────────────────────────────────────────────────

const OUTREACH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMS Outreach — Twilio + AI Photo Generator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 15px; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0B0D11; color: #B0B8C4; min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }

  /* Header */
  .hdr {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-bottom: clamp(20px, 2.5vw, 32px); padding-bottom: clamp(14px, 1.5vw, 20px);
    border-bottom: 1px solid #1E222B;
  }
  .hdr h1 { font-size: clamp(18px, 1.5vw, 26px); font-weight: 700; color: #F7F8F8; letter-spacing: -0.3px; }
  .hdr-right { display: flex; align-items: flex-end; gap: clamp(8px, 1vw, 14px); }
  .btn-home {
    display: inline-flex; align-items: center; gap: 6px;
    background: #13161D; color: #B0B8C4; border: 1px solid #1E222B;
    border-radius: 10px; padding: 7px 16px; font-size: 13px; font-weight: 500;
    font-family: inherit; text-decoration: none; transition: border-color .15s, color .15s, background .15s;
  }
  .btn-home:hover { color: #F7F8F8; border-color: #2A3040; background: #1A1E27; }
  .btn-home svg { width: 14px; height: 14px; }
  .ev-pick { display: flex; flex-direction: column; gap: 3px; }
  .ev-pick-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .8px; color: #4D5562; padding-left: 2px; }
  .ev-sel {
    background: #13161D; color: #F7F8F8; border: 1px solid #4B8BF544;
    font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 10px;
    cursor: pointer; font-family: inherit; transition: border-color .15s, box-shadow .15s;
  }
  .ev-sel:focus { outline: none; border-color: #4B8BF5; box-shadow: 0 0 0 3px #4B8BF520; }
  .ev-sel option { background: #13161D; color: #B0B8C4; }

  /* Stat cards */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: clamp(16px, 2vw, 28px); }
  .stat {
    background: #13161D; border: 1px solid #1E222B; border-left: 3px solid #1E222B;
    border-radius: 14px; padding: 16px 18px; transition: border-color .2s;
  }
  .stat:hover { border-color: #2A3040; }
  .stat:nth-child(1) { border-left-color: #4B8BF5; }
  .stat:nth-child(2) { border-left-color: #2EBA54; }
  .stat:nth-child(3) { border-left-color: #E8853A; }
  .stat .val { font-size: clamp(24px, 2.2vw, 36px); font-weight: 700; color: #F7F8F8; font-variant-numeric: tabular-nums; }
  .stat .lbl { font-size: 11px; color: #636B78; text-transform: uppercase; letter-spacing: .6px; font-weight: 500; margin-top: 4px; }
  @media (max-width: 540px) { .stats { grid-template-columns: 1fr 1fr 1fr; } .stat .val { font-size: 22px; } }

  /* Main two-column layout */
  .main { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
  @media (max-width: 768px) { .main { grid-template-columns: 1fr; } }

  .panel {
    background: #13161D; border: 1px solid #1E222B; border-radius: 14px;
    padding: clamp(16px, 1.5vw, 24px); transition: border-color .2s;
  }
  .panel:hover { border-color: #252A34; }
  .panel h2 {
    font-size: 11px; font-weight: 600; color: #4D5562;
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px;
  }

  /* User list */
  .toolbar {
    display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;
  }
  .toolbar label {
    font-size: 13px; color: #8B95A5; display: flex; align-items: center; gap: 6px; cursor: pointer;
  }
  .toolbar label input { accent-color: #4B8BF5; cursor: pointer; }
  .sel-count { font-size: 12px; color: #4B8BF5; font-weight: 500; }

  .user-list {
    max-height: 520px; overflow-y: auto; border: 1px solid #1E222B; border-radius: 10px;
    scrollbar-width: thin; scrollbar-color: #252A34 #13161D;
  }
  .user-list::-webkit-scrollbar { width: 6px; }
  .user-list::-webkit-scrollbar-track { background: #13161D; border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb { background: #252A34; border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb:hover { background: #2A3040; }
  .urow {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    border-bottom: 1px solid #1E222B; font-size: 13px; transition: background .15s;
  }
  .urow:last-child { border-bottom: none; }
  .urow:hover { background: #1A1E27; }
  .urow.winner { background: #E8853A12; border-left: 3px solid #E8853A; }
  .urow input[type=checkbox] { accent-color: #4B8BF5; cursor: pointer; flex-shrink: 0; }
  .urow .trophy { font-size: 14px; flex-shrink: 0; width: 18px; text-align: center; }
  .uphone { font-family: monospace; color: #B0B8C4; min-width: 110px; font-size: 12.5px; }
  .ucnt { color: #8B95A5; min-width: 55px; font-size: 12px; }
  .ustyles { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  .upill { font-size: 10px; padding: 2px 8px; border-radius: 8px; color: #fff; white-space: nowrap; font-weight: 500; }
  .utime { color: #4D5562; font-size: 11px; min-width: 50px; text-align: right; flex-shrink: 0; }

  /* Actions panel */
  .act-section { margin-bottom: 24px; }
  .act-section:last-child { margin-bottom: 0; }
  .act-section h3 {
    font-size: 10px; font-weight: 600; color: #4D5562;
    text-transform: uppercase; letter-spacing: .8px; margin-bottom: 10px;
  }
  .compose-ta {
    width: 100%; background: #0B0D11; border: 1px solid #1E222B; border-radius: 10px;
    color: #B0B8C4; padding: 12px 14px; font-size: 13px; font-family: inherit;
    resize: vertical; min-height: 80px; transition: border-color .15s;
  }
  .compose-ta:focus { outline: none; border-color: #4B8BF5; }
  .compose-ta::placeholder { color: #4D5562; }
  .btn-send {
    width: 100%; margin-top: 10px; background: #F22F46; color: #fff; border: none;
    border-radius: 10px; padding: 10px 18px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, transform .1s;
  }
  .btn-send:hover { background: #D42840; transform: translateY(-1px); }
  .btn-send:disabled { opacity: .5; cursor: default; transform: none; }

  .btn-raffle {
    width: 100%; background: #E8853A18; color: #E8853A; border: 1px solid #E8853A44;
    border-radius: 10px; padding: 10px 18px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s;
  }
  .btn-raffle:hover { background: #E8853A28; border-color: #E8853A; }
  .raffle-display {
    margin-top: 10px; padding: 10px 14px; border-radius: 8px;
    font-size: 12px; display: none;
  }
  .raffle-display.show { display: block; background: #E8853A14; color: #E8853A; border: 1px solid #E8853A33; }

  .winner-list { display: flex; flex-direction: column; gap: 6px; }
  .winner-entry {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    background: #0B0D11; border: 1px solid #1E222B; border-radius: 8px; font-size: 12px;
  }
  .winner-entry .w-icon { font-size: 14px; }
  .winner-entry .w-phone { font-family: monospace; color: #B0B8C4; flex: 1; }
  .winner-entry .w-event { color: #636B78; font-size: 11px; }
  .winner-entry .w-time { color: #4D5562; font-size: 11px; }
  .no-data { color: #4D5562; font-size: 13px; padding: 12px 0; }

  .result-msg {
    font-size: 12px; padding: 8px 12px; border-radius: 8px; margin-top: 10px; display: none;
  }
  .result-msg.success { display: block; background: #2EBA5418; color: #2EBA54; border: 1px solid #2EBA5433; }
  .result-msg.error { display: block; background: #E0444418; color: #F22F46; border: 1px solid #E0444433; }

  .footer {
    text-align: center; color: #4D5562; font-size: 12px; font-weight: 500;
    margin-top: 40px; padding-top: 18px; border-top: 1px solid #1E222B;
  }
</style>
</head>
<body>
<div class="wrap">

<div class="hdr">
  <h1>SMS Outreach</h1>
  <div class="hdr-right">
    <div class="ev-pick"><span class="ev-pick-label">Event</span><select class="ev-sel" id="evSel" onchange="onEventChange()"></select></div>
    <a href="/home/" class="btn-home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="val" id="statRecip">--</div><div class="lbl">Recipients</div></div>
  <div class="stat"><div class="val" id="statSel">0</div><div class="lbl">Selected</div></div>
  <div class="stat"><div class="val" id="statWinners">0</div><div class="lbl">Raffle Winners</div></div>
</div>

<div class="main">
  <!-- Left: User List -->
  <div class="panel">
    <h2>Recipients</h2>
    <div class="toolbar">
      <label><input type="checkbox" id="selAll" onchange="toggleSelectAll()"> Select All</label>
      <span class="sel-count" id="selCount"></span>
    </div>
    <div class="user-list" id="userList"></div>
  </div>

  <!-- Right: Actions -->
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="panel">
      <div class="act-section">
        <h3>Compose Message</h3>
        <textarea class="compose-ta" id="msgBox" placeholder="Type a message to send to selected recipients..."></textarea>
        <button class="btn-send" id="sendBtn" onclick="sendBroadcast()">Send Message</button>
        <div class="result-msg" id="sendResult"></div>
      </div>
    </div>

    <div class="panel">
      <div class="act-section">
        <h3>Pick a Winner</h3>
        <button class="btn-raffle" onclick="pickWinner()">Draw Winner</button>
        <div class="raffle-display" id="raffleDisplay"></div>
      </div>
    </div>

    <div class="panel">
      <div class="act-section">
        <h3>Raffle History</h3>
        <div class="winner-list" id="winnerList"></div>
      </div>
    </div>
  </div>
</div>

<div class="footer">Auto-refreshes recipient list every 10s</div>
</div>

<script>
const STYLE_COLORS = {
  cartoon: "#4B8BF5", "pop-art": "#E8853A", watercolor: "#9B6FE8",
  anime: "#E86B9E", sketch: "#8B95A5", "pixel-art": "#2EBA54",
};

let users = [];
let raffleWinners = [];
let selectedEvent = "";
let winnerIds = new Set();

function evParam() {
  return selectedEvent ? "?event=" + encodeURIComponent(selectedEvent) : "";
}

function onEventChange() {
  selectedEvent = document.getElementById("evSel").value;
  fetchUsers();
  fetchRaffle();
}

async function fetchEvents() {
  try {
    const r = await fetch("api/events");
    const d = await r.json();
    const sel = document.getElementById("evSel");
    sel.innerHTML = '<option value="all">All Events</option>';
    for (const e of d.events) {
      sel.innerHTML += '<option value="' + e + '"' + (e === d.currentEvent ? ' selected' : '') + '>' + e + '</option>';
    }
    selectedEvent = sel.value;
    fetchUsers();
    fetchRaffle();
  } catch (e) { console.error(e); }
}

async function fetchUsers() {
  try {
    const r = await fetch("api/users" + evParam());
    users = await r.json();
    renderUsers();
  } catch (e) { console.error(e); }
}

async function fetchRaffle() {
  try {
    const r = await fetch("api/raffle" + evParam());
    raffleWinners = await r.json();
    winnerIds = new Set(raffleWinners.map(w => w.id));
    renderRaffleHistory();
    document.getElementById("statWinners").textContent = raffleWinners.length;
  } catch (e) { console.error(e); }
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function renderUsers() {
  document.getElementById("statRecip").textContent = users.length;
  const prev = new Set(getSelectedIds());
  let html = "";
  for (const u of users) {
    let pills = "";
    for (const s of u.styles) {
      const c = STYLE_COLORS[s] || "#4B8BF5";
      pills += '<span class="upill" style="background:' + c + '">' + s + '</span>';
    }
    const isWinner = winnerIds.has(u.id);
    const chk = prev.has(u.id) ? " checked" : "";
    html += '<div class="urow' + (isWinner ? ' winner' : '') + '" id="row-' + u.id + '">'
      + '<input type="checkbox" class="ucb" data-id="' + u.id + '"' + chk + ' onchange="updateSelCount()">'
      + (isWinner ? '<span class="trophy">&#127942;</span>' : '')
      + '<span class="uphone">' + u.phone + '</span>'
      + '<span class="ucnt">' + u.count + ' print' + (u.count === 1 ? '' : 's') + '</span>'
      + '<span class="ustyles">' + pills + '</span>'
      + '<span class="utime">' + relativeTime(u.lastActive) + '</span>'
      + '</div>';
  }
  document.getElementById("userList").innerHTML = html || '<div class="no-data">No recipients yet</div>';
  updateSelCount();
}

function renderRaffleHistory() {
  if (raffleWinners.length === 0) {
    document.getElementById("winnerList").innerHTML = '<div class="no-data">No winners yet</div>';
    return;
  }
  let html = "";
  for (const w of raffleWinners) {
    html += '<div class="winner-entry">'
      + '<span class="w-icon">&#127942;</span>'
      + '<span class="w-phone">' + w.maskedPhone + '</span>'
      + '<span class="w-event">' + (w.event || '') + '</span>'
      + '<span class="w-time">' + relativeTime(w.timestamp) + '</span>'
      + '</div>';
  }
  document.getElementById("winnerList").innerHTML = html;
}

function toggleSelectAll() {
  const checked = document.getElementById("selAll").checked;
  document.querySelectorAll(".ucb").forEach(cb => cb.checked = checked);
  updateSelCount();
}

function updateSelCount() {
  const checked = document.querySelectorAll(".ucb:checked").length;
  const total = document.querySelectorAll(".ucb").length;
  document.getElementById("selCount").textContent = checked > 0 ? checked + " of " + total + " selected" : "";
  document.getElementById("statSel").textContent = checked;
  document.getElementById("selAll").checked = total > 0 && checked === total;
  document.getElementById("selAll").indeterminate = checked > 0 && checked < total;
  const btn = document.getElementById("sendBtn");
  btn.textContent = checked > 0 ? "Send to " + checked + " recipient" + (checked === 1 ? "" : "s") : "Send Message";
}

function getSelectedIds() {
  return [...document.querySelectorAll(".ucb:checked")].map(cb => parseInt(cb.dataset.id));
}

function pickWinner() {
  if (users.length === 0) return;
  const display = document.getElementById("raffleDisplay");
  display.className = "raffle-display";
  document.querySelectorAll(".urow.winner-anim").forEach(r => r.classList.remove("winner-anim"));
  let ticks = 0;
  const totalTicks = 14;
  const interval = setInterval(function() {
    document.querySelectorAll(".urow").forEach(r => r.style.background = "");
    const rand = Math.floor(Math.random() * users.length);
    const row = document.getElementById("row-" + users[rand].id);
    if (row) row.style.background = "#E8853A18";
    ticks++;
    if (ticks >= totalTicks) {
      clearInterval(interval);
      document.querySelectorAll(".urow").forEach(r => r.style.background = "");
      const winnerIdx = Math.floor(Math.random() * users.length);
      const winner = users[winnerIdx];
      const winnerRow = document.getElementById("row-" + winner.id);
      if (winnerRow) {
        winnerRow.classList.add("winner");
        winnerRow.scrollIntoView({ behavior: "smooth", block: "center" });
        const cb = winnerRow.querySelector(".ucb");
        if (cb) { cb.checked = true; updateSelCount(); }
      }
      display.className = "raffle-display show";
      display.innerHTML = "&#127942; Winner: <strong>" + winner.phone + "</strong>";
      // Persist winner
      fetch("api/raffle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: winner.id, maskedPhone: winner.phone, event: selectedEvent }),
      }).then(() => fetchRaffle());
    }
  }, 80);
}

async function sendBroadcast() {
  const ids = getSelectedIds();
  const message = document.getElementById("msgBox").value.trim();
  if (!ids.length || !message) return;
  const btn = document.getElementById("sendBtn");
  const result = document.getElementById("sendResult");
  btn.disabled = true;
  btn.textContent = "Sending...";
  result.className = "result-msg";
  try {
    const r = await fetch("api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, message, event: selectedEvent }),
    });
    const d = await r.json();
    if (d.error) {
      result.className = "result-msg error";
      result.textContent = d.error;
    } else {
      result.className = "result-msg success";
      let msg = "Sent to " + d.sent + " recipient" + (d.sent === 1 ? "" : "s");
      if (d.failed > 0) msg += ", " + d.failed + " failed";
      result.textContent = msg;
    }
  } catch (e) {
    result.className = "result-msg error";
    result.textContent = "Network error: " + e.message;
  } finally {
    btn.disabled = false;
    updateSelCount();
  }
}

fetchEvents();
setInterval(fetchUsers, 10000);
</script>
</body>
</html>`;

// Routes
router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/")) return res.redirect(req.originalUrl + "/");
    res.type("html").send(OUTREACH_HTML);
});

router.get("/api/events", (req, res) => {
    const jobs = readJobs(DONE_DIR);
    const events = [...new Set(jobs.map((j) => j.eventName).filter(Boolean))].sort();
    res.json({ events, currentEvent: settings.get("eventName") });
});

router.get("/api/users", (req, res) => {
    const users = buildUserDirectory(req.query.event);
    res.json(users.map((u) => ({
        id: u.id,
        phone: maskPhone(u.phone),
        count: u.count,
        styles: u.styles,
        lastActive: u.lastActive,
    })));
});

router.post("/api/send-message", async (req, res) => {
    const { ids, message, event } = req.body || {};
    if (!message || !ids || !ids.length) {
        return res.status(400).json({ error: "ids and message are required" });
    }
    const users = buildUserDirectory(event);
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

router.get("/api/raffle", (req, res) => {
    const event = req.query.event;
    if (event && event !== "all") {
        res.json(raffleHistory.filter((w) => w.event === event));
    } else {
        res.json(raffleHistory);
    }
});

router.post("/api/raffle", (req, res) => {
    const { id, maskedPhone, event } = req.body || {};
    if (!id || !maskedPhone) {
        return res.status(400).json({ error: "id and maskedPhone are required" });
    }
    const entry = { id, maskedPhone, event: event || "unknown", timestamp: Date.now() };
    raffleHistory.unshift(entry);
    saveRaffle();
    res.json(entry);
});

// Mount function
function mountOutreach(app) {
    loadRaffle();
    app.use("/outreach", router);
    console.log("📨 SMS Outreach mounted at /outreach");
}

module.exports = { mountOutreach };
