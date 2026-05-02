const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const settings = require("./settings");
const brb = require("./brb");
const { moveJobsToEvent } = require("./queue");
const { DONE_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR } = require("./config");

const ROOT_DIR = path.join(__dirname, "..");
const router = express.Router();
router.use(express.json());

// Cached prefix→style map (stale-while-revalidate — never blocks event loop)
let _styleMapCache = { map: {}, ts: 0 };
const STYLE_MAP_TTL = 30_000; // 30 seconds

function _refreshStyleMap() {
    const dirs = [DONE_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR, GENERATING_DIR, PENDING_DIR];
    (async () => {
        const map = {};
        for (const qDir of dirs) {
            try {
                const files = (await fsp.readdir(qDir)).filter(f => f.endsWith(".json"));
                for (const f of files) {
                    try {
                        const j = JSON.parse(await fsp.readFile(path.join(qDir, f), "utf-8"));
                        if (j.filePrefix && j.style) map[j.filePrefix] = j.style;
                    } catch {}
                }
            } catch {}
        }
        _styleMapCache = { map, ts: Date.now() };
    })();
}

function _getStyleMap() {
    const now = Date.now();
    if (now - _styleMapCache.ts >= STYLE_MAP_TTL) {
        _refreshStyleMap();
    }
    return _styleMapCache.map;
}

// Pre-warm on module load
_refreshStyleMap();

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    res.type("html").send(buildPageHtml());
});

router.get("/img/:event/:file", (req, res) => {
    const { event, file } = req.params;
    if (event.includes("..") || file.includes("..")) return res.sendStatus(400);
    const root = path.join(ROOT_DIR, "downloads", event);
    res.sendFile(file, { root }, (err) => {
        if (err && !res.headersSent) res.sendStatus(404);
    });
});

function gallerySettings() {
    return {
        currentEvent: settings.get("eventName"),
        termsUrl: settings.get("termsUrl") || "",
        revealAnimation: settings.get("revealAnimation") || "off",
        photoBookAutoplay: settings.get("photoBookAutoplay") !== false,
        photoBookInterval: settings.get("photoBookInterval") || 10,
        milestonesEnabled: settings.get("milestonesEnabled") !== false,
        milestoneInterval: settings.get("milestoneInterval") || 100,
    };
}

router.get("/api/events", async (req, res) => {
    try {
        const dlRoot = path.join(ROOT_DIR, "downloads");
        const entries = await fsp.readdir(dlRoot, { withFileTypes: true });
        const events = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
        res.json({ events, ...gallerySettings() });
    } catch {
        res.json({ events: [], ...gallerySettings() });
    }
});

router.get("/api/images", async (req, res) => {
    try {
        const event = req.query.event;
        let dirs;
        if (event && event !== "all") {
            if (event.includes("..") || event.includes("/")) return res.sendStatus(400);
            dirs = [{ dir: path.join(ROOT_DIR, "downloads", event), event }];
        } else if (event === "all") {
            const dlRoot = path.join(ROOT_DIR, "downloads");
            const entries = await fsp.readdir(dlRoot, { withFileTypes: true });
            dirs = entries.filter((d) => d.isDirectory())
                .map((d) => ({ dir: path.join(dlRoot, d.name), event: d.name }));
        } else {
            dirs = [{ dir: settings.getDownloadDir(), event: settings.get("eventName") }];
        }

        const styleMap = _getStyleMap();
        const activeStyles = settings.getActiveStyles();

        const images = [];
        for (const { dir, event: ev } of dirs) {
            let allFilesList;
            try { allFilesList = await fsp.readdir(dir); } catch { continue; }
            const allFiles = new Set(allFilesList);
            const mmsFiles = [...allFiles].filter((f) => f.endsWith("_output_mms.jpg"));
            for (const f of mmsFiles) {
                const prefix = f.replace(/_output_mms\.jpg$/, "");
                const style = styleMap[prefix];
                const styleName = style && activeStyles[style] ? activeStyles[style].name : (style || null);
                images.push({
                    file: f,
                    event: ev,
                    prefix,
                    hasAi: true,
                    hasSelfie: allFiles.has(prefix + "_input.jpg"),
                    style: styleName,
                });
            }
        }
        images.sort((a, b) => b.file.localeCompare(a.file));
        // Count unique styles from actual images, not current event settings
        const uniqueStyles = new Set(images.map((img) => img.style).filter(Boolean));
        const activeStyleCount = uniqueStyles.size;
        res.json({ images, total: images.length, activeStyleCount });
    } catch {
        res.json({ images: [], total: 0 });
    }
});

// Delete specific images by prefix + type
// body: { event, items: [{ prefix, type: "ai"|"selfie"|"both" }] }
router.delete("/api/images", async (req, res) => {
    const { event, items } = req.body || {};
    if (!event || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "event and items[] required" });
    }
    if (event.includes("..") || event.includes("/")) return res.sendStatus(400);
    const dir = path.join(ROOT_DIR, "downloads", event);
    try { await fsp.access(dir); } catch { return res.json({ deleted: 0, errors: [] }); }

    const SUFFIXES_AI = ["_output.png", "_output_mms.jpg"];
    const SUFFIXES_SELFIE = ["_input.jpg"];

    let deleted = 0;
    const errors = [];
    for (const { prefix, type } of items) {
        if (!prefix || prefix.includes("..") || prefix.includes("/")) continue;
        const suffixes = type === "selfie" ? SUFFIXES_SELFIE
            : type === "ai" ? SUFFIXES_AI
            : [...SUFFIXES_AI, ...SUFFIXES_SELFIE];
        for (const suffix of suffixes) {
            const fp = path.join(dir, prefix + suffix);
            try {
                await fsp.unlink(fp); deleted++;
            } catch (e) {
                if (e.code !== "ENOENT") errors.push(`${prefix}${suffix}: ${e.message}`);
            }
        }
    }
    console.log(`🗑️  Deleted ${deleted} files (${items.length} items) from ${event}`);
    res.json({ deleted, errors });
});

// Delete ALL images for an event
router.delete("/api/images/all", async (req, res) => {
    const { event, type } = req.body || {};
    if (!event) return res.status(400).json({ error: "event required" });
    if (event.includes("..") || event.includes("/")) return res.sendStatus(400);
    const dir = path.join(ROOT_DIR, "downloads", event);
    try { await fsp.access(dir); } catch { return res.json({ deleted: 0 }); }

    let deleted = 0;
    const suffixes = type === "selfie" ? ["_input.jpg"]
        : type === "ai" ? ["_output.png", "_output_mms.jpg"]
        : ["_input.jpg", "_output.png", "_output_mms.jpg"];
    try {
        const files = await fsp.readdir(dir);
        for (const f of files) {
            if (suffixes.some((s) => f.endsWith(s))) {
                await fsp.unlink(path.join(dir, f));
                deleted++;
            }
        }
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
    const label = type === "selfie" ? "selfies" : type === "ai" ? "AI outputs" : "ALL";
    console.log(`🗑️  Deleted ${label} ${deleted} files from event "${event}"`);
    res.json({ deleted });
});

// Move photos between events
router.post("/api/move", async (req, res) => {
    const { prefixes, fromEvent, toEvent } = req.body || {};
    if (!Array.isArray(prefixes) || !prefixes.length || !fromEvent || !toEvent) {
        return res.status(400).json({ error: "prefixes, fromEvent, and toEvent required" });
    }
    if (fromEvent === toEvent) return res.status(400).json({ error: "Source and target events are the same" });
    if ([fromEvent, toEvent].some(e => e.includes("..") || e.includes("/") || e.includes("\\"))) {
        return res.sendStatus(400);
    }
    try {
        const results = await moveJobsToEvent(prefixes, fromEvent, toEvent);
        const moved = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        res.json({ moved, failed, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
  background: #000D25;
  background-image:
    radial-gradient(ellipse at 50% 40%, rgba(0,30,80,0.4) 0%, transparent 70%);
}

.scene { display: flex; flex-direction: column; height: 100vh; }

/* ── Top bar ── */
.top-bar {
  flex-shrink: 0; display: flex; flex-direction: column; align-items: center;
  padding: clamp(6px,1vh,12px) 20px 0; gap: 0; position: relative; z-index: 5;
}
.top-bar-row {
  display: flex; justify-content: center; align-items: center;
  width: 100%; position: relative; min-height: 36px;
}
.count-label {
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  font-size: clamp(18px,1.6vw,26px); color: rgba(242,47,70,0.7);
  font-style: italic; font-weight: 400; letter-spacing: 0.03em;
  text-align: center; flex-shrink: 0; margin-top: auto; padding-bottom: 4px;
}
.count-label strong {
  font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  color: #F22F46; font-weight: 800;
  font-size: clamp(26px,2.2vw,42px); font-style: normal;
  display: inline-block;
}
.top-bar.bump strong { animation: cBump .6s cubic-bezier(.36,.07,.19,.97); }
@keyframes cBump {
  0%   { transform: scale(1); color: #F22F46; }
  15%  { transform: scale(1.35); color: #fff; }
  30%  { transform: scale(0.95); }
  45%  { transform: scale(1.15); color: #fff; }
  100% { transform: scale(1); color: #F22F46; }
}

.top-controls {
  position: absolute; right: 16px; display: flex; gap: 6px;
}
.left-controls {
  position: absolute; left: 16px; display: flex; align-items: center; gap: 6px;
}
.ev-sel {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 28px 6px 12px; color: rgba(242,47,70,0.8);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 400;
  cursor: pointer; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23F22F46' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: all .2s ease; max-width: 220px;
}
.ev-sel:hover { color: #F22F46; background-color: rgba(255,255,255,0.1); }
.ev-sel:focus { outline: none; border-color: rgba(242,47,70,0.3); }
.ev-sel option { background: #1a1a2e; color: #F22F46; }
.top-btn {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 12px; color: rgba(242,47,70,0.6);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 400;
  cursor: pointer; user-select: none; display: flex; align-items: center; gap: 5px;
  transition: all .2s ease;
}
.top-btn:hover { color: #F22F46; background: rgba(255,255,255,0.1); }
.top-btn svg { width: 14px; height: 14px; }

/* ── Book area ── */
.book-area {
  flex: 1; display: flex; align-items: center; justify-content: center;
  min-height: 0; padding: clamp(8px,1.5vh,16px) clamp(30px,4vw,70px); position: relative;
}

/* Book wrapper sizes the book */
.book-wrap {
  width: 82vw; height: 60vh;
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
  color: rgba(242,47,70,0.3); line-height: 1.6;
  text-align: center;
}

/* ── Book decoration wrapper ── */
.book-decor {
  position: relative;
  filter: drop-shadow(0 18px 50px rgba(0,0,0,0.45)) drop-shadow(0 3px 10px rgba(0,0,0,0.25));
}

/* Stacked page layers — visible page block (bottom & right edge only, like a real closed book) */
.page-layer {
  position: absolute; pointer-events: none;
  border-radius: 0 1px 1px 0;
}
.page-layer:nth-child(1) {
  right: -2px; bottom: -2px; top: 1px; left: 0;
  background: #ece7de;
  border-right: 1px solid rgba(180,170,155,0.5);
  border-bottom: 1px solid rgba(180,170,155,0.4);
}
.page-layer:nth-child(2) {
  right: -4px; bottom: -3px; top: 2px; left: 0;
  background: #e8e2d8;
  border-right: 1px solid rgba(175,165,148,0.5);
  border-bottom: 1px solid rgba(175,165,148,0.4);
}
.page-layer:nth-child(3) {
  right: -5px; bottom: -5px; top: 3px; left: 0;
  background: #e3ddd2;
  border-right: 1px solid rgba(170,158,140,0.5);
  border-bottom: 1px solid rgba(170,158,140,0.4);
}
.page-layer:nth-child(4) {
  right: -7px; bottom: -6px; top: 4px; left: 0;
  background: #ded7cb;
  border-right: 1px solid rgba(165,153,135,0.5);
  border-bottom: 1px solid rgba(165,153,135,0.4);
}
.page-layer:nth-child(5) {
  right: -8px; bottom: -8px; top: 5px; left: 0;
  background: #d9d1c4;
  border-right: 1px solid rgba(160,148,130,0.5);
  border-bottom: 1px solid rgba(160,148,130,0.45);
}
.page-layer:nth-child(6) {
  right: -10px; bottom: -9px; top: 6px; left: 0;
  background: #d4ccbe;
  border-right: 1px solid rgba(155,142,124,0.5);
  border-bottom: 1px solid rgba(155,142,124,0.45);
  box-shadow: 2px 3px 8px rgba(0,0,0,0.1);
}

/* Hardcover — filled element behind pages with leather-like surface */
.book-cover {
  position: absolute;
  inset: -10px -18px -16px -6px;
  border-radius: 3px 5px 5px 3px;
  pointer-events: none; z-index: -2;
  background:
    linear-gradient(170deg,
      #5a4935 0%, #4e3e2b 20%, #453525 50%,
      #3e2f1f 75%, #352819 100%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.1),
    inset 0 -2px 0 rgba(0,0,0,0.25),
    inset -2px 0 0 rgba(0,0,0,0.1),
    0 4px 8px rgba(0,0,0,0.3),
    0 1px 3px rgba(0,0,0,0.2);
}
/* Cover grain texture */
.book-cover::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='4' height='4' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E");
  pointer-events: none;
}
/* Spine — rounded ridge at center */
.book-cover::after {
  content: ''; position: absolute;
  left: 50%; top: -1px; bottom: -1px; width: 20px;
  transform: translateX(-50%);
  background:
    linear-gradient(90deg,
      transparent 0%,
      rgba(0,0,0,0.15) 8%,
      rgba(0,0,0,0.28) 22%,
      rgba(0,0,0,0.1) 42%,
      rgba(255,255,255,0.04) 50%,
      rgba(0,0,0,0.1) 58%,
      rgba(0,0,0,0.28) 78%,
      rgba(0,0,0,0.15) 92%,
      transparent 100%);
  border-left: 1px solid rgba(0,0,0,0.15);
  border-right: 1px solid rgba(0,0,0,0.15);
}

/* Page edge strip (right side only — left side is the spine/binding) */
.book-decor::after {
  content: ''; position: absolute; z-index: -1;
  right: -10px; top: 0; bottom: 0; width: 10px;
  border-radius: 0 1px 1px 0;
  background:
    repeating-linear-gradient(180deg,
      #e0d9cd 0px, #e0d9cd 1px,
      #eae4d9 1px, #eae4d9 2px);
  box-shadow: 1px 0 2px rgba(0,0,0,0.08), inset -1px 0 0 rgba(255,255,255,0.12);
}

/* ── Page styling ── */
.page {
  background: linear-gradient(to right, #ece7df 0%, #f5f1e9 8%, #fdfaf5 100%);
  overflow: hidden; position: relative;
  box-shadow:
    inset 0px -1px 2px rgba(50,50,50,0.08),
    inset -1px 0px 1px rgba(150,150,150,0.15);
}
/* Inner gutter shadow — darkens the edge where pages meet the spine */
.page::before {
  content: ''; position: absolute; top: 0; bottom: 0; width: 35px; z-index: 3; pointer-events: none;
}
.page.odd::before {
  left: 0;
  background: linear-gradient(90deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.02) 40%, transparent 100%);
}
.page.even::before, .page:not(.odd)::before {
  right: 0; left: auto;
  background: linear-gradient(270deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.02) 40%, transparent 100%);
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
  bottom: clamp(42px,6vh,68px);
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
.photo-frame img.hidden, .photo-frame .original-removed.hidden { opacity: 0; position: absolute; pointer-events: none; }
.photo-frame img.original { position: absolute; inset: clamp(8px,1.2vw,16px); width: auto; height: auto; max-width: calc(100% - clamp(16px,2.4vw,32px)); max-height: calc(100% - clamp(16px,2.4vw,32px)); margin: auto; }
.photo-frame .original-removed {
  position: absolute; inset: clamp(8px,1.2vw,16px); display: flex; align-items: center; justify-content: center;
  background: #000D25; border-radius: 8px; transition: opacity .3s;
}
.removed-content { text-align: center; padding: 1.5rem; }
.removed-content svg { width: 32px; height: 32px; margin-bottom: 0.75rem; opacity: 0.7; }
.removed-content .removed-title {
  font-family: 'Twilio Sans Text', sans-serif; font-weight: 700; font-size: clamp(0.8rem, 1.2vw, 1rem);
  color: #fff; margin-bottom: 0.4rem;
}
.removed-content .removed-desc {
  font-family: 'Twilio Sans Text', sans-serif; font-weight: 400; font-size: clamp(0.65rem, 0.9vw, 0.8rem);
  color: rgba(255,255,255,0.5); line-height: 1.4;
}

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
  font-size: clamp(12px,1vw,16px); font-style: italic;
  color: rgba(239,34,58,0.7); z-index: 2;
}
.page-num-left { left: clamp(14px,2vw,28px); }
.page-num-right { right: clamp(14px,2vw,28px); }

/* Per-page flip button */
.flip-btn {
  position: absolute; bottom: clamp(12px,2vh,24px); left: 50%;
  transform: translateX(-50%); z-index: 5;
  cursor: pointer; user-select: none;
  background: rgba(239,34,58,0.08);
  border: 1px solid rgba(239,34,58,0.2);
  border-radius: 8px; padding: 4px 14px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: clamp(9px,0.7vw,12px);
  font-weight: 600; color: rgba(239,34,58,0.6);
  transition: all .2s ease; white-space: nowrap;
}
.flip-btn:hover { color: rgba(239,34,58,0.85); background: rgba(239,34,58,0.14); border-color: rgba(239,34,58,0.35); }
.flip-btn.active { color: #EF223A; border-color: rgba(239,34,58,0.4); background: rgba(239,34,58,0.1); }

/* Style tag — positioned opposite the page number to avoid overlap */
.style-tag {
  position: absolute; bottom: clamp(6px,1vh,12px);
  z-index: 5; font-family: 'Twilio Sans Mono', monospace;
  font-size: clamp(10px,0.8vw,13px); font-weight: 400;
  color: rgba(239,34,58,0.7); letter-spacing: 0.03em;
  text-transform: capitalize;
}
.style-tag-left { left: clamp(14px,2vw,28px); }
.style-tag-right { right: clamp(14px,2vw,28px); }

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
  justify-content: center; position: relative; z-index: 20;
}
.ctrl-btn {
  background: rgba(255,255,255,0.05); border: 1px solid rgba(210,195,175,0.1);
  border-radius: 10px; padding: 7px 16px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 13px; font-weight: 400;
  color: rgba(242,47,70,0.5); cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px;
  transition: all .2s ease;
}
.ctrl-btn:hover { color: #F22F46; background: rgba(255,255,255,0.08); }
.ctrl-btn:active { transform: scale(0.97); }
.ctrl-btn.active { color: #F22F46; border-color: rgba(242,47,70,0.25); }
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
  box-shadow: 0 2px 6px rgba(0,0,0,0.25), 0 0 0 2px rgba(242,47,70,0.5);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* ── Fullscreen overrides ── */
:fullscreen .top-bar, :-webkit-full-screen .top-bar, .fs-active .top-bar {
  opacity: 0; transition: opacity 0.3s ease;
}
:fullscreen .top-bar:hover, :-webkit-full-screen .top-bar:hover, .fs-active .top-bar:hover {
  opacity: 1;
}
:fullscreen .thumb, :-webkit-full-screen .thumb {
  width: clamp(60px,8vh,120px); height: clamp(60px,8vh,120px); padding: 4px;
}
:fullscreen .thumbs, :-webkit-full-screen .thumbs {
  gap: clamp(10px,1vw,18px);
}
:fullscreen .count-label, :-webkit-full-screen .count-label, .fs-active .count-label {
  font-size: clamp(24px,2.2vw,36px);
}
:fullscreen .count-label strong, :-webkit-full-screen .count-label strong, .fs-active .count-label strong {
  font-size: clamp(36px,3.2vw,56px);
}
:fullscreen .page-num, :-webkit-full-screen .page-num {
  font-size: clamp(14px,1.2vw,20px);
}
:fullscreen .flip-btn, :-webkit-full-screen .flip-btn {
  font-size: clamp(11px,0.8vw,14px); padding: 5px 18px;
}
.terms-notice {
  flex-shrink: 0; padding: 6px 16px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 10px;
  color: rgba(242,47,70,0.2); text-align: center;
}

/* ── Manage mode ── */
.top-btn.manage-active {
  background: rgba(242,47,70,0.15); color: #F22F46;
  border-color: rgba(242,47,70,0.4);
}
.manage-grid {
  display: none; flex: 1; overflow-y: auto; padding: 16px clamp(16px,3vw,40px);
  min-height: 0;
}
.manage-grid.visible { display: block; }
.manage-grid-inner {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}
.mg-card {
  position: relative; cursor: pointer; border-radius: 8px; overflow: hidden;
  background: #1a1a2e; border: 2px solid transparent;
  transition: border-color .2s, transform .15s;
}
.mg-card:hover { transform: translateY(-2px); }
.mg-card.selected { border-color: #F22F46; }
.mg-card .mg-check {
  position: absolute; top: 8px; left: 8px; width: 22px; height: 22px;
  border-radius: 50%; border: 2px solid rgba(255,255,255,0.4);
  background: rgba(0,0,0,0.4); z-index: 2;
  display: flex; align-items: center; justify-content: center;
  transition: all .2s;
}
.mg-card.selected .mg-check {
  background: #F22F46; border-color: #F22F46;
}
.mg-card .mg-check svg { width: 14px; height: 14px; opacity: 0; transition: opacity .2s; }
.mg-card.selected .mg-check svg { opacity: 1; }
.mg-card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.mg-card .mg-label {
  padding: 6px 8px; font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 10px;
  color: rgba(242,47,70,0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mg-type-row {
  display: flex; gap: 4px; padding: 0 8px 6px;
}
.mg-type-tag {
  font-family: 'Twilio Sans Mono', monospace; font-size: 9px; font-weight: 700;
  padding: 2px 6px; border-radius: 4px; text-transform: uppercase;
}
.mg-type-tag.ai { background: rgba(33,136,239,0.15); color: #2188EF; }
.mg-type-tag.selfie { background: rgba(239,34,58,0.15); color: #F83D53; }

/* Action bar */
.action-bar {
  display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
  background: rgba(15,18,25,0.95); backdrop-filter: blur(12px);
  border-top: 1px solid rgba(255,255,255,0.08);
  padding: 12px 20px; align-items: center; gap: 12px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
.action-bar.visible { display: flex; }
.action-bar .ab-count {
  font-size: 13px; color: rgba(210,195,175,0.7); margin-right: auto;
}
.action-bar .ab-count strong { color: #2188EF; }
.ab-btn {
  padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 700;
  cursor: pointer; transition: all .2s; background: rgba(255,255,255,0.06);
  color: rgba(210,195,175,0.7);
}
.ab-btn:hover { background: rgba(255,255,255,0.1); color: rgba(240,230,215,0.9); }
.ab-btn.danger { background: rgba(220,50,50,0.15); border-color: rgba(220,50,50,0.3); color: #e85555; }
.ab-btn.danger:hover { background: rgba(220,50,50,0.25); color: #ff6b6b; }
.ab-delete-wrap { position: relative; }
.ab-delete-menu {
  display: none; position: absolute; bottom: calc(100% + 8px); right: 0;
  background: #1a1e2e; border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px; min-width: 200px; overflow: hidden; z-index: 110;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.ab-delete-menu.open { display: block; }
.ab-delete-menu button {
  display: block; width: 100%; padding: 12px 16px; border: none; background: none;
  color: rgba(210,195,175,0.8); font-family: inherit; font-size: 13px; font-weight: 600;
  text-align: left; cursor: pointer; transition: background .15s;
}
.ab-delete-menu button:hover { background: rgba(255,255,255,0.06); }
.ab-delete-menu button + button { border-top: 1px solid rgba(255,255,255,0.06); }
.ab-delete-menu .ab-dm-destructive { color: #e85555; }
.ab-delete-menu .ab-dm-destructive:hover { background: rgba(220,50,50,0.12); }
.ab-move-sel {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 28px 6px 12px; color: rgba(33,136,239,0.8);
  font-family: 'Twilio Sans Text', sans-serif; font-size: 12px;
  cursor: pointer; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(33,136,239,0.5)'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
}
.ab-move-sel:hover { border-color: rgba(33,136,239,0.3); }
.cb-confirm.move { background: rgba(33,136,239,0.8); }
.cb-confirm.move:hover { background: rgba(33,136,239,1); }

/* Confirmation modal */
.confirm-overlay {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
  align-items: center; justify-content: center;
}
.confirm-overlay.visible { display: flex; }
.confirm-box {
  background: #1a1e2e; border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px; padding: 24px; max-width: 400px; width: 90%;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; text-align: center;
}
.confirm-box h3 { color: #e8e0d4; font-size: 16px; margin-bottom: 8px; }
.confirm-box p { color: rgba(210,195,175,0.6); font-size: 13px; margin-bottom: 20px; line-height: 1.5; }
.confirm-btns { display: flex; gap: 10px; justify-content: center; }
.confirm-btns button {
  padding: 10px 24px; border-radius: 8px; border: none;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 13px; font-weight: 700;
  cursor: pointer; transition: all .2s;
}
.confirm-btns .cb-cancel { background: rgba(255,255,255,0.08); color: rgba(210,195,175,0.7); }
.confirm-btns .cb-cancel:hover { background: rgba(255,255,255,0.12); }
.confirm-btns .cb-confirm { background: #dc3232; color: #fff; }
.confirm-btns .cb-confirm:hover { background: #e84545; }

/* Toast */
.toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: rgba(30,35,50,0.95); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; padding: 10px 20px; z-index: 300;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 13px; color: #2188EF;
  opacity: 0; transition: opacity .3s; pointer-events: none;
}
.toast.show { opacity: 1; }

/* Manage grid empty state */
.mg-empty {
  grid-column: 1 / -1; text-align: center; padding: 60px 20px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 14px; color: rgba(210,195,175,0.3);
  font-style: italic;
}

/* Photo enlarge modal */
.photo-modal {
  display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,.88); z-index: 9999;
  align-items: center; justify-content: center;
}
.photo-modal.open { display: flex; }
.photo-modal-content { position: relative; max-width: 92vw; max-height: 92vh; }
.photo-modal-content img {
  max-width: 90vw; max-height: 88vh; border-radius: 8px;
  box-shadow: 0 12px 60px rgba(0,0,0,.6);
}
.photo-modal-close {
  position: absolute; top: -14px; right: -14px;
  background: rgba(30,22,16,0.8); color: rgba(240,230,215,0.8);
  border: 1px solid rgba(210,195,175,0.2);
  width: 34px; height: 34px; border-radius: 50%; font-size: 20px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  line-height: 1; backdrop-filter: blur(8px); transition: all .2s;
}
.photo-modal-close:hover { background: #EF223A; border-color: #EF223A; color: #fff; }
.photo-frame img.portrait, .photo-frame img.original { cursor: pointer; }

/* ── Reveal animations ── */
@keyframes reveal-pixel {
  0%   { filter: blur(20px) brightness(0.5); }
  100% { filter: blur(0) brightness(1); }
}
@keyframes reveal-brush {
  0%   { clip-path: inset(0 100% 0 0); }
  100% { clip-path: inset(0 0 0 0); }
}
@keyframes reveal-sketch-to-color {
  0%   { filter: grayscale(1) contrast(2); }
  100% { filter: grayscale(0) contrast(1); }
}
.portrait.reveal-pixel { animation: reveal-pixel 1.5s ease-out forwards; }
.portrait.reveal-brush { animation: reveal-brush 1.5s ease-in-out forwards; }
.portrait.reveal-sketch-to-color { animation: reveal-sketch-to-color 2s ease-out forwards; }

/* ── Milestone banner ── */
@keyframes milestone-in { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.7); } 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes milestone-out { 0% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); } }
.milestone-banner {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 9000; pointer-events: none;
  background: rgba(0,13,37,0.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(239,34,58,0.35); border-radius: 20px;
  padding: 32px 56px; text-align: center;
  font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: clamp(28px, 4vw, 56px); font-weight: 800;
  letter-spacing: 0.02em;
  color: #EF223A; text-shadow: 0 0 30px rgba(239,34,58,0.3);
  box-shadow: 0 8px 60px rgba(0,0,0,0.6), 0 0 40px rgba(239,34,58,0.12);
  display: none; opacity: 0;
}
.milestone-banner.show { display: block; animation: milestone-in 0.5s ease-out forwards; }
.milestone-banner.hide { animation: milestone-out 0.5s ease-in forwards; }
`;

const PAGE_BODY = `
<div class="scene">
  <div class="top-bar" id="topBar">
    <div class="top-bar-row">
      <div class="left-controls">
        <select class="ev-sel" id="evSel" onchange="onEventChange()"></select>
        <div class="top-btn share-btn" onclick="copyShareLink()" title="Copy shareable link for this event"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Copy Link</span></div>
      </div>
      <div class="top-controls">
        <div class="top-btn" id="manageBtn" onclick="toggleManage()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>Manage</span></div>
        <div class="top-btn" id="brbBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg><span>BRB</span></div>
        <div class="top-btn" onclick="toggleFullscreen()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Fullscreen</span></div>
      </div>
    </div>
  </div>

  <span class="count-label"><strong id="countNum">0</strong> portraits created</span>
  <div class="book-area">
    <div class="arrow left" onclick="goPrev()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></div>
    <div class="book-wrap" id="bookWrap">
      <div class="empty-msg" id="emptyMsg">Portraits will appear<br>as they are created&hellip;</div>
    </div>
    <div class="arrow right" onclick="goNext()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
  </div>

  <div class="bottom-bar" id="bottomBar">
    <div class="controls">
      <div class="ctrl-btn active" id="playPauseBtn"><svg id="ppIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span id="ppLabel">Playing</span></div>
    </div>
    <div class="thumbs-bar">
      <div class="thumbs" id="thumbs"></div>
    </div>
  </div>
  <div class="manage-grid" id="manageGrid"><div class="manage-grid-inner" id="manageGridInner"></div></div>
  <div class="terms-notice" id="termsNotice" style="display:none"></div>
</div>
<div class="action-bar" id="actionBar">
  <span class="ab-count"><strong id="abCount">0</strong> selected</span>
  <button class="ab-btn" onclick="manageSelectAll()">Select All</button>
  <button class="ab-btn" onclick="manageDeselectAll()">Deselect All</button>
  <select class="ab-move-sel" id="abMoveSel" style="display:none"><option value="">Move to...</option></select>
  <button class="ab-btn" id="abMoveBtn" onclick="manageMoveSelected()" style="display:none">Move</button>
  <div class="ab-delete-wrap" id="abDeleteWrap">
    <button class="ab-btn danger" onclick="toggleDeleteMenu(event)">Delete &#9662;</button>
    <div class="ab-delete-menu" id="abDeleteMenu">
      <button onclick="manageDeleteSelected()">Delete Selected</button>
      <button onclick="manageDeleteSelfies()">Delete Selfies Only</button>
      <button class="ab-dm-destructive" onclick="manageDeleteAll()">Delete All for Event</button>
    </div>
  </div>
</div>
<div class="confirm-overlay" id="confirmOverlay">
  <div class="confirm-box">
    <h3 id="confirmTitle">Confirm Delete</h3>
    <p id="confirmMsg">Are you sure?</p>
    <div class="confirm-btns">
      <button class="cb-cancel" onclick="closeConfirm()">Cancel</button>
      <button class="cb-confirm" id="confirmBtn" onclick="confirmAction()">Delete</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="milestone-banner" id="milestoneBanner"></div>
<div class="photo-modal" id="photoModal" onclick="closePhotoModal(event)">
  <div class="photo-modal-content">
    <img id="photoModalImg" src="">
    <button class="photo-modal-close" onclick="closePhotoModal()">&times;</button>
  </div>
</div>
`;

const PAGE_JS = `
var images = [];
var allEvents = [];
var bookReady = false;
var autoTimer = null, paused = false;
var AUTO_INTERVAL = 10000, POLL_INTERVAL = 5000, photoBookAutoplay = true;
var activeStyleCount = 1;
var flipped = {};
var selectedEvent = "";
var revealAnimation = "off";
var revealedImages = new Set();
var lastMilestone = parseInt(sessionStorage.getItem("lastMilestone") || "0");
var milestonesEnabled = true;
var milestoneInterval = 100;

function imgUrl(img) { return "/photogallery/img/" + encodeURIComponent(img.event) + "/" + img.file; }
function origUrl(img) { return "/photogallery/img/" + encodeURIComponent(img.event) + "/" + img.file.replace("_output_mms.jpg", "_input.jpg"); }

/* ── Build the book ── */
function initBook() {
  var wrap = document.getElementById("bookWrap");

  // Destroy previous book if any
  var oldDecor = document.getElementById("bookDecor");
  if (oldDecor) {
    var oldBook = document.getElementById("book");
    if (oldBook) { try { $(oldBook).turn("destroy"); } catch(e) {} }
    oldDecor.remove();
  }
  bookReady = false;
  flipped = {};

  if (images.length === 0) {
    document.getElementById("emptyMsg").style.display = "";
    document.getElementById("bottomBar").classList.remove("visible");
    document.getElementById("thumbs").innerHTML = "";
    return;
  }

  document.getElementById("emptyMsg").style.display = "none";
  document.getElementById("bottomBar").classList.add("visible");

  // Create decoration wrapper
  var decor = document.createElement("div");
  decor.className = "book-decor";
  decor.id = "bookDecor";

  // Page layers (stacked behind)
  for (var l = 0; l < 6; l++) {
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
    pg.dataset.index = i;
    // turn.js: odd pages (1,3,5…) = right, even pages (2,4,6…) = left
    var turnPage = i + 1;
    var isRight = (turnPage % 2 === 1);
    pg.className = "page " + (isRight ? "odd" : "even");
    var pageNum = n - i;

    var styleTag = (activeStyleCount >= 2 && images[i].style) ? '<div class="style-tag ' + (isRight ? 'style-tag-left' : 'style-tag-right') + '">' + images[i].style + '</div>' : '';
    pg.innerHTML =
      '<div class="photo-mount">' +
        '<div class="photo-frame">' +
          '<div class="corner corner-tl"></div>' +
          '<div class="corner corner-tr"></div>' +
          '<div class="corner corner-bl"></div>' +
          '<div class="corner corner-br"></div>' +
          '<img class="portrait" src="' + imgUrl(images[i]) + '" loading="lazy" alt="">' +
          (images[i].hasSelfie !== false
            ? '<img class="original hidden" src="' + origUrl(images[i]) + '" loading="lazy" alt="">'
            : '<div class="original hidden original-removed"><div class="removed-content"><svg viewBox="0 0 24 24" fill="none" stroke="#EF223A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1"/></svg><div class="removed-title">Original Photo Removed</div><div class="removed-desc">The original selfie has been deleted to protect the subject&#39;s privacy.</div></div></div>') +
        '</div>' +
      '</div>' +
      '<div class="flip-btn" data-idx="' + i + '">View Original</div>' +
      styleTag +
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

var _fetchingEvents = false, _fetchingImages = false;

/* ── Fetch events ── */
async function fetchEvents() {
  try {
    var r = await fetch("api/events"), d = await r.json();
    allEvents = d.events || [];
    revealAnimation = d.revealAnimation || "off";
    milestonesEnabled = d.milestonesEnabled !== false;
    milestoneInterval = d.milestoneInterval || 100;
    var newAutoplay = d.photoBookAutoplay !== false;
    var newInterval = (d.photoBookInterval || 10) * 1000;
    if (newInterval !== AUTO_INTERVAL || newAutoplay !== photoBookAutoplay) {
      AUTO_INTERVAL = newInterval;
      photoBookAutoplay = newAutoplay;
      if (!paused && photoBookAutoplay) { startAuto(); }
      else if (!photoBookAutoplay) { stopAuto(); paused = true; updatePPBtn(); }
    }
    var sel = document.getElementById("evSel");
    var prev = sel.value || d.currentEvent;
    sel.innerHTML = '<option value="all">All Events</option>';
    for (var i = 0; i < d.events.length; i++) {
      var e = d.events[i];
      sel.innerHTML += '<option value="' + e + '"' + (prev === e ? ' selected' : '') + '>' + e + '</option>';
    }
    var urlEvent = new URLSearchParams(window.location.search).get("event");
    if (urlEvent && d.events.indexOf(urlEvent) >= 0) {
      selectedEvent = urlEvent;
      sel.value = urlEvent;
    } else if (!selectedEvent) {
      selectedEvent = d.currentEvent;
      sel.value = d.currentEvent;
    }
    var tn = document.getElementById("termsNotice");
    if (d.termsUrl) { tn.textContent = "By participating, you agree to our terms of service: " + d.termsUrl; tn.style.display = ""; }
    else { tn.style.display = "none"; }
  } catch(e) {}
}

function onEventChange() {
  selectedEvent = document.getElementById("evSel").value;
  var url = new URL(window.location);
  if (selectedEvent && selectedEvent !== "all") url.searchParams.set("event", selectedEvent);
  else url.searchParams.delete("event");
  history.replaceState(null, "", url);
  stopAuto();
  images = [];
  if (manageMode) {
    selected.clear();
    refreshManage();
  } else {
    initBook();
    fetchImages();
  }
}

function copyShareLink() {
  var url = new URL(window.location);
  if (selectedEvent && selectedEvent !== "all") url.searchParams.set("event", selectedEvent);
  else url.searchParams.delete("event");
  navigator.clipboard.writeText(url.toString()).then(function() { showToast("Link copied!"); });
}

/* ── Fetch images ── */
async function fetchImages() {
  if (_fetchingImages) return;
  _fetchingImages = true;
  try {
    var param = selectedEvent ? "?event=" + encodeURIComponent(selectedEvent) : "";
    var r = await fetch("api/images" + param), d = await r.json();
    var oldLen = images.length;
    images = d.images;
    if (d.activeStyleCount) activeStyleCount = d.activeStyleCount;
    updateCount(d.total, oldLen);

    // Milestone check
    if (milestonesEnabled && d.total > oldLen && oldLen > 0 && milestoneInterval > 0) {
      // Find the next milestone threshold that was just crossed
      var nextThreshold = Math.ceil((oldLen + 1) / milestoneInterval) * milestoneInterval;
      if (d.total >= nextThreshold && nextThreshold > lastMilestone) {
        // Use the highest crossed threshold (in case multiple were crossed at once)
        var highest = Math.floor(d.total / milestoneInterval) * milestoneInterval;
        if (highest > lastMilestone) {
          lastMilestone = highest;
          sessionStorage.setItem("lastMilestone", String(lastMilestone));
          triggerMilestone(highest);
        }
      }
    }

    if (d.total !== oldLen && d.total > 0) {
      initBook();
      renderThumbs();
      highlightThumbs();
      if (oldLen === 0) startAuto();
    }
  } catch(e) {} finally { _fetchingImages = false; }
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
    h += '<div class="thumb" data-page="' + (i + 1) + '"><img src="' + imgUrl(images[i]) + '" loading="lazy"></div>';
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
    // Play reveal animation when flipping back to portrait
    if (revealAnimation !== "off") {
      portrait.classList.remove("reveal-pixel", "reveal-brush", "reveal-sketch-to-color");
      void portrait.offsetWidth; // force reflow to restart animation
      portrait.classList.add("reveal-" + revealAnimation);
    }
  }
}

/* ── Fullscreen ── */
function toggleFullscreen() {
  // Use top-level document when embedded in an iframe (e.g. combo page)
  var doc = window.top.document;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    if (doc.exitFullscreen) doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
  } else {
    var el = doc.documentElement;
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
var wakeLockSentinel = null;
async function handleWakeLock() {
  var doc = (window.top !== window) ? window.top.document : document;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    try { wakeLockSentinel = await navigator.wakeLock.request("screen"); } catch(e) {}
  } else {
    if (wakeLockSentinel) { try { await wakeLockSentinel.release(); } catch(e) {} wakeLockSentinel = null; }
  }
}
function syncFullscreenClass() {
  var doc = (window.top !== window) ? window.top.document : document;
  var isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  document.querySelector(".scene").classList.toggle("fs-active", isFs);
}
function onFullscreenChange() { resizeBook(); handleWakeLock(); syncFullscreenClass(); }
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);
// Also listen on top document for combo/iframe fullscreen
try {
  if (window.top !== window) {
    window.top.document.addEventListener("fullscreenchange", onFullscreenChange);
    window.top.document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }
} catch(e) {}
window.addEventListener("resize", resizeBook);

/* ── Keyboard ── */
document.addEventListener("keydown", function(e) {
  // Don't turn the book (or toggle autoplay) while the photo modal is open —
  // the modal sits on top of the book and the user expects their keys to act
  // on it, not the page behind it. Escape continues to be handled by the
  // modal's own listener.
  var modal = document.getElementById("photoModal");
  if (modal && modal.classList.contains("open")) return;
  if (e.key === "ArrowRight") { goNext(); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { goPrev(); e.preventDefault(); }
  else if (e.key === " ") { togglePause(); e.preventDefault(); }
});

/* ── Manage mode ── */
var manageMode = false;
// selected is a Set of "prefix:type" keys where type is "ai" or "selfie"
var selected = new Set();
var pendingConfirmAction = null;

function selKey(prefix, type) { return prefix + ":" + type; }

function toggleManage() {
  manageMode = !manageMode;
  var btn = document.getElementById("manageBtn");
  btn.classList.toggle("manage-active", manageMode);
  btn.querySelector("span").textContent = manageMode ? "Close Manage" : "Manage";

  // Toggle views
  var bookArea = document.querySelector(".book-area");
  bookArea.style.display = manageMode ? "none" : "";
  document.getElementById("bottomBar").style.display = manageMode ? "none" : "";
  document.getElementById("manageGrid").classList.toggle("visible", manageMode);
  document.getElementById("actionBar").classList.toggle("visible", manageMode);

  if (manageMode) {
    stopAuto();
    selected.clear();
    renderManageGrid();
    updateAbCount();
  } else {
    initBook();
    renderThumbs();
    if (!paused && images.length > 0) startAuto();
  }
}

function renderManageGrid() {
  var container = document.getElementById("manageGridInner");
  if (images.length === 0) {
    container.innerHTML = '<div class="mg-empty">No images to manage</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var prefix = img.prefix || img.file.replace(/_output_mms\.jpg$/, "");
    // AI output card
    html += '<div class="mg-card" data-prefix="' + prefix + '" data-event="' + img.event + '" data-type="ai" onclick="toggleSelect(this)">' +
      '<div class="mg-check"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
      '<img src="' + imgUrl(img) + '" loading="lazy" alt="">' +
      '<div class="mg-label">' + img.event + '</div>' +
      '<div class="mg-type-row"><span class="mg-type-tag ai">AI Output</span></div>' +
      '</div>';
    // Selfie card (only if selfie exists)
    if (img.hasSelfie !== false) {
      html += '<div class="mg-card" data-prefix="' + prefix + '" data-event="' + img.event + '" data-type="selfie" onclick="toggleSelect(this)">' +
        '<div class="mg-check"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
        '<img src="' + origUrl(img) + '" loading="lazy" alt="">' +
        '<div class="mg-label">' + img.event + '</div>' +
        '<div class="mg-type-row"><span class="mg-type-tag selfie">Selfie</span></div>' +
        '</div>';
    }
  }
  container.innerHTML = html;
  // Re-apply selections
  selected.forEach(function(key) {
    var parts = key.split(":");
    var card = container.querySelector('[data-prefix="' + parts[0] + '"][data-type="' + parts[1] + '"]');
    if (card) card.classList.add("selected");
  });
}

function toggleSelect(card) {
  var key = selKey(card.dataset.prefix, card.dataset.type);
  if (selected.has(key)) {
    selected.delete(key);
    card.classList.remove("selected");
  } else {
    selected.add(key);
    card.classList.add("selected");
  }
  updateAbCount();
}

function updateAbCount() {
  document.getElementById("abCount").textContent = selected.size;
  var showMove = selected.size > 0 && selectedEvent && selectedEvent !== "all";
  document.getElementById("abMoveSel").style.display = showMove ? "" : "none";
  document.getElementById("abMoveBtn").style.display = showMove ? "" : "none";
  if (showMove) updateMoveDropdown();
}

function updateMoveDropdown() {
  var sel = document.getElementById("abMoveSel");
  var prev = sel.value;
  sel.innerHTML = '<option value="">Move to...</option>';
  for (var i = 0; i < allEvents.length; i++) {
    if (allEvents[i] !== selectedEvent) {
      sel.innerHTML += '<option value="' + allEvents[i] + '"' + (prev === allEvents[i] ? ' selected' : '') + '>' + allEvents[i] + '</option>';
    }
  }
}

function manageSelectAll() {
  document.querySelectorAll(".mg-card").forEach(function(card) {
    selected.add(selKey(card.dataset.prefix, card.dataset.type));
    card.classList.add("selected");
  });
  updateAbCount();
}

function manageDeselectAll() {
  selected.clear();
  document.querySelectorAll(".mg-card").forEach(function(card) {
    card.classList.remove("selected");
  });
  updateAbCount();
}

function toggleDeleteMenu(e) {
  if (e) e.stopPropagation();
  var menu = document.getElementById("abDeleteMenu");
  var isOpen = menu.classList.contains("open");
  menu.classList.toggle("open");
  if (!isOpen) {
    // Close on outside click
    setTimeout(function() {
      document.addEventListener("click", closeDeleteMenu);
    }, 0);
  }
}
function closeDeleteMenu() {
  document.getElementById("abDeleteMenu").classList.remove("open");
  document.removeEventListener("click", closeDeleteMenu);
}

function manageDeleteSelfies() {
  closeDeleteMenu();
  var ev = selectedEvent || "current event";
  if (ev === "all") {
    showToast("Select a specific event first");
    return;
  }
  showConfirm(
    "Delete Selfies for " + ev,
    "Permanently delete all original selfie photos for event '" + ev + "'? AI-generated outputs will be kept. This cannot be undone.",
    "deleteSelfies"
  );
}

function manageDeleteSelected() {
  closeDeleteMenu();
  if (selected.size === 0) { showToast("Select photos first"); return; }
  // Count types for the message
  var aiCount = 0, selfieCount = 0;
  selected.forEach(function(key) {
    if (key.endsWith(":ai")) aiCount++;
    else selfieCount++;
  });
  var parts = [];
  if (aiCount) parts.push(aiCount + " AI output(s)");
  if (selfieCount) parts.push(selfieCount + " selfie(s)");
  showConfirm(
    "Delete Selected",
    "Permanently delete " + parts.join(" and ") + "? This cannot be undone.",
    "deleteSelected"
  );
}

function manageDeleteAll() {
  closeDeleteMenu();
  var ev = selectedEvent || "current event";
  if (ev === "all") {
    showToast("Select a specific event first");
    return;
  }
  showConfirm(
    "Delete All for " + ev,
    "Permanently delete ALL images (AI outputs and selfies) for event '" + ev + "'? This cannot be undone.",
    "deleteAll"
  );
}

function manageMoveSelected() {
  if (selected.size === 0) return;
  var toEvent = document.getElementById("abMoveSel").value;
  if (!toEvent) { showToast("Select a target event first"); return; }
  if (selectedEvent === "all") { showToast("Select a specific source event first"); return; }
  // Deduplicate prefixes (AI + selfie cards share a prefix)
  var prefixSet = {};
  selected.forEach(function(key) {
    var idx = key.lastIndexOf(":");
    prefixSet[key.substring(0, idx)] = true;
  });
  var count = Object.keys(prefixSet).length;
  showConfirm(
    "Move Photos",
    "Move " + count + " photo(s) from '" + selectedEvent + "' to '" + toEvent + "'?",
    "moveSelected",
    "Move",
    "move"
  );
}

function showConfirm(title, msg, action, btnLabel, btnClass) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMsg").textContent = msg;
  var btn = document.getElementById("confirmBtn");
  btn.textContent = btnLabel || "Delete";
  btn.className = "cb-confirm" + (btnClass ? " " + btnClass : "");
  pendingConfirmAction = action;
  document.getElementById("confirmOverlay").classList.add("visible");
}

function closeConfirm() {
  document.getElementById("confirmOverlay").classList.remove("visible");
  pendingConfirmAction = null;
}

async function confirmAction() {
  var action = pendingConfirmAction;
  closeConfirm();
  if (!action) return;

  if (action === "deleteSelected") {
    // Group by event, then build items with prefix+type
    var byEvent = {};
    selected.forEach(function(key) {
      var idx = key.lastIndexOf(":");
      var prefix = key.substring(0, idx);
      var type = key.substring(idx + 1);
      // Find event from the card
      var card = document.querySelector('[data-prefix="' + prefix + '"][data-type="' + type + '"]');
      if (!card) return;
      var ev = card.dataset.event;
      if (!byEvent[ev]) byEvent[ev] = [];
      byEvent[ev].push({ prefix: prefix, type: type });
    });
    var totalDeleted = 0;
    for (var ev in byEvent) {
      try {
        var r = await fetch("/photogallery/api/images", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: ev, items: byEvent[ev] })
        });
        var d = await r.json();
        totalDeleted += d.deleted;
      } catch(e) {}
    }
    selected.clear();
    showToast("Deleted " + totalDeleted + " files");
    await refreshManage();

  } else if (action === "deleteSelfies") {
    var ev = selectedEvent;
    try {
      var r = await fetch("/photogallery/api/images/all", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: ev, type: "selfie" })
      });
      var d = await r.json();
      showToast("Deleted " + d.deleted + " selfies from " + ev);
    } catch(e) {
      showToast("Delete failed");
    }
    selected.clear();
    await refreshManage();

  } else if (action === "deleteAll") {
    var ev = selectedEvent;
    try {
      var r = await fetch("/photogallery/api/images/all", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: ev })
      });
      var d = await r.json();
      showToast("Deleted " + d.deleted + " files from " + ev);
    } catch(e) {
      showToast("Delete failed");
    }
    selected.clear();
    await refreshManage();

  } else if (action === "moveSelected") {
    var toEvent = document.getElementById("abMoveSel").value;
    if (!toEvent) return;
    // Deduplicate prefixes
    var prefixSet = {};
    selected.forEach(function(key) {
      var idx = key.lastIndexOf(":");
      prefixSet[key.substring(0, idx)] = true;
    });
    var prefixes = Object.keys(prefixSet);
    try {
      var r = await fetch("/photogallery/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: prefixes, fromEvent: selectedEvent, toEvent: toEvent })
      });
      var d = await r.json();
      if (d.moved > 0 && d.failed > 0) showToast("Moved " + d.moved + ", failed " + d.failed);
      else if (d.moved > 0) showToast("Moved " + d.moved + " photo(s) to " + toEvent);
      else showToast(d.error || "Move failed");
    } catch(e) {
      showToast("Move failed");
    }
    selected.clear();
    await refreshManage();
  }
}

async function refreshManage() {
  try {
    var param = selectedEvent ? "?event=" + encodeURIComponent(selectedEvent) : "";
    var r = await fetch("api/images" + param), d = await r.json();
    images = d.images;
    updateCount(d.total, -1);
    renderManageGrid();
    updateAbCount();
  } catch(e) {}
}

function showToast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function() { t.classList.remove("show"); }, 3000);
}

/* ── Photo modal ── */
function openPhotoModal(src) {
  var modal = document.getElementById("photoModal");
  var img = document.getElementById("photoModalImg");
  img.src = src;
  modal.classList.add("open");
  document.addEventListener("keydown", _photoModalEsc);
}
function closePhotoModal(e) {
  if (e && e.target && e.target.tagName === "IMG") return;
  document.getElementById("photoModal").classList.remove("open");
  document.removeEventListener("keydown", _photoModalEsc);
}
function _photoModalEsc(e) { if (e.key === "Escape") closePhotoModal(); }

// Delegate clicks on book images to open modal
document.addEventListener("click", function(e) {
  var img = e.target;
  if (!img || img.tagName !== "IMG") return;
  if (img.classList.contains("portrait") || img.classList.contains("original")) {
    e.stopPropagation();
    openPhotoModal(img.src);
  }
});

/* ── Milestone celebration ── */
function triggerMilestone(count) {
  if (typeof confetti === "function") {
    confetti({ particleCount: 150, spread: 90, origin: { y: 0.6 }, colors: ["#EF223A", "#F83D53", "#FD7685", "#2188EF", "#fff"] });
    setTimeout(function() {
      confetti({ particleCount: 80, spread: 120, origin: { y: 0.5 }, colors: ["#EF223A", "#F83D53", "#FD7685", "#2188EF", "#fff"] });
    }, 300);
  }
  var banner = document.getElementById("milestoneBanner");
  var mod100 = count % 100, mod10 = count % 10;
  var suffix = (mod10 === 1 && mod100 !== 11) ? "st" : (mod10 === 2 && mod100 !== 12) ? "nd" : (mod10 === 3 && mod100 !== 13) ? "rd" : "th";
  banner.textContent = count + suffix + " Portrait!";
  banner.classList.remove("hide");
  banner.classList.add("show");
  setTimeout(function() {
    banner.classList.add("hide");
    setTimeout(function() { banner.classList.remove("show", "hide"); }, 500);
  }, 5000);
}

/* ── Init ── */
// Use pointerup — turn.js intercepts mousedown/click for page-drag gestures
document.getElementById("playPauseBtn").addEventListener("pointerup", function(e) {
  e.stopPropagation();
  e.preventDefault();
  togglePause();
});
fetchEvents().then(function() { fetchImages(); });
setInterval(function() { if (!manageMode) fetchImages(); }, POLL_INTERVAL);
`;

function buildPageHtml() {
return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Photo Book — Twilio Photobooth</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<script src="https://code.jquery.com/jquery-3.7.1.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/turn.js/3/turn.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"><\/script>
<style>${PAGE_CSS}
${brb.BRB_OVERLAY_CSS}
</style>
</head>
<body>
${PAGE_BODY}
` + brb.overlayHtml() + `
<script>${PAGE_JS}
${brb.BRB_OVERLAY_SCRIPT}
// BRB button
document.getElementById("brbBtn").addEventListener("click", function() { toggleBrb(); });
</script>
</body>
</html>`;
}

function mountPhotoGallery(app) {
    app.use("/photogallery", router);
    console.log("📖 Photo book mounted at /photogallery");
}

module.exports = { mountPhotoGallery };
