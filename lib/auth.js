const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

const router = express.Router();

function getClientId() { return process.env.GOOGLE_CLIENT_ID || ""; }
function getClientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ""; }
const SESSION_SECRET =
    process.env.SESSION_SECRET ||
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

// ── Session tokens (HMAC-signed, no server-side store) ──────────────────────

function makeSessionToken({ email, name, picture }) {
    const payload = Buffer.from(JSON.stringify({ email, name, picture, exp: Date.now() + SESSION_MAX_AGE * 1000 })).toString("base64url");
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
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (data.exp < Date.now()) return null;
        return { email: data.email, name: data.name || "", picture: data.picture || "" };
    } catch {
        return null;
    }
}

function parseCookie(req, name) {
    const header = req.headers.cookie || "";
    const match = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function setSessionCookie(res, token, req) {
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const parts = [`session=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_MAX_AGE}`];
    if (isSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
}

// ── Review tokens (HMAC-signed, scoped to /review) ─────────────────────────

function makeReviewToken() {
    const payload = Buffer.from(JSON.stringify({ purpose: "review", exp: Date.now() + REVIEW_TOKEN_TTL * 1000 })).toString("base64url");
    const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    return `${payload}.${sig}`;
}

function verifyReviewToken(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (data.purpose !== "review" || data.exp < Date.now()) return null;
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
    if (p === "/sms") return true;
    if (p.startsWith("/relay")) return true;
    if (p.startsWith("/images")) return true;
    if (p.startsWith("/assets")) return true;
    if (p.startsWith("/review")) return true;

    return false;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    // Check existing session first — works even if OAuth env vars
    // haven't been injected yet (e.g. right after a container deploy).
    const token = parseCookie(req, "session");
    const user = verifySessionToken(token);
    if (user) {
        req.user = user;
        return next();
    }

    // No valid session — need OAuth to be configured for login
    if (!getClientId()) {
        if (req.path.includes("/api/")) {
            return res.status(401).json({ error: "OAuth not configured" });
        }
        return res.status(503).send("Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }

    // API requests get 401, pages get redirected
    if (req.path.includes("/api/")) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    const next_url = encodeURIComponent(req.originalUrl);
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
    overflow: hidden; position: relative;
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
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  .btn-google:hover { background: #f8f8f8; box-shadow: 0 6px 24px rgba(0,0,0,.15); transform: translateY(-2px); }
  .btn-google:active { transform: translateY(0); }
  .btn-google svg { width: 20px; height: 20px; flex-shrink: 0; }

  .divider {
    display: flex; align-items: center; gap: 12px; margin: 28px 0 0;
  }
  .divider::before, .divider::after {
    content: ''; flex: 1; height: 1px; background: var(--th-card-border);
  }
  .divider span {
    font-family: 'Twilio Sans Mono', monospace; font-size: 9px;
    text-transform: uppercase; letter-spacing: 1.5px; color: var(--th-text-muted);
  }

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
    <p class="subtitle">Sign in with your @twilio.com Google account</p>
    {{ERROR}}
    <a class="btn-google" href="{{AUTH_URL}}">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </a>
    <div class="divider"><span>Twilio internal</span></div>
    <div class="footer">Only @twilio.com accounts are allowed</div>
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

router.get("/login", (req, res) => {
    if (!getClientId()) {
        return res.status(503).send("Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }

    const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
    const next_url = req.query.next || "/home";
    const params = new URLSearchParams({
        client_id: getClientId(),
        redirect_uri: `${baseUrl}/auth/callback`,
        response_type: "code",
        scope: "openid email profile",
        hd: "twilio.com",
        state: next_url,
        prompt: "select_account",
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    const error = req.query.error;
    const errorHtml = error ? `<div class="error">${error}</div>` : "";
    const html = LOGIN_HTML.replace("{{AUTH_URL}}", authUrl).replace("{{ERROR}}", errorHtml);

    res.setHeader("Content-Type", "text/html");
    res.send(html);
});

router.get("/callback", async (req, res) => {
    const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
    const code = req.query.code;
    const next_url = req.query.state || "/dashboard";

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
        const token = makeSessionToken({ email: payload.email, name: payload.name || "", picture: payload.picture || "" });
        setSessionCookie(res, token, req);
        console.log(`🔐 Login: ${payload.email}`);
        res.redirect(next_url);
    } catch (err) {
        console.error("OAuth callback error:", err.response?.data || err.message);
        res.redirect(`/auth/login?error=${encodeURIComponent("Authentication failed — please try again")}&next=${encodeURIComponent(next_url)}`);
    }
});

router.get("/me", (req, res) => {
    const token = parseCookie(req, "session");
    const user = verifySessionToken(token);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json({ email: user.email, name: user.name, picture: user.picture });
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
    img.src=u.picture||'';img.alt='';img.referrerPolicy='no-referrer';
    img.onerror=function(){this.style.display='none'};
    const name=document.createElement('span');name.className='user-bar-name';
    name.textContent=u.name||u.email.split('@')[0];
    const btn=document.createElement('button');btn.className='user-bar-logout';
    btn.title='Sign out';btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    btn.onclick=function(){fetch('/auth/logout',{method:'POST'}).then(()=>location='/auth/login')};
    bar.append(img,name,btn);
    var hdr=document.querySelector('.header-controls')||document.querySelector('.hdr-controls');
    if(hdr){hdr.appendChild(bar)}else{bar.classList.add('user-bar--fixed');document.body.appendChild(bar)}
  });
})();
`;

function userBarSnippet() {
    return `<style>${USER_BAR_CSS}</style><script>${USER_BAR_JS}</script>`;
}

// ── Mount helper ────────────────────────────────────────────────────────────

function mountAuth(app) {
    app.use("/auth", router);
}

module.exports = { mountAuth, requireAuth, isPublicRoute, userBarSnippet, makeReviewToken, verifyReviewToken, parseCookie, REVIEW_TOKEN_TTL };
