const fs = require("fs");
const path = require("path");
const { DATA_DIR, DONE_DIR } = require("./config");
const leads = require("./leads");

const CLICKS_FILE = path.join(DATA_DIR, "share-clicks.jsonl");
const VALID_PLATFORMS = ["x", "linkedin", "instagram", "download"];

// ── Stats reader with 30s cache (mirrors dub.js idiom) ──────────────────────
const _statsCache = { key: null, data: null, ts: 0 };
const STATS_CACHE_TTL = 30_000;

// ── Job lookup (duplicates the logic in share.js to avoid a circular require) ─
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

// ── Ensure data dir exists (mirrors pattern in other modules) ───────────────
function ensureDataDir() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ── Record a click (append-only, fire-and-forget) ───────────────────────────
function record({ filePrefix, platform, eventName, userAgent }) {
    if (!VALID_PLATFORMS.includes(platform)) return false;
    const cleanPrefix = String(filePrefix || "").replace(/[^a-zA-Z0-9_\-]/g, "");
    if (!cleanPrefix) return false;

    const job = findJob(cleanPrefix);
    const effectiveEvent = eventName || (job && job.eventName) || null;
    const userPhone = (job && job.userPhone) || null;

    let firstName = null, lastName = null, email = null, company = null;
    if (userPhone && effectiveEvent) {
        try {
            const all = leads.getLeads(effectiveEvent);
            const lead = all.find((l) => l.phone === userPhone);
            if (lead) {
                firstName = lead.firstName || null;
                lastName = lead.lastName || null;
                email = lead.email || null;
                company = lead.company || null;
            }
        } catch { /* ignore */ }
    }

    const entry = {
        ts: Date.now(),
        filePrefix: cleanPrefix,
        platform,
        eventName: effectiveEvent,
        userPhone,
        firstName,
        lastName,
        email,
        company,
        ua: (userAgent || "").slice(0, 200),
    };

    try {
        ensureDataDir();
        fs.appendFileSync(CLICKS_FILE, JSON.stringify(entry) + "\n");
        // Invalidate stats cache so the dashboard reflects new clicks promptly
        _statsCache.ts = 0;
        return true;
    } catch (err) {
        console.error("share-clicks: append failed:", err.message);
        return false;
    }
}

function readAll() {
    try {
        if (!fs.existsSync(CLICKS_FILE)) return [];
        const txt = fs.readFileSync(CLICKS_FILE, "utf-8");
        if (!txt) return [];
        const out = [];
        for (const line of txt.split("\n")) {
            if (!line) continue;
            try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
        return out;
    } catch {
        return [];
    }
}

function getStats(eventFilter) {
    const key = eventFilter || "all";
    const now = Date.now();
    if (_statsCache.key === key && (now - _statsCache.ts) < STATS_CACHE_TTL) {
        return _statsCache.data;
    }

    const rows = readAll();
    const filtered = (key === "all" || !key)
        ? rows
        : rows.filter((r) => r.eventName === key);

    const byPlatform = { x: 0, linkedin: 0, instagram: 0, download: 0 };
    const uniq = new Set();
    for (const r of filtered) {
        if (byPlatform[r.platform] !== undefined) byPlatform[r.platform]++;
        if (r.userPhone) uniq.add(r.userPhone + "|" + r.platform);
    }

    const totalShares = byPlatform.x + byPlatform.linkedin + byPlatform.instagram;
    const totalEvents = totalShares + byPlatform.download;

    // Recent sharers (last 25, newest first). Real shares only — excludes downloads.
    const recent = filtered
        .filter((r) => r.platform !== "download")
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 25)
        .map((r) => ({
            ts: r.ts,
            platform: r.platform,
            eventName: r.eventName,
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            company: r.company,
        }));

    const data = {
        byPlatform,
        totalShares,
        totalEvents,
        uniqueSharers: uniq.size,
        recent,
    };

    _statsCache.key = key;
    _statsCache.data = data;
    _statsCache.ts = now;
    return data;
}

function invalidateCache() {
    _statsCache.ts = 0;
}

module.exports = {
    record,
    getStats,
    invalidateCache,
    VALID_PLATFORMS,
};
