const axios = require("axios");
const settings = require("./settings");

// In-memory cache: longUrl → shortLink (same image never shortened twice)
const cache = new Map();

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
            cache.set(longUrl, shortLink);
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
                if (shortLink) {
                    cache.set(longUrl, shortLink);
                    console.log(`🔗 Short link (existing): ${shortLink}`);
                    return shortLink;
                }
            } catch (_) { /* fall through */ }
        }
        const msg = err.response?.data?.error?.message || err.message;
        console.error(`🔗 dub.co shortening failed: ${msg}`);
        return null;
    }
}

module.exports = { shortenUrl };
