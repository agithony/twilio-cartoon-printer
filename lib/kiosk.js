// Kiosk camera page — opens the device camera, captures a selfie, and
// submits it to /api/generate. Admin-only (inherits the global auth
// middleware from index.js). Shows live status and the final image.

const express = require("express");
const settings = require("./settings");
const { userBarSnippet } = require("./auth");

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
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<title>Kiosk — Twilio Photobooth</title>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<style>
  * { box-sizing: border-box; }
  html, body { width: 100%; min-height: 100vh; background: var(--th-bg); color: var(--th-text); overflow-x: hidden; }
  body {
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    padding: 32px 24px 48px;
    display: flex; flex-direction: column; align-items: center;
  }

  /* Subtle Twilio-red glow (matches booth static panel) */
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background: radial-gradient(ellipse 60% 50% at 50% 25%, rgba(239,34,58,0.06) 0%, transparent 70%);
  }

  .kiosk-header {
    width: 100%; max-width: 640px;
    display: flex; flex-direction: column; align-items: center;
    gap: 6px; margin-bottom: 24px;
  }
  .kiosk-header .logo {
    width: 48px; height: 48px; margin-bottom: 8px;
  }
  .kiosk-header .logo img { width: 100%; height: 100%; display: block; filter: var(--th-logo-filter); }
  .kiosk-header h1 {
    font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 32px; font-weight: 800; letter-spacing: 0.02em;
    color: var(--th-text); margin: 0; text-align: center;
  }
  .kiosk-header .event-tag {
    font-size: 13px; color: var(--th-text-dim); letter-spacing: 0.04em;
    text-transform: uppercase; font-weight: 600;
  }

  .stage {
    position: relative;
    width: min(640px, 100%); aspect-ratio: 4/3;
    background: var(--th-input);
    border: 1px solid var(--th-card-border);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 20px 60px var(--th-card-shadow);
    display: flex; align-items: center; justify-content: center;
  }
  video, canvas, img.preview {
    width: 100%; height: 100%; object-fit: cover; display: block;
    background: var(--th-input);
  }
  /* Mirror the camera preview so it feels like a mirror */
  video { transform: scaleX(-1); }
  .countdown {
    position: absolute; inset: 0; display: none;
    align-items: center; justify-content: center;
    font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: clamp(96px, 20vw, 180px); font-weight: 800;
    color: var(--brand-red); text-shadow: 0 4px 28px rgba(0,0,0,0.7);
    background: rgba(0,13,37,0.35); pointer-events: none;
  }
  .countdown.on { display: flex; }

  .status {
    margin-top: 20px; min-height: 22px; max-width: 640px;
    font-size: 15px; color: var(--th-text-dim); text-align: center;
  }

  .controls {
    margin-top: 16px;
    display: flex; gap: 10px; flex-wrap: wrap;
    align-items: center; justify-content: center;
  }

  .btn {
    font-family: inherit;
    background: var(--brand-red); color: #FFFFFF;
    border: none; padding: 12px 22px; border-radius: 8px;
    font-size: 15px; font-weight: 700; letter-spacing: 0.02em;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.06s ease, opacity 0.15s ease;
  }
  .btn:hover { background: var(--brand-red-hover); transform: translateY(-1px); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
  .btn.secondary {
    background: var(--th-card); color: var(--th-text);
    border: 1px solid var(--th-card-border);
  }
  .btn.secondary:hover { background: var(--th-card-hover); }

  select {
    font-family: inherit;
    background: var(--th-input); color: var(--th-text);
    border: 1px solid var(--th-input-border);
    padding: 10px 12px; border-radius: 8px; font-size: 15px;
    cursor: pointer;
  }

  /* Home nav — top-left, same pattern as user-bar but on the left */
  .home-nav {
    position: fixed; top: 12px; left: 16px; z-index: 9998;
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--th-card); border: 1px solid var(--th-card-border);
    border-radius: 10px; padding: 6px 12px;
    color: var(--th-text-dim); text-decoration: none;
    font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
    transition: color .15s, background .15s;
  }
  .home-nav:hover { color: var(--th-text); background: var(--th-card-hover); }
  .home-nav svg { width: 14px; height: 14px; }

  /* Contact fields — optional, shown on the confirm step */
  .contact-fields {
    width: min(640px, 100%);
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
    margin-top: 20px;
  }
  @media (max-width: 520px) { .contact-fields { grid-template-columns: 1fr; } }
  .contact-fields label {
    display: flex; flex-direction: column; gap: 6px;
    font-size: 12px; color: var(--th-text-muted);
    letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600;
  }
  .contact-fields input {
    font-family: inherit;
    background: var(--th-input); color: var(--th-text);
    border: 1px solid var(--th-input-border);
    padding: 10px 12px; border-radius: 8px; font-size: 15px;
  }
  .contact-fields input:focus {
    outline: none; border-color: var(--brand-red);
  }
  .contact-hint {
    width: min(640px, 100%); margin-top: 8px;
    font-size: 12px; color: var(--th-text-muted); text-align: center;
  }

  /* Confirmation card shown after generation completes */
  .done-card {
    width: min(640px, 100%);
    background: var(--th-card); border: 1px solid var(--th-card-border);
    border-radius: 16px; padding: 32px 24px; text-align: center;
    box-shadow: 0 20px 60px var(--th-card-shadow);
  }
  .done-card .checkmark {
    width: 56px; height: 56px; margin: 0 auto 12px;
    border-radius: 50%; background: rgba(239,34,58,0.12);
    display: flex; align-items: center; justify-content: center;
    color: var(--brand-red);
  }
  .done-card h2 {
    font-family: 'Twilio Sans Display', sans-serif;
    font-size: 26px; font-weight: 800; color: var(--th-text); margin: 0 0 8px;
  }
  .done-card p { color: var(--th-text-dim); font-size: 15px; margin: 4px 0; }

  .hidden { display: none !important; }
</style>
</head>
<body>
<a href="/home" class="home-nav" title="Back to admin home">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>
  Home
</a>
<header class="kiosk-header">
  <div class="logo"><img src="/assets/icon-twilio-bug-red.svg" alt="Twilio"></div>
  <h1>Snap a selfie</h1>
  <div class="event-tag">Event · ${escapedEvent}</div>
</header>

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
  <select id="styleSel" aria-label="Art style"></select>
</div>
<div class="contact-hint" id="pre-capture-hint">
  You'll be able to add your phone or email after the photo — both optional.
</div>

<div class="contact-fields hidden" id="contact-fields">
  <label>Phone (optional)
    <input type="tel" id="phoneInput" placeholder="+14155551234" autocomplete="tel">
  </label>
  <label>Email (optional)
    <input type="email" id="emailInput" placeholder="you@example.com" autocomplete="email">
  </label>
</div>
<div class="contact-hint hidden" id="contact-hint">
  Phone: we'll text you the finished portrait. Email: we'll follow up manually.
</div>

<div class="controls hidden" id="controls-confirm">
  <button class="btn" id="confirmBtn">Looks good — generate</button>
  <button class="btn secondary" id="retakeBtn">Retake</button>
</div>

<div class="done-card hidden" id="done-card">
  <div class="checkmark">
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
  <h2 id="done-title">Your portrait is ready!</h2>
  <p id="done-detail"></p>
</div>

<div class="controls hidden" id="controls-result">
  <button class="btn" id="againBtn">Start over</button>
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
const phoneInput = $("phoneInput");
const emailInput = $("emailInput");
const doneCard = $("done-card");
const doneTitle = $("done-title");
const doneDetail = $("done-detail");

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
    hide("pre-capture-hint");
    show("contact-fields");
    show("contact-hint");
    show("controls-confirm");
    setStatus("Happy with this? Add your phone or email if you'd like it sent to you.");
}

function retake() {
    if (previewEl.src) URL.revokeObjectURL(previewEl.src);
    previewEl.classList.add("hidden");
    videoEl.classList.remove("hidden");
    capturedBlob = null;
    hide("controls-confirm");
    hide("contact-fields");
    hide("contact-hint");
    show("controls-capture");
    show("pre-capture-hint");
    snapBtn.disabled = false;
    setStatus("Take another shot when you're ready.");
}

let lastContact = { phone: "", email: "" };

async function generate() {
    if (!capturedBlob) return;

    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();
    // Client-side sanity check. Using plain string ops (not regex) because
    // this block is inside a template literal — backslash-based escapes
    // like \\d, \\s, \\+ get eaten before reaching the browser.
    if (phone) {
      const isValid = phone[0] === "+"
        && phone.length >= 8 && phone.length <= 16
        && /^[0-9]+$/.test(phone.slice(1))
        && phone[1] !== "0";
      if (!isValid) {
        setStatus("Phone must be in E.164 format (e.g. +14155551234). Clear it to skip.");
        return;
      }
    }
    if (email) {
      const at = email.indexOf("@");
      const dot = email.lastIndexOf(".");
      if (at < 1 || dot < at + 2 || dot >= email.length - 1) {
        setStatus("That email looks invalid. Clear it to skip.");
        return;
      }
    }
    lastContact = { phone, email };

    confirmBtn.disabled = true;
    retakeBtn.disabled = true;
    setStatus("Uploading…");

    const fd = new FormData();
    fd.append("image", capturedBlob, "kiosk.jpg");
    const qs = new URLSearchParams();
    if (styleSel.value) qs.set("style", styleSel.value);
    if (phone) qs.set("phone", phone);
    if (email) qs.set("email", email);

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
    setStatus("Generating your portrait… (this takes a few minutes)");
    const start = Date.now();
    // Poll up to 6 minutes — long enough to outlast manual review in most
    // cases. If it's still pending at the end we show a "check back" note
    // rather than claim failure.
    const DEADLINE_MS = 6 * 60 * 1000;
    let sawReview = false;
    while (Date.now() - start < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await fetch(statusUrl, { cache: "no-store" });
        if (!r.ok) continue;
        const body = await r.json();
        if (body.state === "done" || body.state === "ready") {
            showDone(body);
            return;
        }
        if (body.state === "failed") {
            showFailed(body);
            return;
        }
        if (body.state === "review" && !sawReview) {
            sawReview = true;
            setStatus("Waiting for an admin to review your portrait… we'll update as soon as it clears.");
            // Don't return — keep polling until it transitions out of review.
        }
    }
    showTimeout();
}

function hideStageAndConfirm() {
    // Stop the camera stream so the red "recording" indicator disappears
    // and the device isn't holding the camera open during the wait.
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    hide("controls-confirm");
    hide("contact-fields");
    hide("contact-hint");
    document.getElementById("stage").classList.add("hidden");
    statusEl.classList.add("hidden");
}

function showDone() {
    hideStageAndConfirm();
    doneTitle.textContent = "Your portrait is ready!";
    const parts = [];
    if (lastContact.phone) parts.push("We just texted it to " + lastContact.phone + ".");
    if (lastContact.email) parts.push("We'll also email " + lastContact.email + " shortly.");
    if (!parts.length) parts.push("Come see the photo book to find it.");
    doneDetail.textContent = parts.join(" ");
    doneCard.classList.remove("hidden");
    show("controls-result");
}

function showFailed(body) {
    hideStageAndConfirm();
    doneTitle.textContent = "Something went wrong";
    const reason = body && body.failReason ? body.failReason.replace(/_/g, " ") : "unknown";
    doneDetail.textContent = "Generation failed (" + reason + "). Try a different selfie.";
    doneCard.classList.remove("hidden");
    show("controls-result");
}

function showTimeout() {
    hideStageAndConfirm();
    doneTitle.textContent = "Still working on it";
    doneDetail.textContent = "This is taking longer than expected. Your portrait may still finish — check the photo book in a few minutes.";
    doneCard.classList.remove("hidden");
    show("controls-result");
}

function startOver() {
    if (previewEl.src) URL.revokeObjectURL(previewEl.src);
    previewEl.src = "";
    previewEl.classList.add("hidden");
    videoEl.classList.remove("hidden");
    capturedBlob = null;
    lastContact = { phone: "", email: "" };
    phoneInput.value = "";
    emailInput.value = "";
    confirmBtn.disabled = false;
    retakeBtn.disabled = false;

    document.getElementById("stage").classList.remove("hidden");
    statusEl.classList.remove("hidden");
    doneCard.classList.add("hidden");
    hide("controls-result");
    hide("contact-fields");
    hide("contact-hint");
    show("controls-capture");
    show("pre-capture-hint");

    // Re-request camera — the previous stream was stopped when results landed
    startBtn.disabled = false;
    startBtn.style.display = "";
    snapBtn.disabled = true;
    setStatus("Tap \\"Start camera\\" to begin.");
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
${userBarSnippet()}
</body>
</html>`;
}

function mountKiosk(app) {
    app.use("/kiosk", router);
    console.log("📸 Kiosk mounted at /kiosk");
}

module.exports = { mountKiosk };
