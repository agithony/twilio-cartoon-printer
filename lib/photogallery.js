const fs = require("fs");
const express = require("express");
const { DOWNLOAD_DIR } = require("./config");

const router = express.Router();

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    res.type("html").send(PAGE_HTML);
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

const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%; height: 100%; overflow: hidden;
  font-family: 'Playfair Display', Georgia, serif;
  -webkit-font-smoothing: antialiased;
}
body {
  background: #1a1410;
  background-image:
    radial-gradient(ellipse at 50% 40%, rgba(60,45,30,0.5) 0%, transparent 70%);
}

.scene { display: flex; flex-direction: column; height: 100vh; }

/* ── Top bar ── */
.top-bar {
  flex-shrink: 0; display: flex; justify-content: center; align-items: center;
  padding: clamp(10px,1.5vh,18px) 20px; gap: 20px; position: relative; z-index: 5;
}
.count-label {
  font-size: clamp(16px,1.4vw,24px); color: rgba(210,195,175,0.6);
  font-style: italic; font-weight: 400; letter-spacing: 0.03em;
}
.count-label strong {
  color: rgba(240,230,215,0.9); font-weight: 700;
  font-size: clamp(24px,2.2vw,40px); font-style: normal;
  display: inline-block;
}
.top-bar.bump strong { animation: cBump .6s cubic-bezier(.36,.07,.19,.97); }
@keyframes cBump {
  0%   { transform: scale(1); color: rgba(240,230,215,0.9); }
  15%  { transform: scale(1.35); color: #c8a96e; }
  30%  { transform: scale(0.95); }
  45%  { transform: scale(1.15); color: #c8a96e; }
  100% { transform: scale(1); color: rgba(240,230,215,0.9); }
}

.top-controls {
  position: absolute; right: 16px; display: flex; gap: 6px;
}
.top-btn {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 12px; color: rgba(210,195,175,0.45);
  font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 500;
  cursor: pointer; user-select: none; display: flex; align-items: center; gap: 5px;
  transition: all .2s ease;
}
.top-btn:hover { color: rgba(240,230,215,0.8); background: rgba(255,255,255,0.1); }
.top-btn svg { width: 14px; height: 14px; }

/* ── Book area ── */
.book-area {
  flex: 1; display: flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 clamp(10px,2vw,40px); position: relative;
}

/* Book wrapper sizes the book */
.book-wrap {
  width: 88vw; height: 64vh;
  display: flex; align-items: center; justify-content: center;
}
@media (max-width: 900px) { .book-wrap { width: 95vw; height: 55vh; } }
@media (max-height: 600px) { .book-wrap { height: 50vh; } }
:fullscreen .book-wrap, :-webkit-full-screen .book-wrap {
  width: 82vw; height: 64vh;
}

/* Empty state */
.empty-msg {
  font-size: clamp(14px,1.2vw,20px); font-style: italic;
  color: rgba(160,145,125,0.4); line-height: 1.6;
  text-align: center;
}

/* ── Book decoration wrapper ── */
.book-decor {
  position: relative;
  filter: drop-shadow(0 18px 50px rgba(0,0,0,0.4));
}

/* Stacked page layers underneath */
.page-layer {
  position: absolute; border-radius: 4px;
  background: linear-gradient(180deg, #e8e2d8, #dfd8cc, #e4ddd2);
  pointer-events: none;
}
.page-layer:nth-child(1) {
  inset: 3px -3px -3px 3px;
  background: linear-gradient(180deg, #e4ddd2, #dcd4c7, #e0d8cc);
}
.page-layer:nth-child(2) {
  inset: 5px -5px -5px 5px;
  background: linear-gradient(180deg, #dfd8cb, #d7cfbf, #dbd3c5);
}
.page-layer:nth-child(3) {
  inset: 7px -7px -7px 7px;
  background: linear-gradient(180deg, #dbd3c5, #d2cab9, #d6cec0);
}
.page-layer:nth-child(4) {
  inset: 9px -9px -9px 9px;
  background: linear-gradient(180deg, #d6cec0, #cdc4b3, #d1c9bb);
  box-shadow: 3px 5px 14px rgba(0,0,0,0.15);
}

/* Book cover — border around the pages */
.book-cover {
  position: absolute; inset: -4px;
  border: 3px solid #5c4a36;
  border-radius: 6px;
  pointer-events: none; z-index: 1;
  box-shadow:
    inset 0 0 6px rgba(0,0,0,0.2),
    0 2px 4px rgba(0,0,0,0.15);
  background: transparent;
}
/* Spine line on the cover */
.book-cover::after {
  content: ''; position: absolute;
  left: 50%; top: -1px; bottom: -1px; width: 6px;
  transform: translateX(-50%);
  background: linear-gradient(90deg,
    rgba(60,46,32,0.6) 0%, rgba(60,46,32,0.15) 30%,
    transparent 50%,
    rgba(60,46,32,0.15) 70%, rgba(60,46,32,0.6) 100%);
}

/* Side page edges (visible page thickness) */
.book-decor::before, .book-decor::after {
  content: ''; position: absolute; z-index: -1;
  top: 4px; bottom: 4px; width: 10px;
}
.book-decor::before {
  left: -10px;
  border-radius: 3px 0 0 3px;
  background:
    repeating-linear-gradient(180deg, #d4ccbf 0px, #d4ccbf 1px, #ddd5c8 1px, #ddd5c8 3px);
  box-shadow: -1px 1px 3px rgba(0,0,0,0.1);
}
.book-decor::after {
  right: -10px;
  border-radius: 0 3px 3px 0;
  background:
    repeating-linear-gradient(180deg, #d4ccbf 0px, #d4ccbf 1px, #ddd5c8 1px, #ddd5c8 3px);
  box-shadow: 1px 1px 3px rgba(0,0,0,0.1);
}

/* ── Page styling ── */
.page {
  background: linear-gradient(135deg, #f5f0e8 0%, #efe9df 50%, #e8e0d4 100%);
  overflow: hidden; position: relative;
}
.page::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.35;
  background-image: url("data:image/svg+xml,%3Csvg width='40' height='40' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
}

/* Photo mount */
.photo-mount {
  position: absolute; z-index: 1;
  top: clamp(18px,3vw,44px);
  left: clamp(18px,3vw,44px);
  right: clamp(18px,3vw,44px);
  bottom: clamp(30px,5vh,58px);
  display: flex; align-items: center; justify-content: center;
}
.photo-frame {
  width: 100%; height: 100%;
  background: #fff;
  padding: clamp(8px,1.2vw,16px);
  box-shadow:
    0 1px 2px rgba(0,0,0,0.06),
    0 3px 8px rgba(0,0,0,0.08),
    0 8px 20px rgba(0,0,0,0.06);
  position: relative;
  display: flex; align-items: center; justify-content: center;
}
.photo-frame img {
  display: block;
  max-width: 100%; max-height: 100%;
  object-fit: contain;
  transition: opacity .4s ease;
}
.photo-frame img.hidden { opacity: 0; position: absolute; }
.photo-frame img.original { position: absolute; inset: clamp(8px,1.2vw,16px); width: auto; height: auto; max-width: calc(100% - clamp(16px,2.4vw,32px)); max-height: calc(100% - clamp(16px,2.4vw,32px)); margin: auto; }

/* Photo corner mounts */
.corner {
  position: absolute; width: clamp(14px,1.4vw,22px); height: clamp(14px,1.4vw,22px);
  z-index: 2;
}
.corner::before, .corner::after {
  content: ''; position: absolute;
  background: rgba(160,140,110,0.18);
}
.corner-tl { top: clamp(2px,0.3vw,5px); left: clamp(2px,0.3vw,5px); }
.corner-tl::before { top: 0; left: 0; width: 100%; height: 2px; }
.corner-tl::after { top: 0; left: 0; width: 2px; height: 100%; }
.corner-tr { top: clamp(2px,0.3vw,5px); right: clamp(2px,0.3vw,5px); }
.corner-tr::before { top: 0; right: 0; width: 100%; height: 2px; }
.corner-tr::after { top: 0; right: 0; width: 2px; height: 100%; }
.corner-bl { bottom: clamp(2px,0.3vw,5px); left: clamp(2px,0.3vw,5px); }
.corner-bl::before { bottom: 0; left: 0; width: 100%; height: 2px; }
.corner-bl::after { bottom: 0; left: 0; width: 2px; height: 100%; }
.corner-br { bottom: clamp(2px,0.3vw,5px); right: clamp(2px,0.3vw,5px); }
.corner-br::before { bottom: 0; right: 0; width: 100%; height: 2px; }
.corner-br::after { bottom: 0; right: 0; width: 2px; height: 100%; }

/* Page numbers */
.page-num {
  position: absolute; bottom: clamp(6px,1vh,12px);
  font-size: clamp(10px,0.8vw,13px); font-style: italic;
  color: rgba(120,105,85,0.7); z-index: 2;
}
.page-num-left { left: clamp(14px,2vw,28px); }
.page-num-right { right: clamp(14px,2vw,28px); }

/* Per-page flip button */
.flip-btn {
  position: absolute; bottom: clamp(12px,2vh,24px); left: 50%;
  transform: translateX(-50%); z-index: 5;
  cursor: pointer; user-select: none;
  background: rgba(130,115,95,0.12);
  border: 1px solid rgba(120,105,85,0.25);
  border-radius: 8px; padding: 4px 14px;
  font-family: 'Inter', sans-serif; font-size: clamp(9px,0.7vw,12px);
  font-weight: 600; color: rgba(100,85,65,0.7);
  transition: all .2s ease; white-space: nowrap;
}
.flip-btn:hover { color: rgba(80,65,45,0.9); background: rgba(130,115,95,0.18); border-color: rgba(120,105,85,0.35); }
.flip-btn.active { color: #7a6540; border-color: rgba(122,101,64,0.4); background: rgba(122,101,64,0.1); }

/* ── Nav arrows ── */
.arrow {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 10;
  cursor: pointer; user-select: none;
  width: clamp(42px,3.4vw,54px); height: clamp(42px,3.4vw,54px);
  border-radius: 50%;
  background: rgba(30,22,16,0.6);
  border: 1px solid rgba(210,195,175,0.12);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  color: rgba(210,195,175,0.5);
  transition: all .2s ease;
}
.arrow:hover {
  background: rgba(40,30,22,0.8); color: rgba(240,230,215,0.85);
  border-color: rgba(210,195,175,0.2); transform: translateY(-50%) scale(1.06);
}
.arrow:active { transform: translateY(-50%) scale(0.95); }
.arrow svg { width: 20px; height: 20px; }
.arrow.left { left: clamp(6px,1.2vw,20px); }
.arrow.right { right: clamp(6px,1.2vw,20px); }

/* ── Bottom bar ── */
.bottom-bar {
  flex-shrink: 0; display: none; flex-direction: column; align-items: stretch;
  padding: clamp(6px,1vh,12px) 0 0; width: 100%;
}
.bottom-bar.visible { display: flex; }

.controls {
  display: flex; gap: 8px; margin-bottom: clamp(6px,0.8vh,10px);
  justify-content: center;
}
.ctrl-btn {
  background: rgba(255,255,255,0.05); border: 1px solid rgba(210,195,175,0.1);
  border-radius: 10px; padding: 7px 16px;
  font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500;
  color: rgba(210,195,175,0.45); cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px;
  transition: all .2s ease;
}
.ctrl-btn:hover { color: rgba(240,230,215,0.75); background: rgba(255,255,255,0.08); }
.ctrl-btn:active { transform: scale(0.97); }
.ctrl-btn.active { color: #c8a96e; border-color: rgba(200,169,110,0.2); }
.ctrl-btn svg { width: 15px; height: 15px; flex-shrink: 0; }

/* ── Thumbnail strip ── */
.thumbs-bar {
  flex-shrink: 0; padding: clamp(4px,0.6vh,8px) 0 clamp(10px,1.4vh,18px);
  width: 100%;
}
.thumbs {
  display: flex; gap: clamp(8px,0.7vw,12px);
  overflow-x: auto; padding: 0 clamp(16px,3vw,40px);
  scrollbar-width: none; scroll-behavior: smooth;
}
.thumbs::-webkit-scrollbar { display: none; }
.thumb {
  width: clamp(50px,7vh,100px); height: clamp(50px,7vh,100px);
  flex-shrink: 0; cursor: pointer;
  background: #fff; padding: 3px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.15);
  opacity: 0.4;
  transition: all .25s ease;
}
.thumb:hover { opacity: 0.75; transform: translateY(-3px) rotate(-1deg); }
.thumb.active {
  opacity: 1; transform: translateY(-2px);
  box-shadow: 0 2px 6px rgba(0,0,0,0.25), 0 0 0 2px rgba(200,169,110,0.5);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* ── Fullscreen overrides ── */
:fullscreen .thumb, :-webkit-full-screen .thumb {
  width: clamp(60px,8vh,120px); height: clamp(60px,8vh,120px); padding: 4px;
}
:fullscreen .thumbs, :-webkit-full-screen .thumbs {
  gap: clamp(10px,1vw,18px);
}
:fullscreen .count-label, :-webkit-full-screen .count-label {
  font-size: clamp(20px,1.8vw,30px);
}
:fullscreen .count-label strong, :-webkit-full-screen .count-label strong {
  font-size: clamp(30px,2.8vw,48px);
}
:fullscreen .page-num, :-webkit-full-screen .page-num {
  font-size: clamp(12px,1vw,16px);
}
:fullscreen .flip-btn, :-webkit-full-screen .flip-btn {
  font-size: clamp(11px,0.8vw,14px); padding: 5px 18px;
}
`;

const PAGE_BODY = `
<div class="scene">
  <div class="top-bar" id="topBar">
    <span class="count-label"><strong id="countNum">0</strong> portraits created</span>
    <div class="top-controls">
      <div class="top-btn" onclick="toggleFullscreen()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Fullscreen</span></div>
    </div>
  </div>

  <div class="book-area">
    <div class="arrow left" onclick="goPrev()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></div>
    <div class="book-wrap" id="bookWrap">
      <div class="empty-msg" id="emptyMsg">Portraits will appear<br>as they are created&hellip;</div>
    </div>
    <div class="arrow right" onclick="goNext()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
  </div>

  <div class="bottom-bar" id="bottomBar">
    <div class="controls">
      <div class="ctrl-btn active" id="playPauseBtn" onclick="togglePause()"><svg id="ppIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span id="ppLabel">Playing</span></div>
    </div>
    <div class="thumbs-bar">
      <div class="thumbs" id="thumbs"></div>
    </div>
  </div>
</div>
`;

const PAGE_JS = `
var images = [];
var bookReady = false;
var autoTimer = null, paused = false;
var AUTO_INTERVAL = 10000, POLL_INTERVAL = 5000;
var flipped = {};

function imgUrl(f) { return "/images/" + f; }
function origUrl(f) { return "/images/" + f.replace("_output_mms.jpg", "_input.jpg"); }

/* ── Build the book ── */
function initBook() {
  var wrap = document.getElementById("bookWrap");

  // Destroy previous book if any
  var oldDecor = document.getElementById("bookDecor");
  if (oldDecor) {
    var oldBook = document.getElementById("book");
    if (oldBook) $(oldBook).turn("destroy");
    oldDecor.remove();
  }
  bookReady = false;
  flipped = {};

  if (images.length === 0) return;

  document.getElementById("emptyMsg").style.display = "none";
  document.getElementById("bottomBar").classList.add("visible");

  // Create decoration wrapper
  var decor = document.createElement("div");
  decor.className = "book-decor";
  decor.id = "bookDecor";

  // Page layers (stacked behind)
  for (var l = 0; l < 4; l++) {
    var layer = document.createElement("div");
    layer.className = "page-layer";
    decor.appendChild(layer);
  }

  // Book cover border
  var cover = document.createElement("div");
  cover.className = "book-cover";
  decor.appendChild(cover);

  // Create book element
  var book = document.createElement("div");
  book.id = "book";
  book.style.position = "relative";
  book.style.zIndex = "2";
  var n = images.length;

  for (var i = 0; i < n; i++) {
    var pg = document.createElement("div");
    pg.className = "page";
    pg.dataset.index = i;
    // turn.js: odd pages (1,3,5…) = right, even pages (2,4,6…) = left
    var turnPage = i + 1;
    var isRight = (turnPage % 2 === 1);
    var pageNum = n - i;

    pg.innerHTML =
      '<div class="photo-mount">' +
        '<div class="photo-frame">' +
          '<div class="corner corner-tl"></div>' +
          '<div class="corner corner-tr"></div>' +
          '<div class="corner corner-bl"></div>' +
          '<div class="corner corner-br"></div>' +
          '<img class="portrait" src="' + imgUrl(images[i]) + '" alt="">' +
          '<img class="original hidden" src="' + origUrl(images[i]) + '" alt="">' +
        '</div>' +
      '</div>' +
      '<div class="flip-btn" data-idx="' + i + '">View Original</div>' +
      '<div class="page-num ' + (isRight ? 'page-num-right' : 'page-num-left') + '">' + pageNum + '</div>';
    book.appendChild(pg);
  }

  decor.appendChild(book);
  wrap.appendChild(decor);

  // Size the book to fill the wrapper
  var w = wrap.clientWidth;
  var h = wrap.clientHeight;
  // Maintain 3:4 aspect ratio per page (so 3:2 total for spread)
  var bookW = Math.min(w, h * 1.5);
  var bookH = bookW / 1.5;
  if (bookH > h) { bookH = h; bookW = bookH * 1.5; }

  decor.style.width = bookW + "px";
  decor.style.height = bookH + "px";

  $(book).turn({
    width: bookW,
    height: bookH,
    display: "double",
    acceleration: true,
    gradients: true,
    elevation: 50,
    page: 1,
    when: {
      turned: function(e, page) {
        highlightThumbs();
        if (!paused) startAuto();
      }
    }
  });

  bookReady = true;

  // Bind flip-btn clicks (delegated)
  $(book).on("click", ".flip-btn", function() {
    var idx = parseInt(this.dataset.idx);
    toggleFlip(idx, this);
  });

  highlightThumbs();
}

/* ── Fetch images ── */
async function fetchImages() {
  try {
    var r = await fetch("api/images"), d = await r.json();
    var oldLen = images.length;
    images = d.images;
    updateCount(d.total, oldLen);

    if (d.total !== oldLen && d.total > 0) {
      initBook();
      renderThumbs();
      highlightThumbs();
      if (oldLen === 0) startAuto();
    }
  } catch(e) {}
}

function updateCount(t, o) {
  document.getElementById("countNum").textContent = t;
  if (t > o && o > 0) {
    var b = document.getElementById("topBar");
    b.classList.remove("bump");
    void b.offsetWidth;
    b.classList.add("bump");
  }
}

/* ── Navigation ── */
function goNext() {
  if (!bookReady) return;
  $("#book").turn("next");
}
function goPrev() {
  if (!bookReady) return;
  $("#book").turn("previous");
}

/* ── Thumbnails ── */
function renderThumbs() {
  var c = document.getElementById("thumbs");
  if (c.children.length === images.length) return;
  var h = "";
  for (var i = 0; i < images.length; i++) {
    h += '<div class="thumb" data-page="' + (i + 1) + '"><img src="' + imgUrl(images[i]) + '" loading="lazy" alt=""></div>';
  }
  c.innerHTML = h;
  c.querySelectorAll(".thumb").forEach(function(t) {
    t.addEventListener("click", function() {
      if (!bookReady) return;
      var pg = parseInt(this.dataset.page);
      $("#book").turn("page", pg);
    });
  });
}

function highlightThumbs() {
  if (!bookReady) return;
  var view = $("#book").turn("view");
  var thumbs = document.querySelectorAll(".thumb");
  thumbs.forEach(function(t) {
    var pg = parseInt(t.dataset.page);
    t.classList.toggle("active", view.indexOf(pg) !== -1);
  });
  // Scroll active into view
  var tc = document.getElementById("thumbs");
  var first = view[0] || view[1];
  if (first && thumbs[first - 1]) {
    var thumb = thumbs[first - 1];
    var scrollLeft = thumb.offsetLeft - tc.clientWidth / 2 + thumb.offsetWidth / 2;
    tc.scrollTo({ left: scrollLeft, behavior: "smooth" });
  }
}

/* ── Auto-rotate ── */
function updatePPBtn() {
  var ic = document.getElementById("ppIcon"), lb = document.getElementById("ppLabel"), bt = document.getElementById("playPauseBtn");
  if (paused) {
    ic.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    lb.textContent = "Paused"; bt.classList.remove("active");
  } else {
    ic.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    lb.textContent = "Playing"; bt.classList.add("active");
  }
}
function startAuto() {
  stopAuto(); paused = false; updatePPBtn();
  autoTimer = setInterval(function() {
    if (!bookReady) return;
    var cur = $("#book").turn("page");
    var total = $("#book").turn("pages");
    if (cur + 2 > total) {
      $("#book").turn("page", 1);
    } else {
      $("#book").turn("next");
    }
  }, AUTO_INTERVAL);
}
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
function togglePause() { if (paused) startAuto(); else { stopAuto(); paused = true; updatePPBtn(); } }

/* ── View Original (swap images) ── */
function toggleFlip(idx, btn) {
  var page = document.querySelector('.page[data-index="' + idx + '"]');
  if (!page) return;
  var portrait = page.querySelector(".portrait");
  var original = page.querySelector(".original");
  flipped[idx] = !flipped[idx];
  if (flipped[idx]) {
    portrait.classList.add("hidden");
    original.classList.remove("hidden");
    btn.textContent = "View Portrait"; btn.classList.add("active");
  } else {
    original.classList.add("hidden");
    portrait.classList.remove("hidden");
    btn.textContent = "View Original"; btn.classList.remove("active");
  }
}

/* ── Fullscreen ── */
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

/* Resize book on fullscreen change */
function resizeBook() {
  if (!bookReady) return;
  setTimeout(function() {
    var wrap = document.getElementById("bookWrap");
    var decor = document.getElementById("bookDecor");
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    var bookW = Math.min(w, h * 1.5);
    var bookH = bookW / 1.5;
    if (bookH > h) { bookH = h; bookW = bookH * 1.5; }
    if (decor) { decor.style.width = bookW + "px"; decor.style.height = bookH + "px"; }
    $("#book").turn("size", bookW, bookH);
  }, 100);
}
document.addEventListener("fullscreenchange", resizeBook);
document.addEventListener("webkitfullscreenchange", resizeBook);
window.addEventListener("resize", resizeBook);

/* ── Keyboard ── */
document.addEventListener("keydown", function(e) {
  if (e.key === "ArrowRight") { goNext(); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { goPrev(); e.preventDefault(); }
  else if (e.key === " ") { togglePause(); e.preventDefault(); }
});

/* ── Init ── */
fetchImages();
setInterval(fetchImages, POLL_INTERVAL);
`;

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo Book — Twilio AI Photobooth</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/turn.js/3/turn.min.js"></script>
<style>${PAGE_CSS}</style>
</head>
<body>
${PAGE_BODY}
<script>${PAGE_JS}</script>
</body>
</html>`;

function mountPhotoGallery(app) {
    app.use("/photogallery", router);
    console.log("📖 Photo gallery mounted at /photogallery");
}

module.exports = { mountPhotoGallery };
