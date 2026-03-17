const path = require("path");
const { OpenAI } = require("openai");

// ── Static constants (not runtime-configurable) ─────────────────────────────

const MAX_RETRIES = 3;
const POLL_INTERVAL = 1000;

// ── Model IDs (override via .env if needed) ────────────────────────────────

const MODELS = {
    orchestrator: process.env.MODEL_ORCHESTRATOR || "gpt-5.4",
    visionLight: process.env.MODEL_VISION_LIGHT || "gpt-5.4-nano",
    imageGen: process.env.MODEL_IMAGE_GEN || "gpt-image-1.5",
    smartReply: process.env.MODEL_SMART_REPLY || "gpt-5.4-nano",
};

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

// ── API Clients ─────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = require("twilio")(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
);

module.exports = {
    MAX_RETRIES,
    POLL_INTERVAL,
    MODELS,
    formatTimestamp,
    DATA_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    DONE_DIR,
    FAILED_DIR,
    openai,
    twilioClient,
};
