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
  font-size: clamp(13px,1.1vw,18px); color: rgba(210,195,175,0.6);
  font-style: italic; font-weight: 400; letter-spacing: 0.03em;
}
.count-label strong {
  color: rgba(240,230,215,0.9); font-weight: 600;
  font-size: clamp(15px,1.3vw,22px); font-style: normal;
}
.top-bar.bump strong { animation: cBump .4s ease; }
@keyframes cBump { 0%{transform:scale(1)} 40%{transform:scale(1.18);color:#c8a96e} 100%{transform:scale(1)} }

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

/* The open book */
.book {
  display: flex; position: relative;
  width: 88vw; height: 64vh;
  perspective: 2000px;
  border-radius: 6px;
  filter: drop-shadow(0 18px 50px rgba(0,0,0,0.35));
}
@media (max-width: 900px) { .book { width: 95vw; height: 55vh; } }
@media (max-height: 600px) { .book { height: 50vh; } }
/* Fullscreen — fill the screen */
:fullscreen .book, :-webkit-full-screen .book {
  width: 82vw; height: 64vh;
}

/* Shared page base */
.pg {
  width: 50%; height: 100%; position: relative;
}

/* Left page */
.pg-left {
  background: linear-gradient(105deg, #f5f0e8 0%, #efe9df 60%, #e8e0d4 100%);
  border-radius: 6px 0 0 6px;
  box-shadow:
    inset -2px 0 8px rgba(0,0,0,0.08),
    inset 0 0 30px rgba(0,0,0,0.03),
    -6px 6px 20px rgba(0,0,0,0.25);
  overflow: hidden;
}
/* Subtle page texture (both pages) */
.pg-left::after, .pg-right::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.35;
  background-image: url("data:image/svg+xml,%3Csvg width='40' height='40' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
}

/* Page numbers */
.page-num {
  position: absolute; bottom: clamp(8px,1vh,14px);
  font-size: clamp(10px,0.8vw,13px); font-style: italic;
  color: rgba(120,105,85,0.7); z-index: 2;
}
.page-num-left { left: clamp(16px,2vw,30px); }
.page-num-right { right: clamp(16px,2vw,30px); }

/* Empty state */
.empty-msg {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: clamp(14px,1.2vw,20px); font-style: italic;
  color: rgba(160,145,125,0.4); line-height: 1.6;
  text-align: center; z-index: 1; padding: 30px;
}

/* Right page */
.pg-right {
  background: linear-gradient(255deg, #f5f0e8 0%, #efe9df 60%, #e8e0d4 100%);
  border-radius: 0 6px 6px 0;
  box-shadow:
    inset 2px 0 8px rgba(0,0,0,0.08),
    inset 0 0 30px rgba(0,0,0,0.03),
    6px 6px 20px rgba(0,0,0,0.25);
  overflow: hidden;
}
/* Book spine */
.spine {
  position: absolute; left: 50%; top: 0; bottom: 0; width: 8px;
  transform: translateX(-50%); z-index: 3;
  background: linear-gradient(90deg,
    rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.02) 30%,
    rgba(0,0,0,0.0) 50%,
    rgba(0,0,0,0.02) 70%, rgba(0,0,0,0.12) 100%);
}
/* Stacked page layers underneath the book */
.page-stack { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
.page-layer {
  position: absolute; border-radius: 6px;
  background: linear-gradient(180deg, #e8e2d8, #dfd8cc, #e4ddd2);
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
  box-shadow: 3px 5px 12px rgba(0,0,0,0.12);
}
/* Side edge lines for realism */
.book::before, .book::after {
  content: ''; position: absolute; z-index: -1;
}
.book::before {
  left: -10px; top: 3px; bottom: 3px; width: 10px;
  border-radius: 3px 0 0 3px;
  background: linear-gradient(90deg, #cec5b6, #d8d0c3 30%, #e0d8cc);
  background-size: 100% 3px;
  background-image:
    linear-gradient(90deg, #cec5b6, #d8d0c3 30%, #e0d8cc),
    repeating-linear-gradient(180deg, #d4ccbf, #d4ccbf 1px, transparent 1px, transparent 3px);
}
.book::after {
  right: -10px; top: 3px; bottom: 3px; width: 10px;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(270deg, #cec5b6, #d8d0c3 30%, #e0d8cc);
  background-size: 100% 3px;
  background-image:
    linear-gradient(270deg, #cec5b6, #d8d0c3 30%, #e0d8cc),
    repeating-linear-gradient(180deg, #d4ccbf, #d4ccbf 1px, transparent 1px, transparent 3px);
}

/* Page turn overlay */
.page-turn {
  position: absolute; inset: 0; z-index: 20; pointer-events: none;
  transform-origin: left center;
  backface-visibility: hidden;
  background: linear-gradient(255deg, #f2ede5 0%, #ebe5db 40%, #e5ddd2 100%);
  border-radius: 0 6px 6px 0;
  box-shadow: -4px 0 12px rgba(0,0,0,0.18), 0 0 30px rgba(0,0,0,0.06);
  display: none;
}
.pg-left.turning-left {
  animation: pageInfoFade .55s ease;
}
@keyframes pageInfoFade {
  0% { opacity: 1; }
  40% { opacity: 0.3; }
  100% { opacity: 1; }
}

/* Photo mount — absolute so it gets a definite size from the page */
.photo-mount {
  position: absolute; z-index: 1;
  top: clamp(22px,3vw,48px);
  left: clamp(22px,3vw,48px);
  right: clamp(22px,3vw,48px);
  bottom: clamp(34px,5vh,62px);
  display: flex; align-items: center; justify-content: center;
  perspective: 1200px;
  transform-style: preserve-3d;
}
.photo-inner {
  width: 100%; height: 100%;
  position: relative; transform-style: preserve-3d;
  transition: transform .7s cubic-bezier(.4,0,.2,1);
}
.photo-mount.flipped .photo-inner { transform: rotateY(180deg); }

.photo-frame {
  width: 100%; height: 100%;
  background: #fff;
  padding: clamp(10px,1.2vw,18px);
  box-shadow:
    0 1px 2px rgba(0,0,0,0.06),
    0 3px 8px rgba(0,0,0,0.08),
    0 8px 20px rgba(0,0,0,0.06);
  position: relative;
  transform-style: preserve-3d;
  display: flex; align-items: center; justify-content: center;
}
.photo-frame img {
  display: block;
  max-width: 100%; max-height: 100%;
  object-fit: contain; backface-visibility: hidden;
  transition: opacity .5s ease;
}
.photo-frame img.fade { opacity: 0; }
.photo-frame img.back-img {
  position: absolute;
  top: clamp(10px,1.2vw,18px); left: clamp(10px,1.2vw,18px);
  width: calc(100% - clamp(20px,2.4vw,36px));
  height: calc(100% - clamp(20px,2.4vw,36px));
  object-fit: contain;
  transform: rotateY(180deg);
}

/* Photo corner mounts */
.corner {
  position: absolute; width: clamp(16px,1.5vw,24px); height: clamp(16px,1.5vw,24px);
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

/* Per-page flip button — sits on the page between photo and page number */
.flip-btn {
  position: absolute; bottom: clamp(14px,2vh,26px); left: 50%;
  transform: translateX(-50%); z-index: 5;
  cursor: pointer; user-select: none;
  background: rgba(130,115,95,0.12);
  border: 1px solid rgba(120,105,85,0.25);
  border-radius: 8px; padding: 4px 14px;
  font-family: 'Inter', sans-serif; font-size: clamp(9px,0.7vw,12px);
  font-weight: 600; color: rgba(100,85,65,0.7);
  transition: all .2s ease; white-space: nowrap;
  display: none;
}
.flip-btn.visible { display: block; }
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
  font-size: clamp(16px,1.6vw,24px);
}
:fullscreen .count-label strong, :-webkit-full-screen .count-label strong {
  font-size: clamp(20px,2vw,32px);
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

    <div class="book">
      <div class="page-stack">
        <div class="page-layer"></div>
        <div class="page-layer"></div>
        <div class="page-layer"></div>
        <div class="page-layer"></div>
      </div>
      <div class="pg pg-left" id="pgLeft">
        <div class="empty-msg" id="emptyMsg">Portraits will appear<br>as they are created&hellip;</div>
        <div class="photo-mount" id="mountL" style="display:none">
          <div class="photo-inner" id="innerL">
            <div class="photo-frame">
              <div class="corner corner-tl"></div>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
              <div class="corner corner-br"></div>
              <img id="imgL" src="" alt="">
              <img id="origL" class="back-img" src="" alt="">
            </div>
          </div>
        </div>
        <div class="flip-btn" id="flipL" onclick="toggleFlip('L')">View Original</div>
        <div class="page-num page-num-left" id="pageNumL"></div>
      </div>
      <div class="spine"></div>
      <div class="pg pg-right" id="pgRight">
        <div class="page-turn" id="pageTurn"></div>
        <div class="photo-mount" id="mountR" style="display:none">
          <div class="photo-inner" id="innerR">
            <div class="photo-frame">
              <div class="corner corner-tl"></div>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
              <div class="corner corner-br"></div>
              <img id="imgR" src="" alt="">
              <img id="origR" class="back-img" src="" alt="">
            </div>
          </div>
        </div>
        <div class="flip-btn" id="flipR" onclick="toggleFlip('R')">View Original</div>
        <div class="page-num page-num-right" id="pageNumR"></div>
      </div>
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
var images=[], spread=0, autoTimer=null, paused=false;
var flippedL=false, flippedR=false;
var turning=false;
var AUTO_INTERVAL=10000, POLL_INTERVAL=5000;

function totalSpreads(){ return Math.ceil(images.length/2); }
function imgUrl(f){return "/images/"+f;}
function origUrl(f){return "/images/"+f.replace("_output_mms.jpg","_input.jpg");}

async function fetchImages(){
  try{
    var r=await fetch("api/images"), d=await r.json();
    var old=images.length, wasNewest=spread===0;
    images=d.images; updateCount(d.total,old); renderThumbs();
    if(d.total>old&&old>0&&wasNewest) showSpread(0,false);
    if(old===0&&d.total>0){ showSpread(0,false); startAuto(); }
  }catch(e){}
}

function updateCount(t,o){
  document.getElementById("countNum").textContent=t;
  if(t>o&&o>0){var b=document.getElementById("topBar");b.classList.remove("bump");void b.offsetWidth;b.classList.add("bump");}
}

/* ── Page turn via overlay ── */
function doPageTurn(cb){
  if(turning){ cb(); return; }
  turning=true;
  var ov=document.getElementById("pageTurn");
  var pgL=document.getElementById("pgLeft");
  ov.style.display="block";
  ov.style.transition="none";
  ov.style.transform="rotateY(-180deg)";
  void ov.offsetWidth;
  pgL.classList.add("turning-left");

  ov.style.transition="transform .28s ease-in";
  ov.style.transform="rotateY(0deg)";
  ov.addEventListener("transitionend",function p1(){
    ov.removeEventListener("transitionend",p1);
    cb();
    requestAnimationFrame(function(){
      ov.style.transition="transform .28s ease-out";
      ov.style.transform="rotateY(180deg)";
      ov.addEventListener("transitionend",function p2(){
        ov.removeEventListener("transitionend",p2);
        ov.style.display="none";
        pgL.classList.remove("turning-left");
        turning=false;
      });
    });
  });
}

function applySpread(s){
  var iL=s*2, iR=s*2+1;
  var n=images.length;

  // Left page (always has an image if spread is valid)
  document.getElementById("imgL").src=imgUrl(images[iL]);
  document.getElementById("origL").src=origUrl(images[iL]);
  document.getElementById("pageNumL").textContent=n-iL;
  document.getElementById("flipL").classList.add("visible");

  // Right page (might be empty if odd total)
  var mountR=document.getElementById("mountR");
  if(iR<n){
    mountR.style.display="flex";
    document.getElementById("imgR").src=imgUrl(images[iR]);
    document.getElementById("origR").src=origUrl(images[iR]);
    document.getElementById("pageNumR").textContent=n-iR;
    document.getElementById("flipR").classList.add("visible");
  }else{
    mountR.style.display="none";
    document.getElementById("pageNumR").textContent="";
    document.getElementById("flipR").classList.remove("visible");
  }
}

function showSpread(s,animate){
  if(!images.length)return;
  var max=totalSpreads();
  s=((s%max)+max)%max;
  var isFirst=document.getElementById("mountL").style.display!=="flex";
  var changed=s!==spread||isFirst;
  spread=s;

  // Reset auto-rotate timer on any manual navigation
  if(animate && !paused) startAuto();

  document.getElementById("emptyMsg").style.display="none";
  document.getElementById("mountL").style.display="flex";
  document.getElementById("mountR").style.display="flex";
  document.getElementById("bottomBar").classList.add("visible");

  // Reset flip state for both pages
  resetFlip();

  highlightThumbs(s);

  if(changed && animate!==false && !isFirst){
    doPageTurn(function(){ applySpread(s); });
  }else{
    applySpread(s);
  }
}

function resetFlip(){
  if(flippedL){
    flippedL=false;
    document.getElementById("mountL").classList.remove("flipped");
    var bL=document.getElementById("flipL");
    bL.textContent="View Original"; bL.classList.remove("active");
  }
  if(flippedR){
    flippedR=false;
    document.getElementById("mountR").classList.remove("flipped");
    var bR=document.getElementById("flipR");
    bR.textContent="View Original"; bR.classList.remove("active");
  }
}

function highlightThumbs(s){
  var iL=s*2, iR=s*2+1;
  var thumbs=document.querySelectorAll(".thumb");
  thumbs.forEach(function(t,i){ t.classList.toggle("active",i===iL||i===iR); });
  var tc=document.getElementById("thumbs");
  if(thumbs[iL]){
    var thumb=thumbs[iL];
    var scrollLeft=thumb.offsetLeft - tc.clientWidth/2 + thumb.offsetWidth/2;
    tc.scrollTo({left:scrollLeft,behavior:"smooth"});
  }
}

function goNext(){ if(totalSpreads()>1) showSpread(spread+1,true); }
function goPrev(){ if(totalSpreads()>1) showSpread(spread-1,true); }

function updatePPBtn(){
  var ic=document.getElementById("ppIcon"),lb=document.getElementById("ppLabel"),bt=document.getElementById("playPauseBtn");
  if(paused){ic.innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';lb.textContent="Paused";bt.classList.remove("active");}
  else{ic.innerHTML='<polygon points="5 3 19 12 5 21 5 3"/>';lb.textContent="Playing";bt.classList.add("active");}
}
function startAuto(){stopAuto();paused=false;updatePPBtn();autoTimer=setInterval(function(){if(totalSpreads()>1)showSpread(spread+1,true);},AUTO_INTERVAL);}
function stopAuto(){if(autoTimer){clearInterval(autoTimer);autoTimer=null;}}
function togglePause(){if(paused)startAuto();else{stopAuto();paused=true;updatePPBtn();}}

function toggleFlip(side){
  if(!images.length||turning)return;
  var mount=document.getElementById("mount"+side);
  var btn=document.getElementById("flip"+side);
  if(side==="L"){
    flippedL=!flippedL;
    if(flippedL){ mount.classList.add("flipped"); btn.textContent="View Portrait"; btn.classList.add("active"); }
    else{ mount.classList.remove("flipped"); btn.textContent="View Original"; btn.classList.remove("active"); }
  }else{
    flippedR=!flippedR;
    if(flippedR){ mount.classList.add("flipped"); btn.textContent="View Portrait"; btn.classList.add("active"); }
    else{ mount.classList.remove("flipped"); btn.textContent="View Original"; btn.classList.remove("active"); }
  }
}

function toggleFullscreen(){
  if(document.fullscreenElement||document.webkitFullscreenElement){
    if(document.exitFullscreen)document.exitFullscreen();
    else if(document.webkitExitFullscreen)document.webkitExitFullscreen();
  }else{
    var el=document.documentElement;
    if(el.requestFullscreen)el.requestFullscreen();
    else if(el.webkitRequestFullscreen)el.webkitRequestFullscreen();
  }
}

function renderThumbs(){
  var c=document.getElementById("thumbs");
  if(c.children.length===images.length)return;
  var h="";
  for(var i=0;i<images.length;i++){
    var s=Math.floor(i/2);
    h+='<div class="thumb'+(s===spread?' active':'')+'" data-spread="'+s+'"><img src="'+imgUrl(images[i])+'" loading="lazy" alt=""></div>';
  }
  c.innerHTML=h;
  c.querySelectorAll(".thumb").forEach(function(t){
    t.addEventListener("click",function(){
      var s=parseInt(this.dataset.spread);
      if(s!==spread) showSpread(s,true);
    });
  });
}

document.addEventListener("keydown",function(e){
  if(e.key==="ArrowRight"){goNext();e.preventDefault();}
  else if(e.key==="ArrowLeft"){goPrev();e.preventDefault();}
  else if(e.key===" "){togglePause();e.preventDefault();}
});

fetchImages();
setInterval(fetchImages,POLL_INTERVAL);
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
