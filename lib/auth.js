const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

const router = express.Router();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    (() => {
        const s = crypto.randomBytes(32).toString("hex");
        console.log("⚠️  SESSION_SECRET not set — generated ephemeral secret (sessions won't survive restart)");
        return s;
    })();

const SESSION_MAX_AGE = 86400; // 24 hours

// ── Session tokens (HMAC-signed, no server-side store) ──────────────────────

function makeSessionToken(email) {
    const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_MAX_AGE * 1000 })).toString("base64url");
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
        return { email: data.email };
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

// ── Public route check ──────────────────────────────────────────────────────

function isPublicRoute(req) {
    const method = req.method.toUpperCase();
    const p = req.path;

    if (p.startsWith("/auth")) return true;
    if (p === "/healthz") return true;
    if (p === "/") return true;
    if (p.startsWith("/assets/") || p.startsWith("/images/")) return true;
    if (p.startsWith("/home")) return true;
    if (p === "/sms") return true;
    if (p.startsWith("/relay")) return true;
    if (p.startsWith("/photogallery") && method === "GET") return true;

    return false;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (!CLIENT_ID) return next(); // OAuth not configured — allow all

    const token = parseCookie(req, "session");
    const user = verifySessionToken(token);
    if (user) {
        req.user = user;
        return next();
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1219; color: #b8c0cc; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #1a2030; border: 1px solid #252d3a; border-radius: 16px;
    padding: 48px 40px; text-align: center; max-width: 400px; width: 90%;
  }
  .card h1 { font-size: 22px; color: #fff; margin-bottom: 8px; }
  .card p { font-size: 13px; color: #525c6c; margin-bottom: 32px; }
  .error {
    background: rgba(242,47,70,.1); border: 1px solid rgba(242,47,70,.3);
    color: #F22F46; border-radius: 8px; padding: 10px 14px;
    font-size: 13px; margin-bottom: 20px;
  }
  .btn {
    display: inline-flex; align-items: center; gap: 10px;
    background: #fff; color: #333; border: 1px solid #ddd; border-radius: 8px;
    padding: 12px 28px; font-size: 14px; font-weight: 600;
    text-decoration: none; cursor: pointer; transition: all .15s;
  }
  .btn:hover { background: #f5f5f5; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  .btn svg { width: 20px; height: 20px; }
  .footer { margin-top: 24px; font-size: 11px; color: #3a4050; }
</style>
</head>
<body>
<div class="card">
  <h1>Admin Login</h1>
  <p>Sign in with your @twilio.com Google account</p>
  {{ERROR}}
  <a class="btn" href="{{AUTH_URL}}">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Sign in with Google
  </a>
  <div class="footer">Only @twilio.com accounts are allowed</div>
</div>
</body>
</html>`;

// ── Routes ──────────────────────────────────────────────────────────────────

router.get("/login", (req, res) => {
    if (!CLIENT_ID) {
        return res.status(503).send("Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }

    const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
    const next_url = req.query.next || "/dashboard";
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
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
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: `${baseUrl}/auth/callback`,
            grant_type: "authorization_code",
        });

        // Decode ID token payload (middle segment)
        const idToken = tokenRes.data.id_token;
        const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());

        // Enforce @twilio.com domain
        if (payload.hd !== "twilio.com" || !payload.email_verified) {
            return res.redirect(`/auth/login?error=${encodeURIComponent("Only @twilio.com accounts are allowed")}&next=${encodeURIComponent(next_url)}`);
        }

        // Set session cookie and redirect
        const token = makeSessionToken(payload.email);
        setSessionCookie(res, token, req);
        console.log(`🔐 Login: ${payload.email}`);
        res.redirect(next_url);
    } catch (err) {
        console.error("OAuth callback error:", err.response?.data || err.message);
        res.redirect(`/auth/login?error=${encodeURIComponent("Authentication failed — please try again")}&next=${encodeURIComponent(next_url)}`);
    }
});

router.post("/logout", (req, res) => {
    res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/auth/login");
});

// ── Mount helper ────────────────────────────────────────────────────────────

function mountAuth(app) {
    app.use("/auth", router);
}

module.exports = { mountAuth, requireAuth, isPublicRoute };
