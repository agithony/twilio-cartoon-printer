const fs = require("fs");
const path = require("path");
const express = require("express");
const { DONE_DIR } = require("./config");
const settings = require("./settings");
const { sendSms } = require("./helpers");
const leads = require("./leads");

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
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Outreach — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0B0D11; color: #B0B8C4; min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }

  /* Section group dividers */
  .section-group { margin-bottom: clamp(20px, 2.5vw, 32px); }
  .section-label {
    font-size: 11px; font-weight: 700; color: #636B78;
    text-transform: uppercase; letter-spacing: 1.5px;
    padding: 0 0 14px 0;
    display: flex; align-items: center; gap: 12px;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: #1E222B; }

  /* Header */
  .hdr {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: clamp(20px, 2.5vw, 32px); padding-bottom: clamp(14px, 1.5vw, 20px);
    border-bottom: 1px solid #1E222B;
    gap: 16px; flex-wrap: wrap;
  }
  .hdr h1 {
    font-size: clamp(20px, 1.6vw, 28px); font-weight: 700; color: #F7F8F8;
    letter-spacing: -0.3px; padding-top: 6px;
  }
  .hdr-controls {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .hdr-item {
    display: inline-flex; align-items: center; gap: 6px;
    background: #13161D; border: 1px solid #1E222B; border-radius: 10px;
    padding: 8px 14px; font-size: 13px; font-weight: 500; color: #B0B8C4;
    font-family: inherit; cursor: pointer; white-space: nowrap;
    transition: border-color .15s, color .15s, background .15s;
    text-decoration: none;
  }
  .hdr-item:hover { color: #F7F8F8; border-color: #2A3040; background: #1A1E27; }
  .hdr-item svg { width: 14px; height: 14px; flex-shrink: 0; }
  .hdr-item select {
    background: transparent; border: none; color: #F7F8F8;
    font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer; outline: none; padding: 0; margin: 0;
    -webkit-appearance: none; appearance: none;
  }
  .hdr-item select option { background: #13161D; color: #B0B8C4; }

  /* Stat cards */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: clamp(20px, 2.5vw, 32px); }
  .stat {
    background: #13161D; border: 1px solid #1E222B; border-top: 3px solid #1E222B;
    border-radius: 14px; padding: 20px 20px; position: relative; overflow: hidden;
    transition: border-color .2s, transform .15s, box-shadow .15s;
  }
  .stat::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 50px;
    background: linear-gradient(180deg, rgba(255,255,255,.02) 0%, transparent 100%);
    pointer-events: none;
  }
  .stat:hover { border-color: #2A3040; transform: translateY(-2px); box-shadow: 0 6px 24px rgba(0,0,0,.25); }
  .stat:nth-child(1) { border-top-color: #4B8BF5; }
  .stat:nth-child(2) { border-top-color: #2EBA54; }
  .stat:nth-child(3) { border-top-color: #E8853A; }
  .stat:nth-child(1)::before { background: linear-gradient(180deg, rgba(75,139,245,.06) 0%, transparent 100%); }
  .stat:nth-child(2)::before { background: linear-gradient(180deg, rgba(46,186,84,.06) 0%, transparent 100%); }
  .stat:nth-child(3)::before { background: linear-gradient(180deg, rgba(232,133,58,.06) 0%, transparent 100%); }
  .stat .val { font-size: clamp(26px, 2.4vw, 40px); font-weight: 700; color: #F7F8F8; font-variant-numeric: tabular-nums; position: relative; }
  .stat .lbl { font-size: 12px; color: #636B78; text-transform: uppercase; letter-spacing: .6px; font-weight: 500; margin-top: 4px; position: relative; }
  @media (max-width: 540px) { .stats { grid-template-columns: 1fr 1fr 1fr; } .stat .val { font-size: 22px; } }

  /* Main two-column layout */
  .main { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
  @media (max-width: 768px) { .main { grid-template-columns: 1fr; } }

  .panel {
    background: #13161D; border: 1px solid #1E222B; border-radius: 14px;
    padding: clamp(20px, 2vw, 28px); position: relative; overflow: hidden;
    transition: border-color .2s, box-shadow .2s;
  }
  .panel::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: #1E222B;
  }
  .panel:hover { border-color: #252A34; box-shadow: 0 4px 20px rgba(0,0,0,.15); }
  .panel h2 {
    font-size: 13px; font-weight: 700; color: #8B95A5;
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px;
    padding-left: 12px; border-left: 3px solid #4B8BF5; line-height: 1;
    padding-top: 1px; padding-bottom: 1px;
  }
  /* Panel accent colors */
  .panel-recip::before { background: linear-gradient(90deg, #4B8BF5, #4B8BF500); }
  .panel-recip h2 { border-left-color: #4B8BF5; }
  .panel-compose::before { background: linear-gradient(90deg, #F22F46, #F22F4600); }
  .panel-raffle::before { background: linear-gradient(90deg, #E8853A, #E8853A00); }
  .panel-history::before { background: linear-gradient(90deg, #E8853A, #E8853A00); }
  .panel-leads::before { background: linear-gradient(90deg, #9B6FE8, #9B6FE800); }
  .panel-leads h2 { border-left-color: #9B6FE8; }

  /* User list */
  .toolbar {
    display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap;
    padding: 8px 12px; background: #0B0D11; border-radius: 10px; border: 1px solid #1E222B;
  }
  .toolbar label {
    font-size: 13px; color: #8B95A5; display: flex; align-items: center; gap: 6px; cursor: pointer;
    font-weight: 500;
  }
  .toolbar label input { accent-color: #4B8BF5; cursor: pointer; }
  .sel-count { font-size: 13px; color: #4B8BF5; font-weight: 600; }

  .user-list {
    max-height: 520px; overflow-y: auto;
    background: #0B0D11; border: 1px solid #1E222B; border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: #252A34 #0B0D11;
  }
  .user-list::-webkit-scrollbar { width: 6px; }
  .user-list::-webkit-scrollbar-track { background: #0B0D11; border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb { background: #252A34; border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb:hover { background: #2A3040; }
  .urow {
    display: flex; align-items: center; gap: 10px; padding: 11px 16px;
    border-bottom: 1px solid #1A1E27; font-size: 13px;
    transition: background .15s;
  }
  .urow:last-child { border-bottom: none; }
  .urow:hover { background: #13161D; }
  .urow.winner { background: #E8853A0A; border-left: 3px solid #E8853A; }
  .urow input[type=checkbox] { accent-color: #4B8BF5; cursor: pointer; flex-shrink: 0; }
  .urow .trophy { font-size: 14px; flex-shrink: 0; width: 18px; text-align: center; }
  .uphone { font-family: "SF Mono", "Fira Code", monospace; color: #B0B8C4; min-width: 110px; font-size: 13px; }
  .ucnt { color: #8B95A5; min-width: 55px; font-size: 12px; font-weight: 500; }
  .ustyles { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  .upill { font-size: 10px; padding: 3px 9px; border-radius: 10px; color: #fff; white-space: nowrap; font-weight: 600; letter-spacing: .2px; }
  .utime { color: #4D5562; font-size: 11px; min-width: 50px; text-align: right; flex-shrink: 0; }

  /* Actions panel */
  .act-section { margin-bottom: 24px; }
  .act-section:last-child { margin-bottom: 0; }
  .act-section h3 {
    font-size: 11px; font-weight: 700; color: #8B95A5;
    text-transform: uppercase; letter-spacing: .8px; margin-bottom: 14px;
    padding-left: 12px; border-left: 3px solid #4D5562; line-height: 1;
    padding-top: 1px; padding-bottom: 1px;
  }
  .act-compose h3 { border-left-color: #F22F46; }
  .act-raffle h3 { border-left-color: #E8853A; }
  .act-history h3 { border-left-color: #E8853A; }
  .compose-ta {
    width: 100%; background: #0B0D11; border: 1px solid #1E222B; border-radius: 10px;
    color: #B0B8C4; padding: 14px 16px; font-size: 14px; font-family: inherit;
    resize: vertical; min-height: 90px; transition: border-color .15s, box-shadow .15s;
    line-height: 1.5;
  }
  .compose-ta:focus { outline: none; border-color: #F22F46; box-shadow: 0 0 0 3px rgba(242,47,70,.1); }
  .compose-ta::placeholder { color: #4D5562; }
  .btn-send {
    width: 100%; margin-top: 12px; background: #F22F46; color: #fff; border: none;
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, transform .1s, box-shadow .15s;
    letter-spacing: .2px;
  }
  .btn-send:hover { background: #D42840; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(242,47,70,.25); }
  .btn-send:active { transform: translateY(0); box-shadow: none; }
  .btn-send:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }

  .btn-raffle {
    width: 100%; background: #E8853A10; color: #E8853A; border: 1px solid #E8853A33;
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
    letter-spacing: .2px;
  }
  .btn-raffle:hover { background: #E8853A20; border-color: #E8853A; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(232,133,58,.2); }
  .btn-raffle:active { transform: translateY(0); box-shadow: none; }
  .raffle-display {
    margin-top: 12px; padding: 12px 16px; border-radius: 10px;
    font-size: 13px; display: none;
  }
  .raffle-display.show { display: block; background: #E8853A0C; color: #E8853A; border: 1px solid #E8853A28; }

  .winner-list { display: flex; flex-direction: column; gap: 6px; }
  .winner-entry {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: #0B0D11; border: 1px solid #1E222B; border-radius: 10px; font-size: 13px;
    transition: border-color .15s;
  }
  .winner-entry:hover { border-color: #252A34; }
  .winner-entry .w-icon { font-size: 14px; }
  .winner-entry .w-phone { font-family: "SF Mono", "Fira Code", monospace; color: #B0B8C4; flex: 1; font-size: 13px; }
  .winner-entry .w-event { color: #636B78; font-size: 11px; }
  .winner-entry .w-time { color: #4D5562; font-size: 11px; }
  .no-data { color: #4D5562; font-size: 13px; padding: 16px 0; }

  /* Lead capture */
  .lead-stat { display: flex; align-items: baseline; gap: 10px; margin-bottom: 16px; }
  .lead-stat .val { font-size: 32px; font-weight: 700; color: #9B6FE8; font-variant-numeric: tabular-nums; }
  .lead-stat .lbl { font-size: 13px; color: #636B78; }
  .btn-export {
    width: 100%; background: #9B6FE810; color: #9B6FE8; border: 1px solid #9B6FE833;
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    text-decoration: none; letter-spacing: .2px;
  }
  .btn-export:hover { background: #9B6FE820; border-color: #9B6FE8; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(155,111,232,.2); }
  .btn-export:active { transform: translateY(0); box-shadow: none; }
  .btn-export svg { width: 16px; height: 16px; flex-shrink: 0; }
  .lead-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  .lead-table th {
    text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600;
    color: #636B78; text-transform: uppercase; letter-spacing: .5px;
    border-bottom: 2px solid #1E222B; background: #0B0D11;
    position: sticky; top: 0; z-index: 1;
  }
  .lead-table td { padding: 8px 12px; color: #B0B8C4; border-bottom: 1px solid #1A1E27; }
  .lead-table tr:last-child td { border-bottom: none; }
  .lead-table tr:hover td { background: #13161D; }
  .lead-table-wrap {
    max-height: 320px; overflow-y: auto;
    background: #0B0D11; border: 1px solid #1E222B; border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: #252A34 #0B0D11;
  }
  .lead-table-wrap::-webkit-scrollbar { width: 6px; }
  .lead-table-wrap::-webkit-scrollbar-track { background: #0B0D11; border-radius: 3px; }
  .lead-table-wrap::-webkit-scrollbar-thumb { background: #252A34; border-radius: 3px; }

  .result-msg {
    font-size: 13px; padding: 10px 14px; border-radius: 10px; margin-top: 12px; display: none;
    font-weight: 500;
  }
  .result-msg.success { display: block; background: #2EBA540C; color: #2EBA54; border: 1px solid #2EBA5428; }
  .result-msg.error { display: block; background: #E044440C; color: #F22F46; border: 1px solid #E0444428; }

  .footer {
    text-align: center; color: #4D5562; font-size: 12px; font-weight: 500;
    margin-top: 48px; padding: 24px 0 8px;
    border-top: 1px solid #1E222B; letter-spacing: .3px;
  }
</style>
</head>
<body>
<div class="wrap">

<div class="hdr">
  <h1>Outreach</h1>
  <div class="hdr-controls">
    <div class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;opacity:.5"><circle cx="12" cy="12" r="10"/></svg><select id="evSel" onchange="onEventChange()"></select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;opacity:.4"><polyline points="6 9 12 15 18 9"/></svg></div>
    <a href="/home/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="val" id="statRecip">--</div><div class="lbl">Recipients</div></div>
  <div class="stat"><div class="val" id="statSel">0</div><div class="lbl">Selected</div></div>
  <div class="stat"><div class="val" id="statWinners">0</div><div class="lbl">Raffle Winners</div></div>
</div>

<div class="section-group">
  <div class="section-label">Messaging</div>
<div class="main">
  <!-- Left: User List -->
  <div class="panel panel-recip">
    <h2>Recipients</h2>
    <div class="toolbar">
      <label><input type="checkbox" id="selAll" onchange="toggleSelectAll()"> Select All</label>
      <span class="sel-count" id="selCount"></span>
    </div>
    <div class="user-list" id="userList"></div>
  </div>

  <!-- Right: Actions -->
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="panel panel-compose">
      <div class="act-section act-compose">
        <h3>Compose Message</h3>
        <textarea class="compose-ta" id="msgBox" placeholder="Type a message to send to selected recipients..."></textarea>
        <button class="btn-send" id="sendBtn" onclick="sendBroadcast()">Send Message</button>
        <div class="result-msg" id="sendResult"></div>
      </div>
    </div>

    <div class="panel panel-raffle">
      <div class="act-section act-raffle">
        <h3>Pick a Winner</h3>
        <button class="btn-raffle" onclick="pickWinner()">Draw Winner</button>
        <div class="raffle-display" id="raffleDisplay"></div>
      </div>
    </div>

    <div class="panel panel-history">
      <div class="act-section act-history">
        <h3>Raffle History</h3>
        <div class="winner-list" id="winnerList"></div>
      </div>
    </div>
  </div>
</div>
</div><!-- /.section-group -->

<div class="section-group">
  <div class="section-label">Lead Capture</div>
<div class="panel panel-leads">
  <h2>Lead Capture</h2>
  <div class="lead-stat"><span class="val" id="statLeads">--</span><span class="lbl">Leads captured for this event</span></div>
  <a class="btn-export" id="exportBtn" href="#" onclick="exportLeads();return false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    Download Report (CSV)
  </a>
  <div class="lead-table-wrap" style="margin-top:16px">
    <table class="lead-table">
      <thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Title</th><th>Country</th></tr></thead>
      <tbody id="leadTableBody"><tr><td colspan="5" class="no-data">Loading...</td></tr></tbody>
    </table>
  </div>
</div>
</div><!-- /.section-group -->

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
  fetchLeads();
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
    fetchLeads();
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

async function fetchLeads() {
  try {
    var r = await fetch("api/leads" + evParam());
    var data = await r.json();
    document.getElementById("statLeads").textContent = data.length;
    var tbody = document.getElementById("leadTableBody");
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="no-data">No leads captured yet</td></tr>';
      return;
    }
    var html = "";
    for (var l of data) {
      html += "<tr>"
        + "<td>" + esc(l.firstName) + " " + esc(l.lastName) + "</td>"
        + "<td>" + esc(l.email) + "</td>"
        + "<td>" + esc(l.company) + "</td>"
        + "<td>" + esc(l.jobTitle) + "</td>"
        + "<td>" + esc(l.country) + "</td>"
        + "</tr>";
    }
    tbody.innerHTML = html;
  } catch(e) { console.error(e); }
}

function esc(s) {
  if (!s) return "";
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function exportLeads() {
  var ev = selectedEvent || "all";
  window.location.href = "api/leads/export?event=" + encodeURIComponent(ev);
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
    const jobEvents = jobs.map((j) => j.eventName).filter(Boolean);
    let dlEvents = [];
    try {
        const dlRoot = path.join(__dirname, "..", "downloads");
        dlEvents = fs.readdirSync(dlRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch {}
    const events = [...new Set([...jobEvents, ...dlEvents])].sort();
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

// ── Leads API ────────────────────────────────────────────────────────────────

router.get("/api/leads", (req, res) => {
    const event = req.query.event;
    const eventFilter = event && event !== "all" ? event : null;
    const allLeads = eventFilter ? leads.getLeads(eventFilter) : leads.getLeads(null);
    // Sort by most recent first
    allLeads.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    res.json(allLeads.map((l) => ({
        firstName: l.firstName || "",
        lastName: l.lastName || "",
        email: l.email || "",
        company: l.company || "",
        jobTitle: l.jobTitle || "",
        country: l.country || "",
        phone: maskPhone(l.phone || ""),
        completedAt: l.completedAt || 0,
    })));
});

router.get("/api/leads/export", (req, res) => {
    const event = req.query.event;
    const eventFilter = event && event !== "all" ? event : null;
    const allLeads = eventFilter ? leads.getLeads(eventFilter) : leads.getLeads(null);
    allLeads.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    const headers = ["First Name", "Last Name", "Email", "Company", "Job Title", "Country", "Phone", "Date"];
    const rows = allLeads.map((l) => [
        l.firstName || "",
        l.lastName || "",
        l.email || "",
        l.company || "",
        l.jobTitle || "",
        l.country || "",
        l.phone || "",
        l.completedAt ? new Date(l.completedAt).toISOString().split("T")[0] : "",
    ]);

    // Build CSV
    const escapeCsv = (val) => {
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };
    const csv = [headers.map(escapeCsv).join(",")]
        .concat(rows.map((r) => r.map(escapeCsv).join(",")))
        .join("\n");

    const filename = `leads-${eventFilter || "all-events"}-${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
});

// Mount function
function mountOutreach(app) {
    loadRaffle();
    app.use("/outreach", router);
    console.log("📨 Outreach mounted at /outreach");
}

module.exports = { mountOutreach };
