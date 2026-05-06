const express = require("express");
const path = require("path");
const settings = require("./settings");
const { makeReviewToken, verifyReviewToken, parseCookie, REVIEW_TOKEN_TTL } = require("./auth");
const { getReviewQueue, approveJob, rejectJob, pickVariant, regenerateVariant, rejectParent } = require("./queue");
const { mountReviewSettings } = require("./review-settings");

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

function reviewLandingPath() {
    const mode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
    return mode === "human" ? "/review/queue" : "/review/settings";
}

router.get("/", (req, res) => {
    // If already authed, go straight to the appropriate page
    const token = parseCookie(req, "review_token");
    if (verifyReviewToken(token) || req.user) {
        return res.redirect(reviewLandingPath());
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
    res.redirect(reviewLandingPath());
});

// ── Review queue page ───────────────────────────────────────────────────────

router.get("/queue", requireReviewAuth, (req, res) => {
    const reviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
    if (reviewMode !== "human") {
        return res.redirect("/review/settings");
    }
    res.setHeader("Content-Type", "text/html");
    res.send(QUEUE_HTML);
});

// ── Review API ──────────────────────────────────────────────────────────────

router.get("/api/queue", requireReviewAuth, async (req, res) => {
    const eventFilter = req.query.e || settings.get("eventName") || "all";
    const jobs = await getReviewQueue(eventFilter);
    res.json(jobs);
});

router.post("/api/job", requireReviewAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const filename = path.basename(body.filename || "");
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const action = body.action;
    const notify = !!body.notify;
    const reanalyze = !!body.reanalyze;
    if (!(filename || parentJobId) || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filename or parentJobId required, action must be approve|reject" });
    }
    try {
        // Parent-level action (multi-variant card)
        if (parentJobId) {
            if (action === "approve") {
                return res.status(400).json({ error: "Approve at parent level is not supported — pick a specific variant" });
            }
            const message = notify ? settings.getMsg("reviewReject") : null;
            const feedback = body.feedback || "";
            await rejectParent(parentJobId, message, reanalyze, feedback);
            return res.json({ ok: true });
        }

        // Legacy single-variant path
        if (action === "approve") {
            await approveJob(filename);
        } else {
            const message = notify ? settings.getMsg("reviewReject") : null;
            const feedback = body.feedback || "";
            await rejectJob(filename, message, reanalyze, feedback);
        }
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ALREADY_DECIDED") return res.status(409).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

// ── Multi-variant endpoints ────────────────────────────────────────────────

router.post("/api/variant/pick", requireReviewAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const variantId = body.variantId ? String(body.variantId) : "";
    if (!parentJobId || !variantId) {
        return res.status(400).json({ error: "parentJobId and variantId required" });
    }
    try {
        await pickVariant(parentJobId, variantId);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ALREADY_DECIDED") return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === "VARIANT_NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
        if (err.code === "VARIANT_FAILED") return res.status(400).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/variant/regenerate", requireReviewAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const variantId = body.variantId ? String(body.variantId) : "";
    if (!parentJobId || !variantId) {
        return res.status(400).json({ error: "parentJobId and variantId required" });
    }
    try {
        await regenerateVariant(parentJobId, variantId);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "VARIANT_NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
        if (err.code === "REGEN_LIMIT_REACHED") return res.status(429).json({ error: err.message, code: err.code });
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
    <h1>Staff Access</h1>
    <p class="subtitle">Enter the PIN to continue</p>
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
  .header-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600;
    color: var(--th-text-dim); text-decoration: none;
    background: var(--th-card); border: 1px solid var(--th-card-border);
    transition: all .15s; cursor: pointer; min-height: 44px;
  }
  .header-btn:hover { border-color: var(--blue-300); color: var(--blue-300); }
  .header-btn svg { width: 16px; height: 16px; }
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
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 220px)); gap: 14px;
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
  .rv-images { display: flex; gap: 4px; margin-bottom: 8px; }
  .rv-images img { width: 100%; border-radius: 4px; cursor: pointer; display: block; }
  .rv-images .rv-img-label {
    position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
    font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
    background: rgba(0,0,0,.6); color: #fff; padding: 1px 5px; border-radius: 3px;
    pointer-events: none;
  }
  .rv-img-wrap { position: relative; flex: 1; min-width: 0; }
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

  /* ── Multi-variant cards ────────────────────────────────────────────── */
  .rv-card.rv-multi { grid-column: span 2; }
  @media (max-width: 900px) { .rv-card.rv-multi { grid-column: span 1; } }

  .rv-multi .rv-orig-row {
    display: flex; gap: 8px; align-items: stretch; margin-bottom: 10px;
  }
  .rv-multi .rv-orig-wrap {
    flex: 0 0 30%; position: relative; max-width: 30%;
  }
  .rv-multi .rv-orig-wrap img {
    width: 100%; height: auto; object-fit: cover; border-radius: 4px;
    cursor: pointer; display: block; aspect-ratio: 1 / 1;
  }
  .rv-multi .rv-variant-row {
    flex: 1; display: grid; gap: 6px;
    grid-template-columns: repeat(var(--variant-count, 3), 1fr);
  }
  .rv-variant {
    position: relative; display: flex; flex-direction: column; gap: 6px;
  }
  .rv-variant .rv-v-imgwrap {
    position: relative; aspect-ratio: 1 / 1; border-radius: 4px; overflow: hidden;
    background: var(--th-bg);
  }
  .rv-variant .rv-v-imgwrap img {
    width: 100%; height: 100%; object-fit: cover; cursor: pointer; display: block;
    transition: opacity .15s;
  }
  .rv-variant .rv-v-num {
    position: absolute; top: 4px; left: 4px;
    background: rgba(0,0,0,.7); color: #fff;
    font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 10px;
    pointer-events: none;
  }
  .rv-variant .rv-v-regens {
    position: absolute; top: 4px; right: 4px;
    background: rgba(246,173,85,.9); color: #1a1a1a;
    font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 10px;
    pointer-events: none; letter-spacing: 0.02em;
  }
  .rv-variant .rv-v-actions {
    display: flex; flex-direction: column; gap: 4px;
  }
  .rv-v-send {
    background: var(--blue-400); color: #fff; border: none; border-radius: 6px;
    padding: 8px 10px; font-size: 12px; font-weight: 700; cursor: pointer;
    transition: all .15s;
  }
  .rv-v-send:hover:not(:disabled) { background: var(--blue-500); transform: translateY(-1px); }
  .rv-v-send:disabled { opacity: .4; cursor: not-allowed; }
  .rv-v-regen {
    background: transparent; color: var(--th-text-dim);
    border: 1px solid var(--th-text-muted); border-radius: 6px;
    padding: 6px 10px; font-size: 11px; font-weight: 600; cursor: pointer;
    transition: all .15s;
  }
  .rv-v-regen:hover:not(:disabled) {
    border-color: var(--blue-500); color: var(--blue-500); background: rgba(24,102,238,.08);
  }
  .rv-v-regen:disabled { opacity: .4; cursor: not-allowed; }

  /* Variant states */
  .rv-variant.is-regen .rv-v-imgwrap::after {
    content: ''; position: absolute; inset: 0;
    background: repeating-linear-gradient(45deg,
      rgba(33,136,239,0.15) 0 12px, rgba(33,136,239,0.05) 12px 24px);
    animation: rv-stripe 1.2s linear infinite;
  }
  .rv-variant.is-regen .rv-v-imgwrap img { opacity: .35; }
  .rv-variant.is-regen .rv-v-imgwrap { cursor: wait; }
  .rv-variant.is-regen .rv-v-num::after {
    content: ' · regenerating'; font-weight: 500;
  }
  .rv-v-regen-label {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', sans-serif; font-size: 13px;
    font-weight: 700; color: var(--th-text);
    text-shadow: 0 1px 3px rgba(0,0,0,.45);
    z-index: 2; pointer-events: none;
  }
  @keyframes rv-stripe {
    0% { background-position: 0 0; }
    100% { background-position: 48px 0; }
  }
  .rv-variant.is-failed .rv-v-imgwrap {
    display: flex; align-items: center; justify-content: center;
    border: 1px dashed rgba(239,34,58,.45);
  }
  .rv-variant.is-failed .rv-v-imgwrap::before {
    content: '⚠ Failed'; color: var(--brand-red);
    font-size: 11px; font-weight: 700;
  }
  .rv-variant.is-failed .rv-v-imgwrap img { display: none; }
  .rv-variant.is-failed .rv-v-send { display: none; }

  /* Card-level actions row (multi-variant) */
  .rv-multi .rv-card-actions {
    display: flex; gap: 6px; flex-wrap: wrap;
    padding-top: 10px; margin-top: 8px;
    border-top: 1px solid var(--th-card-border);
  }
  .rv-multi .rv-card-actions .rv-btn { width: auto; flex: 1; min-width: 110px; font-size: 11px; padding: 8px 10px; }

  /* Mobile carousel layout (≤600px) for multi-variant cards */
  @media (max-width: 600px) {
    .rv-multi .rv-orig-row { flex-direction: column; gap: 10px; }
    .rv-multi .rv-orig-wrap { flex: none; max-width: 100%; }
    .rv-multi .rv-variant-row {
      display: block; position: relative; overflow: hidden;
    }
    .rv-multi .rv-variant {
      display: none;
    }
    .rv-multi .rv-variant.is-active { display: flex; }
    .rv-multi .rv-v-send { padding: 12px 14px; font-size: 14px; min-height: 44px; }
    .rv-multi .rv-v-regen { padding: 10px 14px; font-size: 12px; min-height: 40px; }
    .rv-carousel-nav {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 8px 0 4px;
    }
    .rv-carousel-nav button {
      background: var(--th-card); border: 1px solid var(--th-card-border);
      color: var(--th-text-dim); width: 36px; height: 36px; border-radius: 50%;
      font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .rv-carousel-nav button:disabled { opacity: .3; cursor: not-allowed; }
    .rv-carousel-dots { display: flex; gap: 6px; }
    .rv-carousel-dots span {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--th-text-muted); opacity: .4; cursor: pointer;
    }
    .rv-carousel-dots span.is-active { opacity: 1; background: var(--blue-400); }
    .rv-carousel-label { font-size: 11px; color: var(--th-text-muted); font-weight: 600; margin-left: 4px; }

    /* Card-level actions: collapsed disclosure on mobile */
    .rv-multi .rv-card-actions-toggle {
      display: block; width: 100%; padding: 10px; margin-top: 8px;
      background: transparent; border: 1px dashed var(--th-card-border);
      color: var(--th-text-muted); font-size: 12px; font-weight: 600;
      border-radius: 6px; cursor: pointer;
    }
    .rv-multi .rv-card-actions {
      display: none;
    }
    .rv-multi.actions-open .rv-card-actions { display: flex; }
    .rv-multi.actions-open .rv-card-actions-toggle { border-style: solid; color: var(--th-text); }
  }
  @media (min-width: 601px) {
    .rv-carousel-nav, .rv-card-actions-toggle { display: none !important; }
    .rv-multi .rv-variant { display: flex !important; }
  }

  /* Re-analyze feedback panel */
  .rv-feedback {
    display: none; margin-top: 8px; text-align: left;
  }
  .rv-feedback.open { display: block; }
  .rv-feedback textarea {
    width: 100%; box-sizing: border-box; min-height: 60px; padding: 8px; border-radius: 6px;
    border: 1px solid var(--th-card-border); background: var(--th-bg); color: var(--th-text);
    font-size: 12px; font-family: inherit; resize: vertical;
  }
  .rv-feedback textarea:focus { outline: none; border-color: var(--blue-400); }
  .rv-feedback-hint { font-size: 10px; color: var(--th-text-muted); margin: 4px 0 6px; }
  .rv-feedback-btns { display: flex; gap: 6px; }
  .rv-feedback-btns .rv-btn { font-size: 11px; padding: 6px 12px; }
  .rv-fb-submit { background: var(--blue-500); }
  .rv-fb-cancel { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }

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
  .rv-modal-content { position: relative; max-width: 92vw; max-height: 90vh; display: flex; gap: 16px; align-items: center; }
  .rv-modal-pane { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .rv-modal-pane img {
    max-width: 44vw; max-height: 82vh; border-radius: 10px;
    box-shadow: 0 8px 40px rgba(0,0,0,.5);
  }
  .rv-modal-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: rgba(255,255,255,.7); }
  @media (max-width: 700px) {
    .rv-modal-content { flex-direction: column; gap: 10px; }
    .rv-modal-pane img { max-width: 88vw; max-height: 40vh; }
  }
  .rv-modal-close {
    position: absolute; top: -12px; right: -12px;
    background: var(--th-card); color: #fff; border: 2px solid var(--th-text-muted);
    width: 32px; height: 32px; border-radius: 50%; font-size: 18px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .rv-modal-close:hover { background: var(--brand-red); border-color: var(--brand-red); }
  .rv-modal-nav {
    position: absolute; left: 50%; bottom: -52px;
    transform: translateX(-50%);
    display: flex; gap: 12px; align-items: center;
  }
  .rv-modal-nav-btn {
    background: var(--th-card); color: var(--th-text); border: 1px solid var(--th-text-muted);
    width: 44px; height: 44px; border-radius: 50%;
    font-size: 22px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all .15s;
  }
  .rv-modal-nav-btn:hover:not(:disabled) { border-color: var(--blue-400); color: var(--blue-400); }
  .rv-modal-nav-btn:disabled { opacity: .3; cursor: not-allowed; }

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
    <a href="/review/settings" class="header-btn" title="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </div>

  <div class="offline-bar" id="offlineBar">Connection lost — retrying automatically...</div>
  <div class="rv-bulk-bar" id="rvBulkBar">
    <label><input type="checkbox" id="rvSelectAll" onchange="toggleSelectAll(this.checked)"> Select all</label>
    <span class="rv-bulk-count" id="rvBulkCount"></span>
    <div class="rv-bulk-actions">
      <button class="rv-btn rv-btn-approve" id="rvBulkApprove" onclick="bulkAction('approve')" title="Deliver all selected images to their users via MMS">Approve Selected</button>
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
    <div class="rv-modal-pane"><span class="rv-modal-label">Original</span><img id="reviewModalOrig" src=""></div>
    <div class="rv-modal-pane"><span class="rv-modal-label" id="reviewModalGenLabel">Generated</span><img id="reviewModalImg" src=""></div>
    <button class="rv-modal-close" onclick="closeModal()">&times;</button>
    <div class="rv-modal-nav" id="reviewModalNav" style="display:none">
      <button class="rv-modal-nav-btn" id="rvModalPrev" onclick="cycleModalVariant(-1)" title="Previous variant">‹</button>
      <button class="rv-modal-nav-btn" id="rvModalNext" onclick="cycleModalVariant(1)" title="Next variant">›</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var _selected = new Set();
var _openFeedback = {};
var _fetching = false;
var _hasMultiCards = false;
var _cardVariants = {};     // parentJobId -> { origSrc, variants: [{variantId, filePrefix, status, mmsSrc, fullSrc}] }
var _carouselIndex = {};    // parentJobId -> currently-visible variant index (mobile)
var _actionsOpen = {};      // parentJobId -> true when the mobile card-level actions panel is expanded
var _regenInFlight = {};    // key "parentJobId|variantId" -> true while regen request pending
var _pickInFlight = new Set(); // parentJobId values currently being picked
var _modalContext = null;   // { parentJobId, idx, variantCount } or null for single

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
    grid.replaceChildren();
    badge.textContent = "0";
    empty.style.display = "";
    _selected.clear();
    updateBulk(0);
    _hasMultiCards = false;
    refreshBulkApproveVisibility();
    return;
  }

  empty.style.display = "none";
  badge.textContent = jobs.length;

  // Cards are keyed by filename (singleton) or parentJobId (multi).
  var cardIds = new Set(jobs.map(function(j){ return j.parentJobId || j.filename; }));
  _selected.forEach(function(k){ if (!cardIds.has(k)) _selected.delete(k); });
  Object.keys(_actionsOpen).forEach(function(k){ if (!cardIds.has(k)) delete _actionsOpen[k]; });

  _hasMultiCards = jobs.some(function(j){ return !!j.parentJobId; });

  var parts = [];
  for (var j of jobs) {
    if (j.parentJobId) {
      parts.push(renderMultiCard(j));
    } else {
      parts.push(renderSingleCard(j));
    }
  }
  if (Object.keys(_openFeedback).length > 0) { badge.textContent = jobs.length; return; }
  // All dynamic values below are escaped via escHtml. The HTML assembled here is
  // composed from trusted template strings + escHtml'd values — same pattern as
  // pre-existing single-variant code path.
  grid.innerHTML = parts.join(""); // eslint-disable-line no-unsanitized/property
  updateBulk(jobs.length);
  refreshBulkApproveVisibility();

  // Restore carousel position for any cards that were mid-swipe before re-render
  for (var id in _carouselIndex) {
    applyCarouselIndex(id, _carouselIndex[id]);
  }
}

function renderSingleCard(j) {
  var fn = escHtml(j.filename);
  var fp = escHtml(j.filePrefix);
  var imgSrc = "/images/staging/" + fp + "_output_mms.jpg";
  var origSrc = "/images/staging/" + fp + "_input.jpg";
  var fullSrc = "/images/staging/" + fp + "_output.png";
  var sel = _selected.has(j.filename);
  var h = "";
  h += '<div class="rv-card'+(sel?" rv-selected":"")+'" id="rv-'+fn+'">';
  h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect(\\''+fn+'\\',this.checked)" title="Select for bulk action">';
  h += '<div class="rv-images">';
  h += '<div class="rv-img-wrap"><img src="'+origSrc+'" onclick="openSingleModal(\\''+origSrc+'\\',\\''+fullSrc+'\\')" title="Click to compare"><span class="rv-img-label">Original</span></div>';
  h += '<div class="rv-img-wrap"><img src="'+imgSrc+'" onclick="openSingleModal(\\''+origSrc+'\\',\\''+fullSrc+'\\')" title="Click to compare"><span class="rv-img-label">Generated</span></div>';
  h += '</div>';
  h += '<div class="rv-meta">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+'</div>';
  h += '<div class="rv-actions">';
  h += '<button class="rv-btn rv-btn-approve" onclick="doAction(\\''+fn+'\\',\\'approve\\')" title="Deliver this image to the user via MMS">Approve</button>';
  h += '<div class="rv-reject-row">';
  h += '<button class="rv-btn rv-btn-notify" onclick="doAction(\\''+fn+'\\',\\'reject\\',{notify:true})" title="Discard and send the user an SMS asking them to try a different photo">Reject + Notify</button>';
  h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback(\\''+fn+'\\')" title="Re-generate with fresh analysis — optionally add instructions">Re-analyze</button>';
  h += '<button class="rv-btn rv-btn-reject" onclick="doAction(\\''+fn+'\\',\\'reject\\')" title="Discard this image silently — the user is not notified">Reject</button>';
  h += '</div></div>';
  h += '<div class="rv-feedback" id="rvfb-'+fn+'">';
  h += '<textarea placeholder="Optional: describe what to fix (e.g. fix the logo, include the dog, remove the hat)"></textarea>';
  h += '<div class="rv-feedback-hint">Leave blank to re-generate with fresh analysis only.</div>';
  h += '<div class="rv-feedback-btns">';
  h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedback(\\''+fn+'\\')">Re-generate</button>';
  h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback(\\''+fn+'\\')">Cancel</button>';
  h += '</div></div>';
  h += '</div>';
  return h;
}

function renderMultiCard(j) {
  var pid = escHtml(j.parentJobId);
  var cardKey = j.parentJobId;
  var firstPrefix = j.variants && j.variants[0] ? escHtml(j.variants[0].filePrefix) : escHtml(j.filePrefix);
  var origSrc = "/images/staging/" + firstPrefix + "_input.jpg";
  var sel = _selected.has(cardKey);
  var variants = j.variants || [];
  var variantCount = variants.length;

  _cardVariants[cardKey] = {
    origSrc: origSrc,
    variants: variants.map(function(v){
      return {
        variantId: v.variantId,
        filePrefix: v.filePrefix,
        status: v.status,
        mmsSrc: "/images/staging/" + v.filePrefix + "_output_mms.jpg",
        fullSrc: "/images/staging/" + v.filePrefix + "_output.png",
      };
    }),
  };

  var actionsOpenCls = _actionsOpen[cardKey] ? " actions-open" : "";
  var h = "";
  h += '<div class="rv-card rv-multi'+(sel?" rv-selected":"")+actionsOpenCls+'" id="rv-'+pid+'" style="--variant-count:'+variantCount+'">';
  h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect(\\''+pid+'\\',this.checked)" title="Select for bulk action">';

  h += '<div class="rv-orig-row">';
  h += '<div class="rv-orig-wrap"><img src="'+origSrc+'" alt="Original photo" onclick="openMultiModal(\\''+pid+'\\',-1)" title="Original photo"></div>';

  h += '<div class="rv-variant-row">';
  var regenLimit = j.regenerationLimit || 2;
  variants.forEach(function(v, idx){
    var failed = v.status === "FAILED";
    // "inFlight" = variant is in PENDING_DIR or GENERATING_DIR (not yet
    // showable or approvable). REGENERATING = user clicked Regen;
    // GENERATING = initial fan-out still completing.
    var regenerating = v.status === "REGENERATING";
    var generating = v.status === "GENERATING";
    var inFlight = regenerating || generating;
    var isActive = idx === 0;
    var vid = escHtml(v.variantId);
    var vfp = escHtml(v.filePrefix);
    var regenCount = v.regenCount || 0;
    var regenExhausted = regenCount >= regenLimit;
    var stateCls = (failed ? " is-failed" : "") + (inFlight ? " is-regen" : "") + (isActive ? " is-active" : "");
    h += '<div class="rv-variant'+stateCls+'" data-variant-idx="'+idx+'" data-variant-id="'+vid+'" id="rvv-'+pid+'-'+idx+'">';
    h += '<div class="rv-v-imgwrap"'+(inFlight ? '' : ' onclick="openMultiModal(\\''+pid+'\\','+idx+')"')+'>';
    h += '<span class="rv-v-num">'+(idx+1)+'/'+variantCount+'</span>';
    if (regenCount > 0) {
      h += '<span class="rv-v-regens" title="Regenerations used">'+regenCount+'/'+regenLimit+'</span>';
    }
    // For in-flight variants the server has not yet produced a staged image
    // (either never did — first pass — or deleted it for a regen), so we
    // leave the img src blank and let the .is-regen stripe + text overlay
    // carry the visual state.
    if (inFlight) {
      h += '<div class="rv-v-regen-label">'+(regenerating ? 'Regenerating…' : 'Generating…')+'</div>';
    } else {
      h += '<img src="/images/staging/'+vfp+'_output_mms.jpg" alt="Variant '+(idx+1)+'">';
    }
    h += '</div>';
    h += '<div class="rv-v-actions">';
    var regenDisabled = regenExhausted || inFlight ? ' disabled' : '';
    var regenTitle = regenExhausted
      ? 'Regeneration limit reached ('+regenLimit+')'
      : regenerating ? 'Already regenerating…'
      : generating ? 'Wait for generation to finish'
      : 'Regenerate only this variant (siblings untouched)';
    if (failed) {
      h += '<button class="rv-v-regen" onclick="regenVariant(\\''+pid+'\\',\\''+vid+'\\')"'+regenDisabled+' title="'+(regenExhausted?regenTitle:"Try generating this variant again")+'">↻ Try Again</button>';
    } else if (inFlight) {
      // No Approve while in flight (staged file is gone or not yet written),
      // just a disabled Regen
      h += '<button class="rv-v-send" disabled title="'+(regenerating ? 'Wait for regeneration to finish' : 'Wait for generation to finish')+'">Approve</button>';
      h += '<button class="rv-v-regen" disabled title="'+regenTitle+'">↻ Regen</button>';
    } else {
      h += '<button class="rv-v-send" onclick="pickVariantClick(\\''+pid+'\\',\\''+vid+'\\')" title="Approve variant '+(idx+1)+' — delivered to the user via MMS">Approve</button>';
      h += '<button class="rv-v-regen" onclick="regenVariant(\\''+pid+'\\',\\''+vid+'\\')"'+regenDisabled+' title="'+regenTitle+'">↻ Regen this</button>';
    }
    h += '</div>';
    h += '</div>';
  });
  h += '</div></div>';

  h += '<div class="rv-carousel-nav">';
  h += '<button id="cnav-prev-'+pid+'" onclick="cycleMobileVariant(\\''+pid+'\\',-1)" aria-label="Previous variant">‹</button>';
  h += '<div class="rv-carousel-dots" id="cdots-'+pid+'">';
  for (var d = 0; d < variantCount; d++) {
    h += '<span'+(d===0?' class="is-active"':'')+' onclick="setMobileVariant(\\''+pid+'\\','+d+')" aria-label="Variant '+(d+1)+'"></span>';
  }
  h += '</div>';
  h += '<button id="cnav-next-'+pid+'" onclick="cycleMobileVariant(\\''+pid+'\\',1)" aria-label="Next variant">›</button>';
  h += '<span class="rv-carousel-label" id="clabel-'+pid+'">1 / '+variantCount+'</span>';
  h += '</div>';

  h += '<div class="rv-meta">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+' &middot; '+variantCount+' variants</div>';

  var isOpen = !!_actionsOpen[cardKey];
  h += '<button class="rv-card-actions-toggle" onclick="toggleCardActions(\\''+pid+'\\')" aria-expanded="'+isOpen+'">Card-level actions '+(isOpen?'▴':'▾')+'</button>';
  h += '<div class="rv-card-actions">';
  h += '<button class="rv-btn rv-btn-notify" onclick="parentAction(\\''+pid+'\\',\\'reject\\',{notify:true})" title="Discard all variants and SMS the user to try again">Reject + Notify</button>';
  h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback(\\''+pid+'\\')" title="Discard all and regenerate 3 new variants with optional feedback">Re-analyze All</button>';
  h += '<button class="rv-btn rv-btn-reject" onclick="parentAction(\\''+pid+'\\',\\'reject\\')" title="Discard all variants silently — user is not notified">Reject Silently</button>';
  h += '</div>';

  h += '<div class="rv-feedback" id="rvfb-'+pid+'">';
  h += '<textarea placeholder="Optional: describe what to fix for all 3 regenerations"></textarea>';
  h += '<div class="rv-feedback-hint">Leave blank to re-generate all '+variantCount+' variants with fresh analysis.</div>';
  h += '<div class="rv-feedback-btns">';
  h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedbackParent(\\''+pid+'\\')">Regenerate All</button>';
  h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback(\\''+pid+'\\')">Cancel</button>';
  h += '</div></div>';

  h += '</div>';
  return h;
}

function refreshBulkApproveVisibility() {
  var btn = document.getElementById("rvBulkApprove");
  if (!btn) return;
  btn.style.display = _hasMultiCards ? "none" : "";
  btn.title = _hasMultiCards
    ? "Bulk approve is disabled when multi-variant cards are present — pick a specific variant per card"
    : "Deliver all selected images to their users via MMS";
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
  if (opts.reanalyze) {
    payload.reanalyze = true;
    if (opts.feedback) payload.feedback = opts.feedback;
  }
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
      var msg = action === "approve" ? "Approved" : opts.reanalyze ? (payload.feedback ? "Re-generating with feedback" : "Re-generating with fresh analysis") : opts.notify ? "Rejected, user notified" : "Rejected";
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

function showFeedback(fn) {
  _openFeedback[fn] = _openFeedback[fn] || "";
  var panel = document.getElementById("rvfb-"+fn);
  if (panel) {
    panel.classList.add("open");
    var ta = panel.querySelector("textarea");
    ta.value = _openFeedback[fn];
    ta.focus();
    ta.oninput = function() { _openFeedback[fn] = ta.value; };
  }
}
function hideFeedback(fn) {
  delete _openFeedback[fn];
  var panel = document.getElementById("rvfb-"+fn);
  if (panel) { panel.classList.remove("open"); panel.querySelector("textarea").value = ""; }
}
function submitFeedback(fn) {
  var panel = document.getElementById("rvfb-"+fn);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[fn];
  doAction(fn, "reject", { reanalyze: true, feedback: fb || undefined });
}

function openSingleModal(origSrc, genSrc) {
  _modalContext = null;
  // Decode the images off-main-thread so the <img> paint doesn't run
  // top-to-bottom inside the modal once it becomes visible.
  [origSrc, genSrc].forEach(function(s) { if (s) { var p = new Image(); p.src = s; } });
  document.getElementById("reviewModalOrig").src = origSrc;
  document.getElementById("reviewModalImg").src = genSrc;
  document.getElementById("reviewModalGenLabel").textContent = "Generated";
  document.getElementById("reviewModalNav").style.display = "none";
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _esc);
}

// Multi-variant modal: pid is parentJobId, idx is variant index (-1 = start on original/variant-1)
function openMultiModal(pid, idx) {
  var ctx = _cardVariants[pid];
  if (!ctx) return;
  _modalContext = { parentJobId: pid, idx: Math.max(0, idx), variantCount: ctx.variants.length };
  renderModalVariant();
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _esc);
  // Warm the browser cache for every variant's full-size image so arrow-key
  // navigation doesn't blocking-load top-to-bottom each time.
  for (var i = 0; i < ctx.variants.length; i++) {
    var src = ctx.variants[i] && ctx.variants[i].fullSrc;
    if (src) { var pre = new Image(); pre.src = src; }
  }
}

function cycleModalVariant(delta) {
  if (!_modalContext) return;
  var next = _modalContext.idx + delta;
  if (next < 0 || next >= _modalContext.variantCount) return;
  _modalContext.idx = next;
  renderModalVariant();
}

function renderModalVariant() {
  if (!_modalContext) return;
  var ctx = _cardVariants[_modalContext.parentJobId];
  if (!ctx) return;
  var v = ctx.variants[_modalContext.idx];
  document.getElementById("reviewModalOrig").src = ctx.origSrc;
  document.getElementById("reviewModalImg").src = v.fullSrc;
  document.getElementById("reviewModalGenLabel").textContent = "Variant " + (_modalContext.idx + 1) + " / " + _modalContext.variantCount;
  document.getElementById("reviewModalNav").style.display = _modalContext.variantCount > 1 ? "flex" : "none";
  document.getElementById("rvModalPrev").disabled = _modalContext.idx === 0;
  document.getElementById("rvModalNext").disabled = _modalContext.idx === _modalContext.variantCount - 1;
}

function closeModal(e) {
  // Only close when the user clicks the backdrop itself, not any child
  // element (images, nav buttons, labels). Previous version accidentally
  // closed the modal on nav-button clicks because BUTTON isn't IMG.
  if (e && e.target && !e.target.classList.contains("rv-modal")) return;
  document.getElementById("reviewModal").classList.remove("open");
  document.removeEventListener("keydown", _esc);
  _modalContext = null;
}
function _esc(e) {
  if (e.key === "Escape") return closeModal();
  if (_modalContext && e.key === "ArrowLeft") { e.preventDefault(); return cycleModalVariant(-1); }
  if (_modalContext && e.key === "ArrowRight") { e.preventDefault(); return cycleModalVariant(1); }
}

// ── Multi-variant handlers ─────────────────────────────────────────────────

async function pickVariantClick(parentJobId, variantId) {
  if (_pickInFlight.has(parentJobId)) return;
  _pickInFlight.add(parentJobId);

  // Disable all Send/Regen buttons on this card immediately (optimistic)
  var card = document.getElementById("rv-"+parentJobId);
  if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = true; });

  try {
    var r = await fetch("/review/api/variant/pick", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ parentJobId: parentJobId, variantId: variantId }),
      credentials: "same-origin"
    });
    if (r.status === 401) { location.href = "/review"; return; }
    if (r.ok) {
      _selected.delete(parentJobId);
      if (card) card.remove();
      showToast("Sent to user");
      fetchQueue();
    } else if (r.status === 409) {
      // Already decided — treat as success for this reviewer's intent
      if (card) card.remove();
      showToast("Already handled — moving on");
      fetchQueue();
    } else {
      var d = await r.json().catch(function(){ return {}; });
      showToast(d.error || "Send failed");
      if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = false; });
    }
  } catch(e) {
    showToast("Connection error — try again");
    if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = false; });
  } finally {
    _pickInFlight.delete(parentJobId);
  }
}

async function regenVariant(parentJobId, variantId) {
  var key = parentJobId + "|" + variantId;
  if (_regenInFlight[key]) return;
  _regenInFlight[key] = true;

  // Find the variant DOM element; mark as regenerating
  var card = document.getElementById("rv-"+parentJobId);
  var variantEl = card ? card.querySelector('[data-variant-id="'+CSS.escape(variantId)+'"]') : null;
  if (variantEl) {
    variantEl.classList.add("is-regen");
    variantEl.classList.remove("is-failed");
    variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = true; });
  }

  try {
    var r = await fetch("/review/api/variant/regenerate", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ parentJobId: parentJobId, variantId: variantId }),
      credentials: "same-origin"
    });
    if (r.status === 401) { location.href = "/review"; return; }
    if (r.ok) {
      showToast("Regenerating variant…");
      // Card will temporarily disappear from review queue (variant moves back
      // to PENDING_DIR) and reappear when all siblings are terminal again.
      fetchQueue();
    } else if (r.status === 429) {
      var dLimit = await r.json().catch(function(){ return {}; });
      showToast(dLimit.error || "Regeneration limit reached");
      if (variantEl) {
        variantEl.classList.remove("is-regen");
        variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
        var regenBtn = variantEl.querySelector(".rv-v-regen");
        if (regenBtn) { regenBtn.disabled = true; regenBtn.title = "Regeneration limit reached"; }
      }
    } else {
      var d = await r.json().catch(function(){ return {}; });
      showToast(d.error || "Regenerate failed");
      if (variantEl) {
        variantEl.classList.remove("is-regen");
        variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
      }
    }
  } catch(e) {
    showToast("Connection error — tap retry");
    if (variantEl) {
      variantEl.classList.remove("is-regen");
      variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
    }
  } finally {
    delete _regenInFlight[key];
  }
}

async function parentAction(parentJobId, action, opts) {
  opts = opts || {};
  var payload = { parentJobId: parentJobId, action: action };
  if (opts.notify) payload.notify = true;
  if (opts.reanalyze) {
    payload.reanalyze = true;
    if (opts.feedback) payload.feedback = opts.feedback;
  }
  try {
    var r = await fetch("/review/api/job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload),
      credentials: "same-origin"
    });
    if (r.status === 401) { location.href = "/review"; return; }
    var d = await r.json();
    if (d.ok) {
      _selected.delete(parentJobId);
      var card = document.getElementById("rv-"+parentJobId);
      if (card) card.remove();
      var msg = opts.reanalyze
        ? (opts.feedback ? "Re-generating with feedback" : "Re-generating all variants")
        : opts.notify ? "Rejected — user notified" : "Rejected silently";
      showToast(msg);
      fetchQueue();
    } else {
      showToast(d.error || "Action failed");
      fetchQueue();
    }
  } catch(e) { showToast("Connection error — try again"); }
}

function submitFeedbackParent(pid) {
  var panel = document.getElementById("rvfb-"+pid);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[pid];
  parentAction(pid, "reject", { reanalyze: true, feedback: fb || undefined });
}

// ── Mobile carousel nav ────────────────────────────────────────────────────

function cycleMobileVariant(pid, delta) {
  var ctx = _cardVariants[pid];
  if (!ctx) return;
  var cur = _carouselIndex[pid] || 0;
  var next = cur + delta;
  if (next < 0 || next >= ctx.variants.length) return;
  _carouselIndex[pid] = next;
  applyCarouselIndex(pid, next);
}
function setMobileVariant(pid, idx) {
  var ctx = _cardVariants[pid];
  if (!ctx || idx < 0 || idx >= ctx.variants.length) return;
  _carouselIndex[pid] = idx;
  applyCarouselIndex(pid, idx);
}
function applyCarouselIndex(pid, idx) {
  var card = document.getElementById("rv-"+pid);
  if (!card) return;
  var variants = card.querySelectorAll(".rv-variant");
  variants.forEach(function(el, i){
    el.classList.toggle("is-active", i === idx);
  });
  var dots = card.querySelectorAll("#cdots-"+CSS.escape(pid)+" span");
  dots.forEach(function(el, i){ el.classList.toggle("is-active", i === idx); });
  var label = document.getElementById("clabel-"+pid);
  if (label) label.textContent = (idx + 1) + " / " + variants.length;
  var prev = document.getElementById("cnav-prev-"+pid);
  var next = document.getElementById("cnav-next-"+pid);
  if (prev) prev.disabled = idx === 0;
  if (next) next.disabled = idx === variants.length - 1;
}

function toggleCardActions(pid) {
  var card = document.getElementById("rv-"+pid);
  if (!card) return;
  var open = card.classList.toggle("actions-open");
  // Persist across poll-driven re-renders — without this, the next poll
  // (every 3s) wipes the DOM and the panel collapses under the user.
  if (open) _actionsOpen[pid] = true; else delete _actionsOpen[pid];
  var btn = card.querySelector(".rv-card-actions-toggle");
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Card-level actions ▴" : "Card-level actions ▾";
  }
}

// ── Mobile swipe gestures ──────────────────────────────────────────────────
// Two swipe contexts:
//   1. Variant carousel row inside a multi-variant card (mobile only, ≤600px)
//   2. Comparison modal (any width) — swipe through variants when modal is open
// Both share the same body-level event delegation so handlers survive DOM
// re-renders without rebinding.
(function setupSwipeNav() {
  var SWIPE_THRESHOLD_PX = 50;
  var touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  var touchActivePid = null;      // variant-row swipe target
  var touchActiveModal = false;   // modal swipe context

  function findCardPid(target) {
    var card = target.closest && target.closest(".rv-card.rv-multi");
    if (!card) return null;
    var row = target.closest(".rv-variant-row");
    if (!row) return null;
    return card.id.replace("rv-", "");
  }

  function insideOpenModal(target) {
    // The comparison modal has id="reviewModal" and .open when visible.
    var modal = document.getElementById("reviewModal");
    if (!modal || !modal.classList.contains("open")) return false;
    return modal.contains(target);
  }

  document.body.addEventListener("touchstart", function(e) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    touchActivePid = null;
    touchActiveModal = false;

    // Modal takes priority over variant row — if the modal is open, it's
    // receiving the gesture regardless of viewport width.
    if (insideOpenModal(e.target)) {
      touchActiveModal = true;
      return;
    }

    // Variant row: mobile widths only.
    if (window.innerWidth > 600) return;
    var pid = findCardPid(e.target);
    if (pid) touchActivePid = pid;
  }, { passive: true });

  document.body.addEventListener("touchend", function(e) {
    if (!touchActivePid && !touchActiveModal) return;
    if (!e.changedTouches || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    var elapsed = Date.now() - touchStartTime;
    var pid = touchActivePid;
    var wasModal = touchActiveModal;
    touchActivePid = null;
    touchActiveModal = false;

    // Ignore if vertical movement dominates (user was scrolling), or if the
    // swipe took too long (>600ms) — treat that as a slow drag, not a flick.
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (elapsed > 600) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;

    // Swipe left (dx < 0) → next; right (dx > 0) → previous.
    var delta = dx < 0 ? 1 : -1;
    if (wasModal) cycleModalVariant(delta);
    else if (pid) cycleMobileVariant(pid, delta);
  }, { passive: true });

  document.body.addEventListener("touchcancel", function() {
    touchActivePid = null;
    touchActiveModal = false;
  }, { passive: true });
})();

// Poll every 3s while the document is visible. When hidden (e.g. phone
// locked, tab backgrounded) pause polling to save battery. On visibility
// restore, fetch immediately so the reviewer sees the latest state
// instead of whatever snapshot was current when they switched away.
var _pollTimer = null;
function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(fetchQueue, 3000);
}
function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "visible") {
    fetchQueue();
    startPolling();
  } else {
    stopPolling();
  }
});
fetchQueue();
startPolling();
</script>
</body></html>`;

// ── Mount helper ────────────────────────────────────────────────────────────

function mountReview(app) {
    mountReviewSettings(router, requireReviewAuth);
    app.use("/review", router);
}

module.exports = { mountReview };
