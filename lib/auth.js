const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

const router = express.Router();

function getClientId() { return process.env.GOOGLE_CLIENT_ID || ""; }
function getClientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ""; }
function hasGoogleAuth() { return Boolean(getClientId() && getClientSecret()); }
function getAdminPin() {
    const pin = process.env.ADMIN_PIN || "";
    return pin.length >= 8 && pin.length <= 64 && !/[^A-Za-z0-9]/.test(pin) ? pin : "";
}
function hasAdminAuth() { return hasGoogleAuth() || Boolean(getAdminPin()); }
const configuredSessionSecret = process.env.SESSION_SECRET || "";
if (process.env.NODE_ENV === "production" && configuredSessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters in production");
}
const SESSION_SECRET =
    configuredSessionSecret ||
    (() => {
        const s = crypto.randomBytes(32).toString("hex");
        console.log("⚠️  SESSION_SECRET not set — generated ephemeral secret (sessions won't survive restart)");
        return s;
    })();

const ALLOWED_EMAILS = new Set(
    (process.env.ALLOWED_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
);
const SESSION_MAX_AGE = 86400; // 24 hours
const REVIEW_TOKEN_TTL = parseInt(process.env.REVIEW_TOKEN_TTL || String(7 * 86400), 10); // 7 days
const PIN_FAILURE_LIMIT = 5;
const PIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PIN_FAILURE_MAX_ENTRIES = 10_000;
const PIN_FAILURE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_NONCE_COOKIE = "oauth_nonce";
const REVIEW_CREDENTIAL_METHODS = new Set(["reviewPin"]);
const pinFailures = new Map();

function prunePinFailures(now = Date.now()) {
    for (const [key, failure] of pinFailures) {
        if (failure.resetAt <= now) pinFailures.delete(key);
    }
}

function recordPinFailure(state) {
    if (!pinFailures.has(state.key) && pinFailures.size >= PIN_FAILURE_MAX_ENTRIES) {
        prunePinFailures(state.now);
        while (pinFailures.size >= PIN_FAILURE_MAX_ENTRIES) {
            pinFailures.delete(pinFailures.keys().next().value);
        }
    }
    pinFailures.set(state.key, { count: state.count + 1, resetAt: state.resetAt });
}

function clearPinFailures(state) {
    pinFailures.delete(state.key);
}

const pinFailurePruneTimer = setInterval(prunePinFailures, PIN_FAILURE_PRUNE_INTERVAL_MS);
pinFailurePruneTimer.unref();

// ── Session tokens (HMAC-signed, no server-side store) ──────────────────────

function getPinFingerprint(pin = getAdminPin()) {
    if (!pin) return "";
    return crypto.createHmac("sha256", SESSION_SECRET).update(`admin-pin:${pin}`).digest("base64url");
}

function safeEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function credentialMatches(candidate, configuredCredential) {
    const candidateHash = crypto.createHash("sha256").update(typeof candidate === "string" ? candidate : "").digest();
    const configuredHash = crypto.createHash("sha256").update(typeof configuredCredential === "string" ? configuredCredential : "").digest();
    return Boolean(configuredCredential) && crypto.timingSafeEqual(candidateHash, configuredHash);
}

function pinMatches(candidate) {
    return credentialMatches(candidate, getAdminPin());
}

function makeSessionToken({ email = "", name = "", picture = "", authMethod = "google", pinFingerprint = "" }) {
    const data = { email, name, picture, authMethod, exp: Date.now() + SESSION_MAX_AGE * 1000 };
    if (authMethod === "pin") data.pinFingerprint = pinFingerprint;
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    return `${payload}.${sig}`;
}

function verifySessionToken(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (!safeEqual(sig, expected)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (!Number.isFinite(data.exp) || data.exp < Date.now()) return null;
        const authMethod = data.authMethod || "google"; // Preserve pre-authMethod Google sessions.
        if (authMethod === "pin") {
            const fingerprint = getPinFingerprint();
            if (!fingerprint || typeof data.pinFingerprint !== "string" || !safeEqual(data.pinFingerprint, fingerprint)) return null;
            return { email: "", name: "PIN Admin", picture: "", authMethod };
        }
        if (authMethod !== "google" || typeof data.email !== "string" || !data.email) return null;
        return {
            email: data.email,
            name: typeof data.name === "string" ? data.name : "",
            picture: typeof data.picture === "string" ? data.picture : "",
            authMethod,
        };
    } catch {
        return null;
    }
}

function parseCookie(req, name) {
    const header = req.headers.cookie || "";
    const match = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
    if (!match) return null;
    try {
        return decodeURIComponent(match.slice(name.length + 1));
    } catch {
        return null;
    }
}

function authenticateAdminSession(req) {
    const user = verifySessionToken(parseCookie(req, "session"));
    if (user) req.user = user;
    return user;
}

function setSessionCookie(res, token, req) {
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const parts = [`session=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_MAX_AGE}`];
    if (isSecure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
}

function setOAuthNonceCookie(res, nonce, req) {
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const parts = [
        `${OAUTH_NONCE_COOKIE}=${nonce}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/auth/callback",
        `Max-Age=${Math.ceil(OAUTH_STATE_MAX_AGE_MS / 1000)}`,
    ];
    if (isSecure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
}

function clearOAuthNonceCookie(res, req) {
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const parts = [`${OAUTH_NONCE_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/auth/callback", "Max-Age=0"];
    if (isSecure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
}

// ── Review tokens (HMAC-signed and bound to the login credential) ──────────

function getReviewCredentialFingerprint(method, credential) {
    if (!REVIEW_CREDENTIAL_METHODS.has(method) || typeof credential !== "string" || !credential) return "";
    return crypto.createHmac("sha256", SESSION_SECRET).update(`review:${method}:${credential}`).digest("base64url");
}

function makeReviewToken({ method, credential }) {
    const credentialFingerprint = getReviewCredentialFingerprint(method, credential);
    if (!credentialFingerprint) throw new Error("Review token requires a credential method and value");
    const payload = Buffer.from(JSON.stringify({
        purpose: "review",
        method,
        credentialFingerprint,
        exp: Date.now() + REVIEW_TOKEN_TTL * 1000,
    })).toString("base64url");
    const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    return `${payload}.${sig}`;
}

function verifyReviewToken(token, credentials = {}) {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (!safeEqual(sig, expected)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (data.purpose !== "review" || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
        if (!REVIEW_CREDENTIAL_METHODS.has(data.method)) return null;
        const credential = credentials[data.method];
        const fingerprint = getReviewCredentialFingerprint(data.method, credential);
        if (!fingerprint || !safeEqual(data.credentialFingerprint, fingerprint)) return null;
        return data;
    } catch {
        return null;
    }
}

// ── Public route check ──────────────────────────────────────────────────────

function isPublicRoute(req) {
    const method = req.method.toUpperCase();
    const p = req.path;

    if (p.startsWith("/auth")) return true;
    if (p === "/healthz") return true;
    if (p === "/inbound" || p === "/sms") return true;
    if (p.startsWith("/relay") || p.startsWith("/api/print-relay")) return true;
    // Staged image paths are admitted here so their route-level middleware can
    // accept either an admin session or the narrower review token.
    if (p.startsWith("/images")) return true;
    if (p.startsWith("/assets")) return true;
    if (p.startsWith("/booth-uploads")) return true;
    if (p.startsWith("/review")) return true;
    if (p.startsWith("/s/")) return true;
    // Photo book is intended for public display screens at events. Only
    // the approved read paths are public — GET / (HTML), GET /img/* (images),
    // and GET /api/* (event + photo listings). GET /staging/* has its own
    // dual-session middleware. The DELETE / POST /api/*
    // endpoints under /photogallery (delete photo, delete-all, move
    // between events) stay auth-gated because they're admin-only ops
    // that would otherwise let anyone on the internet wipe an event.
    if (p.startsWith("/photogallery") && method === "GET") return true;

    return false;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

function isApiRequest(req) {
    return /(^|\/)api(?:\/|$)/.test(req.path || "");
}

function safeNextPath(value, fallback = "/dashboard") {
    if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
    try {
        const parsed = new URL(value, "http://local.invalid");
        return parsed.origin === "http://local.invalid" ? value : fallback;
    } catch {
        return fallback;
    }
}

function makeOAuthState(next) {
    const nonce = crypto.randomBytes(32).toString("base64url");
    const data = {
        purpose: "oauth-state",
        next: safeNextPath(next, "/dashboard"),
        nonce,
        exp: Date.now() + OAUTH_STATE_MAX_AGE_MS,
    };
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto.createHmac("sha256", SESSION_SECRET).update(`oauth-state:${payload}`).digest("base64url");
    return { nonce, token: `${payload}.${signature}` };
}

function verifyOAuthState(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`oauth-state:${payload}`).digest("base64url");
    if (!safeEqual(signature, expected)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (data.purpose !== "oauth-state" || !Number.isFinite(data.exp) || data.exp <= Date.now()) return null;
        if (typeof data.nonce !== "string" || data.nonce.length !== 43 || /[^A-Za-z0-9_-]/.test(data.nonce)) return null;
        if (typeof data.next !== "string" || !data.next || safeNextPath(data.next, "") !== data.next) return null;
        return data;
    } catch {
        return null;
    }
}

function oauthNonceMatches(candidate, expected) {
    const candidateValue = typeof candidate === "string" ? candidate : "";
    const expectedValue = typeof expected === "string" ? expected : "";
    const candidateHash = crypto.createHash("sha256").update(candidateValue).digest();
    const expectedHash = crypto.createHash("sha256").update(expectedValue).digest();
    return Boolean(candidateValue && expectedValue) && crypto.timingSafeEqual(candidateHash, expectedHash);
}

function requireAuth(req, res, next) {
    // Check existing session first — works even if OAuth env vars
    // haven't been injected yet (e.g. right after a container deploy).
    const user = authenticateAdminSession(req);
    if (user) {
        return next();
    }

    // No valid session — at least one login method must be configured.
    if (!hasAdminAuth()) {
        if (isApiRequest(req)) {
            return res.status(401).json({ error: "Authentication not configured" });
        }
        return res.status(503).send("Admin authentication is not configured.");
    }

    // API requests get 401, pages get redirected
    if (isApiRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    const next_url = encodeURIComponent(safeNextPath(req.originalUrl, "/dashboard"));
    res.redirect(`/auth/login?next=${next_url}`);
}

// ── Login page ──────────────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<title>Admin Login — Twilio Photobooth</title>
<style>
  @font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Extrabold.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Bold.otf') format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Mono'; src: url('/assets/fonts/TwilioSansMono-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }

  :root, html[data-theme="dark"] {
    --th-bg: #000D25; --th-card: #232B45; --th-card-border: #38425E;
    --th-text: #FFFFFF; --th-text-dim: #9AA0B4; --th-text-muted: #656E87;
    --th-raised: #38425E; --brand-red: #EF223A; --brand-red-hover: #DB132A;
  }
  html[data-theme="light"] {
    --th-bg: #FFFFFF; --th-card: #FFFFFF; --th-card-border: #DDE0E6;
    --th-text: #000D25; --th-text-dim: #4D5777; --th-text-muted: #656E87;
    --th-raised: #F3F4F7; --brand-red: #EF223A; --brand-red-hover: #DB132A;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { background: var(--th-bg); transition: background-color 0.2s ease; }
  body {
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--th-bg); color: var(--th-text-dim);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    -webkit-font-smoothing: antialiased; transition: background-color 0.2s ease, color 0.2s ease;
    overflow-x: hidden; position: relative; padding: 72px 0 32px;
  }

  /* Ambient red glow behind everything */
  body::before {
    content: ''; position: fixed; top: -40%; left: -20%; width: 140%; height: 140%;
    background: radial-gradient(ellipse at 30% 20%, rgba(239,34,58,0.12) 0%, transparent 55%),
                radial-gradient(ellipse at 70% 80%, rgba(33,136,239,0.06) 0%, transparent 50%);
    pointer-events: none; z-index: 0;
  }
  html[data-theme="light"] body::before {
    background: radial-gradient(ellipse at 30% 20%, rgba(239,34,58,0.06) 0%, transparent 55%),
                radial-gradient(ellipse at 70% 80%, rgba(33,136,239,0.04) 0%, transparent 50%);
  }

  .login-wrapper {
    text-align: center; max-width: 440px; width: 92%; position: relative; z-index: 1;
  }

  /* Builder shape behind card */
  .builder-shape {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 520px; height: 520px; pointer-events: none; opacity: 0.12;
  }

  /* Bug mark — red, glowing */
  .bug-mark { margin-bottom: 28px; filter: drop-shadow(0 0 20px rgba(239,34,58,0.35)); }
  .bug-mark svg { width: 56px; height: 56px; }
  .bug-mark svg path { fill: var(--brand-red); }

  /* Red accent bar at top of card */
  .card {
    position: relative;
    background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 16px;
    padding: 48px 40px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.3), 0 0 80px rgba(239,34,58,0.06);
    transition: background-color 0.2s ease, border-color 0.2s ease;
    overflow: hidden;
  }
  html[data-theme="light"] .card {
    box-shadow: 0 8px 40px rgba(0,13,37,0.1), 0 0 60px rgba(239,34,58,0.04);
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--brand-red) 0%, #F83D53 40%, #2188EF 100%);
  }
  .card h1 {
    font-family: 'Twilio Sans Display', sans-serif; font-size: 26px;
    font-weight: 800; color: var(--th-text); letter-spacing: 0.02em;
    line-height: 1; margin-bottom: 6px;
  }
  .card .app-name {
    font-family: 'Twilio Sans Mono', monospace; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1px;
    color: var(--brand-red); font-weight: 400; margin-bottom: 6px;
  }
  .card .subtitle {
    font-size: 13px; color: var(--th-text-muted); margin-bottom: 32px;
  }

  .error {
    background: rgba(239,34,58,.1); border: 1px solid rgba(239,34,58,.3);
    color: var(--brand-red); border-radius: 8px; padding: 10px 14px;
    font-size: 13px; margin-bottom: 20px;
  }

  .btn-google {
    display: inline-flex; align-items: center; gap: 10px;
    background: #fff; color: #333; border: 1px solid #ddd; border-radius: 10px;
    padding: 14px 32px; font-size: 14px; font-weight: 700;
    font-family: 'Twilio Sans Text', sans-serif;
    text-decoration: none; cursor: pointer; transition: all .2s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08); width: 100%; justify-content: center;
  }
  .btn-google:hover { background: #f8f8f8; box-shadow: 0 6px 24px rgba(0,0,0,.15); transform: translateY(-2px); }
  .btn-google:active { transform: translateY(0); }
  .btn-google svg { width: 20px; height: 20px; flex-shrink: 0; }

  .divider {
    display: flex; align-items: center; gap: 12px; margin: 24px 0;
  }
  .divider::before, .divider::after {
    content: ''; flex: 1; height: 1px; background: var(--th-card-border);
  }
  .divider span {
    font-family: 'Twilio Sans Mono', monospace; font-size: 9px;
    text-transform: uppercase; letter-spacing: 1.5px; color: var(--th-text-muted);
  }

  .pin-form { display: flex; flex-direction: column; gap: 12px; text-align: left; }
  .pin-form label {
    color: var(--th-text-dim); font-size: 12px; font-weight: 700;
  }
  .pin-form input {
    width: 100%; border: 1px solid var(--th-card-border); border-radius: 10px;
    background: var(--th-bg); color: var(--th-text); padding: 13px 14px;
    font: 16px 'Twilio Sans Mono', monospace; letter-spacing: .08em; outline: none;
  }
  .pin-form input:focus { border-color: #2188EF; box-shadow: 0 0 0 3px rgba(33,136,239,.16); }
  .btn-pin {
    border: 0; border-radius: 10px; padding: 14px 24px; cursor: pointer;
    background: var(--brand-red); color: #fff; font: 700 14px 'Twilio Sans Text', sans-serif;
    transition: background .15s, transform .15s;
  }
  .btn-pin:hover { background: var(--brand-red-hover); transform: translateY(-1px); }
  .btn-pin:active { transform: translateY(0); }

  .footer {
    margin-top: 16px; font-size: 11px; color: var(--th-text-muted);
    font-family: 'Twilio Sans Mono', monospace; text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Theme toggle — top right of page */
  .theme-toggle {
    position: fixed; top: 20px; right: 20px; z-index: 10;
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--th-card); border: 1px solid var(--th-card-border);
    border-radius: 8px; padding: 6px 10px;
    color: var(--th-text-muted); font-size: 11px;
    cursor: pointer; transition: all 0.15s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  .theme-toggle:hover { color: var(--th-text); border-color: var(--th-raised); background: var(--th-raised); }
  .theme-toggle svg { width: 14px; height: 14px; }
  .theme-toggle .icon-sun, .theme-toggle .icon-moon { display: none; }
  html[data-theme="dark"] .theme-toggle .icon-sun { display: block; }
  html[data-theme="light"] .theme-toggle .icon-moon { display: block; }
  @media (max-width: 480px) {
    .card { padding: 40px 24px; }
    .builder-shape { width: 430px; height: 430px; }
  }
</style>
</head>
<body>

<button class="theme-toggle" onclick="toggleTheme()">
  <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
</button>

<div class="login-wrapper">
  <svg class="builder-shape" viewBox="0 0 480 480" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M70,24 Q24,24 24,70 L24,230 Q24,300 70,345 L210,415 Q255,440 325,390 L415,275 Q460,230 460,160 L460,70 Q460,24 415,24 Z" stroke="#EF223A" stroke-width="3" fill="none"/>
  </svg>

  <div class="bug-mark">
    <svg viewBox="0 0 46 46" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.25 33.17C19.69 33.17 21.67 31.19 21.67 28.75C21.67 26.31 19.69 24.33 17.25 24.33C14.81 24.33 12.83 26.31 12.83 28.75C12.83 31.19 14.81 33.17 17.25 33.17ZM17.25 21.67C19.69 21.67 21.67 19.69 21.67 17.25C21.67 14.81 19.69 12.83 17.25 12.83C14.81 12.83 12.83 14.81 12.83 17.25C12.83 19.69 14.81 21.67 17.25 21.67ZM28.75 33.17C31.19 33.17 33.17 31.19 33.17 28.75C33.17 26.31 31.19 24.33 28.75 24.33C26.31 24.33 24.33 26.31 24.33 28.75C24.33 31.19 26.31 33.17 28.75 33.17ZM28.75 21.67C31.19 21.67 33.17 19.69 33.17 17.25C33.17 14.81 31.19 12.83 28.75 12.83C26.31 12.83 24.33 14.81 24.33 17.25C24.33 19.69 26.31 21.67 28.75 21.67ZM23 0C35.46 0 46 10.54 46 23C46 35.46 35.46 46 23 46C10.54 46 0 35.46 0 23C0 10.54 10.54 0 23 0ZM23 6.19C13.74 6.19 6.19 13.48 6.19 22.69C6.19 31.9 13.74 39.81 23 39.81C32.26 39.81 39.81 31.9 39.81 22.69C39.81 13.48 32.26 6.19 23 6.19Z" fill="#EF223A"/>
    </svg>
  </div>

  <div class="card">
    <div class="app-name">AI Photobooth</div>
    <h1>Admin Login</h1>
    <p class="subtitle">{{SUBTITLE}}</p>
    {{ERROR}}
    {{METHODS}}
    {{FOOTER}}
  </div>
</div>

<script>
function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('twilio-theme', next);
}
</script>
</body>
</html>`;

// ── Routes ──────────────────────────────────────────────────────────────────

router.use(express.urlencoded({ extended: false, limit: "1kb" }));

function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function setLoginHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function googleAuthUrl(req, state) {
    const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
    const params = new URLSearchParams({
        client_id: getClientId(),
        redirect_uri: `${baseUrl}/auth/callback`,
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function renderLogin(req, res, { error = "", status = 200, next = req.query.next } = {}) {
    const googleEnabled = hasGoogleAuth();
    const pinEnabled = Boolean(getAdminPin());
    const nextUrl = safeNextPath(next, "/dashboard");
    const methods = [];

    if (googleEnabled) {
        const oauthState = makeOAuthState(nextUrl);
        setOAuthNonceCookie(res, oauthState.nonce, req);
        methods.push(`<a class="btn-google" href="${escapeHtml(googleAuthUrl(req, oauthState.token))}">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </a>`);
    }
    if (googleEnabled && pinEnabled) methods.push('<div class="divider"><span>or</span></div>');
    if (pinEnabled) {
        methods.push(`<form class="pin-form" method="POST" action="/auth/pin">
      <label for="admin-pin">Administrator PIN</label>
      <input id="admin-pin" name="pin" type="password" inputmode="text" minlength="8" maxlength="64" pattern="[A-Za-z0-9]{8,64}" autocomplete="current-password" required>
      <input type="hidden" name="next" value="${escapeHtml(nextUrl)}">
      <button class="btn-pin" type="submit">Sign in with PIN</button>
    </form>`);
    }

    const subtitle = googleEnabled && pinEnabled
        ? "Choose Google or the shared administrator PIN"
        : googleEnabled ? "Sign in with your authorized Google account"
            : pinEnabled ? "Enter the shared administrator PIN" : "No login method is configured";
    const footerText = googleEnabled
        ? "Google access is limited to authorized accounts"
        : pinEnabled ? "Shared administrator access" : "Contact the application administrator";
    const errorHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
    const html = LOGIN_HTML
        .replace("{{SUBTITLE}}", subtitle)
        .replace("{{ERROR}}", errorHtml)
        .replace("{{METHODS}}", methods.join(""))
        .replace("{{FOOTER}}", `<div class="footer">${footerText}</div>`);

    setLoginHeaders(res);
    res.status(status).type("html").send(html);
}

function pinFailureState(req, scope) {
    const client = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${scope}:${client}`;
    const now = Date.now();
    const existing = pinFailures.get(key);
    if (existing && existing.resetAt <= now) {
        pinFailures.delete(key);
        return { key, now, count: 0, resetAt: now + PIN_FAILURE_WINDOW_MS };
    }
    return { key, now, count: existing?.count || 0, resetAt: existing?.resetAt || now + PIN_FAILURE_WINDOW_MS };
}

router.get("/login", (req, res) => {
    const configured = hasGoogleAuth() || Boolean(getAdminPin());
    renderLogin(req, res, {
        error: configured ? (typeof req.query.error === "string" ? req.query.error : "") : "Admin authentication is not configured.",
        status: configured ? 200 : 503,
    });
});

router.get("/pin", (req, res) => {
    res.setHeader("Allow", "POST");
    res.setHeader("Cache-Control", "no-store");
    res.status(405).send("Method Not Allowed");
});

router.post("/pin", (req, res) => {
    if (!getAdminPin()) {
        return renderLogin(req, res, { error: "PIN authentication is not configured.", status: 503, next: req.body?.next });
    }

    const state = pinFailureState(req, "admin");
    if (state.count >= PIN_FAILURE_LIMIT) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - state.now) / 1000))));
        return renderLogin(req, res, { error: "Too many failed attempts. Try again later.", status: 429, next: req.body?.next });
    }

    if (!pinMatches(req.body?.pin)) {
        recordPinFailure(state);
        return renderLogin(req, res, { error: "Invalid administrator PIN.", status: 401, next: req.body?.next });
    }

    clearPinFailures(state);
    const token = makeSessionToken({ authMethod: "pin", name: "PIN Admin", pinFingerprint: getPinFingerprint() });
    setSessionCookie(res, token, req);
    res.redirect(safeNextPath(req.body?.next, "/dashboard"));
});

router.get("/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const nonceCookie = parseCookie(req, OAUTH_NONCE_COOKIE);
    clearOAuthNonceCookie(res, req);
    if (!hasGoogleAuth()) return res.status(503).send("Google authentication is not configured.");
    const oauthState = verifyOAuthState(req.query.state);
    if (!oauthState || !oauthNonceMatches(nonceCookie, oauthState.nonce)) {
        return res.status(400).send("Invalid or expired OAuth state.");
    }
    const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
    const code = req.query.code;
    const next_url = oauthState.next;

    if (!code) {
        return res.redirect(`/auth/login?error=${encodeURIComponent("Login cancelled")}&next=${encodeURIComponent(next_url)}`);
    }

    try {
        // Exchange code for tokens
        const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
            code,
            client_id: getClientId(),
            client_secret: getClientSecret(),
            redirect_uri: `${baseUrl}/auth/callback`,
            grant_type: "authorization_code",
        });

        // Decode ID token payload (middle segment)
        const idToken = tokenRes.data.id_token;
        const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());

        // Enforce @twilio.com domain (or allowlisted email)
        const emailLower = (payload.email || "").toLowerCase();
        if (!(payload.hd === "twilio.com" || ALLOWED_EMAILS.has(emailLower)) || !payload.email_verified) {
            return res.redirect(`/auth/login?error=${encodeURIComponent("Only @twilio.com accounts are allowed")}&next=${encodeURIComponent(next_url)}`);
        }

        // Set session cookie and redirect
        const token = makeSessionToken({ email: payload.email, name: payload.name || "", picture: payload.picture || "", authMethod: "google" });
        setSessionCookie(res, token, req);
        console.log(`🔐 Login: ${payload.email}`);
        res.redirect(next_url);
    } catch (err) {
        console.error("OAuth callback error:", err.response?.data?.error || err.message);
        res.redirect(`/auth/login?error=${encodeURIComponent("Authentication failed — please try again")}&next=${encodeURIComponent(next_url)}`);
    }
});

router.get("/me", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const token = parseCookie(req, "session");
    const user = verifySessionToken(token);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json({ email: user.email, name: user.name, picture: user.picture, authMethod: user.authMethod });
});

router.post("/logout", (req, res) => {
    res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/auth/login");
});

// ── User bar (shared across pages) ─────────────────────────────────────────

const USER_BAR_CSS = `
.user-bar {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--th-card, #232B45); backdrop-filter: blur(8px);
  border: 1px solid var(--th-card-border, #38425E); border-radius: 10px;
  padding: 5px 10px 5px 5px; font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
.user-bar--fixed {
  position: fixed; top: 12px; right: 16px; z-index: 9999;
}
.user-bar-avatar {
  width: 24px; height: 24px; border-radius: 50%; object-fit: cover; border: 1px solid var(--th-card-border, #38425E);
}
.user-bar-name { font-size: 12px; color: var(--th-text-dim, #9AA0B4); white-space: nowrap; }
.user-bar-logout {
  margin-left: 2px; background: none; border: none; cursor: pointer;
  color: var(--th-text-muted, #656E87); display: flex; align-items: center; padding: 2px;
  border-radius: 4px; transition: color .15s;
}
.user-bar-logout:hover { color: var(--brand-red, #EF223A); }
`;

const USER_BAR_JS = `
(function(){
  fetch('/auth/me').then(r=>r.ok?r.json():null).then(u=>{
    if(!u)return;
    const bar=document.createElement('div');bar.className='user-bar';
    const img=document.createElement('img');img.className='user-bar-avatar';
    if(u.picture)img.src=u.picture;img.alt='';img.referrerPolicy='no-referrer';
    img.onerror=function(){this.style.display='none'};
    const name=document.createElement('span');name.className='user-bar-name';
    name.textContent=u.name||(u.email?u.email.split('@')[0]:'Admin');
    const btn=document.createElement('button');btn.className='user-bar-logout';
    btn.title='Sign out';btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    btn.onclick=function(){fetch('/auth/logout',{method:'POST'}).then(()=>location='/auth/login')};
    if(u.picture)bar.appendChild(img);bar.append(name,btn);
    var hdr=document.querySelector('.header-controls')||document.querySelector('.hdr-controls');
    if(hdr){hdr.appendChild(bar)}else{bar.classList.add('user-bar--fixed');document.body.appendChild(bar)}
  });
})();
`;

function userBarSnippet() {
    return `<style>${USER_BAR_CSS}</style><script>${USER_BAR_JS}</script>`;
}

// ── Theme toggle button (for display pages with a top-bar) ─────────────────
// Renders both sun and moon SVGs and flips their visibility with CSS driven
// by html[data-theme]. Reuses localStorage('twilio-theme') so a toggle here
// stays in sync with /home. Drop into an existing .top-btn layout.
function themeToggleButton(opts) {
    const className = (opts && opts.className) || "top-btn";
    const id = (opts && opts.id) || "themeBtn";
    return `<style>
  #${id} .icon-sun, #${id} .icon-moon { display: none; width: 14px; height: 14px; }
  html[data-theme="dark"] #${id} .icon-moon { display: inline-block; }
  html[data-theme="light"] #${id} .icon-sun { display: inline-block; }
</style>
<div class="${className}" id="${id}" onclick="(function(){var c=document.documentElement.getAttribute('data-theme')||'dark';var n=c==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);localStorage.setItem('twilio-theme',n);if(window.parent!==window)window.parent.postMessage({type:'twilio-theme-change',theme:n},window.location.origin)})()" title="Toggle light/dark mode">
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
  <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
  <span>Theme</span>
</div>`;
}

// ── Magician hat badge (shared across admin pages) ─────────────────────────

const MAGIC_HAT_CSS = `
:root { --magic-gold: #E9C46A; --magic-purple: #6B3FA0; }
html[data-theme="light"] { --magic-gold: #C89B2C; --magic-purple: #5B2E8E; }
@keyframes magic-hat-wobble { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
@keyframes magic-hat-sparkle-rise {
  0% { opacity: 0; transform: translate(0,0) scale(.4); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--hx,0), -34px) scale(1.1); }
}
.magic-hat {
  position: fixed; bottom: 16px; left: 16px;
  width: 72px; height: 72px;
  cursor: pointer; z-index: 50;
}
.magic-hat-svg {
  width: 64px; height: 64px;
  filter: drop-shadow(0 4px 8px rgba(0,0,0,.4))
          drop-shadow(0 0 8px rgba(239,34,58,.7))
          drop-shadow(0 0 22px rgba(239,34,58,.55));
  transform-origin: 50% 90%;
  transition: transform .4s cubic-bezier(.2,.9,.3,1.2), filter .4s ease;
}
.magic-hat:hover .magic-hat-svg {
  animation: magic-hat-wobble .6s ease-in-out;
  transform: scale(1.1);
  filter: drop-shadow(0 4px 8px rgba(0,0,0,.4))
          drop-shadow(0 0 10px rgba(239,34,58,.85))
          drop-shadow(0 0 28px rgba(239,34,58,.65));
}
.magic-hat-sparkle {
  position: absolute; color: var(--magic-gold, #E9C46A);
  font-size: 12px; pointer-events: none; opacity: 0; top: 12px;
  text-shadow: 0 0 8px rgba(233,196,106,.9);
}
.magic-hat:hover .magic-hat-sparkle { animation: magic-hat-sparkle-rise .9s ease-out forwards; }
.magic-hat-sparkle.mh1 { left: 20px; --hx: -10px; animation-delay: .05s; }
.magic-hat-sparkle.mh2 { left: 32px; --hx: 0px; animation-delay: .15s; }
.magic-hat-sparkle.mh3 { left: 44px; --hx: 12px; animation-delay: .25s; }
.magic-hat-bubble {
  position: absolute; top: -4px; left: 78px;
  padding: 14px 18px 14px 20px;
  background: var(--th-card, #232B45);
  border: 1px solid rgba(107,63,160,.45);
  border-radius: 14px;
  box-shadow: 0 12px 32px var(--th-card-shadow, rgba(0,0,0,.3)), 0 0 20px rgba(107,63,160,.18);
  opacity: 0;
  transform: translateX(-10px) scale(.9);
  transform-origin: left center;
  transition: opacity .3s ease .1s, transform .35s cubic-bezier(.2,.9,.3,1.2) .1s;
  pointer-events: none;
  min-width: 240px; white-space: nowrap;
}
.magic-hat-bubble::before {
  content: ""; position: absolute; left: -8px; top: 22px;
  width: 14px; height: 14px;
  background: var(--th-card, #232B45);
  border-left: 1px solid rgba(107,63,160,.45);
  border-bottom: 1px solid rgba(107,63,160,.45);
  transform: rotate(45deg);
}
.magic-hat-bubble strong {
  display: block; font-size: 13px; margin-bottom: 4px;
  color: var(--th-text, #FFFFFF);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, sans-serif;
  font-weight: 700;
}
.magic-hat-bubble a {
  display: block; margin-top: 4px; font-size: 12px;
  color: var(--blue-400, #2188EF); text-decoration: none;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, sans-serif;
}
.magic-hat-bubble a:hover { text-decoration: underline; }
.magic-hat-bubble .slack {
  margin-top: 4px; font-size: 12px;
  color: var(--th-text-dim, #9AA0B4);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, sans-serif;
}
.magic-hat:hover .magic-hat-bubble { opacity: 1; transform: translateX(0) scale(1); pointer-events: auto; }
@media (max-width: 760px) { .magic-hat { display: none; } }
`;

const MAGIC_HAT_HTML = `
<div class="magic-hat" aria-label="Built by the Twilio Magician">
  <svg class="magic-hat-svg" viewBox="0 0 64 64" fill="none">
    <ellipse cx="32" cy="54" rx="28" ry="5" fill="#0A0A0A"/>
    <ellipse cx="32" cy="52" rx="26" ry="3.5" fill="#1C1C1C"/>
    <path d="M14 52 L14 20 Q14 14 20 14 L44 14 Q50 14 50 20 L50 52 Z" fill="#0A0A0A"/>
    <path d="M14 52 L14 20 Q14 14 20 14 L44 14 Q50 14 50 20 L50 52 Z" fill="url(#magicHatShine)" opacity="0.35"/>
    <rect x="14" y="44" width="36" height="6" fill="#EF223A"/>
    <rect x="14" y="44" width="36" height="1.5" fill="#A81025"/>
    <path d="M18 18 L18 46" stroke="#2A2A2A" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
    <defs>
      <linearGradient id="magicHatShine" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
      </linearGradient>
    </defs>
  </svg>
  <span class="magic-hat-sparkle mh1">&#10023;</span>
  <span class="magic-hat-sparkle mh2">&#10022;</span>
  <span class="magic-hat-sparkle mh3">&#10023;</span>
  <div class="magic-hat-bubble">
    <strong>Built by the Twilio Magician</strong>
    <a href="https://twil.io/magic" target="_blank" rel="noopener">&rarr; twil.io/magic</a>
    <div class="slack">Slack: Anthony Dellavecchia</div>
  </div>
</div>
`;

function magicHatSnippet() {
    return `<style>${MAGIC_HAT_CSS}</style>${MAGIC_HAT_HTML}`;
}

// ── twModal loader ──────────────────────────────────────────────────────────
// Emits the <link> + <script> that load the themed modal component used in
// place of window.alert/confirm/prompt across admin pages. Drop near the
// top of <head> so the CSS is available before any modal is rendered.
function twModalSnippet() {
    return `<link rel="stylesheet" href="/assets/tw-modal.css">\n<script src="/assets/tw-modal.js"></script>`;
}

// ── Mount helper ────────────────────────────────────────────────────────────

function mountAuth(app) {
    app.use("/auth", router);
}

module.exports = {
    mountAuth,
    requireAuth,
    isPublicRoute,
    userBarSnippet,
    themeToggleButton,
    magicHatSnippet,
    twModalSnippet,
    makeReviewToken,
    verifyReviewToken,
    parseCookie,
    authenticateAdminSession,
    credentialMatches,
    getAdminPin,
    hasAdminAuth,
    pinFailureState,
    recordPinFailure,
    clearPinFailures,
    PIN_FAILURE_LIMIT,
    REVIEW_TOKEN_TTL,
    __test: { pinFailures, recordPinFailure, prunePinFailures, PIN_FAILURE_MAX_ENTRIES },
};
