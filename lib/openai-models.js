const crypto = require("crypto");
const { getOpenAI } = require("./config");
const settings = require("./settings");

const CURATED_MODELS = Object.freeze({
    text: Object.freeze(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]),
    vision: Object.freeze(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]),
    image: Object.freeze(["gpt-image-2-2026-04-21", "gpt-image-1.5"]),
});

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

let cache = null;
let inFlight = null;

function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function isResponseModel(id) {
    const normalized = id.toLowerCase();
    if (!/^(?:gpt-[0-9]|o[0-9])/.test(normalized)) return false;
    return !/(?:audio|realtime|transcrib|tts|image|search|moderation|embedding|instruct|codex|deep-research)/.test(normalized);
}

function classifyModelIds(models) {
    const ids = (Array.isArray(models) ? models : [])
        .map((model) => typeof model === "string" ? model : model && model.id)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim());
    const text = uniqueSorted(ids.filter(isResponseModel));
    return {
        text,
        // The Models API has no capability metadata. GPT candidates are useful
        // suggestions here, but the UI still labels discovered IDs as unverified.
        vision: text.filter((id) => /^gpt-/i.test(id)),
        image: uniqueSorted(ids.filter((id) => /^gpt-image-/i.test(id))),
    };
}

function fallbackCatalog(reason) {
    return {
        source: "curated",
        reason,
        models: { text: [], vision: [], image: [] },
        refreshedAt: null,
    };
}

function apiKeyFingerprint(apiKey) {
    return crypto.createHash("sha256").update(apiKey).digest("hex");
}

async function loadOpenAIModelCatalog(options = {}) {
    const configuredKey = options.apiKey === undefined ? settings.get("openaiApiKey") : options.apiKey;
    const apiKey = typeof configuredKey === "string" ? configuredKey.trim() : "";
    if (!apiKey) return fallbackCatalog("missing-api-key");

    const now = options.now === undefined ? Date.now() : options.now;
    const fingerprint = apiKeyFingerprint(apiKey);
    if (cache && cache.fingerprint === fingerprint && cache.expiresAt > now) return cache.catalog;
    if (inFlight && inFlight.fingerprint === fingerprint) return inFlight.promise;

    const logger = options.logger || console;
    const promise = (async () => {
        try {
            const client = options.client || getOpenAI();
            const page = await client.models.list({ timeout: REQUEST_TIMEOUT_MS });
            const catalog = {
                source: "openai",
                reason: null,
                models: classifyModelIds(page && page.data),
                refreshedAt: new Date(now).toISOString(),
            };
            cache = { fingerprint, expiresAt: now + CACHE_TTL_MS, catalog };
            return catalog;
        } catch (err) {
            logger.warn(`OpenAI model discovery failed: ${err.message}`);
            const catalog = fallbackCatalog("discovery-unavailable");
            cache = { fingerprint, expiresAt: now + FAILURE_CACHE_TTL_MS, catalog };
            return catalog;
        }
    })();

    inFlight = { fingerprint, promise };
    try {
        return await promise;
    } finally {
        if (inFlight && inFlight.promise === promise) inFlight = null;
    }
}

function resetModelCatalogCache() {
    cache = null;
    inFlight = null;
}

module.exports = {
    CURATED_MODELS,
    classifyModelIds,
    loadOpenAIModelCatalog,
    resetModelCatalogCache,
};
