const axios = require("axios");
const settings = require("./settings");

// In-memory cache: longUrl → shortLink (same image never shortened twice)
const MAX_CACHE = 5000;
const cache = new Map();

function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, value);
}

// Analytics cache — keyed by event filter, 60s TTL per entry
const _analyticsCache = new Map(); // eventKey → { data, ts }
const ANALYTICS_CACHE_TTL = 60_000;

/**
 * Shorten a URL via dub.co. Returns the short link or null on failure.
 * Never throws — failures are logged and the caller falls back to the full URL.
 * @param {string} longUrl - The URL to shorten
 * @param {string} [slug] - Custom slug (dub.co `key` field), e.g. "p-20260410_013745"
 */
async function shortenUrl(longUrl, slug) {
    if (!longUrl) return null;

    const apiKey = settings.get("dubApiKey");
    if (!apiKey) return null;

    if (cache.has(longUrl)) return cache.get(longUrl);

    const domain = settings.get("dubDomain") || "dub.sh";
    const body = { url: longUrl, domain };
    if (slug) body.key = slug;
    const folderId = settings.get("dubFolderId");
    if (folderId) body.folderId = folderId;

    const headers = { Authorization: `Bearer ${apiKey}` };

    try {
        const res = await axios.post(
            "https://api.dub.co/links",
            body,
            { headers, timeout: 5000 }
        );
        const shortLink = res.data.shortLink;
        if (shortLink) {
            cacheSet(longUrl, shortLink);
            console.log(`🔗 Short link: ${shortLink}`);
            return shortLink;
        }
        return null;
    } catch (err) {
        // 409 = slug already exists (e.g. after app restart) — retrieve it
        if (err.response?.status === 409 && slug) {
            try {
                const info = await axios.get(
                    `https://api.dub.co/links/info?domain=${encodeURIComponent(domain)}&key=${encodeURIComponent(slug)}`,
                    { headers, timeout: 5000 }
                );
                const shortLink = info.data.shortLink;
                if (shortLink && info.data.url === longUrl) {
                    cacheSet(longUrl, shortLink);
                    console.log(`🔗 Short link (existing): ${shortLink}`);
                    return shortLink;
                }
                if (shortLink) {
                    console.error(`🔗 Slug "${slug}" exists but points to different URL — skipping`);
                }
            } catch (_) { /* fall through */ }
        }
        const msg = err.response?.data?.error?.message || err.message;
        console.error(`🔗 dub.co shortening failed: ${msg}`);
        return null;
    }
}

/**
 * Fetch link analytics from dub.co, optionally filtered by event.
 * Cached for 60 seconds per event key. Never throws.
 * @param {string} [eventFilter="all"] - Event name to filter by, or "all"
 */
async function getAnalytics(eventFilter) {
    const apiKey = settings.get("dubApiKey");
    if (!apiKey) return null;

    const cacheKey = eventFilter || "all";
    const cached = _analyticsCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < ANALYTICS_CACHE_TTL)
        return cached.data;

    const headers = { Authorization: `Bearer ${apiKey}` };
    const params = { event: "clicks", interval: "all" };
    const domain = settings.get("dubDomain");
    if (domain) params.domain = domain;
    const folderId = settings.get("dubFolderId");
    if (folderId) params.folderId = folderId;

    try {
        // Fetch top links (enough to filter by event) + global count
        const [countRes, topRes] = await Promise.allSettled([
            axios.get("https://api.dub.co/analytics", { headers, timeout: 5000, params: { ...params, groupBy: "count" } }),
            axios.get("https://api.dub.co/analytics", { headers, timeout: 5000, params: { ...params, groupBy: "top_links", limit: 100 } }),
        ]);

        if (countRes.status === "rejected" && topRes.status === "rejected") {
            console.error("🔗 Dub analytics unavailable:", countRes.reason?.response?.status || countRes.reason?.message);
            return null;
        }

        let allLinks = topRes.status === "fulfilled"
            ? (topRes.value.data || [])
                .filter(l => l.shortLink) // skip entries without a short link
                .map(l => ({ shortLink: l.shortLink, url: l.url || "", clicks: l.clicks || 0 }))
            : [];

        // Filter by event if not "all" — share URLs contain ?e=EventName
        const filterByEvent = cacheKey !== "all";
        let filteredLinks = allLinks;
        if (filterByEvent) {
            const eventParam = `e=${encodeURIComponent(cacheKey)}`;
            filteredLinks = allLinks.filter(l => l.url && l.url.includes(eventParam));
        }

        // For "all": use the accurate count endpoint; for per-event: sum filtered links
        const totalClicks = filterByEvent
            ? filteredLinks.reduce((sum, l) => sum + l.clicks, 0)
            : (countRes.status === "fulfilled" ? (countRes.value.data.clicks || 0) : 0);

        const topLinks = filteredLinks
            .sort((a, b) => b.clicks - a.clicks)
            .slice(0, 5);

        const result = { totalClicks, topLinks };
        _analyticsCache.set(cacheKey, { data: result, ts: Date.now() });

        // Cap cache size
        if (_analyticsCache.size > 50) {
            const oldest = _analyticsCache.keys().next().value;
            _analyticsCache.delete(oldest);
        }

        return result;
    } catch (err) {
        console.error("🔗 Dub analytics error:", err.message);
        return null;
    }
}

module.exports = { shortenUrl, getAnalytics };
