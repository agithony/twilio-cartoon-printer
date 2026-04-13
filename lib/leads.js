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
// Validation and normalization logic lives in code; prompts and error messages
// come from settings so admins can edit them on the fly.

const FIELD_VALIDATORS = {
    firstName: {
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        normalize: (v) => v.trim(),
    },
    lastName: {
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        normalize: (v) => v.trim(),
    },
    country: {
        validate: (v) => /^[A-Za-z]{2,3}$/.test((v || "").trim()),
        normalize: (v) => v.trim().toUpperCase(),
    },
    email: {
        validate: (v) => {
            const email = (v || "").trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
            const domain = email.split("@")[1];
            return !PERSONAL_DOMAINS.includes(domain);
        },
        normalize: (v) => v.trim().toLowerCase(),
    },
    personalEmail: {
        validate: (v) => {
            const email = (v || "").trim().toLowerCase();
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        },
        normalize: (v) => v.trim().toLowerCase(),
    },
    company: {
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        normalize: (v) => v.trim(),
    },
    jobTitle: {
        validate: (v) => typeof v === "string" && v.trim().length > 0,
        normalize: (v) => v.trim(),
    },
};

// Ordered field keys (determines survey question order)
const FIELD_ORDER = ["firstName", "lastName", "country", "email", "personalEmail", "company", "jobTitle"];

function getActiveSurveyFields() {
    const fieldConfig = settings.getLeadFields();
    return FIELD_ORDER
        .filter((key) => fieldConfig[key] && fieldConfig[key].enabled !== false)
        .map((key) => ({
            key,
            prompt: fieldConfig[key].prompt,
            errorMsg: fieldConfig[key].errorMsg,
            validate: FIELD_VALIDATORS[key].validate,
            normalize: FIELD_VALIDATORS[key].normalize,
        }));
}

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

let _writeCounter = 0;
function atomicWriteSync(filePath, data) {
    const tmp = filePath + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
}

function saveLead(phone, eventName, answers) {
    const key = `${phone}:${eventName}`;
    leadsData[key] = {
        phone,
        eventName,
        ...answers,
        completedAt: Date.now(),
    };
    atomicWriteSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));
}

// ── Queries ──────────────────────────────────────────────────────────────────

function isCompleted(phone, eventName) {
    return !!leadsData[`${phone}:${eventName}`];
}

function getFirstName(phone, eventName) {
    const lead = leadsData[`${phone}:${eventName}`];
    return (lead && lead.firstName) ? lead.firstName.trim() : null;
}

function getLeadName(phone, eventName) {
    const lead = leadsData[`${phone}:${eventName}`];
    if (!lead) return null;
    const parts = [lead.firstName, lead.lastName].filter(Boolean).map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
}

function isActive(phone) {
    return activeSurveys.has(phone);
}

function getLeads(eventName) {
    const all = Object.values(leadsData);
    if (!eventName) return all;
    return all.filter((l) => l.eventName === eventName);
}

function deleteByPhone(phone, eventName) {
    let deleted = 0;
    for (const key of Object.keys(leadsData)) {
        if (key.startsWith(phone + ":") && (!eventName || key === `${phone}:${eventName}`)) {
            delete leadsData[key];
            deleted++;
        }
    }
    if (deleted > 0) {
        atomicWriteSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));
    }
    activeSurveys.delete(phone);
    return deleted;
}

function deleteByEvent(eventName) {
    let deleted = 0;
    for (const key of Object.keys(leadsData)) {
        if (key.endsWith(":" + eventName)) {
            delete leadsData[key];
            deleted++;
        }
    }
    if (deleted > 0) {
        atomicWriteSync(LEADS_FILE, JSON.stringify(leadsData, null, 2));
    }
    return deleted;
}

// ── Survey engine ────────────────────────────────────────────────────────────

async function startSurvey(phone, appPhone, eventName, mode, pendingData) {
    const fields = getActiveSurveyFields();

    // If no fields are enabled, skip the survey entirely
    if (fields.length === 0) {
        if (pendingData && mode === "before") {
            return { status: "completed", pendingImage: pendingData };
        }
        if (pendingData && mode === "after") {
            try { await sendSms(phone, appPhone, pendingData.body, pendingData.mediaUrl); } catch (err) {
                console.error(`❌ Held MMS delivery failed for ${phone}: ${err.message}`);
            }
        }
        return { status: "completed" };
    }

    const state = {
        phone,
        appPhone,
        eventName,
        currentField: 0,
        fields,
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
        ? settings.getMsg("leadIntroBefore") + "\n\n"
        : settings.getMsg("leadIntroAfter") + "\n\n";

    await sendSms(phone, appPhone, intro + fields[0].prompt);
    console.log(`📋 Lead capture started for ${phone} (${mode} mode, ${fields.length} fields)`);
}

async function processResponse(phone, messageBody) {
    const state = activeSurveys.get(phone);
    if (!state) return { status: "not_active" };

    state.lastActivity = Date.now();
    const fields = state.fields || getActiveSurveyFields();
    const field = fields[state.currentField];
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
    if (state.currentField < fields.length) {
        const next = fields[state.currentField];
        await sendSms(phone, state.appPhone, next.prompt);
        return { status: "in_progress" };
    }

    // Survey complete
    return await completeSurvey(phone);
}

async function completeSurvey(phone) {
    const state = activeSurveys.get(phone);
    if (!state) return { status: "not_active" };
    const { answers, heldMms, pendingImage } = state;

    // Save lead
    saveLead(phone, state.eventName, answers);
    console.log(`📋 Lead captured for ${phone}: ${answers.firstName} ${answers.lastName} (${answers.email})`);

    const firstName = answers.firstName || "";

    if (heldMms) {
        // "After" mode: deliver held portrait directly
        await sendSms(phone, state.appPhone, settings.getMsg("leadComplete", { firstName }));
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
        await sendSms(phone, state.appPhone, settings.getMsg("leadComplete", { firstName }));
        const pi = pendingImage;
        activeSurveys.delete(phone);
        return { status: "completed", pendingImage: pi };
    }

    // "Before" mode with no image: tell them to send a selfie
    await sendSms(phone, state.appPhone, settings.getMsg("leadCompleteWithCta", { firstName }));
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
    getFirstName,
    getLeadName,
    startSurvey,
    processResponse,
    getLeads,
    deleteByPhone,
    deleteByEvent,
};
