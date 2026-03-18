const path = require("path");
const { OpenAI } = require("openai");

// ── Static constants (not runtime-configurable) ─────────────────────────────

const MAX_RETRIES = 3;
const POLL_INTERVAL = 1000;

// ── Lazy settings accessor (avoids circular dep) ───────────────────────────

let _settings = null;
function _s() {
    if (!_settings) _settings = require("./settings");
    return _settings;
}

// ── Model IDs (runtime-configurable via settings UI) ────────────────────────

function getModels() {
    return {
        orchestrator: _s().get("modelOrchestrator"),
        visionLight: _s().get("modelVisionLight"),
        imageGen: _s().get("modelImageGen"),
        smartReply: _s().get("modelSmartReply"),
    };
}

function formatTimestamp(epochMs) {
    const d = new Date(epochMs);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── Paths ───────────────────────────────────────────────────────────────────

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const QUEUE_DIR = path.join(ROOT_DIR, "queue");
const PENDING_DIR = path.join(QUEUE_DIR, "pending");
const GENERATING_DIR = path.join(QUEUE_DIR, "generating");
const READY_DIR = path.join(QUEUE_DIR, "ready");
const PRINTING_DIR = path.join(QUEUE_DIR, "printing");
const PROCESSING_DIR = path.join(QUEUE_DIR, "processing"); // legacy, kept for crash recovery
const DONE_DIR = path.join(QUEUE_DIR, "done");
const FAILED_DIR = path.join(QUEUE_DIR, "failed");

// ── API Clients (lazy, memoized — recreated when credentials change) ────────

let _openaiClient = null, _openaiKey = null;
function getOpenAI() {
    const key = _s().get("openaiApiKey");
    if (!_openaiClient || _openaiKey !== key) {
        _openaiClient = new OpenAI({ apiKey: key });
        _openaiKey = key;
    }
    return _openaiClient;
}

let _twilioClient = null, _twilioSid = null, _twilioToken = null;
function getTwilioClient() {
    const sid = _s().get("twilioAccountSid");
    const token = _s().get("twilioAuthToken");
    if (!_twilioClient || _twilioSid !== sid || _twilioToken !== token) {
        _twilioClient = require("twilio")(sid, token);
        _twilioSid = sid;
        _twilioToken = token;
    }
    return _twilioClient;
}

module.exports = {
    MAX_RETRIES,
    POLL_INTERVAL,
    getModels,
    formatTimestamp,
    DATA_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    DONE_DIR,
    FAILED_DIR,
    getOpenAI,
    getTwilioClient,
};
