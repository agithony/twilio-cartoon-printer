const path = require("path");
const { OpenAI } = require("openai");

const MAX_RETRIES = 3;
const POLL_INTERVAL = 3000;
const MAX_CONCURRENT_GENERATION = parseInt(process.env.MAX_CONCURRENT_GENERATION || "3", 10);
const MAX_PRINTS = parseInt(process.env.MAX_PRINTS_PER_USER || "2", 10);
const EVENT_NAME = process.env.EVENT_NAME || "default";
const ADMIN_PHONES = (process.env.ADMIN_PHONES || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

const TERMS_URL = process.env.TERMS_URL || "";

const PROMO_EVENT_NAME = process.env.PROMO_EVENT_NAME || "";
const PROMO_EVENT_DATE = process.env.PROMO_EVENT_DATE || "";
const PROMO_EVENT_URL = process.env.PROMO_EVENT_URL || "";
const PROMO_INTRO =
    PROMO_EVENT_NAME && PROMO_EVENT_URL
        ? `\n\nP.S. Join us at ${PROMO_EVENT_NAME}${PROMO_EVENT_DATE ? `, ${PROMO_EVENT_DATE}` : ""}! It's Twilio's annual flagship developer conference and it's free to attend. Register here: ${PROMO_EVENT_URL}`
        : "";
const PROMO_RETURNING =
    PROMO_EVENT_NAME && PROMO_EVENT_URL
        ? `\n\nHave you registered for ${PROMO_EVENT_NAME} yet? It's Twilio's annual flagship developer conference${PROMO_EVENT_DATE ? ` -- ${PROMO_EVENT_DATE}` : ""}. Don't miss out, it's free to attend! Register here: ${PROMO_EVENT_URL}`
        : "";

function formatTimestamp(epochMs) {
    const d = new Date(epochMs);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const ROOT_DIR = path.join(__dirname, "..");
const DOWNLOAD_DIR = path.join(ROOT_DIR, "downloads", EVENT_NAME);
const QUEUE_DIR = path.join(ROOT_DIR, "queue");
const PENDING_DIR = path.join(QUEUE_DIR, "pending");
const GENERATING_DIR = path.join(QUEUE_DIR, "generating");
const READY_DIR = path.join(QUEUE_DIR, "ready");
const PRINTING_DIR = path.join(QUEUE_DIR, "printing");
const PROCESSING_DIR = path.join(QUEUE_DIR, "processing"); // legacy, kept for crash recovery
const DONE_DIR = path.join(QUEUE_DIR, "done");
const FAILED_DIR = path.join(QUEUE_DIR, "failed");
const TEMPLATE_FILE = process.env.TEMPLATE_FILE || "";
const TEMPLATE_PATH = TEMPLATE_FILE ? path.join(ROOT_DIR, "templates", TEMPLATE_FILE) : "";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = require("twilio")(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
);

module.exports = {
    MAX_RETRIES,
    POLL_INTERVAL,
    MAX_CONCURRENT_GENERATION,
    MAX_PRINTS,
    EVENT_NAME,
    ADMIN_PHONES,
    TERMS_URL,
    PROMO_INTRO,
    PROMO_RETURNING,
    formatTimestamp,
    DOWNLOAD_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    DONE_DIR,
    FAILED_DIR,
    TEMPLATE_PATH,
    openai,
    twilioClient,
};
