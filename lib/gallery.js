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
<title>Gallery — Twilio AI Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e1e4e8; }

  .gallery { display: flex; flex-direction: column; height: 100vh; }

  /* Counter */
  .counter {
    text-align: center; padding: 14px 0 8px; flex-shrink: 0;
    font-size: clamp(13px, 1.2vw, 20px); color: #6e7681; font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .counter strong { color: #f0f6fc; font-size: clamp(16px, 1.5vw, 26px); }
  .counter.bump strong { animation: bump .35s ease; }
  @keyframes bump { 0% { transform: scale(1); } 50% { transform: scale(1.25); color: #3fb950; } 100% { transform: scale(1); } }

  /* Main image area */
  .viewer {
    flex: 1; position: relative; display: flex; align-items: center; justify-content: center;
    overflow: hidden; min-height: 0;
  }
  .viewer img {
    max-width: 90%; max-height: 100%; object-fit: contain; border-radius: 6px;
    transition: opacity .4s ease;
  }
  .viewer img.fade-out { opacity: 0; }
  .viewer .empty {
    color: #484f58; font-size: clamp(14px, 1.2vw, 20px); text-align: center;
  }

  /* Nav arrows */
  .nav-arrow {
    position: absolute; top: 50%; transform: translateY(-50%);
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.5); font-size: clamp(20px, 2vw, 36px);
    width: clamp(36px, 3.5vw, 56px); height: clamp(60px, 7vh, 100px);
    border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background .15s, color .15s; z-index: 10; user-select: none;
  }
  .nav-arrow:hover { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.85); }
  .nav-arrow.left { left: clamp(100px, 18vw, 320px); }
  .nav-arrow.right { right: clamp(100px, 18vw, 320px); }

  /* Top toolbar */
  .toolbar {
    position: absolute; top: 12px; right: 12px; z-index: 10;
    display: flex; gap: 6px;
  }
  .tool-btn {
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1);
    color: #8b949e; font-size: 14px; padding: 6px 12px; border-radius: 6px;
    cursor: pointer; display: flex; align-items: center; gap: 6px;
    transition: background .15s, color .15s; user-select: none;
  }
  .tool-btn:hover { background: rgba(255,255,255,0.12); color: #e1e4e8; }
  .tool-btn.active { color: #58a6ff; }

  /* Thumbnail strip */
  .thumbs-wrap {
    flex-shrink: 0; padding: 10px 0 14px; overflow: hidden;
  }
  .thumbs {
    display: flex; gap: 6px; overflow-x: auto; padding: 0 14px;
    scrollbar-width: thin; scrollbar-color: #272d37 #000;
    scroll-behavior: smooth;
  }
  .thumbs::-webkit-scrollbar { height: 4px; }
  .thumbs::-webkit-scrollbar-track { background: #000; }
  .thumbs::-webkit-scrollbar-thumb { background: #272d37; border-radius: 2px; }
  .thumb {
    width: clamp(56px, 5.5vw, 88px); height: clamp(56px, 5.5vw, 88px);
    flex-shrink: 0; border-radius: 6px; overflow: hidden; cursor: pointer;
    border: 2px solid transparent; transition: border-color .15s, transform .15s;
    opacity: 0.6; transition: opacity .15s, border-color .15s, transform .15s;
  }
  .thumb:hover { opacity: 0.9; transform: scale(1.05); }
  .thumb.active { border-color: #58a6ff; opacity: 1; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

  /* Home link */
  .home-link {
    position: fixed; top: 10px; left: 12px; z-index: 20;
    color: #484f58; text-decoration: none; font-size: 12px;
    padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,0.4);
    transition: color .15s;
  }
  .home-link:hover { color: #8b949e; }
</style>
</head>
<body>
<div class="gallery">
  <a href="/home/" class="home-link">&larr; Home</a>
  <div class="counter" id="counter"><strong id="countNum">0</strong> portraits generated</div>
  <div class="viewer" id="viewer">
    <div class="nav-arrow left" onclick="goPrev()">&lsaquo;</div>
    <div class="empty" id="emptyMsg">No images yet — portraits will appear here as they're generated.</div>
    <img id="mainImg" src="" alt="" style="display:none">
    <div class="nav-arrow right" onclick="goNext()">&rsaquo;</div>
    <div class="toolbar">
      <div class="tool-btn active" id="playPauseBtn" onclick="togglePause()" title="Play / Pause auto-rotate">&#9654; Playing</div>
      <div class="tool-btn" id="fullscreenBtn" onclick="toggleFullscreen()" title="Toggle fullscreen">&#x26F6; Fullscreen</div>
    </div>
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
var AUTO_INTERVAL = 10000;
var POLL_INTERVAL = 5000;

function imgUrl(filename) { return "/images/" + filename; }

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

  var img = document.getElementById("mainImg");
  var empty = document.getElementById("emptyMsg");
  empty.style.display = "none";
  img.style.display = "block";

  // Crossfade
  img.classList.add("fade-out");
  setTimeout(function() {
    img.src = imgUrl(images[idx]);
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
  if (paused) {
    btn.innerHTML = "&#9208; Paused";
    btn.classList.remove("active");
  } else {
    btn.innerHTML = "&#9654; Playing";
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
    console.log("\\u{1F5BC} Gallery mounted at /gallery");
}

module.exports = { mountGallery };
