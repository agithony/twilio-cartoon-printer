const path = require("path");
const express = require("express");
const { EVENT_NAME, VIDEO_FILE, MAX_PRINTS } = require("./config");
const { STYLES, STYLE_LIST } = require("./styles");

const router = express.Router();

const ASSETS_DIR = path.join(__dirname, "..", "assets");

// Build style list HTML at startup
const styleListHtml = STYLE_LIST.map(
    (k) => `<span class="style-pill">${STYLES[k].name}</span>`,
).join(" ");

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    res.type("html").send(HOME_HTML);
});

router.get("/video", (req, res) => {
    res.type("html").send(VIDEO_HTML);
});

router.get("/combo", (req, res) => {
    res.type("html").send(COMBO_HTML);
});

const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Twilio AI Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(14px, 1.1vw, 18px); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0c10;
    color: #e1e4e8;
    min-height: 100vh;
    padding: clamp(16px, 3vw, 40px);
  }
  .wrap { max-width: 900px; margin: 0 auto; }

  /* Header */
  .hero { text-align: center; margin-bottom: clamp(28px, 3vw, 48px); }
  .hero-icon { font-size: clamp(36px, 4vw, 56px); margin-bottom: 12px; }
  .hero h1 { font-size: clamp(22px, 2.4vw, 36px); font-weight: 700; color: #f0f6fc; margin-bottom: 6px; }
  .hero .event { font-size: clamp(13px, 1.2vw, 20px); color: #f0883e; font-weight: 500; }

  /* Action cards */
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(12px, 1.4vw, 20px); margin-bottom: clamp(28px, 3vw, 48px); }
  @media (max-width: 500px) { .actions { grid-template-columns: 1fr; } }
  .action-card {
    background: #12151c;
    border: 1px solid #1b1f27;
    border-radius: 12px;
    padding: clamp(20px, 2.2vw, 32px);
    text-decoration: none;
    transition: transform .15s, border-color .15s, box-shadow .15s;
    display: block;
  }
  .action-card:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(0,0,0,.3); border-color: #30363d; }
  .action-card .card-icon { font-size: clamp(24px, 2.4vw, 36px); margin-bottom: 12px; }
  .action-card h2 { font-size: clamp(15px, 1.2vw, 20px); font-weight: 600; margin-bottom: 8px; }
  .action-card p { font-size: clamp(12px, 0.9rem, 15px); color: #6e7681; line-height: 1.5; }
  .action-card.dashboard { border-top: 3px solid #58a6ff; }
  .action-card.dashboard h2 { color: #58a6ff; }
  .action-card.booth { border-top: 3px solid #3fb950; }
  .action-card.booth h2 { color: #3fb950; }

  /* Expandable sub-options under booth display */
  .sub-options {
    overflow: hidden; max-height: 0;
    transition: max-height .3s ease, margin .3s ease;
    margin-top: 0;
  }
  .sub-options.open { max-height: 200px; margin-top: clamp(8px, 1vw, 14px); }
  .sub-toggle {
    display: inline-flex; align-items: center; gap: 5px;
    margin-top: 12px; padding: 0; border: none; background: none;
    font-size: clamp(11px, 0.8rem, 13px); color: #6e7681;
    cursor: pointer; font-family: inherit; transition: color .15s;
  }
  .sub-toggle:hover { color: #c9d1d9; }
  .sub-toggle svg { width: 12px; height: 12px; transition: transform .25s; }
  .sub-toggle.open svg { transform: rotate(180deg); }
  .sub-links {
    display: flex; gap: clamp(8px, 0.8vw, 12px); flex-wrap: wrap;
  }
  .sub-link {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 8px;
    background: #1b1f27; border: 1px solid #262b34;
    color: #c9d1d9; text-decoration: none;
    font-size: clamp(11px, 0.8rem, 13px); font-weight: 500;
    transition: all .15s;
  }
  .sub-link:hover { background: #262b34; border-color: #30363d; color: #f0f6fc; }

  /* Sections */
  .section { margin-bottom: clamp(24px, 2.6vw, 40px); }
  .section-title {
    font-size: clamp(10px, 0.78rem, 13px); font-weight: 600; color: #6e7681;
    text-transform: uppercase; letter-spacing: .7px; margin-bottom: clamp(12px, 1.2vw, 20px);
    padding-bottom: 8px; border-bottom: 1px solid #1b1f27;
  }

  /* How it works */
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(clamp(130px, 14vw, 180px), 1fr)); gap: clamp(10px, 1.2vw, 16px); }
  .step {
    background: #12151c;
    border: 1px solid #1b1f27;
    border-radius: 10px;
    padding: clamp(14px, 1.4vw, 22px);
    text-align: center;
  }
  .step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 50%;
    background: #58a6ff22; color: #58a6ff;
    font-size: 13px; font-weight: 700; margin-bottom: 10px;
  }
  .step-text { font-size: clamp(11px, 0.85rem, 14px); color: #c9d1d9; line-height: 1.4; }

  /* Status checklist */
  .checklist { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(10px, 1vw, 16px); }
  @media (max-width: 600px) { .checklist { grid-template-columns: 1fr; } }
  .check-item {
    background: #12151c;
    border: 1px solid #1b1f27;
    border-radius: 10px;
    padding: clamp(12px, 1.2vw, 18px) clamp(14px, 1.4vw, 20px);
    display: flex; align-items: center; gap: 12px;
  }
  .check-dot {
    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
    background: #30363d;
  }
  .check-dot.ok { background: #3fb950; }
  .check-dot.warn { background: #f0883e; }
  .check-dot.err { background: #f85149; }
  .check-dot.loading { background: #30363d; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .check-label { font-size: clamp(12px, 0.9rem, 15px); color: #c9d1d9; }
  .check-value { margin-left: auto; font-size: clamp(12px, 0.9rem, 15px); color: #6e7681; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* Quick reference */
  .ref-grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(10px, 1vw, 16px); }
  @media (max-width: 600px) { .ref-grid { grid-template-columns: 1fr; } }
  .ref-box {
    background: #12151c;
    border: 1px solid #1b1f27;
    border-radius: 10px;
    padding: clamp(14px, 1.4vw, 22px);
  }
  .ref-box h3 { font-size: clamp(11px, 0.85rem, 14px); font-weight: 600; color: #e1e4e8; margin-bottom: 10px; }
  .ref-box p { font-size: clamp(11px, 0.85rem, 14px); color: #6e7681; line-height: 1.5; }
  .style-pill {
    display: inline-block; font-size: clamp(10px, 0.75rem, 12px);
    padding: 3px 10px; border-radius: 10px; margin: 3px 2px;
    background: #1b1f27; color: #c9d1d9; font-weight: 500;
  }

  .footer {
    text-align: center; color: #3d434d; font-size: clamp(11px, 0.78rem, 13px);
    margin-top: clamp(24px, 2.6vw, 40px); padding-top: 16px; border-top: 1px solid #1b1f27;
  }
</style>
</head>
<body>
<div class="wrap">

<div class="hero">
  <div class="hero-icon">&#x1F4F8;</div>
  <h1>Twilio AI Photobooth</h1>
  <div class="event">${EVENT_NAME}</div>
</div>

<!-- Quick Actions -->
<div class="actions">
  <a href="/dashboard/" class="action-card dashboard">
    <div class="card-icon">&#x1F4CA;</div>
    <h2>Open Dashboard</h2>
    <p>Monitor live prints, manage the queue, track paper, send SMS to attendees, and generate event reports.</p>
  </a>
  <div class="action-card booth">
    <a href="/home/combo" target="_blank" style="text-decoration:none;color:inherit;display:block">
      <div class="card-icon">&#x1F4FA;</div>
      <h2>Launch Booth Display</h2>
      <p>Opens a split-screen with the intro video and photo book side by side. Drag the divider to resize. Ideal for a single booth monitor.</p>
    </a>
    <button class="sub-toggle" id="subToggle" onclick="event.stopPropagation();this.classList.toggle('open');document.getElementById('subOpts').classList.toggle('open')">
      Open individually <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="sub-options" id="subOpts">
      <div class="sub-links">
        <a href="/home/video" target="_blank" class="sub-link">&#x1F3AC; Intro Video</a>
        <a href="/photogallery/" target="_blank" class="sub-link">&#x1F4D6; Photo Book</a>
      </div>
    </div>
  </div>
</div>

<!-- How It Works -->
<div class="section">
  <div class="section-title">How It Works</div>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Attendee texts a selfie to your Twilio number</div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text">They pick an art style by name (or get the default)</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">AI generates their portrait in that style</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">It prints automatically at your booth</div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">They get an SMS when it's ready to pick up</div></div>
  </div>
</div>

<!-- Booth Status -->
<div class="section">
  <div class="section-title">Booth Status</div>
  <div class="checklist">
    <div class="check-item">
      <span class="check-dot loading" id="dotPrinter"></span>
      <span class="check-label">Printer</span>
      <span class="check-value" id="valPrinter">Checking...</span>
    </div>
    <div class="check-item">
      <span class="check-dot loading" id="dotPaper"></span>
      <span class="check-label">Paper</span>
      <span class="check-value" id="valPaper">Checking...</span>
    </div>
    <div class="check-item">
      <span class="check-dot loading" id="dotQueue"></span>
      <span class="check-label">Queue</span>
      <span class="check-value" id="valQueue">Checking...</span>
    </div>
    <div class="check-item">
      <span class="check-dot loading" id="dotPrints"></span>
      <span class="check-label">Total Prints</span>
      <span class="check-value" id="valPrints">Checking...</span>
    </div>
  </div>
</div>

<!-- Quick Reference -->
<div class="section">
  <div class="section-title">Quick Reference</div>
  <div class="ref-grid">
    <div class="ref-box">
      <h3>Available Styles</h3>
      <p>Attendees type a style name with their selfie. If they don't pick one, it defaults to cartoon.</p>
      <div style="margin-top:10px">${styleListHtml}</div>
    </div>
    <div class="ref-box">
      <h3>Limits</h3>
      <p>Each attendee gets <strong style="color:#f0f6fc">${MAX_PRINTS}</strong> free prints per event.</p>
      <p style="margin-top:8px">Admin phone numbers (set in .env) get unlimited prints and are hidden from dashboard metrics.</p>
    </div>
  </div>
</div>

<div class="footer">Powered by Twilio + OpenAI</div>

</div><!-- /.wrap -->

<script>
async function checkStatus() {
  try {
    var r = await fetch("/dashboard/api/stats");
    var d = await r.json();

    // Printer
    var dp = document.getElementById("dotPrinter");
    var vp = document.getElementById("valPrinter");
    if (d.printer.status === "ready") { dp.className = "check-dot ok"; vp.textContent = "Ready"; }
    else if (d.printer.status === "printing") { dp.className = "check-dot ok"; vp.textContent = "Printing"; }
    else if (d.printer.status === "not_found") { dp.className = "check-dot err"; vp.textContent = "Not found"; }
    else { dp.className = "check-dot err"; vp.textContent = d.printer.message || "Error"; }

    // Paper
    var dpa = document.getElementById("dotPaper");
    var vpa = document.getElementById("valPaper");
    vpa.textContent = d.paper.remaining + " / " + d.paper.capacity + " sheets";
    if (d.paper.isEmpty) { dpa.className = "check-dot err"; }
    else if (d.paper.isWarning) { dpa.className = "check-dot warn"; }
    else { dpa.className = "check-dot ok"; }

    // Queue
    var dq = document.getElementById("dotQueue");
    var vq = document.getElementById("valQueue");
    var total = d.queue.pending + d.queue.generating + d.queue.ready + d.queue.printing;
    vq.textContent = total === 0 ? "Empty" : total + " job" + (total === 1 ? "" : "s");
    dq.className = total === 0 ? "check-dot ok" : "check-dot ok";

    // Total prints
    var dpr = document.getElementById("dotPrints");
    var vpr = document.getElementById("valPrints");
    vpr.textContent = d.totals.done + " completed";
    dpr.className = "check-dot ok";
  } catch (e) {
    document.querySelectorAll(".check-dot").forEach(function(el) { el.className = "check-dot err"; });
    document.querySelectorAll(".check-value").forEach(function(el) { el.textContent = "Unavailable"; });
  }
}
checkStatus();
setInterval(checkStatus, 5000);
</script>
</body>
</html>`;

const VIDEO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get Started — Twilio AI Photobooth</title>
<style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
</style>
</head>
<body>
<video id="vid" autoplay loop muted playsinline src="/assets/${VIDEO_FILE}"></video>
<div style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10;display:flex;align-items:center;gap:8px">
  <div id="playBtn" style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.7);font-family:sans-serif;font-size:13px;cursor:pointer;user-select:none;backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;transition:all .2s">
    <svg id="pbIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    <span id="pbLabel">Pause</span>
  </div>
  <div id="fsBtn" style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.7);font-family:sans-serif;font-size:13px;cursor:pointer;user-select:none;backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;transition:all .2s">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
    <span>Fullscreen</span>
  </div>
</div>
<script>
var v = document.getElementById("vid");
v.play().catch(function() {});

// Hide fullscreen button when embedded in combo iframe (combo has its own)
if (window.self !== window.top) {
  document.getElementById("fsBtn").style.display = "none";
}

// Custom play/pause button only — clicking video area does nothing
var pbBtn = document.getElementById("playBtn");
pbBtn.addEventListener("click", function() {
  if (v.paused) { v.play(); document.getElementById("pbIcon").innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'; document.getElementById("pbLabel").textContent = "Pause"; }
  else { v.pause(); document.getElementById("pbIcon").innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>'; document.getElementById("pbLabel").textContent = "Play"; }
});

// Fullscreen toggle
document.getElementById("fsBtn").addEventListener("click", function() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } else {
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
});
</script>
</body>
</html>`;

const COMBO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Booth Display — Twilio AI Photobooth</title>
<style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  .split {
    display: flex; width: 100%; height: 100%;
  }
  .split iframe {
    border: none; height: 100%;
  }
  #leftPane { flex: 1; }
  #rightPane { flex: 1; }
  .handle {
    width: 8px; flex-shrink: 0; cursor: col-resize;
    background: rgba(255,255,255,0.06);
    position: relative; z-index: 10;
    transition: background .15s;
  }
  .handle:hover, .handle.active {
    background: rgba(255,255,255,0.15);
  }
  .handle::after {
    content: ''; position: absolute;
    top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: 3px; height: 36px; border-radius: 2px;
    background: rgba(255,255,255,0.25);
  }
  /* Overlay to capture mouse over iframes during drag */
  .drag-overlay {
    display: none; position: fixed; inset: 0; z-index: 5;
    cursor: col-resize;
  }
  .drag-overlay.active { display: block; }
</style>
</head>
<body>
<div class="split" id="split">
  <iframe id="leftPane" src="/home/video" allow="autoplay; fullscreen" allowfullscreen></iframe>
  <div class="handle" id="handle"></div>
  <iframe id="rightPane" src="/photogallery/" allow="fullscreen" allowfullscreen></iframe>
</div>
<div class="drag-overlay" id="overlay"></div>
<script>
(function() {
  var handle = document.getElementById("handle");
  var overlay = document.getElementById("overlay");
  var left = document.getElementById("leftPane");
  var right = document.getElementById("rightPane");
  var dragging = false;

  handle.addEventListener("mousedown", function(e) {
    e.preventDefault();
    dragging = true;
    handle.classList.add("active");
    overlay.classList.add("active");
  });

  document.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    var x = e.clientX;
    var total = window.innerWidth;
    var pct = (x / total) * 100;
    pct = Math.max(15, Math.min(85, pct));
    left.style.flex = "none";
    right.style.flex = "none";
    left.style.width = pct + "%";
    right.style.width = (100 - pct) + "%";
  });

  document.addEventListener("mouseup", function() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    overlay.classList.remove("active");
  });
})();
</script>
</body>
</html>`;

function mountHome(app) {
    app.use("/assets", express.static(ASSETS_DIR));
    app.use("/home", router);
    console.log("🏠 Home page mounted at /home");
}

module.exports = { mountHome };
