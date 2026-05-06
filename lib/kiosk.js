// Kiosk camera page — opens the device camera, captures a selfie, and
// submits it to /api/generate. Admin-only (inherits the global auth
// middleware from index.js). Shows live status and the final image.

const express = require("express");
const settings = require("./settings");

const router = express.Router();

router.get("/", (req, res) => {
    const activeStyleList = settings.getActiveStyleList();
    const activeStyles = settings.getActiveStyles();
    const eventName = settings.get("eventName");
    const styleOptions = activeStyleList.map((key) => {
        const s = activeStyles[key];
        return { key, name: (s && s.name) || key };
    });

    res.type("html").send(buildKioskHtml({ styleOptions, eventName }));
});

function buildKioskHtml({ styleOptions, eventName }) {
    // Escape </ so a style name containing </script> can't break out of the
    // <script> block and inject arbitrary JS. The result is still valid JSON.
    const styleJson = JSON.stringify(styleOptions).replace(/<\//g, "<\\/");
    const escapedEvent = String(eventName || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiosk — Twilio Photobooth</title>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000D25; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; overflow: hidden; }
  .wrap { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; gap: 20px; }
  h1 { font-size: 28px; font-weight: 800; }
  .event-tag { font-size: 13px; color: #8a93ac; margin-top: -12px; }
  .stage { position: relative; width: min(560px, 90vw); aspect-ratio: 4/3; background: #06101f; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  video, canvas, img.preview { width: 100%; height: 100%; object-fit: cover; display: block; }
  /* Mirror the camera preview so it feels like a mirror */
  video { transform: scaleX(-1); }
  .countdown { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: 144px; font-weight: 900; color: #EF223A; text-shadow: 0 4px 28px rgba(0,0,0,0.7); background: rgba(0,0,0,0.25); pointer-events: none; }
  .countdown.on { display: flex; }
  .status { font-size: 15px; color: #b5bed4; min-height: 22px; text-align: center; max-width: 540px; }
  .controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: center; }
  .btn { background: #EF223A; color: #fff; border: none; padding: 12px 22px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: transform 0.06s ease, opacity 0.15s ease; }
  .btn:hover { transform: translateY(-1px); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.secondary { background: rgba(255,255,255,0.08); }
  select { background: #122033; color: #fff; border: 1px solid rgba(255,255,255,0.1); padding: 10px 12px; border-radius: 8px; font-size: 15px; }
  label.inline { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #b5bed4; }
  input[type="checkbox"] { width: 16px; height: 16px; accent-color: #EF223A; }
  .hidden { display: none !important; }
  a { color: #7eb5ff; }
</style>
</head>
<body>
<div class="wrap">
  <div>
    <h1>Snap a selfie</h1>
    <div class="event-tag">Event: ${escapedEvent}</div>
  </div>

  <div class="stage" id="stage">
    <video id="video" autoplay playsinline muted></video>
    <canvas id="canvas" class="hidden"></canvas>
    <img id="preview" class="preview hidden" alt="Generated portrait">
    <div id="countdown" class="countdown"></div>
  </div>

  <div id="status" class="status">Tap "Start camera" to begin.</div>

  <div class="controls" id="controls-capture">
    <button class="btn" id="startBtn">Start camera</button>
    <button class="btn" id="snapBtn" disabled>Take photo</button>
    <select id="styleSel"></select>
  </div>

  <div class="controls hidden" id="controls-confirm">
    <button class="btn" id="confirmBtn">Looks good — generate</button>
    <button class="btn secondary" id="retakeBtn">Retake</button>
  </div>

  <div class="controls hidden" id="controls-result">
    <button class="btn" id="againBtn">Start over</button>
    <a id="shareLink" class="btn secondary" target="_blank" rel="noopener" style="display:none">Open share page</a>
  </div>
</div>

<script>
const STYLES = ${styleJson};

const $ = (id) => document.getElementById(id);
const videoEl = $("video");
const canvasEl = $("canvas");
const previewEl = $("preview");
const countdownEl = $("countdown");
const statusEl = $("status");
const startBtn = $("startBtn");
const snapBtn = $("snapBtn");
const confirmBtn = $("confirmBtn");
const retakeBtn = $("retakeBtn");
const againBtn = $("againBtn");
const styleSel = $("styleSel");
const shareLink = $("shareLink");

let stream = null;
let capturedBlob = null;

function populateStyles() {
    while (styleSel.firstChild) styleSel.removeChild(styleSel.firstChild);
    if (!STYLES || STYLES.length === 0) {
        const opt = document.createElement("option");
        opt.textContent = "(no styles configured)";
        styleSel.appendChild(opt);
        styleSel.disabled = true;
        return;
    }
    STYLES.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.key;
        opt.textContent = s.name;
        styleSel.appendChild(opt);
    });
    if (STYLES.length === 1) styleSel.style.display = "none";
}

function setStatus(text) { statusEl.textContent = text; }

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }

async function startCamera() {
    setStatus("Requesting camera access…");
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
            audio: false,
        });
        videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});
        startBtn.disabled = true;
        startBtn.style.display = "none";
        snapBtn.disabled = false;
        setStatus("When you're ready, tap \\"Take photo\\".");
    } catch (err) {
        setStatus("Couldn't access the camera: " + err.message);
    }
}

async function runCountdown(n) {
    countdownEl.classList.add("on");
    for (let i = n; i > 0; i--) {
        countdownEl.textContent = String(i);
        await new Promise((r) => setTimeout(r, 900));
    }
    countdownEl.classList.remove("on");
    countdownEl.textContent = "";
}

async function snap() {
    snapBtn.disabled = true;
    await runCountdown(3);

    const w = videoEl.videoWidth || 1280;
    const h = videoEl.videoHeight || 960;
    canvasEl.width = w;
    canvasEl.height = h;
    const ctx = canvasEl.getContext("2d");
    // Un-mirror before saving — preview is mirrored for UX, but the captured
    // image should read left-to-right correctly for downstream processing.
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, -w, 0, w, h);
    ctx.restore();

    capturedBlob = await new Promise((resolve) => {
        canvasEl.toBlob((b) => resolve(b), "image/jpeg", 0.92);
    });

    previewEl.src = URL.createObjectURL(capturedBlob);
    videoEl.classList.add("hidden");
    previewEl.classList.remove("hidden");

    hide("controls-capture");
    show("controls-confirm");
    setStatus("Happy with this? Generate will transform it into your portrait.");
}

function retake() {
    if (previewEl.src) URL.revokeObjectURL(previewEl.src);
    previewEl.classList.add("hidden");
    videoEl.classList.remove("hidden");
    capturedBlob = null;
    hide("controls-confirm");
    show("controls-capture");
    snapBtn.disabled = false;
    setStatus("Take another shot when you're ready.");
}

async function generate() {
    if (!capturedBlob) return;
    confirmBtn.disabled = true;
    retakeBtn.disabled = true;
    setStatus("Uploading…");

    const fd = new FormData();
    fd.append("image", capturedBlob, "kiosk.jpg");
    const qs = new URLSearchParams();
    if (styleSel.value) qs.set("style", styleSel.value);

    try {
        const r = await fetch("/api/generate?" + qs.toString(), { method: "POST", body: fd });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || ("Upload failed (" + r.status + ")"));
        }
        const body = await r.json();
        await pollUntilDone(body.filePrefix, body.statusUrl);
    } catch (err) {
        setStatus("Error: " + err.message);
        confirmBtn.disabled = false;
        retakeBtn.disabled = false;
    }
}

async function pollUntilDone(filePrefix, statusUrl) {
    setStatus("Generating your portrait… (this takes 15–60 seconds)");
    const start = Date.now();
    while (Date.now() - start < 3 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await fetch(statusUrl, { cache: "no-store" });
        if (!r.ok) continue;
        const body = await r.json();
        if (body.state === "done" || body.state === "ready") {
            showResult(body);
            return;
        }
        if (body.state === "failed") {
            setStatus("Generation failed: " + (body.failReason || "unknown") + ". Try a different selfie.");
            hide("controls-confirm");
            show("controls-result");
            return;
        }
        if (body.state === "review") {
            setStatus("Your portrait is waiting for admin review. Check back shortly.");
            hide("controls-confirm");
            show("controls-result");
            return;
        }
    }
    setStatus("Timed out waiting for generation. The job may still finish — check /review.");
    hide("controls-confirm");
    show("controls-result");
}

function showResult(body) {
    previewEl.src = body.resultUrl;
    if (body.shareUrl) {
        shareLink.href = body.shareUrl;
        shareLink.style.display = "";
    } else {
        shareLink.style.display = "none";
    }
    setStatus("Done!");
    hide("controls-confirm");
    show("controls-result");
}

function startOver() {
    if (previewEl.src) URL.revokeObjectURL(previewEl.src);
    previewEl.src = "";
    previewEl.classList.add("hidden");
    videoEl.classList.remove("hidden");
    capturedBlob = null;
    confirmBtn.disabled = false;
    retakeBtn.disabled = false;
    snapBtn.disabled = !stream;
    if (!stream) startBtn.style.display = "";
    startBtn.disabled = !!stream;
    hide("controls-result");
    show("controls-capture");
    setStatus(stream ? "Take another photo when you're ready." : "Tap \\"Start camera\\" to begin.");
}

startBtn.addEventListener("click", startCamera);
snapBtn.addEventListener("click", snap);
confirmBtn.addEventListener("click", generate);
retakeBtn.addEventListener("click", retake);
againBtn.addEventListener("click", startOver);

window.addEventListener("beforeunload", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
});

populateStyles();
</script>
</body>
</html>`;
}

function mountKiosk(app) {
    app.use("/kiosk", router);
    console.log("📸 Kiosk mounted at /kiosk");
}

module.exports = { mountKiosk };
