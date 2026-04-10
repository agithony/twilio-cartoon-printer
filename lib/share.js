const fs = require("fs");
const path = require("path");
const express = require("express");
const settings = require("./settings");
const { DONE_DIR } = require("./config");
const leads = require("./leads");

const router = express.Router();

function escHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sanitizeParam(s) {
    return String(s || "").replace(/[^a-zA-Z0-9_\-]/g, "");
}

function findJob(filePrefix) {
    try {
        const files = fs.readdirSync(DONE_DIR);
        for (const f of files) {
            if (f.startsWith(filePrefix) && f.endsWith(".json")) {
                return JSON.parse(fs.readFileSync(path.join(DONE_DIR, f), "utf-8"));
            }
        }
    } catch { /* ignore */ }
    return null;
}

function resolveImage(filePrefix, eventName) {
    const dlDir = settings.getDownloadDir(eventName);
    const imageFile = `${filePrefix}_output_mms.jpg`;
    const imagePath = path.resolve(path.join(dlDir, imageFile));
    if (!imagePath.startsWith(path.resolve(dlDir))) return { imageFile, imagePath, exists: false };
    return { imageFile, imagePath, exists: fs.existsSync(imagePath) };
}

// Event-aware image route — always resolves from the correct event directory,
// even if the admin has since switched to a different event.
router.get("/:filePrefix/img", (req, res) => {
    const eventName = sanitizeParam(req.query.e) || settings.get("eventName");
    const { imagePath, exists } = resolveImage(sanitizeParam(req.params.filePrefix), eventName);
    if (!exists) return res.status(404).end();
    res.sendFile(imagePath);
});

router.get("/:filePrefix", (req, res) => {
    const filePrefix = sanitizeParam(req.params.filePrefix);
    const eventName = sanitizeParam(req.query.e) || settings.get("eventName");

    const { imageFile, exists } = resolveImage(filePrefix, eventName);
    if (!exists) return res.status(404).send(notFoundPage());

    // Build absolute URLs — use the event-aware /s/:prefix/img route so images
    // survive event switches and OG crawlers always find the right file.
    const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
    const eParam = encodeURIComponent(eventName);
    const imageUrl = `${baseUrl}/s/${filePrefix}/img?e=${eParam}`;
    const sharePageUrl = `${baseUrl}/s/${filePrefix}?e=${eParam}`;

    // Look up job for short link and user phone
    const job = findJob(filePrefix);
    const socialUrl = (job && job.shareUrl) || sharePageUrl;

    // Resolve personalized title if lead data has firstName
    const firstName = (job && job.userPhone) ? leads.getFirstName(job.userPhone, eventName) : null;
    const defaultTitle = settings.getForEvent("sharePageTitle", eventName) || "My AI Portrait";
    const personalizedTemplate = settings.getForEvent("sharePageTitlePersonalized", eventName) || "";
    const pageTitle = (firstName && personalizedTemplate)
        ? personalizedTemplate.replace(/\{firstName\}/g, firstName)
        : defaultTitle;

    // Settings
    const pageDesc = settings.getForEvent("sharePageDescription", eventName) || "Check out my AI portrait, powered by Twilio!";

    const twitterEnabled = settings.getForEvent("enableTwitterShare", eventName) !== false;
    const linkedInEnabled = settings.getForEvent("enableLinkedInShare", eventName) !== false;
    const instagramEnabled = settings.getForEvent("enableInstagramShare", eventName) !== false;

    const twitterHandle = settings.getForEvent("twitterHandle", eventName) || "@twilio";
    const twitterTextTemplate = settings.getForEvent("twitterShareText", eventName) || "Check out my AI portrait from {eventName}! Made with @twilio on X";
    const instagramHandle = settings.getForEvent("instagramHandle", eventName) || "@twilio";

    const twitterText = twitterTextTemplate.replace(/\{eventName\}/g, eventName);

    // Build intent URLs — both use the share URL so crawlers see OG meta tags
    const twitterIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(twitterText)}&url=${encodeURIComponent(socialUrl)}`;
    const linkedInShareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(socialUrl)}`;

    // Build share buttons HTML
    let buttonsHtml = "";

    if (twitterEnabled) {
        buttonsHtml += `
        <a href="${escHtml(twitterIntentUrl)}" target="_blank" rel="noopener" class="share-btn share-btn-twitter">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            Share on X
        </a>`;
    }

    if (linkedInEnabled) {
        buttonsHtml += `
        <a href="${escHtml(linkedInShareUrl)}" target="_blank" rel="noopener" class="share-btn share-btn-linkedin">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            Share on LinkedIn
        </a>`;
    }

    if (instagramEnabled) {
        buttonsHtml += `
        <a href="${escHtml(imageUrl)}" download="${escHtml(imageFile)}" class="share-btn share-btn-instagram">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
            Save for Instagram
        </a>
        <p class="ig-hint">Save the image, then share it on Instagram ${escHtml(instagramHandle)}</p>`;
    }

    // Always show download button
    buttonsHtml += `
    <a href="${escHtml(imageUrl)}" download="${escHtml(imageFile)}" class="share-btn share-btn-download">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Image
    </a>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(pageTitle)}</title>

<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:title" content="${escHtml(pageTitle)}">
<meta property="og:description" content="${escHtml(pageDesc)}">
<meta property="og:image" content="${escHtml(imageUrl)}">
<meta property="og:url" content="${escHtml(sharePageUrl)}">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(pageTitle)}">
<meta name="twitter:description" content="${escHtml(pageDesc)}">
<meta name="twitter:image" content="${escHtml(imageUrl)}">

<style>
/* ── Twilio Sans ─────────────────────────────────────────────────────────── */
@font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Regular.otf') format('opentype'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Extrabold.otf') format('opentype'); font-weight: 800; font-display: swap; }
@font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Bold.otf') format('opentype'); font-weight: 700; font-display: swap; }
@font-face { font-family: 'Twilio Sans Mono'; src: url('/assets/fonts/TwilioSansMono-Regular.otf') format('opentype'); font-weight: 400; font-display: swap; }

/* ── Brand primitives ────────────────────────────────────────────────────── */
:root {
    --brand-red: #EF223A;
    --brand-red-hover: #DB132A;
    --ink: #000D25;
    --red-400: #F83D53;
    --blue-400: #2188EF;
    --gray-50: #F3F4F7;
    --gray-100: #DDE0E6;
    --gray-200: #BABECC;
    --gray-500: #656E87;
    --gray-600: #4D5777;
    --gray-700: #38425E;
    --gray-800: #232B45;
    --gray-850: #191F36;
    --gray-900: #080C18;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--ink);
    color: var(--gray-50);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
    position: relative;
}

/* ── Ambient glow (brand pattern) ────────────────────────────────────────── */
body::before {
    content: '';
    position: fixed;
    top: -40%; left: -20%;
    width: 140%; height: 140%;
    background:
        radial-gradient(ellipse at 30% 20%, rgba(239,34,58,0.12) 0%, transparent 55%),
        radial-gradient(ellipse at 70% 80%, rgba(33,136,239,0.06) 0%, transparent 50%);
    pointer-events: none;
    z-index: 0;
}

/* ── Layout ──────────────────────────────────────────────────────────────── */
.container {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 480px;
    padding: 32px 16px 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
}

/* ── Builder shape (behind card) ─────────────────────────────────────────── */
.builder-shape {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -48%);
    width: 520px; height: 520px;
    pointer-events: none;
    opacity: 0.10;
    z-index: 0;
}

/* ── Bug mark ────────────────────────────────────────────────────────────── */
.bug-mark {
    filter: drop-shadow(0 0 20px rgba(239,34,58,0.35));
}

/* ── Eyebrow label ───────────────────────────────────────────────────────── */
.eyebrow {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--brand-red);
}

/* ── Portrait card ───────────────────────────────────────────────────────── */
.portrait-card {
    position: relative;
    width: 100%;
    background: var(--gray-800);
    border: 1px solid var(--gray-700);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 8px 40px rgba(0,0,0,0.3), 0 0 80px rgba(239,34,58,0.06);
}
.portrait-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--brand-red) 0%, var(--red-400) 40%, var(--blue-400) 100%);
    z-index: 1;
}
.portrait-card img {
    width: 100%;
    height: auto;
    display: block;
}

/* ── Page title ──────────────────────────────────────────────────────────── */
h1 {
    font-family: 'Twilio Sans Display', sans-serif;
    font-size: 24px;
    font-weight: 800;
    text-align: center;
    letter-spacing: 0.02em;
    line-height: 1;
    color: #fff;
}

/* ── Share buttons ───────────────────────────────────────────────────────── */
.share-buttons {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.share-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 14px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    font-family: 'Twilio Sans Text', sans-serif;
    text-decoration: none;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    border: none;
}
.share-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(0,0,0,0.3);
}
.share-btn:active { transform: translateY(0); }
.share-btn svg { flex-shrink: 0; }

.share-btn-twitter {
    background: #000;
    color: #fff;
    border: 1px solid var(--gray-700);
}
.share-btn-twitter:hover { border-color: var(--gray-500); }

.share-btn-linkedin {
    background: #0A66C2;
    color: #fff;
}
.share-btn-linkedin:hover { background: #0958a8; }

.share-btn-instagram {
    background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);
    color: #fff;
}

.share-btn-download {
    background: var(--gray-800);
    color: var(--gray-50);
    border: 1px solid var(--gray-700);
}
.share-btn-download:hover { border-color: var(--gray-600); background: var(--gray-850); }

.ig-hint {
    font-size: 12px;
    color: var(--gray-500);
    text-align: center;
    margin-top: -6px;
}

/* ── Divider ─────────────────────────────────────────────────────────────── */
.divider {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
}
.divider::before, .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--gray-700);
}
.divider span {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--gray-500);
}

/* ── Footer ──────────────────────────────────────────────────────────────── */
.footer {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--gray-500);
    text-align: center;
}
.footer a {
    color: var(--brand-red);
    text-decoration: none;
}
.footer a:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="container">
    <!-- Builder shape (subtle brand element) -->
    <svg class="builder-shape" viewBox="0 0 480 480" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M70,24 Q24,24 24,70 L24,230 Q24,300 70,345 L210,415 Q255,440 325,390 L415,275 Q460,230 460,160 L460,70 Q460,24 415,24 Z" stroke="#EF223A" stroke-width="4" fill="none"/>
    </svg>

    <!-- Bug mark with glow -->
    <div class="bug-mark">
        <svg width="40" height="40" viewBox="0 0 46 46" fill="none"><path d="M17.25 33.17C19.69 33.17 21.67 31.19 21.67 28.75C21.67 26.31 19.69 24.33 17.25 24.33C14.81 24.33 12.83 26.31 12.83 28.75C12.83 31.19 14.81 33.17 17.25 33.17ZM17.25 21.67C19.69 21.67 21.67 19.69 21.67 17.25C21.67 14.81 19.69 12.83 17.25 12.83C14.81 12.83 12.83 14.81 12.83 17.25C12.83 19.69 14.81 21.67 17.25 21.67ZM28.75 33.17C31.19 33.17 33.17 31.19 33.17 28.75C33.17 26.31 31.19 24.33 28.75 24.33C26.31 24.33 24.33 26.31 24.33 28.75C24.33 31.19 26.31 33.17 28.75 33.17ZM28.75 21.67C31.19 21.67 33.17 19.69 33.17 17.25C33.17 14.81 31.19 12.83 28.75 12.83C26.31 12.83 24.33 14.81 24.33 17.25C24.33 19.69 26.31 21.67 28.75 21.67ZM23 0C35.46 0 46 10.54 46 23C46 35.46 35.46 46 23 46C10.54 46 0 35.46 0 23C0 10.54 10.54 0 23 0ZM23 6.19C13.74 6.19 6.19 13.48 6.19 22.69C6.19 31.9 13.74 39.81 23 39.81C32.26 39.81 39.81 31.9 39.81 22.69C39.81 13.48 32.26 6.19 23 6.19Z" fill="#EF223A"/></svg>
    </div>

    <!-- Eyebrow -->
    <span class="eyebrow">AI Photobooth</span>

    <!-- Portrait in branded card -->
    <div class="portrait-card">
        <img src="${escHtml(imageUrl)}" alt="AI Portrait">
    </div>

    <h1>${escHtml(pageTitle)}</h1>

    <!-- Share buttons -->
    <div class="share-buttons">
        ${buttonsHtml}
    </div>

    <div class="divider"><span>Powered by Twilio</span></div>

    <div class="footer">Built with <a href="https://www.twilio.com" target="_blank" rel="noopener">Twilio</a> APIs</div>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
});

function notFoundPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not Found</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #080C18; color: #9AA0B4; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.msg { text-align: center; }
.msg h1 { font-size: 48px; color: #EF223A; margin-bottom: 8px; }
.msg p { font-size: 16px; }
</style>
</head>
<body><div class="msg"><h1>404</h1><p>This portrait was not found or has expired.</p></div></body>
</html>`;
}

function mountShare(app) {
    app.use("/s", router);
}

module.exports = { mountShare };
