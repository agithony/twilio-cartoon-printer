const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const { sendSms } = require("./helpers");

const LEADS_FILE = path.join(__dirname, "..", "data", "leads.json");

// ── Personal email domains (rejected for business email field) ───────────────

const PERSONAL_DOMAINS = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "icloud.com", "aol.com", "mail.com", "protonmail.com",
    "zoho.com", "yandex.com", "gmx.com", "live.com",
    "yahoo.co.uk", "yahoo.co.in", "hotmail.co.uk",
    "me.com", "msn.com", "inbox.com", "proton.me",
];

// ── Survey field definitions ─────────────────────────────────────────────────

const SURVEY_FIELDS = [
    {
        key: "firstName",
        prompt: "What's your first name?",
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        errorMsg: "Please enter your first name.",
        normalize: (v) => v.trim(),
    },
    {
        key: "lastName",
        prompt: "And your last name?",
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        errorMsg: "Please enter your last name.",
        normalize: (v) => v.trim(),
    },
    {
        key: "country",
        prompt: "What country are you from? (2-letter code, e.g. US, UK, CA, DE, FR, JP)",
        validate: (v) => /^[A-Za-z]{2,3}$/.test((v || "").trim()),
        errorMsg: "That doesn't look like a country code. Please enter a 2-letter code like US, UK, CA, DE, FR, AU, JP, BR, IN, etc.",
        normalize: (v) => v.trim().toUpperCase(),
    },
    {
        key: "email",
        prompt: "What's your business email? (Must be a company email, not personal like Gmail)",
        validate: (v) => {
            const email = (v || "").trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
            const domain = email.split("@")[1];
            return !PERSONAL_DOMAINS.includes(domain);
        },
        errorMsg: "We need a work email address -- personal emails like @gmail.com, @yahoo.com, @hotmail.com, etc. aren't accepted. What's your company email?",
        normalize: (v) => v.trim().toLowerCase(),
    },
    {
        key: "company",
        prompt: "What company do you work for?",
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        errorMsg: "Please enter your company name.",
        normalize: (v) => v.trim(),
    },
    {
        key: "jobTitle",
        prompt: "Last one -- what's your job title?",
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        errorMsg: "Please enter your job title.",
        normalize: (v) => v.trim(),
    },
];

// ── State ────────────────────────────────────────────────────────────────────

// Persisted leads: { "phone:event": leadRecord }
let leadsData = {};

// Active surveys: Map<phone, surveyState>
const activeSurveys = new Map();

// ── Persistence ──────────────────────────────────────────────────────────────

function load() {
    try {
        if (fs.existsSync(LEADS_FILE)) {
            leadsData = JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8"));
        }
    } catch {
        leadsData = {};
    }
    const count = Object.keys(leadsData).length;
    if (count > 0) console.log(`📋 Leads loaded (${count} records)`);
}

function saveLead(phone, eventName, answers) {
    const key = `${phone}:${eventName}`;
    leadsData[key] = {
        phone,
        eventName,
        ...answers,
        completedAt: Date.now(),
    };
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));
}

// ── Queries ──────────────────────────────────────────────────────────────────

function isCompleted(phone, eventName) {
    return !!leadsData[`${phone}:${eventName}`];
}

function isActive(phone) {
    return activeSurveys.has(phone);
}

function getLeads(eventName) {
    const all = Object.values(leadsData);
    if (!eventName) return all;
    return all.filter((l) => l.eventName === eventName);
}

// ── Survey engine ────────────────────────────────────────────────────────────

async function startSurvey(phone, appPhone, eventName, mode, pendingData) {
    const state = {
        phone,
        appPhone,
        eventName,
        currentField: 0,
        answers: {},
        pendingImage: null,
        heldMms: null,
        lastActivity: Date.now(),
    };

    if (mode === "before" && pendingData) {
        state.pendingImage = pendingData;
    } else if (mode === "after" && pendingData) {
        state.heldMms = pendingData;
    }

    activeSurveys.set(phone, state);

    const intro = mode === "before"
        ? "Before we create your portrait, we just need a few quick details -- it'll only take a minute!\n\n"
        : "While your portrait is being prepared, we just have a few quick questions -- it'll only take a minute!\n\n";

    await sendSms(phone, appPhone, intro + SURVEY_FIELDS[0].prompt);
    console.log(`📋 Lead capture started for ${phone} (${mode} mode)`);
}

async function processResponse(phone, messageBody) {
    const state = activeSurveys.get(phone);
    if (!state) return { status: "not_active" };

    state.lastActivity = Date.now();
    const field = SURVEY_FIELDS[state.currentField];
    const body = (messageBody || "").trim();

    // Validate answer
    if (!field.validate(body)) {
        await sendSms(phone, state.appPhone, field.errorMsg);
        return { status: "in_progress" };
    }

    // Store normalized answer
    state.answers[field.key] = field.normalize(body);
    state.currentField++;

    // More questions?
    if (state.currentField < SURVEY_FIELDS.length) {
        const next = SURVEY_FIELDS[state.currentField];
        await sendSms(phone, state.appPhone, next.prompt);
        return { status: "in_progress" };
    }

    // Survey complete
    return await completeSurvey(phone);
}

async function completeSurvey(phone) {
    const state = activeSurveys.get(phone);
    const { answers, heldMms, pendingImage } = state;

    // Save lead
    saveLead(phone, state.eventName, answers);
    console.log(`📋 Lead captured for ${phone}: ${answers.firstName} ${answers.lastName} (${answers.email})`);

    if (heldMms) {
        // "After" mode: deliver held portrait directly
        await sendSms(phone, state.appPhone, `Thanks, ${answers.firstName}!`);
        try {
            await sendSms(phone, state.appPhone, heldMms.body, heldMms.mediaUrl);
        } catch (err) {
            console.error(`❌ Held MMS delivery failed for ${phone}: ${err.message}`);
        }
        activeSurveys.delete(phone);
        return { status: "completed" };
    }

    if (pendingImage) {
        // "Before" mode with image: let caller enqueue
        await sendSms(phone, state.appPhone, `Thanks, ${answers.firstName}!`);
        const pi = pendingImage;
        activeSurveys.delete(phone);
        return { status: "completed", pendingImage: pi };
    }

    // "Before" mode with no image: tell them to send a selfie
    await sendSms(phone, state.appPhone, `Thanks, ${answers.firstName}! Now send us a selfie and we'll turn it into art.`);
    activeSurveys.delete(phone);
    return { status: "completed" };
}

// ── Stale survey cleanup ─────────────────────────────────────────────────────

const STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function cleanupStale() {
    const now = Date.now();
    for (const [phone, state] of activeSurveys) {
        if (now - state.lastActivity > STALE_TIMEOUT_MS) {
            console.log(`📋 Removing stale survey for ${phone}`);
            activeSurveys.delete(phone);
        }
    }
}

setInterval(cleanupStale, 5 * 60 * 1000); // every 5 minutes

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    load,
    isCompleted,
    isActive,
    startSurvey,
    processResponse,
    getLeads,
};
