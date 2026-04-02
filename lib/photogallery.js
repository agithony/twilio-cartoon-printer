const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const settings = require("./settings");
const brb = require("./brb");
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

router.get("/api/events", async (req, res) => {
    try {
        const dlRoot = path.join(ROOT_DIR, "downloads");
        const entries = await fsp.readdir(dlRoot, { withFileTypes: true });
        const events = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
        res.json({ events, currentEvent: settings.get("eventName"), termsUrl: settings.get("termsUrl") || "" });
    } catch {
        res.json({ events: [], currentEvent: settings.get("eventName"), termsUrl: settings.get("termsUrl") || "" });
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
    const { event } = req.body || {};
    if (!event) return res.status(400).json({ error: "event required" });
    if (event.includes("..") || event.includes("/")) return res.sendStatus(400);
    const dir = path.join(ROOT_DIR, "downloads", event);
    try { await fsp.access(dir); } catch { return res.json({ deleted: 0 }); }

    let deleted = 0;
    const suffixes = ["_input.jpg", "_output.png", "_output_mms.jpg"];
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
    console.log(`🗑️  Deleted ALL ${deleted} files from event "${event}"`);
    res.json({ deleted });
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
  flex-shrink: 0; display: flex; justify-content: center; align-items: center;
  padding: clamp(10px,1.5vh,18px) 20px; gap: 20px; position: relative; z-index: 5;
}
.count-label {
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  font-size: clamp(16px,1.4vw,24px); color: rgba(210,195,175,0.6);
  font-style: italic; font-weight: 400; letter-spacing: 0.03em;
}
.count-label strong {
  font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  color: rgba(240,230,215,0.9); font-weight: 800;
  font-size: clamp(24px,2.2vw,40px); font-style: normal;
  display: inline-block;
}
.top-bar.bump strong { animation: cBump .6s cubic-bezier(.36,.07,.19,.97); }
@keyframes cBump {
  0%   { transform: scale(1); color: rgba(240,230,215,0.9); }
  15%  { transform: scale(1.35); color: #EF223A; }
  30%  { transform: scale(0.95); }
  45%  { transform: scale(1.15); color: #EF223A; }
  100% { transform: scale(1); color: rgba(240,230,215,0.9); }
}

.top-controls {
  position: absolute; right: 16px; display: flex; gap: 6px;
}
.ev-sel {
  position: absolute; left: 16px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 28px 6px 12px; color: rgba(210,195,175,0.7);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 400;
  cursor: pointer; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23998a73' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: all .2s ease; max-width: 220px;
}
.ev-sel:hover { color: rgba(240,230,215,0.8); background-color: rgba(255,255,255,0.1); }
.ev-sel:focus { outline: none; border-color: rgba(200,169,110,0.4); }
.ev-sel option { background: #1a1a2e; color: #d2c3af; }
.top-btn {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 12px; color: rgba(210,195,175,0.45);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 400;
  cursor: pointer; user-select: none; display: flex; align-items: center; gap: 5px;
  transition: all .2s ease;
}
.top-btn:hover { color: rgba(240,230,215,0.8); background: rgba(255,255,255,0.1); }
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
.photo-frame img.hidden { opacity: 0; position: absolute; pointer-events: none; }
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
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: clamp(9px,0.7vw,12px);
  font-weight: 600; color: rgba(100,85,65,0.7);
  transition: all .2s ease; white-space: nowrap;
}
.flip-btn:hover { color: rgba(80,65,45,0.9); background: rgba(130,115,95,0.18); border-color: rgba(120,105,85,0.35); }
.flip-btn.active { color: #7a6540; border-color: rgba(122,101,64,0.4); background: rgba(122,101,64,0.1); }

/* Style tag — positioned opposite the page number to avoid overlap */
.style-tag {
  position: absolute; bottom: clamp(6px,1vh,12px);
  z-index: 5; font-family: 'Twilio Sans Mono', monospace;
  font-size: clamp(8px,0.6vw,11px); font-weight: 400;
  color: rgba(120,105,85,0.6); letter-spacing: 0.03em;
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
  color: rgba(210,195,175,0.45); cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px;
  transition: all .2s ease;
}
.ctrl-btn:hover { color: rgba(240,230,215,0.75); background: rgba(255,255,255,0.08); }
.ctrl-btn:active { transform: scale(0.97); }
.ctrl-btn.active { color: #2188EF; border-color: rgba(33,136,239,0.2); }
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
.terms-notice {
  flex-shrink: 0; padding: 6px 16px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 10px;
  color: rgba(210,195,175,0.2); text-align: center;
}

/* ── Manage mode ── */
.top-btn.manage-active {
  background: rgba(33,136,239,0.2); color: #2188EF;
  border-color: rgba(33,136,239,0.4);
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
.mg-card.selected { border-color: #2188EF; }
.mg-card .mg-check {
  position: absolute; top: 8px; left: 8px; width: 22px; height: 22px;
  border-radius: 50%; border: 2px solid rgba(255,255,255,0.4);
  background: rgba(0,0,0,0.4); z-index: 2;
  display: flex; align-items: center; justify-content: center;
  transition: all .2s;
}
.mg-card.selected .mg-check {
  background: #2188EF; border-color: #2188EF;
}
.mg-card .mg-check svg { width: 14px; height: 14px; opacity: 0; transition: opacity .2s; }
.mg-card.selected .mg-check svg { opacity: 1; }
.mg-card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.mg-card .mg-label {
  padding: 6px 8px; font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 10px;
  color: rgba(210,195,175,0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
`;

const PAGE_BODY = `
<div class="scene">
  <div class="top-bar" id="topBar">
    <select class="ev-sel" id="evSel" onchange="onEventChange()"></select>
    <span class="count-label"><strong id="countNum">0</strong> portraits created</span>
    <div class="top-controls">
      <div class="top-btn" id="manageBtn" onclick="toggleManage()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>Manage</span></div>
      <div class="top-btn" id="brbBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg><span>BRB</span></div>
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
  <button class="ab-btn danger" onclick="manageDeleteSelected()">Delete Selected</button>
  <button class="ab-btn danger" onclick="manageDeleteAll()">Delete All for Event</button>
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
<div class="photo-modal" id="photoModal" onclick="closePhotoModal(event)">
  <div class="photo-modal-content">
    <img id="photoModalImg" src="">
    <button class="photo-modal-close" onclick="closePhotoModal()">&times;</button>
  </div>
</div>
`;

const PAGE_JS = `
var images = [];
var bookReady = false;
var autoTimer = null, paused = false;
var AUTO_INTERVAL = 10000, POLL_INTERVAL = 5000;
var activeStyleCount = 1;
var flipped = {};
var selectedEvent = "";

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

    var styleTag = (activeStyleCount >= 2 && images[i].style) ? '<div class="style-tag ' + (isRight ? 'style-tag-left' : 'style-tag-right') + '">' + images[i].style + '</div>' : '';
    pg.innerHTML =
      '<div class="photo-mount">' +
        '<div class="photo-frame">' +
          '<div class="corner corner-tl"></div>' +
          '<div class="corner corner-tr"></div>' +
          '<div class="corner corner-bl"></div>' +
          '<div class="corner corner-br"></div>' +
          '<img class="portrait" src="' + imgUrl(images[i]) + '" loading="lazy" alt="">' +
          '<img class="original hidden" src="' + origUrl(images[i]) + '" loading="lazy" alt="">' +
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

/* ── Fetch events ── */
async function fetchEvents() {
  try {
    var r = await fetch("api/events"), d = await r.json();
    var sel = document.getElementById("evSel");
    var prev = sel.value || d.currentEvent;
    sel.innerHTML = '<option value="all">All Events</option>';
    for (var i = 0; i < d.events.length; i++) {
      var e = d.events[i];
      sel.innerHTML += '<option value="' + e + '"' + (prev === e ? ' selected' : '') + '>' + e + '</option>';
    }
    if (!selectedEvent) {
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
  stopAuto();
  images = [];
  initBook();
  fetchImages();
}

/* ── Fetch images ── */
async function fetchImages() {
  try {
    var param = selectedEvent ? "?event=" + encodeURIComponent(selectedEvent) : "";
    var r = await fetch("api/images" + param), d = await r.json();
    var oldLen = images.length;
    images = d.images;
    if (d.activeStyleCount) activeStyleCount = d.activeStyleCount;
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
document.addEventListener("fullscreenchange", resizeBook);
document.addEventListener("webkitfullscreenchange", resizeBook);
// Also listen on top document for combo/iframe fullscreen
try {
  if (window.top !== window) {
    window.top.document.addEventListener("fullscreenchange", resizeBook);
    window.top.document.addEventListener("webkitfullscreenchange", resizeBook);
  }
} catch(e) {}
window.addEventListener("resize", resizeBook);

/* ── Keyboard ── */
document.addEventListener("keydown", function(e) {
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

function manageDeleteSelected() {
  if (selected.size === 0) return;
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

function showConfirm(title, msg, action) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMsg").textContent = msg;
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Photo Book — Twilio Photobooth</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<script src="https://code.jquery.com/jquery-3.7.1.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/turn.js/3/turn.min.js"><\/script>
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
