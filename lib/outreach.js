const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const { DONE_DIR, PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR, FAILED_DIR } = require("./config");
const settings = require("./settings");
const { sendSms } = require("./helpers");
const leads = require("./leads");
const kioskSubmissions = require("./kiosk-submissions");
const contacts = require("./contacts");
const { userBarSnippet, magicHatSnippet } = require("./auth");

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

let _writeCounter = 0;
function saveRaffle() {
    try {
        const tmp = RAFFLE_FILE + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmp, JSON.stringify(raffleHistory, null, 2), "utf-8");
        fs.renameSync(tmp, RAFFLE_FILE);
    } catch (err) {
        console.error("Failed to save raffle history:", err);
    }
}

// Helper functions — async stale-while-revalidate cache for job reads
const _outreachJobsCache = new Map();
const _OUTREACH_CACHE_TTL = 30_000;

function _refreshOutreachJobs(dir) {
    if (_outreachJobsCache.get(dir + ":pending")) return; // dedup
    _outreachJobsCache.set(dir + ":pending", true);
    (async () => {
        try {
            const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
            const jobs = [];
            for (const f of files) {
                try {
                    const data = await fsp.readFile(path.join(dir, f), "utf-8");
                    const job = JSON.parse(data);
                    if (job) jobs.push(job);
                } catch {}
            }
            _outreachJobsCache.set(dir, { jobs, ts: Date.now() });
        } catch {}
        _outreachJobsCache.delete(dir + ":pending");
    })();
}

function readJobs(dir) {
    const cached = _outreachJobsCache.get(dir);
    const now = Date.now();
    if (cached && (now - cached.ts) < _OUTREACH_CACHE_TTL) return cached.jobs;
    _refreshOutreachJobs(dir);
    return cached ? cached.jobs : [];
}

// Pre-warm
_refreshOutreachJobs(DONE_DIR);
_refreshOutreachJobs(PENDING_DIR);
_refreshOutreachJobs(GENERATING_DIR);
_refreshOutreachJobs(REVIEW_DIR);
_refreshOutreachJobs(READY_DIR);
_refreshOutreachJobs(PRINTING_DIR);

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
<html lang="en" data-theme="dark">
<head>
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Outreach — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(15px, 1.2vw, 19px); }
  body {
    background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
    scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-bg);
  }
  .wrap { max-width: 1200px; margin: 0 auto; }

  /* Section group dividers */
  .section-group { margin-bottom: clamp(20px, 2.5vw, 32px); }
  .section-label {
    font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1.5px;
    padding: 0 0 14px 0;
    display: flex; align-items: center; gap: 12px;
    font-family: 'Twilio Sans Mono', monospace;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: var(--th-card-border); }

  /* Header */
  .hdr {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: clamp(20px, 2.5vw, 32px); padding-bottom: clamp(14px, 1.5vw, 20px);
    border-bottom: 1px solid var(--th-card-border);
    gap: 16px; flex-wrap: wrap;
  }
  .hdr h1 {
    font-size: clamp(20px, 1.6vw, 28px); font-weight: 700; color: var(--th-text);
    letter-spacing: -0.3px; padding-top: 6px;
  }
  .hdr-controls {
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

  /* Stat cards */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: clamp(20px, 2.5vw, 32px); }
  .stat {
    background: linear-gradient(145deg, var(--th-card), var(--th-card)); border: 1px solid var(--th-card-border); border-top: 3px solid var(--th-card-border);
    border-radius: 16px; padding: 22px 22px; position: relative; overflow: hidden;
    transition: border-color .2s, transform .2s ease, box-shadow .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
  }
  .stat::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 50px;
    background: linear-gradient(180deg, rgba(255,255,255,.02) 0%, transparent 100%);
    pointer-events: none;
  }
  .stat:hover { border-color: var(--th-input-border); transform: translateY(-2px); box-shadow: 0 6px 24px rgba(0,0,0,.25); }
  .stat:nth-child(1) { border-top-color: var(--blue-400); }
  .stat:nth-child(2) { border-top-color: var(--blue-400); }
  .stat:nth-child(3) { border-top-color: var(--blue-300); }
  .stat:nth-child(4) { border-top-color: var(--brand-red); }
  .stat:nth-child(1)::before { background: linear-gradient(180deg, rgba(75,139,245,.06) 0%, transparent 100%); }
  .stat:nth-child(2)::before { background: linear-gradient(180deg, rgba(75,139,245,.06) 0%, transparent 100%); }
  .stat:nth-child(3)::before { background: linear-gradient(180deg, rgba(75,139,245,.06) 0%, transparent 100%); }
  .stat:nth-child(4)::before { background: linear-gradient(180deg, rgba(239,34,58,.06) 0%, transparent 100%); }
  .stat .val { font-size: clamp(26px, 2.4vw, 40px); font-weight: 800; color: var(--th-text); font-variant-numeric: tabular-nums; position: relative; font-family: 'Twilio Sans Display', sans-serif; }
  .stat .lbl { font-size: 12px; color: var(--th-text-muted); text-transform: uppercase; letter-spacing: .6px; font-weight: 400; margin-top: 4px; position: relative; font-family: 'Twilio Sans Mono', monospace; }
  @media (max-width: 540px) { .stats { grid-template-columns: 1fr 1fr; } .stat .val { font-size: 22px; } }

  /* Main two-column layout */
  .main { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
  @media (max-width: 768px) { .main { grid-template-columns: 1fr; } }

  .panel {
    background: linear-gradient(160deg, var(--th-card), var(--th-card)); border: 1px solid var(--th-card-border); border-radius: 16px;
    padding: clamp(22px, 2.2vw, 32px); position: relative; overflow: hidden;
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
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px;
    padding-left: 12px; border-left: 3px solid var(--blue-400); line-height: 1;
    padding-top: 1px; padding-bottom: 1px;
  }
  /* Panel accent colors */
  .panel-recip::before { background: linear-gradient(90deg, var(--blue-400), transparent); }
  .panel-recip h2 { border-left-color: var(--blue-400); }
  .panel-compose::before { background: linear-gradient(90deg, var(--brand-red), transparent); }
  .panel-raffle::before { background: linear-gradient(90deg, var(--blue-300), transparent); }
  .panel-history::before { background: linear-gradient(90deg, var(--blue-300), transparent); }
  .panel-leads::before { background: linear-gradient(90deg, var(--blue-500), transparent); }
  .panel-leads h2 { border-left-color: var(--blue-500); }

  /* User list */
  .toolbar {
    display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap;
    padding: 8px 12px; background: var(--th-bg); border-radius: 10px; border: 1px solid var(--th-card-border);
  }
  .toolbar label {
    font-size: 13px; color: var(--th-text-secondary); display: flex; align-items: center; gap: 6px; cursor: pointer;
    font-weight: 400;
  }
  .toolbar label input { accent-color: var(--blue-400); cursor: pointer; }
  .sel-count { font-size: 13px; color: var(--blue-400); font-weight: 700; }

  .user-list {
    max-height: 520px; overflow-y: auto;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-bg);
  }
  .user-list::-webkit-scrollbar { width: 6px; }
  .user-list::-webkit-scrollbar-track { background: var(--th-bg); border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb { background: var(--th-input-border); border-radius: 3px; }
  .user-list::-webkit-scrollbar-thumb:hover { background: var(--th-input-border); }
  .urow {
    display: flex; align-items: center; gap: 10px; padding: 11px 16px;
    border-bottom: 1px solid var(--th-bg-subtle); font-size: 13px;
    transition: background .15s;
  }
  .urow:last-child { border-bottom: none; }
  .urow:hover { background: var(--th-card); }
  .urow.winner { background: rgba(var(--blue-300-rgb, 58,206,250), 0.04); border-left: 3px solid var(--blue-300); }
  .urow input[type=checkbox] { accent-color: var(--blue-400); cursor: pointer; flex-shrink: 0; }
  .urow .trophy { font-size: 14px; flex-shrink: 0; width: 18px; text-align: center; }
  .uphone { font-family: 'Twilio Sans Mono', "SF Mono", "Fira Code", monospace; color: var(--th-text-dim); min-width: 110px; font-size: 13px; flex-shrink: 0; }
  .uname { color: var(--th-text); font-size: 13px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ucnt { color: var(--th-text-secondary); min-width: 55px; font-size: 12px; font-weight: 400; flex-shrink: 0; }
  .ustyles { display: flex; gap: 4px; flex-wrap: wrap; min-width: 60px; }
  .upill { font-size: 10px; padding: 3px 9px; border-radius: 10px; color: #fff; white-space: nowrap; font-weight: 700; letter-spacing: .2px; }
  .utime { color: var(--th-text-muted); font-size: 11px; min-width: 50px; text-align: right; flex-shrink: 0; }

  /* Actions panel */
  .act-section { margin-bottom: 24px; }
  .act-section:last-child { margin-bottom: 0; }
  .act-section h3 {
    font-size: 11px; font-weight: 700; color: var(--th-text-secondary);
    text-transform: uppercase; letter-spacing: .8px; margin-bottom: 14px;
    padding-left: 12px; border-left: 3px solid var(--th-text-muted); line-height: 1;
    font-family: 'Twilio Sans Mono', monospace;
    padding-top: 1px; padding-bottom: 1px;
  }
  .act-compose h3 { border-left-color: var(--brand-red); }
  .act-raffle h3 { border-left-color: var(--blue-300); }
  .act-history h3 { border-left-color: var(--blue-300); }
  .compose-ta {
    width: 100%; background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 10px;
    color: var(--th-text-dim); padding: 14px 16px; font-size: 14px; font-family: inherit;
    resize: vertical; min-height: 90px; transition: border-color .15s, box-shadow .15s;
    line-height: 1.5;
  }
  .compose-ta:focus { outline: none; border-color: var(--brand-red); box-shadow: 0 0 0 3px rgba(239,34,58,.1); }
  .compose-ta::placeholder { color: var(--th-text-muted); }
  .btn-send {
    width: 100%; margin-top: 12px; background: var(--brand-red); color: #fff; border: none;
    border-radius: 12px; padding: 13px 18px; font-size: 14px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: all .2s ease;
    letter-spacing: .2px; box-shadow: 0 2px 8px rgba(239,34,58,.2);
  }
  .btn-send:hover { background: var(--brand-red); filter: brightness(1.1); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(239,34,58,.3); }
  .btn-send:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(239,34,58,.15); }
  .btn-send:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }

  .btn-raffle {
    width: 100%; background: rgba(var(--blue-300-rgb, 58,206,250), 0.06); color: var(--blue-300); border: 1px solid rgba(var(--blue-300-rgb, 58,206,250), 0.2);
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
    letter-spacing: .2px;
  }
  .btn-raffle:hover { background: rgba(var(--blue-300-rgb, 58,206,250), 0.12); border-color: var(--blue-300); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(58,206,250,.2); }
  .btn-raffle:active { transform: translateY(0); box-shadow: none; }
  .raffle-display {
    margin-top: 12px; padding: 12px 16px; border-radius: 10px;
    font-size: 13px; display: none;
  }
  .raffle-display.show { display: block; background: rgba(var(--blue-300-rgb, 58,206,250), 0.05); color: var(--blue-300); border: 1px solid rgba(var(--blue-300-rgb, 58,206,250), 0.16); }

  .winner-list { display: flex; flex-direction: column; gap: 6px; }
  .winner-entry {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 10px; font-size: 13px;
    transition: border-color .15s;
  }
  .winner-entry:hover { border-color: var(--th-input-border); }
  .winner-entry .w-icon { font-size: 14px; }
  .winner-entry .w-phone { font-family: 'Twilio Sans Mono', "SF Mono", "Fira Code", monospace; color: var(--th-text-dim); flex: 1; font-size: 13px; }
  .winner-entry .w-event { color: var(--th-text-muted); font-size: 11px; }
  .winner-entry .w-time { color: var(--th-text-muted); font-size: 11px; }
  .no-data { color: var(--th-text-muted); font-size: 13px; padding: 16px 0; }

  /* Lead capture */
  .lead-stat { display: flex; align-items: baseline; gap: 10px; margin-bottom: 16px; }
  .lead-stat .val { font-size: 32px; font-weight: 800; color: var(--blue-500); font-variant-numeric: tabular-nums; font-family: 'Twilio Sans Display', sans-serif; }
  .lead-stat .lbl { font-size: 13px; color: var(--th-text-muted); }
  .btn-export {
    width: 100%; background: rgba(var(--blue-500-rgb, 101,78,238), 0.06); color: var(--blue-500); border: 1px solid rgba(var(--blue-500-rgb, 101,78,238), 0.2);
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    text-decoration: none; letter-spacing: .2px;
  }
  .btn-export:hover { background: rgba(var(--blue-500-rgb, 101,78,238), 0.12); border-color: var(--blue-500); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(101,78,238,.2); }
  .btn-export:active { transform: translateY(0); box-shadow: none; }
  .btn-export svg { width: 16px; height: 16px; flex-shrink: 0; }
  .lead-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  .lead-table th {
    text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 700;
    color: var(--th-text-muted); text-transform: uppercase; letter-spacing: .5px;
    border-bottom: 2px solid var(--th-card-border); background: var(--th-bg);
    font-family: 'Twilio Sans Mono', monospace;
    position: sticky; top: 0; z-index: 1;
  }
  .lead-table td { padding: 8px 12px; color: var(--th-text-dim); border-bottom: 1px solid var(--th-bg-subtle); }
  .lead-table tr:last-child td { border-bottom: none; }
  .lead-table tbody tr:nth-child(even) td { background: rgba(255,255,255,.015); }
  .lead-table tr:hover td { background: var(--th-card); }
  .lead-table-wrap {
    max-height: 320px; overflow-y: auto;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-bg);
  }
  .lead-table-wrap::-webkit-scrollbar { width: 6px; }
  .lead-table-wrap::-webkit-scrollbar-track { background: var(--th-bg); border-radius: 3px; }
  .lead-table-wrap::-webkit-scrollbar-thumb { background: var(--th-input-border); border-radius: 3px; }

  .btn-delete {
    padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(239,34,58,0.2);
    background: transparent; color: var(--brand-red); font-size: 12px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: all .15s; margin-left: auto;
    display: none; align-items: center; gap: 5px;
  }
  .btn-delete:hover { background: rgba(239,34,58,0.08); border-color: rgba(239,34,58,0.4); }
  .btn-delete.visible { display: inline-flex; }
  .btn-delete svg { width: 13px; height: 13px; }

  /* Per-row action button */
  .urow-act {
    background: none; border: none; color: var(--th-text-muted); cursor: pointer;
    padding: 4px 8px; font-size: 18px; line-height: 1; border-radius: 6px;
    transition: all .15s; margin-left: auto; flex-shrink: 0; font-family: inherit;
  }
  .urow-act:hover { background: rgba(255,255,255,0.08); color: var(--th-text-dim); }

  /* Shared user action popup */
  .urow-popup {
    display: none; position: fixed; z-index: 200;
    background: var(--th-card, #1a1e2e); border: 1px solid var(--th-card-border, rgba(255,255,255,0.12));
    border-radius: 12px; min-width: 190px; overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .urow-popup.open { display: block; }
  .urow-popup-title {
    padding: 10px 14px 6px; font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid var(--th-card-border, rgba(255,255,255,0.06));
  }
  .urow-popup button {
    display: flex; width: 100%; padding: 11px 14px; border: none; background: none;
    color: var(--th-text-dim, rgba(210,195,175,0.8)); font-family: inherit; font-size: 13px; font-weight: 600;
    text-align: left; cursor: pointer; transition: background .15s; align-items: center; gap: 8px;
  }
  .urow-popup button:hover { background: rgba(255,255,255,0.06); }
  .urow-popup button + button { border-top: 1px solid var(--th-card-border, rgba(255,255,255,0.06)); }
  .urow-popup button.destructive { color: var(--brand-red, #EF223A); }
  .urow-popup button.destructive:hover { background: rgba(239,34,58,0.08); }

  /* Delete All Leads button */
  .btn-delete-leads {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(239,34,58,0.06); color: var(--brand-red); border: 1px solid rgba(239,34,58,0.2);
    border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: all .2s;
  }
  .btn-delete-leads:hover { background: rgba(239,34,58,0.12); border-color: rgba(239,34,58,0.4); transform: translateY(-1px); }
  .btn-delete-leads:active { transform: translateY(0); }
  .btn-delete-leads svg { width: 16px; height: 16px; flex-shrink: 0; }

  /* Drop-offs */
  .panel-dropoffs::before { background: linear-gradient(90deg, var(--brand-red), transparent); }
  .panel-dropoffs h2 { border-left-color: var(--brand-red); }
  .dropoff-desc { font-size: 13px; color: var(--th-text-muted); margin-bottom: 14px; line-height: 1.5; }
  .dropoff-list {
    max-height: 400px; overflow-y: auto;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 12px;
    scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-bg);
  }
  .dropoff-list::-webkit-scrollbar { width: 6px; }
  .dropoff-list::-webkit-scrollbar-track { background: var(--th-bg); border-radius: 3px; }
  .dropoff-list::-webkit-scrollbar-thumb { background: var(--th-input-border); border-radius: 3px; }
  .drow {
    display: flex; align-items: center; gap: 12px; padding: 11px 16px;
    border-bottom: 1px solid var(--th-bg-subtle); font-size: 13px;
    transition: background .15s;
  }
  .drow:last-child { border-bottom: none; }
  .drow:hover { background: var(--th-card); }
  .drow .dphone { font-family: 'Twilio Sans Mono', "SF Mono", "Fira Code", monospace; color: var(--th-text-dim); min-width: 110px; font-size: 13px; }
  .drow .dtime { color: var(--th-text-muted); font-size: 11px; min-width: 50px; }
  .drow .dnudge-status { color: var(--th-text-muted); font-size: 11px; flex: 1; }
  .btn-nudge {
    background: rgba(239,34,58,0.06); color: var(--brand-red); border: 1px solid rgba(239,34,58,0.2);
    border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: all .15s; white-space: nowrap;
    flex-shrink: 0;
  }
  .btn-nudge:hover { background: rgba(239,34,58,0.12); border-color: rgba(239,34,58,0.4); }
  .btn-nudge:disabled { opacity: .5; cursor: default; }

  .result-msg {
    font-size: 13px; padding: 10px 14px; border-radius: 10px; margin-top: 12px; display: none;
    font-weight: 400;
  }
  .result-msg.success { display: block; background: rgba(var(--blue-400-rgb, 0,124,213), 0.05); color: var(--blue-400); border: 1px solid rgba(var(--blue-400-rgb, 0,124,213), 0.16); }
  .result-msg.error { display: block; background: rgba(239,34,58,0.05); color: var(--brand-red); border: 1px solid rgba(239,34,58,0.16); }

  .footer {
    text-align: center; color: var(--th-text-muted); font-size: 12px; font-weight: 400;
    margin-top: 48px; padding: 24px 0 8px;
    border-top: 1px solid var(--th-card-border); letter-spacing: .3px;
  }

  /* Theme toggle */
  .theme-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 10px;
    padding: 8px; cursor: pointer; color: var(--th-text-dim);
    transition: all .2s ease;
  }
  .theme-toggle:hover { color: var(--th-text); border-color: var(--th-input-border); background: var(--th-raised); }
  .theme-toggle svg { width: 16px; height: 16px; }
  [data-theme="dark"] .icon-sun { display: none; }
  [data-theme="dark"] .icon-moon { display: block; }
  [data-theme="light"] .icon-sun { display: block; }
  [data-theme="light"] .icon-moon { display: none; }
</style>
</head>
<body>
<div class="wrap">

<div id="reviewNotify" style="display:none;background:linear-gradient(90deg,var(--blue-300),var(--brand-red));color:#fff;padding:12px 20px;border-radius:10px;margin-bottom:16px;font-size:14px;font-weight:700;align-items:center;justify-content:space-between;animation:rn-pulse 2s ease-in-out infinite">
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
    <a href="/home/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Home</a>
    <a href="/dashboard/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>Dashboard</a>
    <a href="/dashboard/logs/" class="hdr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Logs</a>
    <button class="theme-toggle" onclick="toggleTheme()">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
    </button>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="val" id="statRecip">--</div><div class="lbl">Recipients</div></div>
  <div class="stat"><div class="val" id="statSel">0</div><div class="lbl">Selected</div></div>
  <div class="stat"><div class="val" id="statWinners">0</div><div class="lbl">Raffle Winners</div></div>
  <div class="stat"><div class="val" id="statDropoffs">0</div><div class="lbl">Drop-offs</div></div>
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
      <input type="text" id="userSearch" placeholder="Search users..." oninput="filterUsers()" style="flex:1;min-width:120px;padding:6px 12px;border-radius:8px;border:1px solid var(--th-card-border);background:var(--th-bg);color:var(--th-text-dim);font-size:13px;font-family:inherit;outline:none;transition:border-color .2s" onfocus="this.style.borderColor='var(--blue-400)'" onblur="this.style.borderColor='var(--th-card-border)'">
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
          <span id="charCount" style="font-size:12px;color:var(--th-text-muted)">0 characters</span>
          <span style="font-size:11px;color:var(--th-text-muted)">SMS: 160 chars/segment</span>
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
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <a class="btn-export" id="exportBtn" href="#" onclick="exportLeads();return false" style="flex:1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download Report (CSV)
    </a>
    <button class="btn-delete-leads" id="deleteLeadsBtn" onclick="deleteAllLeads()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Delete All Leads
    </button>
  </div>
  <div class="lead-table-wrap" style="margin-top:16px">
    <table class="lead-table">
      <thead><tr><th>Name</th><th>Email</th><th>Personal Email</th><th>Company</th><th>Title</th><th>Country</th></tr></thead>
      <tbody id="leadTableBody"><tr><td colspan="6" class="no-data">Loading...</td></tr></tbody>
    </table>
  </div>
</div>
</div><!-- /.section-group -->

<div class="section-group">
  <div class="section-label">Kiosk Submissions</div>
<div class="panel panel-kiosk">
  <h2>Kiosk Submissions</h2>
  <p class="dropoff-desc">Contact info captured at <code>/kiosk</code>, tied to the portrait the user generated. Use this to manually email portraits until automated email is wired up.</p>
  <div class="lead-table-wrap" style="margin-top:12px">
    <table class="lead-table">
      <thead><tr><th style="width:80px">Image</th><th>Phone</th><th>Email</th><th>Style</th><th>Submitted</th><th>Emailed?</th></tr></thead>
      <tbody id="kioskSubsBody"><tr><td colspan="6" class="no-data">Loading...</td></tr></tbody>
    </table>
  </div>
</div>
</div><!-- /.section-group -->

<div class="section-group">
  <div class="section-label">Drop-offs</div>
<div class="panel panel-dropoffs">
  <h2>Drop-offs</h2>
  <p class="dropoff-desc">Users who texted in but never received a finished portrait. Send them a nudge to come back and try again.</p>
  <div class="dropoff-list" id="dropoffList"><div class="no-data" style="padding:16px">Loading...</div></div>
</div>
</div><!-- /.section-group -->

<div class="urow-popup" id="urowPopup">
  <div class="urow-popup-title" id="urowPopupTitle">User Actions</div>
  <button onclick="deleteUserAction('photos')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Delete Photos</button>
  <button onclick="deleteUserAction('lead')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg> Delete Lead Data</button>
  <button class="destructive" onclick="deleteUserAction('all')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete Everything</button>
</div>
<div class="footer">Auto-refreshes recipient list every 10s</div>
</div>

<script>
const STYLE_COLORS = {
  cartoon: "var(--blue-400)", "pop-art": "var(--blue-300)", watercolor: "var(--blue-500)",
  anime: "var(--red-400)", sketch: "var(--th-text-secondary)", "pixel-art": "var(--blue-200)",
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
  fetchKioskSubs();
  fetchDropOffs();
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
    fetchDropOffs();
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
      const c = STYLE_COLORS[s] || "var(--blue-400)";
      pills += '<span class="upill" style="background:' + c + '">' + s + '</span>';
    }
    const isWinner = winnerIds.has(u.id);
    const chk = prev.has(u.id) ? " checked" : "";
    html += '<div class="urow' + (isWinner ? ' winner' : '') + '" id="row-' + u.id + '">'
      + '<input type="checkbox" class="ucb" data-id="' + u.id + '"' + chk + ' onchange="updateSelCount()">'
      + (isWinner ? '<span class="trophy">&#127942;</span>' : '')
      + '<span class="uphone">' + u.phone + '</span>'
      + '<span class="uname">' + (u.name ? esc(u.name) : '') + '</span>'
      + '<span class="ucnt">' + u.count + ' print' + (u.count === 1 ? '' : 's') + '</span>'
      + '<span class="ustyles">' + pills + '</span>'
      + '<span class="utime">' + relativeTime(u.lastActive) + '</span>'
      + '<button class="urow-act" onclick="showUserMenu(event,' + u.id + ')" title="Actions">&#8942;</button>'
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
  el.style.color = len > 160 ? "var(--blue-300)" : "var(--th-text-muted)";
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
    if (row) row.style.background = "rgba(var(--blue-300-rgb, 58,206,250), 0.1)";
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
  if (!confirm("Send this message to " + ids.length + " recipient" + (ids.length === 1 ? "" : "s") + "?")) return;
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
      document.getElementById("msgBox").value = "";
      updateCharCount();
    }
  } catch (e) {
    result.className = "result-msg error";
    result.textContent = "Network error: " + e.message;
  } finally {
    btn.disabled = false;
    updateSelCount();
  }
}

// ── Per-user action menu ──────────────────────────────────────────────────
var activeUserId = null;

function showUserMenu(e, id) {
  e.stopPropagation();
  activeUserId = id;
  var user = users.find(function(u) { return u.id === id; });
  var popup = document.getElementById("urowPopup");
  document.getElementById("urowPopupTitle").textContent = user ? user.phone : "User Actions";
  var rect = e.target.getBoundingClientRect();
  // Position near the button, but keep within viewport
  var top = rect.bottom + 4;
  var right = window.innerWidth - rect.right;
  if (top + 160 > window.innerHeight) top = rect.top - 160;
  popup.style.top = top + "px";
  popup.style.right = right + "px";
  popup.style.left = "auto";
  popup.classList.add("open");
  setTimeout(function() { document.addEventListener("click", closeUserMenu); }, 0);
}

function closeUserMenu() {
  document.getElementById("urowPopup").classList.remove("open");
  document.removeEventListener("click", closeUserMenu);
  activeUserId = null;
}

async function deleteUserAction(scope) {
  var id = activeUserId;
  closeUserMenu();
  if (!id) return;
  var user = users.find(function(u) { return u.id === id; });
  var phone = user ? user.phone : "this user";
  var labels = { photos: "photos and job history", lead: "lead capture data", all: "ALL data (photos, jobs, and lead)" };
  var msg = "Delete " + (labels[scope] || "data") + " for " + phone + "?\\n\\nThis cannot be undone.";
  if (!confirm(msg)) return;
  try {
    var r = await fetch("api/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id], event: selectedEvent, scope: scope }),
    });
    var d = await r.json();
    if (d.error) {
      alert("Delete failed: " + d.error);
    } else {
      fetchUsers();
      fetchLeads();
    }
  } catch (e) {
    alert("Delete failed: " + e.message);
  }
}

// ── Bulk leads delete ─────────────────────────────────────────────────────
async function deleteAllLeads() {
  var ev = selectedEvent;
  if (!ev || ev === "all") {
    alert("Select a specific event first.");
    return;
  }
  var count = document.getElementById("statLeads").textContent;
  var msg = "Delete ALL " + count + " lead(s) for event '" + ev + "'?\\n\\nThis removes lead capture data only — photos and jobs are not affected.\\n\\nThis cannot be undone.";
  if (!confirm(msg)) return;
  var btn = document.getElementById("deleteLeadsBtn");
  btn.disabled = true;
  btn.textContent = "Deleting...";
  try {
    var r = await fetch("api/leads", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: ev }),
    });
    var d = await r.json();
    if (d.error) {
      alert("Delete failed: " + d.error);
    } else {
      fetchLeads();
    }
  } catch (e) {
    alert("Delete failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete All Leads';
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
      tbody.innerHTML = '<tr><td colspan="6" class="no-data">No leads captured yet</td></tr>';
      return;
    }
    var html = "";
    for (var l of data) {
      html += "<tr>"
        + "<td>" + esc(l.firstName) + " " + esc(l.lastName) + "</td>"
        + "<td>" + esc(l.email) + "</td>"
        + "<td>" + esc(l.personalEmail) + "</td>"
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

async function fetchKioskSubs() {
  try {
    var r = await fetch("api/kiosk-submissions" + evParam());
    var data = await r.json();
    var tbody = document.getElementById("kioskSubsBody");
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    if (data.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 6;
      td.className = "no-data";
      td.textContent = "No kiosk submissions yet";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (var s of data) {
      var row = document.createElement("tr");
      row.dataset.prefix = s.filePrefix;
      row.dataset.event = s.event;
      // thumb
      var tdImg = document.createElement("td");
      var img = document.createElement("img");
      img.src = "/photogallery/img/" + encodeURIComponent(s.event) + "/" + encodeURIComponent(s.filePrefix) + "_output_mms.jpg";
      img.loading = "lazy";
      img.style.cssText = "width:56px;height:56px;object-fit:cover;border-radius:6px;background:var(--th-input)";
      img.onerror = function() { this.style.visibility = "hidden"; };
      tdImg.appendChild(img);
      row.appendChild(tdImg);
      // text columns
      var cols = [s.phone || "—", s.email || "—", s.style || "—", new Date(s.submittedAt).toLocaleString()];
      for (var i = 0; i < cols.length; i++) {
        var td2 = document.createElement("td");
        td2.textContent = cols[i];
        row.appendChild(td2);
      }
      // emailed checkbox
      var tdChk = document.createElement("td");
      var chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = !!s.emailedAt;
      (function(prefix, event) {
        chk.addEventListener("change", function() { toggleEmailed(this, prefix, event); });
      })(s.filePrefix, s.event);
      tdChk.appendChild(chk);
      row.appendChild(tdChk);
      tbody.appendChild(row);
    }
  } catch(e) { console.error(e); }
}

async function toggleEmailed(cb, filePrefix, event) {
  try {
    var r = await fetch("api/kiosk-submissions/emailed", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ filePrefix: filePrefix, event: event, emailed: cb.checked }),
    });
    if (!r.ok) throw new Error("toggle failed");
  } catch(e) {
    cb.checked = !cb.checked;
    console.error(e);
  }
}

function exportLeads() {
  var ev = selectedEvent || "all";
  window.location.href = "api/leads/export?event=" + encodeURIComponent(ev);
}

var dropoffs = [];

async function fetchDropOffs() {
  try {
    var r = await fetch("api/drop-offs" + evParam());
    dropoffs = await r.json();
    document.getElementById("statDropoffs").textContent = dropoffs.length;
    renderDropOffs();
  } catch (e) { console.error(e); }
}

function renderDropOffs() {
  var list = document.getElementById("dropoffList");
  if (dropoffs.length === 0) {
    list.innerHTML = '<div class="no-data" style="padding:16px">No drop-offs for this event</div>';
    return;
  }
  var html = "";
  for (var d of dropoffs) {
    var nudgeLabel = d.nudgedAt ? "Nudge Again" : "Nudge";
    var nudgeStatus = d.nudgedAt ? "Nudged " + relativeTime(d.nudgedAt) : "";
    html += '<div class="drow">'
      + '<span class="dphone">' + esc(d.phone) + '</span>'
      + '<span class="dtime">Texted ' + relativeTime(d.firstContactAt) + '</span>'
      + '<span class="dnudge-status">' + nudgeStatus + '</span>'
      + '<button class="btn-nudge" onclick="nudgeDropOff(' + "'" + esc(d.id) + "'" + ',' + "'" + esc(d.phone) + "'" + ')">' + nudgeLabel + '</button>'
      + '</div>';
  }
  list.innerHTML = html;
}

async function nudgeDropOff(id, phone) {
  if (!confirm("Send a nudge message to " + phone + "?")) return;
  try {
    var r = await fetch("api/nudge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, event: selectedEvent }),
    });
    var d = await r.json();
    if (d.error) {
      alert("Nudge failed: " + d.error);
    } else {
      fetchDropOffs();
    }
  } catch (e) {
    alert("Nudge failed: " + e.message);
  }
}

fetchEvents();
setInterval(fetchUsers, 10000);
setInterval(fetchDropOffs, 10000);

// Review notification polling
(function() {
  var el = document.getElementById("reviewNotify");
  var txt = document.getElementById("reviewNotifyText");
  function poll() {
    fetch("/dashboard/api/review-count").then(function(r){return r.json()}).then(function(d) {
      var n = d && d.count ? d.count : 0;
      if (el && txt) {
        if (n > 0) {
          txt.textContent = n + " image" + (n === 1 ? "" : "s") + " pending review";
          el.style.display = "flex";
        } else {
          el.style.display = "none";
        }
      }
      // Screen-edge pulsing glow across admin pages
      document.body.classList.toggle("review-pending", n > 0);
    }).catch(function(){});
  }
  poll();
  setInterval(poll, 5000);
})();

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('twilio-theme', next);
}
</script>
${userBarSnippet()}
${magicHatSnippet()}
</body>
</html>`;

// Routes
router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/")) return res.redirect(req.originalUrl + "/");
    res.type("html").send(OUTREACH_HTML);
});

router.get("/api/events", async (req, res) => {
    const jobs = readJobs(DONE_DIR);
    const jobEvents = jobs.map((j) => j.eventName).filter(Boolean);
    let dlEvents = [];
    try {
        const dlRoot = path.join(__dirname, "..", "downloads");
        dlEvents = (await fsp.readdir(dlRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch {}
    const events = [...new Set([...jobEvents, ...dlEvents])].sort();
    res.json({ events, currentEvent: settings.get("eventName") });
});

router.get("/api/users", (req, res) => {
    const eventFilter = req.query.event || settings.get("eventName");
    const users = buildUserDirectory(eventFilter);
    const showLeadData = eventFilter !== "all";
    const eventName = showLeadData ? eventFilter : null;
    res.json(users.map((u) => ({
        id: u.id,
        phone: maskPhone(u.phone),
        name: showLeadData ? (leads.getLeadName(u.phone, eventName) || null) : null,
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
    const users = buildUserDirectory(event || settings.get("eventName"));
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
    const { ids, scope } = req.body || {};
    const event = (req.body || {}).event || settings.get("eventName");
    if (!ids || !ids.length) {
        return res.status(400).json({ error: "ids are required" });
    }
    if (!event) {
        return res.status(400).json({ error: "event is required" });
    }

    const deletePhotos = !scope || scope === "photos" || scope === "all";
    const deleteLead = !scope || scope === "lead" || scope === "all";

    const users = buildUserDirectory(event);
    const byId = new Map(users.map((u) => [u.id, u]));
    // Skip GENERATING_DIR and PRINTING_DIR — workers actively hold references
    // to jobs in those dirs; deleting mid-processing would corrupt state.
    const queueDirs = [DONE_DIR, PENDING_DIR, REVIEW_DIR, READY_DIR, FAILED_DIR];
    let deletedJobs = 0;
    let deletedLeads = 0;
    let deletedImages = 0;

    for (const id of ids) {
        const user = byId.get(id);
        if (!user) continue;
        const phone = user.phone;

        if (deletePhotos) {
            // Collect file prefixes from jobs before deleting, so we can delete images
            const filePrefixes = new Set();

            // Delete job files from all queue directories
            const isAllEvents = event === "all";
            for (const dir of queueDirs) {
                try {
                    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
                    for (const f of files) {
                        try {
                            const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                            if (job.userPhone === phone && (isAllEvents || !event || job.eventName === event)) {
                                if (job.filePrefix) filePrefixes.add({ prefix: job.filePrefix, eventName: job.eventName });
                                fs.unlinkSync(path.join(dir, f));
                                deletedJobs++;
                            }
                        } catch {}
                    }
                } catch {}
            }

            // Delete image files from the relevant event download directories
            if (filePrefixes.size > 0 && event) {
                const dlRoot = path.join(__dirname, "..", "downloads");
                const prefixesByEvent = new Map();
                for (const { prefix, eventName } of filePrefixes) {
                    if (!prefixesByEvent.has(eventName)) prefixesByEvent.set(eventName, []);
                    prefixesByEvent.get(eventName).push(prefix);
                }
                for (const [evName, prefixes] of prefixesByEvent) {
                    const dirs = [path.join(dlRoot, evName), path.join(dlRoot, evName, ".staging")];
                    for (const evDir of dirs) {
                        try {
                            const files = fs.readdirSync(evDir);
                            for (const f of files) {
                                for (const prefix of prefixes) {
                                    if (f.startsWith(prefix)) {
                                        try { fs.unlinkSync(path.join(evDir, f)); deletedImages++; } catch {}
                                        break;
                                    }
                                }
                            }
                        } catch {}
                    }
                }
            }
        }

        if (deleteLead) {
            const isAllEvents = event === "all";
            deletedLeads += leads.deleteByPhone(phone, isAllEvents ? null : event);
        }

        // Clean up contact record so deleted users don't reappear in drop-offs
        if (deletePhotos) {
            const isAllEvents = event === "all";
            contacts.deleteByPhone(phone, isAllEvents ? null : event);
        }
    }

    // Invalidate outreach job cache so deleted users don't reappear in UI
    _outreachJobsCache.clear();

    // Rebuild usage cache
    if (deletePhotos) {
        const { buildUsageCache } = require("./queue");
        buildUsageCache();
    }

    const label = scope === "photos" ? "photos" : scope === "lead" ? "lead" : "all data";
    console.log(`🗑️  Deleted ${label} for ${ids.length} user(s): ${deletedJobs} jobs, ${deletedLeads} leads, ${deletedImages} images removed`);
    res.json({ deleted: ids.length, deletedJobs, deletedLeads, deletedImages });
});

// ── Drop-offs API ────────────────────────────────────────────────────────────

router.get("/api/drop-offs", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    // Check all active + completed directories — anyone with a job anywhere in the
    // pipeline is NOT a drop-off.  Only FAILED_DIR is excluded so failed users
    // can still be nudged.
    const activeJobs = [
        ...readJobs(DONE_DIR),
        ...readJobs(PENDING_DIR),
        ...readJobs(GENERATING_DIR),
        ...readJobs(REVIEW_DIR),
        ...readJobs(READY_DIR),
        ...readJobs(PRINTING_DIR),
    ];
    const adminPhones = settings.get("adminPhones") || [];
    const dropOffs = contacts.getDropOffs(event, activeJobs, adminPhones);
    res.json(dropOffs.map((c) => ({
        id: String(phoneHash(c.phone)),
        phone: maskPhone(c.phone),
        firstContactAt: c.firstContactAt,
        nudgedAt: c.nudgedAt,
    })));
});

router.post("/api/nudge", async (req, res) => {
    const { id, event } = req.body || {};
    if (!id) return res.status(400).json({ error: "id is required" });

    const eventFilter = event || settings.get("eventName");
    const activeJobs = [
        ...readJobs(DONE_DIR),
        ...readJobs(PENDING_DIR),
        ...readJobs(GENERATING_DIR),
        ...readJobs(REVIEW_DIR),
        ...readJobs(READY_DIR),
        ...readJobs(PRINTING_DIR),
    ];
    const adminPhones = settings.get("adminPhones") || [];
    const dropOffs = contacts.getDropOffs(eventFilter, activeJobs, adminPhones);

    // Find the contact by hash ID
    const match = dropOffs.find((c) => String(phoneHash(c.phone)) === String(id));
    if (!match) return res.status(404).json({ error: "drop-off not found" });

    const message = settings.getMsgForEvent("nudgeDropoff", match.eventName, { eventName: match.eventName });
    try {
        await sendSms(match.phone, match.appPhone, message);
        contacts.markNudged(match.phone, match.eventName);
        console.log(`📇 Nudged drop-off: ${maskPhone(match.phone)} (${match.eventName})`);
        res.json({ ok: true });
    } catch (err) {
        console.error(`❌ Nudge failed for ${maskPhone(match.phone)}: ${err.message}`);
        res.status(500).json({ error: "Failed to send nudge message" });
    }
});

// ── Leads API ────────────────────────────────────────────────────────────────

router.get("/api/leads", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    const eventFilter = event && event !== "all" ? event : null;
    const allLeads = eventFilter ? leads.getLeads(eventFilter) : leads.getLeads(null);
    // Sort by most recent first
    allLeads.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    res.json(allLeads.map((l) => ({
        firstName: l.firstName || "",
        lastName: l.lastName || "",
        email: l.email || "",
        personalEmail: l.personalEmail || "",
        company: l.company || "",
        jobTitle: l.jobTitle || "",
        country: l.country || "",
        phone: maskPhone(l.phone || ""),
        completedAt: l.completedAt || 0,
    })));
});

router.delete("/api/leads", (req, res) => {
    const { event } = req.body || {};
    if (!event || event === "all") {
        return res.status(400).json({ error: "specific event required" });
    }
    const deleted = leads.deleteByEvent(event);
    console.log(`🗑️  Deleted ${deleted} leads for event "${event}"`);
    res.json({ deleted });
});

router.get("/api/kiosk-submissions", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    const records = kioskSubmissions.listByEvent(event === "all" ? null : event);
    res.json(records);
});

router.post("/api/kiosk-submissions/emailed", (req, res) => {
    const { filePrefix, event, emailed } = req.body || {};
    if (!filePrefix || !event) return res.status(400).json({ error: "filePrefix and event required" });
    const updated = emailed
        ? kioskSubmissions.markEmailed(filePrefix, event)
        : kioskSubmissions.unmarkEmailed(filePrefix, event);
    if (!updated) return res.status(404).json({ error: "submission not found" });
    res.json(updated);
});

router.get("/api/leads/export", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    const eventFilter = event && event !== "all" ? event : null;
    const allLeads = eventFilter ? leads.getLeads(eventFilter) : leads.getLeads(null);
    allLeads.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    const headers = ["First Name", "Last Name", "Company Name", "Email Address", "Job Title", "Phone Number", "Address", "City", "Country", "State", "Postal Code", "List Import - Campaign Member Status"];
    const rows = allLeads.map((l) => {
        const email = (l.email || l.personalEmail || "").trim();
        return [
            (l.firstName || "").trim(),
            (l.lastName || "").trim(),
            (l.company || "").trim(),
            email,
            (l.jobTitle || "").trim(),
            (l.phone || "").trim(),
            "",  // Address
            "",  // City
            (l.country || "").trim(),
            "",  // State
            "",  // Postal Code
            "Attended",
        ];
    });

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
