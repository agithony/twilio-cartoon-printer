const path = require("path");
const { OpenAI } = require("openai");

// ── Static constants (not runtime-configurable) ─────────────────────────────

const MAX_RETRIES = 3;
const POLL_INTERVAL = 3000;

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
