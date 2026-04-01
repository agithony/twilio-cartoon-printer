const fs = require("fs");
const express = require("express");
const { EVENT_NAME, DOWNLOAD_DIR } = require("./config");

const router = express.Router();

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    res.type("html").send(GALLERY_HTML);
});

router.get("/api/images", (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR)
            .filter((f) => f.endsWith("_output_mms.jpg"))
            .sort()
            .reverse();
        res.json({ images: files, total: files.length });
    } catch {
        res.json({ images: [], total: 0 });
    }
});

const GALLERY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Gallery — Twilio Photobooth</title>
<style>
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Bold.otf') format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Extrabold.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%; overflow: hidden;
    background: #000D25;
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #e1e4e8; -webkit-font-smoothing: antialiased;
  }

  .gallery { display: flex; flex-direction: column; height: 100vh; }

  /* Counter */
  .counter {
    text-align: center; padding: 18px 0 10px; flex-shrink: 0;
    font-size: clamp(13px, 1.1vw, 18px); color: #656E87; font-weight: 400;
    font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
  }
  .counter strong {
    font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #f0f6fc; font-size: clamp(18px, 1.6vw, 28px);
    font-weight: 800;
  }
  .counter.bump strong { animation: bump .4s cubic-bezier(.36,.07,.19,.97); }
  @keyframes bump {
    0% { transform: scale(1); }
    40% { transform: scale(1.2); color: #EF223A; }
    100% { transform: scale(1); }
  }

  /* Main image area */
  .viewer {
    flex: 1; position: relative; display: flex; align-items: center; justify-content: center;
    overflow: hidden; min-height: 0;
  }
  .img-flipper {
    position: relative; max-width: 88%; max-height: 96%;
    perspective: 1200px;
  }
  .img-flipper .flip-inner {
    position: relative; transition: transform .7s cubic-bezier(.4,.0,.2,1); transform-style: preserve-3d;
  }
  .img-flipper.flipped .flip-inner { transform: rotateY(180deg); }
  .img-flipper img {
    max-width: 100%; max-height: 100%; object-fit: contain;
    border-radius: 10px;
    transition: opacity .5s cubic-bezier(.4,.0,.2,1);
    backface-visibility: hidden;
    box-shadow: 0 8px 40px rgba(0,0,0,.6);
  }
  .img-flipper img.fade-out { opacity: 0; }
  .img-flipper img.back {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    transform: rotateY(180deg);
  }
  .viewer .empty {
    color: #3d434d; font-size: clamp(14px, 1.2vw, 20px); text-align: center;
    font-weight: 400; letter-spacing: 0.01em;
  }

  /* ── Shared glass style ── */
  .glass {
    background: rgba(0,13,37,0.75);
    backdrop-filter: blur(16px) saturate(1.4);
    -webkit-backdrop-filter: blur(16px) saturate(1.4);
    border: 1px solid rgba(255,255,255,0.08);
    transition: all .2s cubic-bezier(.4,.0,.2,1);
    cursor: pointer; user-select: none;
  }
  .glass:hover {
    background: rgba(25,31,54,0.85);
    border-color: rgba(255,255,255,0.14);
  }

  /* Nav arrows */
  .nav-arrow {
    position: absolute; top: 50%; transform: translateY(-50%); z-index: 10;
    width: clamp(44px, 3.5vw, 56px); height: clamp(44px, 3.5vw, 56px);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.5);
  }
  .nav-arrow:hover { color: #fff; transform: translateY(-50%) scale(1.08); }
  .nav-arrow:active { transform: translateY(-50%) scale(0.95); }
  .nav-arrow svg { width: 22px; height: 22px; }
  .nav-arrow.left { left: clamp(80px, 14vw, 260px); }
  .nav-arrow.right { right: clamp(80px, 14vw, 260px); }

  /* Fullscreen (top-right, solo) */
  .fs-btn {
    position: absolute; top: 16px; right: 16px; z-index: 10;
    border-radius: 10px; padding: 8px 14px;
    font-size: 13px; font-weight: 400; letter-spacing: 0.01em;
    color: rgba(255,255,255,0.5);
    display: flex; align-items: center; gap: 7px;
  }
  .fs-btn:hover { color: rgba(255,255,255,0.85); }
  .fs-btn svg { width: 16px; height: 16px; flex-shrink: 0; }

  /* Image controls (bottom of image) */
  .img-controls {
    position: absolute; bottom: clamp(14px, 2vh, 24px); left: 50%;
    transform: translateX(-50%); z-index: 10;
    display: none; align-items: center; gap: 8px;
  }
  .img-controls.visible { display: flex; }
  .img-pill {
    border-radius: 14px; padding: 11px 22px;
    font-size: 14px; font-weight: 700; letter-spacing: 0.02em;
    color: rgba(255,255,255,0.85);
    display: flex; align-items: center; gap: 8px;
    border-color: rgba(255,255,255,0.22);
    box-shadow: 0 2px 8px rgba(0,0,0,.5), 0 8px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,0.06);
  }
  .img-pill:hover {
    color: #fff; border-color: rgba(255,255,255,0.35);
    box-shadow: 0 2px 8px rgba(0,0,0,.5), 0 8px 30px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,0.1);
    transform: scale(1.03);
  }
  .img-pill:active { transform: scale(0.97); }
  .img-pill.active {
    color: #2188EF; border-color: rgba(33,136,239,0.35);
    box-shadow: 0 2px 8px rgba(0,0,0,.5), 0 8px 30px rgba(0,0,0,.45), 0 0 20px rgba(33,136,239,0.12), inset 0 1px 0 rgba(33,136,239,0.1);
  }
  .img-pill svg { width: 18px; height: 18px; flex-shrink: 0; }

  /* Thumbnail strip */
  .thumbs-wrap {
    flex-shrink: 0; padding: 12px 0 16px; overflow: hidden;
    background: linear-gradient(to bottom, rgba(0,13,37,0), rgba(0,13,37,1) 30%);
  }
  .thumbs {
    display: flex; gap: 8px; overflow-x: auto; padding: 0 20px;
    scrollbar-width: thin; scrollbar-color: #191F36 transparent;
    scroll-behavior: smooth;
  }
  .thumbs::-webkit-scrollbar { height: 3px; }
  .thumbs::-webkit-scrollbar-track { background: transparent; }
  .thumbs::-webkit-scrollbar-thumb { background: #191F36; border-radius: 3px; }
  .thumb {
    width: clamp(60px, 5.5vw, 88px); height: clamp(60px, 5.5vw, 88px);
    flex-shrink: 0; border-radius: 8px; overflow: hidden; cursor: pointer;
    border: 2px solid transparent;
    opacity: 0.45;
    transition: opacity .25s ease, border-color .25s ease, transform .2s ease, box-shadow .25s ease;
  }
  .thumb:hover { opacity: 0.8; transform: scale(1.06); }
  .thumb.active {
    border-color: #2188EF; opacity: 1;
    box-shadow: 0 0 12px rgba(33,136,239,0.25);
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

</style>
</head>
<body>
<div class="gallery">
<div class="counter" id="counter"><strong id="countNum">0</strong> portraits generated</div>
  <div class="viewer" id="viewer">
    <div class="nav-arrow glass left" onclick="goPrev()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></div>
    <div class="empty" id="emptyMsg">No images yet — portraits will appear here as they're generated.</div>
    <div class="img-flipper" id="flipper" style="display:none">
      <div class="flip-inner">
        <img id="mainImg" src="" alt="">
        <img id="origImg" class="back" src="" alt="">
      </div>
      <div class="img-controls" id="imgControls">
        <div class="img-pill glass" id="originalBtn" onclick="toggleOriginal()" title="Toggle between AI portrait and original selfie"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span id="originalLabel">View Original</span></div>
        <div class="img-pill glass active" id="playPauseBtn" onclick="togglePause()" title="Play / Pause auto-rotate"><svg id="playPauseIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span id="playPauseLabel">Playing</span></div>
      </div>
    </div>
    <div class="nav-arrow glass right" onclick="goNext()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
    <div class="fs-btn glass" id="fullscreenBtn" onclick="toggleFullscreen()" title="Toggle fullscreen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Fullscreen</span></div>
  </div>
  <div class="thumbs-wrap">
    <div class="thumbs" id="thumbs"></div>
  </div>
</div>

<script>
var images = [];
var currentIdx = 0;
var autoTimer = null;
var paused = false;
var showingOriginal = false;
var AUTO_INTERVAL = 10000;
var POLL_INTERVAL = 5000;

function imgUrl(filename) { return "/images/" + filename; }
function originalUrl(filename) { return "/images/" + filename.replace("_output_mms.jpg", "_input.jpg"); }

// ── Fetch ──
async function fetchImages() {
  try {
    var r = await fetch("api/images");
    var d = await r.json();
    var oldTotal = images.length;
    var wasOnNewest = currentIdx === 0;

    images = d.images;
    updateCount(d.total, oldTotal);
    renderThumbs();

    // If new images arrived and we were on the newest, show the new one
    if (d.total > oldTotal && oldTotal > 0 && wasOnNewest) {
      showImage(0);
    }
    // First load
    if (oldTotal === 0 && d.total > 0) {
      showImage(0);
      startAuto();
    }
  } catch(e) { /* retry next poll */ }
}

function updateCount(total, oldTotal) {
  var el = document.getElementById("countNum");
  el.textContent = total;
  if (total > oldTotal && oldTotal > 0) {
    var counter = document.getElementById("counter");
    counter.classList.remove("bump");
    void counter.offsetWidth; // reflow
    counter.classList.add("bump");
  }
}

// ── Display ──
function showImage(idx) {
  if (images.length === 0) return;
  idx = ((idx % images.length) + images.length) % images.length;
  currentIdx = idx;

  var flipper = document.getElementById("flipper");
  var img = document.getElementById("mainImg");
  var orig = document.getElementById("origImg");
  var empty = document.getElementById("emptyMsg");
  empty.style.display = "none";
  flipper.style.display = "block";

  // Reset to AI portrait view
  var btn = document.getElementById("originalBtn");
  if (showingOriginal) {
    showingOriginal = false;
    flipper.classList.remove("flipped");
    document.getElementById("originalLabel").textContent = "View Original";
    btn.classList.remove("active");
  }
  document.getElementById("imgControls").classList.add("visible");

  // Crossfade
  img.classList.add("fade-out");
  setTimeout(function() {
    img.src = imgUrl(images[idx]);
    orig.src = originalUrl(images[idx]);
    img.onload = function() { img.classList.remove("fade-out"); };
  }, 200);

  // Update active thumb
  document.querySelectorAll(".thumb").forEach(function(t, i) {
    t.classList.toggle("active", i === idx);
  });
  // Scroll active thumb into view
  var activeThumb = document.querySelector(".thumb.active");
  if (activeThumb) activeThumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

function goNext() {
  if (images.length === 0) return;
  showImage(currentIdx + 1);
}

function goPrev() {
  if (images.length === 0) return;
  showImage(currentIdx - 1);
}

// ── Auto-rotation ──
function updatePlayPauseBtn() {
  var btn = document.getElementById("playPauseBtn");
  var icon = document.getElementById("playPauseIcon");
  var label = document.getElementById("playPauseLabel");
  if (paused) {
    icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    label.textContent = "Paused";
    btn.classList.remove("active");
  } else {
    icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    label.textContent = "Playing";
    btn.classList.add("active");
  }
}

function startAuto() {
  stopAuto();
  paused = false;
  updatePlayPauseBtn();
  autoTimer = setInterval(function() {
    if (images.length > 1) showImage(currentIdx + 1);
  }, AUTO_INTERVAL);
}

function stopAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

function togglePause() {
  if (paused) {
    startAuto();
  } else {
    stopAuto();
    paused = true;
    updatePlayPauseBtn();
  }
}

function toggleOriginal() {
  if (images.length === 0) return;
  var flipper = document.getElementById("flipper");
  var btn = document.getElementById("originalBtn");
  showingOriginal = !showingOriginal;
  var label = document.getElementById("originalLabel");
  if (showingOriginal) {
    flipper.classList.add("flipped");
    label.textContent = "View Portrait";
    btn.classList.add("active");
  } else {
    flipper.classList.remove("flipped");
    label.textContent = "View Original";
    btn.classList.remove("active");
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } else {
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
}

// ── Thumbnails ──
function renderThumbs() {
  var container = document.getElementById("thumbs");
  // Only re-render if count changed
  if (container.children.length === images.length) return;
  var html = "";
  for (var i = 0; i < images.length; i++) {
    html += '<div class="thumb' + (i === currentIdx ? ' active' : '') + '" data-idx="' + i + '">'
      + '<img src="' + imgUrl(images[i]) + '" loading="lazy" alt="">'
      + '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll(".thumb").forEach(function(t) {
    t.addEventListener("click", function() {
      showImage(parseInt(this.dataset.idx));
      if (!paused) startAuto();
    });
  });
}

// ── Keyboard ──
document.addEventListener("keydown", function(e) {
  if (e.key === "ArrowRight") { goNext(); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { goPrev(); e.preventDefault(); }
  else if (e.key === " ") { togglePause(); e.preventDefault(); }
});

// ── Init ──
fetchImages();
setInterval(fetchImages, POLL_INTERVAL);
</script>
</body>
</html>`;

function mountGallery(app) {
    app.use("/gallery", router);
    console.log("🖼️  Gallery mounted at /gallery");
}

module.exports = { mountGallery };
