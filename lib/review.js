const express = require("express");
const path = require("path");
const settings = require("./settings");
const { makeReviewToken, verifyReviewToken, parseCookie, REVIEW_TOKEN_TTL } = require("./auth");
const { getReviewQueue, approveJob, rejectJob } = require("./queue");

const router = express.Router();

// ── Middleware: require valid review token or admin session ──────────────────

function requireReviewAuth(req, res, next) {
    // If user already has an admin session, allow through
    if (req.user) return next();

    const token = parseCookie(req, "review_token");
    if (verifyReviewToken(token)) return next();

    // For API calls, return 401; for pages, redirect to PIN entry
    if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Review session expired" });
    }
    // Only show "expired" if they had a token that failed validation (not first-time visitors)
    return res.redirect(token ? "/review?reason=expired" : "/review");
}

// ── PIN entry page ──────────────────────────────────────────────────────────

router.get("/", (req, res) => {
    // If already authed, go straight to the queue
    const token = parseCookie(req, "review_token");
    if (verifyReviewToken(token) || req.user) {
        return res.redirect("/review/queue");
    }

    // Gate: manual review must be enabled
    if (!settings.get("enableManualReview")) {
        return res.status(403).send(REVIEW_INACTIVE_HTML);
    }

    const pin = settings.get("reviewPin");
    if (!pin) {
        return res.status(403).send(PIN_DISABLED_HTML);
    }

    let errorMsg = "";
    if (req.query.error) errorMsg = "Incorrect PIN — please try again";
    else if (req.query.reason === "expired") errorMsg = "Your session expired — please enter the PIN again";

    res.setHeader("Content-Type", "text/html");
    res.send(PIN_PAGE_HTML.replace("{{ERROR}}", errorMsg ? `<div class="error">${errorMsg}</div>` : ""));
});

router.post("/auth", express.urlencoded({ extended: false }), (req, res) => {
    const pin = settings.get("reviewPin");
    if (!pin) return res.status(403).send("Review PIN not configured");

    const entered = (req.body.pin || "").trim();
    if (entered !== pin) {
        return res.redirect("/review?error=1");
    }

    const token = makeReviewToken();
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const parts = [`review_token=${token}`, "HttpOnly", "SameSite=Lax", "Path=/review", `Max-Age=${REVIEW_TOKEN_TTL}`];
    if (isSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
    res.redirect("/review/queue");
});

// ── Review queue page ───────────────────────────────────────────────────────

router.get("/queue", requireReviewAuth, (req, res) => {
    if (!settings.get("enableManualReview")) {
        return res.status(403).send(REVIEW_INACTIVE_HTML);
    }
    res.setHeader("Content-Type", "text/html");
    res.send(QUEUE_HTML);
});

// ── Review API ──────────────────────────────────────────────────────────────

router.get("/api/queue", requireReviewAuth, (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = getReviewQueue(eventFilter);
    res.json(jobs);
});

router.post("/api/job", requireReviewAuth, express.json(), async (req, res) => {
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
            const message = notify ? settings.getMsg("reviewReject") : null;
            await rejectJob(filename, message, reanalyze);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/bulk", requireReviewAuth, express.json(), async (req, res) => {
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

// ── HTML Templates ──────────────────────────────────────────────────────────

const REVIEW_INACTIVE_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Review — Twilio Photobooth</title>
<style>
  body { background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif; }
  .msg { text-align: center; max-width: 380px; padding: 40px; }
  .msg h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 22px; color: var(--th-text); margin-bottom: 12px; }
  .msg p { font-size: 14px; color: var(--th-text-muted); }
</style>
</head>
<body>
<div class="msg">
  <h1>Review Not Active</h1>
  <p>Manual review is not currently enabled for this event. Ask an admin to enable it in Settings.</p>
</div>
</body></html>`;

const PIN_DISABLED_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Review — Twilio Photobooth</title>
<style>
  body { background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif; }
  .msg { text-align: center; max-width: 380px; padding: 40px; }
  .msg h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 22px; color: var(--th-text); margin-bottom: 12px; }
  .msg p { font-size: 14px; color: var(--th-text-muted); }
</style>
</head>
<body>
<div class="msg">
  <h1>Review Not Available</h1>
  <p>The review PIN has not been configured. An admin needs to set a Review PIN in Settings to enable standalone review access.</p>
</div>
</body></html>`;

const PIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Review Login — Twilio Photobooth</title>
<style>
  body { background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; position: relative; overflow: hidden; }
  body::before {
    content: ''; position: fixed; top: -40%; left: -20%; width: 140%; height: 140%;
    background: radial-gradient(ellipse at 30% 20%, rgba(239,34,58,0.12) 0%, transparent 55%),
                radial-gradient(ellipse at 70% 80%, rgba(33,136,239,0.06) 0%, transparent 50%);
    pointer-events: none; z-index: 0;
  }
  .login-wrapper { text-align: center; max-width: 400px; width: 92%; position: relative; z-index: 1; }
  .card {
    position: relative; background: var(--th-card); border: 1px solid var(--th-card-border);
    border-radius: 16px; padding: 48px 40px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.3); overflow: hidden;
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--brand-red) 0%, #F83D53 40%, #2188EF 100%);
  }
  .card .app-name {
    font-family: 'Twilio Sans Mono', monospace; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1px;
    color: var(--brand-red); font-weight: 400; margin-bottom: 6px;
  }
  .card h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 24px;
    font-weight: 800; color: var(--th-text); margin-bottom: 6px; }
  .card .subtitle { font-size: 13px; color: var(--th-text-muted); margin-bottom: 28px; }
  .error {
    background: rgba(239,34,58,.1); border: 1px solid rgba(239,34,58,.3);
    color: var(--brand-red); border-radius: 8px; padding: 10px 14px;
    font-size: 13px; margin-bottom: 20px;
  }
  .pin-input {
    width: 100%; padding: 14px 16px; font-size: 24px; text-align: center;
    letter-spacing: 12px; font-family: 'Twilio Sans Mono', monospace;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 10px;
    color: var(--th-text); outline: none; transition: border-color .2s;
  }
  .pin-input:focus { border-color: var(--blue-400); }
  .pin-input::placeholder { letter-spacing: 4px; font-size: 14px; color: var(--th-text-muted); }
  .btn-submit {
    margin-top: 20px; width: 100%; padding: 14px; border: none; border-radius: 10px;
    background: var(--brand-red); color: #fff; font-size: 14px; font-weight: 700;
    font-family: 'Twilio Sans Text', sans-serif; cursor: pointer;
    transition: background .2s, transform .1s;
  }
  .btn-submit:hover { background: var(--brand-red-hover, #DB132A); }
  .btn-submit:active { transform: translateY(1px); }
</style>
</head>
<body>
<div class="login-wrapper">
  <div class="card">
    <div class="app-name">AI Photobooth</div>
    <h1>Review Queue</h1>
    <p class="subtitle">Enter the review PIN to continue</p>
    {{ERROR}}
    <form method="POST" action="/review/auth">
      <input class="pin-input" type="password" name="pin" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="PIN" autofocus autocomplete="off">
      <button class="btn-submit" type="submit">Enter</button>
    </form>
  </div>
</div>
</body></html>`;

const QUEUE_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Review Queue — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    padding: 20px 16px; font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  .header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 20px; padding-bottom: 14px;
    border-bottom: 1px solid var(--th-card-border); flex-wrap: wrap; gap: 10px;
  }
  .header h1 {
    font-size: 20px; font-weight: 700; color: var(--th-text);
    display: flex; align-items: center; gap: 8px;
  }
  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--blue-400); animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
  .badge {
    font-size: 12px; background: var(--brand-red); color: #fff;
    border-radius: 10px; padding: 2px 10px; margin-left: 8px; font-weight: 700;
  }
  .empty {
    text-align: center; padding: 60px 20px; color: var(--th-text-muted); font-size: 14px;
  }
  .empty-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.4; }

  /* Grid */
  .review-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px;
  }
  @media (max-width: 500px) {
    .review-grid { grid-template-columns: 1fr; }
  }

  /* Cards */
  .rv-card {
    position: relative; background: var(--th-card); border-radius: 10px;
    padding: 12px; text-align: center;
    border: 1px solid var(--th-card-border); transition: border-color .2s;
  }
  .rv-card:hover { border-color: var(--blue-300); }
  .rv-card img { width: 100%; border-radius: 6px; margin-bottom: 8px; cursor: pointer; }
  .rv-meta { font-size: 11px; color: var(--th-text-muted); margin-bottom: 10px; }
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
  .rv-btn-reject { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }
  .rv-btn-reject:hover { border-color: var(--brand-red); color: var(--brand-red); background: rgba(239,34,58,.08); }
  .rv-btn-notify { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }
  .rv-btn-notify:hover { border-color: var(--blue-300); color: var(--blue-300); background: rgba(25,171,243,.08); }
  .rv-btn-reanalyze { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }
  .rv-btn-reanalyze:hover { border-color: var(--blue-500); color: var(--blue-500); background: rgba(24,102,238,.08); }

  /* Bulk selection */
  .rv-card-check {
    position: absolute; top: 8px; left: 8px; z-index: 2;
    width: 20px; height: 20px; accent-color: var(--blue-400); cursor: pointer;
  }
  .rv-card.rv-selected { border-color: var(--blue-400); box-shadow: 0 0 0 1px var(--blue-400); }
  .rv-bulk-bar {
    display: none; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px; padding: 10px 14px;
    background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 8px;
  }
  .rv-bulk-bar.active { display: flex; }
  .rv-bulk-bar label { font-size: 13px; color: var(--th-text-dim); cursor: pointer; display: flex; align-items: center; gap: 6px; }
  .rv-bulk-bar label input { accent-color: var(--blue-400); cursor: pointer; }
  .rv-bulk-count { font-size: 12px; color: var(--blue-300); font-weight: 700; }
  .rv-bulk-actions { display: flex; gap: 6px; margin-left: auto; }
  .rv-bulk-actions .rv-btn { width: auto; padding: 6px 14px; font-size: 12px; }

  /* Modal */
  .rv-modal {
    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,.85); z-index: 9999;
    align-items: center; justify-content: center;
  }
  .rv-modal.open { display: flex; }
  .rv-modal-content { position: relative; max-width: 90vw; max-height: 90vh; }
  .rv-modal-content img {
    max-width: 90vw; max-height: 85vh; border-radius: 10px;
    box-shadow: 0 8px 40px rgba(0,0,0,.5);
  }
  .rv-modal-close {
    position: absolute; top: -12px; right: -12px;
    background: var(--th-card); color: #fff; border: 2px solid var(--th-text-muted);
    width: 32px; height: 32px; border-radius: 50%; font-size: 18px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .rv-modal-close:hover { background: var(--brand-red); border-color: var(--brand-red); }

  /* Toast */
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--th-card); border: 1px solid var(--th-card-border);
    color: var(--th-text); padding: 10px 20px; border-radius: 10px;
    font-size: 13px; font-weight: 600; z-index: 10000; opacity: 0;
    transition: opacity .3s; pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,.3);
  }
  .toast.show { opacity: 1; }

  /* Offline banner */
  .offline-bar {
    display: none; text-align: center; padding: 8px 16px; font-size: 12px; font-weight: 600;
    background: rgba(239,34,58,.12); color: var(--brand-red); border-radius: 8px;
    margin-bottom: 14px; border: 1px solid rgba(239,34,58,.25);
  }
  .offline-bar.show { display: block; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1><span class="status-dot"></span>Review Queue <span class="badge" id="reviewCount">0</span></h1>
  </div>

  <div class="offline-bar" id="offlineBar">Connection lost — retrying automatically...</div>
  <div class="rv-bulk-bar" id="rvBulkBar">
    <label><input type="checkbox" id="rvSelectAll" onchange="toggleSelectAll(this.checked)"> Select all</label>
    <span class="rv-bulk-count" id="rvBulkCount"></span>
    <div class="rv-bulk-actions">
      <button class="rv-btn rv-btn-approve" onclick="bulkAction('approve')" title="Deliver all selected images to their users via MMS">Approve Selected</button>
      <button class="rv-btn rv-btn-reject" onclick="bulkAction('reject')" title="Discard all selected images silently — users are not notified">Reject Selected</button>
    </div>
  </div>

  <div id="reviewGrid" class="review-grid"></div>
  <div id="emptyState" class="empty" style="display:none">
    <div class="empty-icon">&#10003;</div>
    <p>No images pending review</p>
  </div>
</div>

<div id="reviewModal" class="rv-modal" onclick="closeModal(event)">
  <div class="rv-modal-content">
    <button class="rv-modal-close" onclick="closeModal()">&times;</button>
    <img id="reviewModalImg" src="">
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var _selected = new Set();
var _fetching = false;

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function timeAgo(ts) {
  if (!ts) return "";
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}

function showToast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(function(){ t.classList.remove("show"); }, 2500);
}

async function fetchQueue() {
  if (_fetching) return;
  _fetching = true;
  try {
    var r = await fetch("/review/api/queue");
    if (r.status === 401) { location.href = "/review"; return; }
    var jobs = await r.json();
    document.getElementById("offlineBar").classList.remove("show");
    renderQueue(jobs);
  } catch(e) {
    document.getElementById("offlineBar").classList.add("show");
  } finally {
    _fetching = false;
  }
}

function renderQueue(jobs) {
  var grid = document.getElementById("reviewGrid");
  var badge = document.getElementById("reviewCount");
  var empty = document.getElementById("emptyState");

  if (!jobs.length) {
    grid.innerHTML = "";
    badge.textContent = "0";
    empty.style.display = "";
    _selected.clear();
    updateBulk(0);
    return;
  }

  empty.style.display = "none";
  badge.textContent = jobs.length;

  var current = new Set(jobs.map(function(j){return j.filename}));
  _selected.forEach(function(f){ if (!current.has(f)) _selected.delete(f); });

  var h = "";
  for (var j of jobs) {
    var fn = escHtml(j.filename);
    var fp = escHtml(j.filePrefix);
    var imgSrc = "/images/staging/" + fp + "_output_mms.jpg";
    var sel = _selected.has(j.filename);
    h += '<div class="rv-card'+(sel?" rv-selected":"")+'" id="rv-'+fn+'">';
    h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect(\\''+fn+'\\',this.checked)" title="Select for bulk action">';
    h += '<img src="'+imgSrc+'" onclick="openModal(\\'/images/staging/'+fp+'_output.png\\')" title="Click to enlarge">';
    h += '<div class="rv-meta">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+'</div>';
    h += '<div class="rv-actions">';
    h += '<button class="rv-btn rv-btn-approve" onclick="doAction(\\''+fn+'\\',\\'approve\\')" title="Deliver this image to the user via MMS">Approve</button>';
    h += '<div class="rv-reject-row">';
    h += '<button class="rv-btn rv-btn-reject" onclick="doAction(\\''+fn+'\\',\\'reject\\')" title="Discard this image silently — the user is not notified">Reject</button>';
    h += '<button class="rv-btn rv-btn-notify" onclick="doAction(\\''+fn+'\\',\\'reject\\',{notify:true})" title="Discard and send the user an SMS asking them to try a different photo">Reject + Notify</button>';
    h += '<button class="rv-btn rv-btn-reanalyze" onclick="doAction(\\''+fn+'\\',\\'reject\\',{reanalyze:true})" title="Discard and re-generate with fresh scene analysis — the user is not notified">Re-analyze</button>';
    h += '</div></div></div>';
  }
  grid.innerHTML = h;
  updateBulk(jobs.length);
}

function toggleSelect(filename, checked) {
  if (checked) _selected.add(filename); else _selected.delete(filename);
  var card = document.getElementById("rv-"+filename);
  if (card) { if (checked) card.classList.add("rv-selected"); else card.classList.remove("rv-selected"); }
  var total = document.querySelectorAll(".rv-card-check").length;
  document.getElementById("rvSelectAll").checked = _selected.size === total && total > 0;
  updateBulk(total);
}

function toggleSelectAll(checked) {
  document.querySelectorAll(".rv-card-check").forEach(function(cb) {
    cb.checked = checked;
    var card = cb.closest(".rv-card");
    var fn = card ? card.id.replace("rv-","") : null;
    if (fn) { if (checked) { _selected.add(fn); card.classList.add("rv-selected"); } else { _selected.delete(fn); card.classList.remove("rv-selected"); } }
  });
  updateBulk(document.querySelectorAll(".rv-card-check").length);
}

function updateBulk(total) {
  var bar = document.getElementById("rvBulkBar");
  var ct = document.getElementById("rvBulkCount");
  if (total > 0) {
    bar.classList.add("active");
    ct.textContent = _selected.size ? _selected.size + " of " + total + " selected" : "";
  } else {
    bar.classList.remove("active");
  }
}

async function doAction(filename, action, opts) {
  opts = opts || {};
  var payload = {filename: filename, action: action};
  if (opts.notify) payload.notify = true;
  if (opts.reanalyze) payload.reanalyze = true;
  try {
    var r = await fetch("/review/api/job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    if (r.status === 401) { location.href = "/review"; return; }
    var d = await r.json();
    if (d.ok) {
      _selected.delete(filename);
      var card = document.getElementById("rv-"+filename);
      if (card) card.remove();
      var msg = action === "approve" ? "Approved" : opts.reanalyze ? "Rejected, re-generating" : opts.notify ? "Rejected, user notified" : "Rejected";
      showToast(msg);
      fetchQueue();
    } else {
      var errMsg = (d.error || "").toLowerCase().indexOf("not found") >= 0 ? "Already processed by someone else" : (d.error || "Action failed");
      showToast(errMsg);
      fetchQueue();
    }
  } catch(e) { showToast("Connection error — try again"); }
}

async function bulkAction(action) {
  if (!_selected.size) { showToast("No items selected"); return; }
  var filenames = Array.from(_selected);
  var count = filenames.length;
  var label = action === "approve" ? "approve" : "reject";
  if (!confirm("Are you sure you want to " + label + " " + count + " item" + (count>1?"s":"") + "?")) return;
  try {
    var r = await fetch("/review/api/bulk", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({filenames: filenames, action: action})
    });
    if (r.status === 401) { location.href = "/review"; return; }
    var d = await r.json();
    _selected.clear();
    document.getElementById("rvSelectAll").checked = false;
    var ok = d.results ? d.results.filter(function(x){return x.ok}).length : 0;
    var fail = count - ok;
    showToast(ok + " " + label + (action==="approve"?"d":"ed") + (fail ? ", " + fail + " failed" : ""));
    fetchQueue();
  } catch(e) { showToast("Bulk action failed"); }
}

function openModal(src) {
  var modal = document.getElementById("reviewModal");
  document.getElementById("reviewModalImg").src = src;
  modal.classList.add("open");
  document.addEventListener("keydown", _esc);
}
function closeModal(e) {
  if (e && e.target && e.target.tagName === "IMG") return;
  document.getElementById("reviewModal").classList.remove("open");
  document.removeEventListener("keydown", _esc);
}
function _esc(e) { if (e.key === "Escape") closeModal(); }

fetchQueue();
setInterval(fetchQueue, 3000);
</script>
</body></html>`;

// ── Mount helper ────────────────────────────────────────────────────────────

function mountReview(app) {
    app.use("/review", router);
}

module.exports = { mountReview };
