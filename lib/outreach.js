const fs = require("fs");
const path = require("path");
const express = require("express");
const { DONE_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, FAILED_DIR } = require("./config");
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
  html { font-size: clamp(15px, 1.2vw, 19px); }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1219; color: #b8c0cc; min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
    scrollbar-width: thin; scrollbar-color: #2e3744 #0f1219;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }

  /* Section group dividers */
  .section-group { margin-bottom: clamp(20px, 2.5vw, 32px); }
  .section-label {
    font-size: 11px; font-weight: 700; color: #6b7585;
    text-transform: uppercase; letter-spacing: 1.5px;
    padding: 0 0 14px 0;
    display: flex; align-items: center; gap: 12px;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: #252d3a; }

  /* Header */
  .hdr {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: clamp(20px, 2.5vw, 32px); padding-bottom: clamp(14px, 1.5vw, 20px);
    border-bottom: 1px solid #252d3a;
    gap: 16px; flex-wrap: wrap;
  }
  .hdr h1 {
    font-size: clamp(20px, 1.6vw, 28px); font-weight: 700; color: #edf0f5;
    letter-spacing: -0.3px; padding-top: 6px;
  }
  .hdr-controls {
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

  /* Stat cards */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: clamp(20px, 2.5vw, 32px); }
  .stat {
    background: linear-gradient(145deg, #1a2030, #171c25); border: 1px solid #252d3a; border-top: 3px solid #252d3a;
    border-radius: 16px; padding: 22px 22px; position: relative; overflow: hidden;
    transition: border-color .2s, transform .2s ease, box-shadow .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
  }
  .stat::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 50px;
    background: linear-gradient(180deg, rgba(255,255,255,.02) 0%, transparent 100%);
    pointer-events: none;
  }
  .stat:hover { border-color: #364050; transform: translateY(-2px); box-shadow: 0 6px 24px rgba(0,0,0,.25); }
  .stat:nth-child(1) { border-top-color: #6199f5; }
  .stat:nth-child(2) { border-top-color: #3cc968; }
  .stat:nth-child(3) { border-top-color: #f0983a; }
  .stat:nth-child(1)::before { background: linear-gradient(180deg, rgba(75,139,245,.06) 0%, transparent 100%); }
  .stat:nth-child(2)::before { background: linear-gradient(180deg, rgba(46,186,84,.06) 0%, transparent 100%); }
  .stat:nth-child(3)::before { background: linear-gradient(180deg, rgba(232,133,58,.06) 0%, transparent 100%); }
  .stat .val { font-size: clamp(26px, 2.4vw, 40px); font-weight: 700; color: #edf0f5; font-variant-numeric: tabular-nums; position: relative; }
  .stat .lbl { font-size: 12px; color: #6b7585; text-transform: uppercase; letter-spacing: .6px; font-weight: 500; margin-top: 4px; position: relative; }
  @media (max-width: 540px) { .stats { grid-template-columns: 1fr 1fr 1fr; } .stat .val { font-size: 22px; } }

  /* Main two-column layout */
  .main { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
  @media (max-width: 768px) { .main { grid-template-columns: 1fr; } }

  .panel {
    background: linear-gradient(160deg, #1a2030, #171c25); border: 1px solid #252d3a; border-radius: 16px;
    padding: clamp(22px, 2.2vw, 32px); position: relative; overflow: hidden;
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
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px;
    padding-left: 12px; border-left: 3px solid #6199f5; line-height: 1;
    padding-top: 1px; padding-bottom: 1px;
  }
  /* Panel accent colors */
  .panel-recip::before { background: linear-gradient(90deg, #6199f5, #6199f500); }
  .panel-recip h2 { border-left-color: #6199f5; }
  .panel-compose::before { background: linear-gradient(90deg, #F22F46, #F22F4600); }
  .panel-raffle::before { background: linear-gradient(90deg, #f0983a, #f0983a00); }
  .panel-history::before { background: linear-gradient(90deg, #f0983a, #f0983a00); }
  .panel-leads::before { background: linear-gradient(90deg, #a87fee, #a87fee00); }
  .panel-leads h2 { border-left-color: #a87fee; }

  /* User list */
  .toolbar {
    display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap;
    padding: 8px 12px; background: #0f1219; border-radius: 10px; border: 1px solid #252d3a;
  }
  .toolbar label {
    font-size: 13px; color: #94a0b0; display: flex; align-items: center; gap: 6px; cursor: pointer;
    font-weight: 500;
  }
  .toolbar label input { accent-color: #6199f5; cursor: pointer; }
  .sel-count { font-size: 13px; color: #6199f5; font-weight: 600; }

  .user-list {
    max-height: 520px; overflow-y: auto;
    background: #0f1219; border: 1px solid #252d3a; border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: #2e3744 #0f1219;
  }
  .user-list::-webkit-scrollbar { width: 6px; }
  .user-list::-webkit-scrollbar-track { background: #0f1219; border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb { background: #2e3744; border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb:hover { background: #364050; }
  .urow {
    display: flex; align-items: center; gap: 10px; padding: 11px 16px;
    border-bottom: 1px solid #1c2230; font-size: 13px;
    transition: background .15s;
  }
  .urow:last-child { border-bottom: none; }
  .urow:hover { background: #171c25; }
  .urow.winner { background: #f0983a0A; border-left: 3px solid #f0983a; }
  .urow input[type=checkbox] { accent-color: #6199f5; cursor: pointer; flex-shrink: 0; }
  .urow .trophy { font-size: 14px; flex-shrink: 0; width: 18px; text-align: center; }
  .uphone { font-family: "SF Mono", "Fira Code", monospace; color: #b8c0cc; min-width: 110px; font-size: 13px; }
  .ucnt { color: #94a0b0; min-width: 55px; font-size: 12px; font-weight: 500; }
  .ustyles { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  .upill { font-size: 10px; padding: 3px 9px; border-radius: 10px; color: #fff; white-space: nowrap; font-weight: 600; letter-spacing: .2px; }
  .utime { color: #525c6c; font-size: 11px; min-width: 50px; text-align: right; flex-shrink: 0; }

  /* Actions panel */
  .act-section { margin-bottom: 24px; }
  .act-section:last-child { margin-bottom: 0; }
  .act-section h3 {
    font-size: 11px; font-weight: 700; color: #94a0b0;
    text-transform: uppercase; letter-spacing: .8px; margin-bottom: 14px;
    padding-left: 12px; border-left: 3px solid #525c6c; line-height: 1;
    padding-top: 1px; padding-bottom: 1px;
  }
  .act-compose h3 { border-left-color: #F22F46; }
  .act-raffle h3 { border-left-color: #f0983a; }
  .act-history h3 { border-left-color: #f0983a; }
  .compose-ta {
    width: 100%; background: #0f1219; border: 1px solid #252d3a; border-radius: 10px;
    color: #b8c0cc; padding: 14px 16px; font-size: 14px; font-family: inherit;
    resize: vertical; min-height: 90px; transition: border-color .15s, box-shadow .15s;
    line-height: 1.5;
  }
  .compose-ta:focus { outline: none; border-color: #F22F46; box-shadow: 0 0 0 3px rgba(242,47,70,.1); }
  .compose-ta::placeholder { color: #525c6c; }
  .btn-send {
    width: 100%; margin-top: 12px; background: linear-gradient(135deg, #F22F46, #e0283e); color: #fff; border: none;
    border-radius: 12px; padding: 13px 18px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: all .2s ease;
    letter-spacing: .2px; box-shadow: 0 2px 8px rgba(242,47,70,.2);
  }
  .btn-send:hover { background: linear-gradient(135deg, #ff3a52, #F22F46); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(242,47,70,.3); }
  .btn-send:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(242,47,70,.15); }
  .btn-send:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }

  .btn-raffle {
    width: 100%; background: #f0983a10; color: #f0983a; border: 1px solid #f0983a33;
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
    letter-spacing: .2px;
  }
  .btn-raffle:hover { background: #f0983a20; border-color: #f0983a; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(232,133,58,.2); }
  .btn-raffle:active { transform: translateY(0); box-shadow: none; }
  .raffle-display {
    margin-top: 12px; padding: 12px 16px; border-radius: 10px;
    font-size: 13px; display: none;
  }
  .raffle-display.show { display: block; background: #f0983a0C; color: #f0983a; border: 1px solid #f0983a28; }

  .winner-list { display: flex; flex-direction: column; gap: 6px; }
  .winner-entry {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: #0f1219; border: 1px solid #252d3a; border-radius: 10px; font-size: 13px;
    transition: border-color .15s;
  }
  .winner-entry:hover { border-color: #2e3744; }
  .winner-entry .w-icon { font-size: 14px; }
  .winner-entry .w-phone { font-family: "SF Mono", "Fira Code", monospace; color: #b8c0cc; flex: 1; font-size: 13px; }
  .winner-entry .w-event { color: #6b7585; font-size: 11px; }
  .winner-entry .w-time { color: #525c6c; font-size: 11px; }
  .no-data { color: #525c6c; font-size: 13px; padding: 16px 0; }

  /* Lead capture */
  .lead-stat { display: flex; align-items: baseline; gap: 10px; margin-bottom: 16px; }
  .lead-stat .val { font-size: 32px; font-weight: 700; color: #a87fee; font-variant-numeric: tabular-nums; }
  .lead-stat .lbl { font-size: 13px; color: #6b7585; }
  .btn-export {
    width: 100%; background: #a87fee10; color: #a87fee; border: 1px solid #a87fee33;
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    text-decoration: none; letter-spacing: .2px;
  }
  .btn-export:hover { background: #a87fee20; border-color: #a87fee; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(155,111,232,.2); }
  .btn-export:active { transform: translateY(0); box-shadow: none; }
  .btn-export svg { width: 16px; height: 16px; flex-shrink: 0; }
  .lead-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  .lead-table th {
    text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600;
    color: #6b7585; text-transform: uppercase; letter-spacing: .5px;
    border-bottom: 2px solid #252d3a; background: #0f1219;
    position: sticky; top: 0; z-index: 1;
  }
  .lead-table td { padding: 8px 12px; color: #b8c0cc; border-bottom: 1px solid #1c2230; }
  .lead-table tr:last-child td { border-bottom: none; }
  .lead-table tbody tr:nth-child(even) td { background: rgba(255,255,255,.015); }
  .lead-table tr:hover td { background: #171c25; }
  .lead-table-wrap {
    max-height: 320px; overflow-y: auto;
    background: #0f1219; border: 1px solid #252d3a; border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: #2e3744 #0f1219;
  }
  .lead-table-wrap::-webkit-scrollbar { width: 6px; }
  .lead-table-wrap::-webkit-scrollbar-track { background: #0f1219; border-radius: 3px; }
  .lead-table-wrap::-webkit-scrollbar-thumb { background: #2e3744; border-radius: 3px; }

  .btn-delete {
    padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(242,47,70,0.2);
    background: transparent; color: #F22F46; font-size: 12px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: all .15s; margin-left: auto;
    display: none; align-items: center; gap: 5px;
  }
  .btn-delete:hover { background: rgba(242,47,70,0.08); border-color: rgba(242,47,70,0.4); }
  .btn-delete.visible { display: inline-flex; }
  .btn-delete svg { width: 13px; height: 13px; }

  .result-msg {
    font-size: 13px; padding: 10px 14px; border-radius: 10px; margin-top: 12px; display: none;
    font-weight: 500;
  }
  .result-msg.success { display: block; background: #3cc9680C; color: #3cc968; border: 1px solid #3cc96828; }
  .result-msg.error { display: block; background: #E044440C; color: #F22F46; border: 1px solid #E0444428; }

  .footer {
    text-align: center; color: #525c6c; font-size: 12px; font-weight: 500;
    margin-top: 48px; padding: 24px 0 8px;
    border-top: 1px solid #252d3a; letter-spacing: .3px;
  }
</style>
</head>
<body>
<div class="wrap">

<div id="reviewNotify" style="display:none;background:linear-gradient(90deg,#f0983a,#F22F46);color:#fff;padding:12px 20px;border-radius:10px;margin-bottom:16px;font-size:14px;font-weight:600;align-items:center;justify-content:space-between;animation:rn-pulse 2s ease-in-out infinite">
  <span id="reviewNotifyText"></span>
  <a href="/dashboard/" style="color:#fff;background:rgba(0,0,0,.25);padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;white-space:nowrap">Go to Dashboard</a>
</div>
<style>
  @keyframes rn-pulse { 0%,100%{opacity:1} 50%{opacity:.85} }
</style>

<div class="hdr">
  <h1>Outreach</h1>
  <div class="hdr-controls">
    <div class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;opacity:.5"><circle cx="12" cy="12" r="10"/></svg><select id="evSel" onchange="onEventChange()"></select><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;opacity:.4"><polyline points="6 9 12 15 18 9"/></svg></div>
    <a href="/dashboard/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>Dashboard</a>
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
      <input type="text" id="userSearch" placeholder="Search users..." oninput="filterUsers()" style="flex:1;min-width:120px;padding:6px 12px;border-radius:8px;border:1px solid #252d3a;background:#0f1219;color:#b8c0cc;font-size:13px;font-family:inherit;outline:none;transition:border-color .2s" onfocus="this.style.borderColor='#6199f5'" onblur="this.style.borderColor='#252d3a'">
      <button class="btn-delete" id="deleteBtn" onclick="deleteSelectedUsers()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete</button>
    </div>
    <div class="user-list" id="userList"></div>
  </div>

  <!-- Right: Actions -->
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="panel panel-compose">
      <div class="act-section act-compose">
        <h3>Compose Message</h3>
        <textarea class="compose-ta" id="msgBox" placeholder="Type a message to send to selected recipients..." oninput="updateCharCount()"></textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
          <span id="charCount" style="font-size:12px;color:#525c6c">0 characters</span>
          <span style="font-size:11px;color:#525c6c">SMS: 160 chars/segment</span>
        </div>
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
  cartoon: "#6199f5", "pop-art": "#f0983a", watercolor: "#a87fee",
  anime: "#f07aab", sketch: "#94a0b0", "pixel-art": "#3cc968",
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
      const c = STYLE_COLORS[s] || "#6199f5";
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
  const delBtn = document.getElementById("deleteBtn");
  delBtn.className = checked > 0 ? "btn-delete visible" : "btn-delete";
}

function getSelectedIds() {
  return [...document.querySelectorAll(".ucb:checked")].map(cb => parseInt(cb.dataset.id));
}

function updateCharCount() {
  var len = document.getElementById("msgBox").value.length;
  var segments = Math.ceil(len / 160) || 1;
  var el = document.getElementById("charCount");
  el.textContent = len + " character" + (len === 1 ? "" : "s") + (len > 160 ? " (" + segments + " SMS segments)" : "");
  el.style.color = len > 160 ? "#f0983a" : "#525c6c";
}

function filterUsers() {
  var q = document.getElementById("userSearch").value.toLowerCase().trim();
  document.querySelectorAll(".urow").forEach(function(row) {
    var text = row.textContent.toLowerCase();
    row.style.display = !q || text.includes(q) ? "" : "none";
  });
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
    if (row) row.style.background = "#f0983a18";
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

async function deleteSelectedUsers() {
  const ids = getSelectedIds();
  if (!ids.length) return;
  const count = ids.length;
  const msg = "Are you sure you want to delete " + count + " user" + (count === 1 ? "" : "s") + "?\\n\\nThis will permanently remove their:\\n- Job history and queue entries\\n- Generated images\\n- Lead capture data\\n\\nThis action cannot be undone.";
  if (!confirm(msg)) return;
  const btn = document.getElementById("deleteBtn");
  btn.disabled = true;
  btn.innerHTML = "Deleting...";
  try {
    const r = await fetch("api/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, event: selectedEvent }),
    });
    const d = await r.json();
    if (d.error) {
      alert("Delete failed: " + d.error);
    } else {
      fetchUsers();
      fetchLeads();
    }
  } catch (e) {
    alert("Delete failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete';
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

// Review notification polling
(function() {
  var el = document.getElementById("reviewNotify");
  var txt = document.getElementById("reviewNotifyText");
  if (!el || !txt) return;
  function poll() {
    fetch("/dashboard/api/review-count").then(function(r){return r.json()}).then(function(d) {
      if (d.count > 0) {
        txt.textContent = d.count + " image" + (d.count === 1 ? "" : "s") + " pending review";
        el.style.display = "flex";
      } else {
        el.style.display = "none";
      }
    }).catch(function(){});
  }
  poll();
  setInterval(poll, 5000);
})();
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

// ── Delete User ──────────────────────────────────────────────────────────────

router.delete("/api/users", (req, res) => {
    const { ids, event } = req.body || {};
    if (!ids || !ids.length) {
        return res.status(400).json({ error: "ids are required" });
    }

    const users = buildUserDirectory(event);
    const byId = new Map(users.map((u) => [u.id, u]));
    const queueDirs = [DONE_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, FAILED_DIR];
    let deletedJobs = 0;
    let deletedLeads = 0;
    let deletedImages = 0;

    for (const id of ids) {
        const user = byId.get(id);
        if (!user) continue;
        const phone = user.phone;

        // Collect file prefixes from jobs before deleting, so we can delete images
        const filePrefixes = new Set();

        // Delete job files from all queue directories
        for (const dir of queueDirs) {
            try {
                const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
                for (const f of files) {
                    try {
                        const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                        if (job.userPhone === phone) {
                            if (job.filePrefix) filePrefixes.add(job.filePrefix);
                            fs.unlinkSync(path.join(dir, f));
                            deletedJobs++;
                        }
                    } catch {}
                }
            } catch {}
        }

        // Delete image files from downloads using collected prefixes
        if (filePrefixes.size > 0) {
            try {
                const dlRoot = path.join(__dirname, "..", "downloads");
                const eventDirs = fs.readdirSync(dlRoot, { withFileTypes: true })
                    .filter((d) => d.isDirectory())
                    .map((d) => d.name);
                for (const ev of eventDirs) {
                    const evDir = path.join(dlRoot, ev);
                    try {
                        const files = fs.readdirSync(evDir);
                        for (const f of files) {
                            for (const prefix of filePrefixes) {
                                if (f.startsWith(prefix)) {
                                    try { fs.unlinkSync(path.join(evDir, f)); deletedImages++; } catch {}
                                    break;
                                }
                            }
                        }
                    } catch {}
                }
            } catch {}
        }

        // Delete leads
        deletedLeads += leads.deleteByPhone(phone);
    }

    // Rebuild usage cache
    const { buildUsageCache } = require("./queue");
    buildUsageCache();

    console.log(`🗑️  Deleted ${ids.length} user(s): ${deletedJobs} jobs, ${deletedLeads} leads, ${deletedImages} images removed`);
    res.json({ deleted: ids.length, deletedJobs, deletedLeads, deletedImages });
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
