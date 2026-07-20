const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");
const settings = require("./settings");
const { getTwilioClient } = require("./helpers");

const CACHE_FILE = process.env.CONTENT_TEMPLATE_CACHE_FILE || path.join(DATA_DIR, "content-template-cache.json");
let cache;
let writeCounter = 0;
const inFlight = new Map();

function readCache() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
    catch { cache = {}; }
    return cache;
}

function saveCache() {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tempPath = `${CACHE_FILE}.tmp.${process.pid}.${writeCounter++}`;
    fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2));
    fs.renameSync(tempPath, CACHE_FILE);
}

function truncate(value, max) {
    return String(value || "").trim().slice(0, max);
}

function buildListPicker(options, bodyText, buttonLabel) {
    return {
        body: truncate(bodyText, 1024),
        button: truncate(buttonLabel, 20),
        items: options.slice(0, 10).map((option) => ({
            item: truncate(option.name || option.key, 24),
            id: truncate(option.key, 200),
            description: truncate(option.description || option.prompt || "Tap to choose", 72) || "Tap to choose",
        })),
    };
}

async function getOrCreateListPicker(menuKind, options, bodyText, buttonLabel) {
    const rawIds = options.slice(0, 10).map((option) => String(option.key || ""));
    if (rawIds.some((id) => id.length > 200) || new Set(rawIds).size !== rawIds.length) return null;
    const picker = buildListPicker(options, bodyText, buttonLabel);
    if (picker.items.length === 0) return null;

    const account = settings.get("twilioAccountSid") || "unknown";
    const hash = crypto.createHash("sha256")
        .update(JSON.stringify({ account, menuKind, picker }))
        .digest("hex");
    if (readCache()[hash]) return cache[hash];
    if (inFlight.has(hash)) return inFlight.get(hash);

    const creation = (async () => {
        try {
            const content = await getTwilioClient().content.v1.contents.create({
                friendlyName: `pb_${menuKind}_${hash.slice(0, 12)}`,
                language: "en",
                types: { "twilio/list-picker": picker },
            });
            cache[hash] = content.sid;
            saveCache();
            return content.sid;
        } catch (err) {
            console.error(`📋 Failed to create ${menuKind} list picker: ${err.message}`);
            return null;
        } finally {
            inFlight.delete(hash);
        }
    })();
    inFlight.set(hash, creation);
    return creation;
}

function resetCacheForTest() {
    cache = undefined;
    inFlight.clear();
}

module.exports = { buildListPicker, getOrCreateListPicker, resetCacheForTest };
