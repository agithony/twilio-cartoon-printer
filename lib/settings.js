const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const USER_SETTINGS_DIR = path.join(DATA_DIR, "user-settings");
const TEMPLATES_DIR = path.join(ROOT_DIR, "templates");
const ASSETS_DIR = path.join(ROOT_DIR, "assets");
const BRAND_REFS_DIR = path.join(ROOT_DIR, "brand-references");
const STYLE_REFS_DIR = path.join(ROOT_DIR, "style-references");
const BG_REFS_DIR = path.join(ROOT_DIR, "background-references");

// Keys that are global (shared across all events, not saved per-event).
// Only credentials and infrastructure — everything else is per-event.
const GLOBAL_KEYS = new Set([
    "twilioAccountSid", "twilioAuthToken", "twilioPhoneNumber",
    "openaiApiKey", "modelOrchestrator", "modelVisionLight", "modelImageGen", "modelSmartReply", "modelRefAnalysis",
    "printRelayKey",
    "customBrands",
    "usageOverrides",
    "dubApiKey",
    "dubDomain",
    "dubFolderId",
]);

// Legacy — kept for export compatibility but no longer used for routing.
const USER_EXCLUDED_KEYS = new Set([...GLOBAL_KEYS, "eventName", "enableManualReview"]);

// ── Print presets ────────────────────────────────────────────────────────────

const PRINT_SIZES = {
    "4x6":  { width: 1200, height: 1800, pageSize: "4x6",            dpi: 300 },
    "5x7":  { width: 1500, height: 2100, pageSize: "EPPhotoPaper2L", dpi: 300 },
    "8x10": { width: 2400, height: 3000, pageSize: "8x10",           dpi: 300 },
};

const PRINT_QUALITIES = {
    standard: "360x360dpi",
    high:     "720x720dpi",
    max:      "1440x1440dpi",
};

// ── Defaults (from .env, computed once at startup) ──────────────────────────

const DEFAULTS = {
    eventName: process.env.EVENT_NAME || "default",
    maxPrints: parseInt(process.env.MAX_PRINTS_PER_USER || "2", 10),
    maxConcurrentGeneration: parseInt(process.env.MAX_CONCURRENT_GENERATION || "15", 10),
    adminPhones: (process.env.ADMIN_PHONES || "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    usageOverrides: {},
    templateFile: process.env.TEMPLATE_FILE || "",
    videoFile: process.env.VIDEO_FILE || "get-started.mp4",
    printerName: process.env.PRINTER_NAME || "",
    termsUrl: process.env.TERMS_URL || "",
    enablePrinting: process.env.ENABLE_PRINTING !== "false",
    immediateDigitalDelivery: true,
    disabledPrinters: [],
    brandPrompt: process.env.BRAND_PROMPT || "",
    brandReferenceFiles: [],
    enableFrameBorder: true,
    frameBorderColor: "#000000",
    defaultStyle: process.env.DEFAULT_STYLE || "cartoon",
    leadCaptureMode: "disabled",
    disabledStyles: [],
    stylePromptOverrides: {},
    customStyles: {},
    customBrands: {},
    enableBrandMenu: false,
    disabledBrands: [],
    brandPromptOverrides: {},
    boothDisplayMode: "video",
    boothHeadline: "Get Your AI Portrait",
    boothSubline: "",
    boothQrImage: "",
    boothStep1: "Scan the QR code with your phone camera",
    boothStep2: "Send the pre-filled text message",
    boothStep3: "Take a selfie and reply with your photo",
    boothSteps: ["Scan the QR code with your phone camera", "Send the pre-filled text message", "Take a selfie and reply with your photo"],
    boothLegalText: "",
    enablePromoMessage: false,
    promoMessage: process.env.PROMO_MESSAGE || "",
    enableShareLinks: false,
    sharePageOnly: false,
    enableTwitterShare: true,
    enableLinkedInShare: true,
    enableInstagramShare: true,
    twitterHandle: process.env.TWITTER_HANDLE || "@twilio",
    twitterShareText: process.env.TWITTER_SHARE_TEXT || "Check out my AI portrait from {eventName}! Made with @twilio on X",
    linkedInShareText: process.env.LINKEDIN_SHARE_TEXT || "Check out my AI portrait from {eventName}, powered by Twilio!",
    linkedInCompanyUrl: process.env.LINKEDIN_COMPANY_URL || "https://www.linkedin.com/company/twilio-inc-",
    instagramHandle: process.env.INSTAGRAM_HANDLE || "@twilio",
    shareMessageText: "Share your portrait: {url}",
    sharePageTitle: "My AI Portrait",
    sharePageTitlePersonalized: "{firstName}'s AI Portrait",
    sharePageDescription: "Check out my AI portrait, powered by Twilio!",
    dubApiKey: process.env.DUB_API_KEY || "",
    dubDomain: process.env.DUB_DOMAIN || "twil.io",
    dubSlugPrefix: process.env.DUB_SLUG_PREFIX || "p",
    dubFolderId: process.env.DUB_FOLDER_ID || "",
    dubSlugCounter: 0,
    enableNps: false,
    npsDelay: 30,
    queuePaused: false,
    breakMessage: "",
    revealAnimation: "off",
    photoBookAutoplay: true,
    photoBookInterval: 10,
    milestonesEnabled: true,
    milestoneInterval: 100,
    // ── Configurable SMS Messages ────────────────────────────────────────────
    messages: {
        // Welcome (no photo sent)
        welcome: "Send us a selfie and we'll turn it into art!",
        welcomeCount: "You get {maxPrints} free {unit} at {eventName}.",
        remainingCount: "By the way, you have {remaining} {unit} remaining.",
        // Multiple photos
        multiplePhotos: "One at a time! Send a single selfie and we'll work our magic.",
        // Quota exceeded
        quotaExceeded: "You've already used your {maxPrints} free {units} for {eventName}. Thanks for stopping by!",
        // Enqueue confirmation
        enqueued: "{confirmLabel} is in the works!",
        pickupPrint: "It may take a minute or two -- we'll text you when it's ready for pickup at the Twilio booth.",
        pickupDigital: "It may take a minute or two -- we'll text it to you as soon as it's done.",
        twilioBlurb: "Fun fact: this experience is powered by Twilio! Your photo is received via text, transformed by AI, and delivered back to you -- all through Twilio's APIs.",
        // Delivery
        deliveryDigital: "Here's your {styleName} portrait!",
        deliveryPrint: "Your {styleName} portrait has been sent to the printer! Head to the Twilio booth to pick it up.",
        lastPortrait: "That was your last one -- thanks for visiting!",
        // Moderation / errors
        moderationFail: "That photo didn't work -- try sending a different selfie. Don't worry, it didn't count toward your limit!",
        noFace: "We need to see your face for the portrait! Send a selfie with your face visible. Don't worry, that one didn't count.",
        multiSubjectReject: "Group photos aren't supported for this experience — please send a selfie with just yourself!",
        // Style menu
        styleMenuIntro: "Great selfie! Pick your art style:",
        styleMenuFooter: "Reply with a number or style name.",
        styleMenuRetry: "That one isn't on the menu! Reply with a number or style name:",
        brandMenuIntro: "Now pick your brand:",
        brandMenuFooter: "Reply with a number or name.",
        brandMenuRetry: "That didn't match a brand. Try again:",
        backgroundMenuIntro: "Now pick your background:",
        backgroundMenuFooter: "Reply with a number or name.",
        backgroundMenuRetry: "That didn't match a background. Try again:",
        // Lead capture
        leadIntroBefore: "Before we create your portrait, we just need a few quick details -- it'll only take a minute!",
        leadIntroAfter: "We have a few quick questions -- it'll only take a minute!",
        leadComplete: "Thanks, {firstName}!",
        leadCompleteWithCta: "Thanks, {firstName}! Now send us a selfie and we'll turn it into art.",
        // NPS
        npsPrompt: "Thanks for visiting! How would you rate your portrait experience? Reply with a number 1-5 (5 = loved it)",
        npsThanks: "Thanks for the feedback! We appreciate it.",
        // Manual review
        reviewReject: "We weren't able to use that photo. Please try sending a different one!",
        reviewFailed: "Sorry, we couldn't get your portrait right this time. Please try again with a different photo!",
    },
    // ── Configurable Lead Capture Fields ──────────────────────────────────────
    leadCaptureFields: {
        firstName: { enabled: true, prompt: "What's your first name?", errorMsg: "Please enter your first name." },
        lastName: { enabled: true, prompt: "And your last name?", errorMsg: "Please enter your last name." },
        country: { enabled: true, prompt: "What country are you from? (2-letter code, e.g. US, UK, CA, DE, FR, JP)", errorMsg: "That doesn't look like a country code. Please enter a 2-letter code like US, UK, CA, DE, FR, AU, JP, BR, IN, etc." },
        email: { enabled: true, prompt: "What's your business email? (Must be a company email, not personal like Gmail)", errorMsg: "We need a work email address -- personal emails like @gmail.com, @yahoo.com, @hotmail.com, etc. aren't accepted. What's your company email?" },
        personalEmail: { enabled: false, prompt: "What is your email address?", errorMsg: "Please enter a valid email address." },
        company: { enabled: true, prompt: "What company do you work for?", errorMsg: "Please enter your company name." },
        jobTitle: { enabled: true, prompt: "Last one -- what's your job title?", errorMsg: "Please enter your job title." },
    },
    // ── Configurable AI Prompts ───────────────────────────────────────────────
    promptPreserve: "Preserve accurately for every subject: skin tone, eye color, hair color, hairstyle, facial hair, glasses, jewelry, clothing, and any visible accessories or distinguishing features.",
    promptComposition: "Composition: Portrait framing from the chest up, with all subjects positioned naturally as they appear in the original photo.",
    promptPreserveBrand: "Preserve accurately: skin tone, eye color, hair color and style, facial hair, glasses, facial structure.",
    promptBrandInstruction: "Logos and text: Copy the exact logos, crests, numbers, and text from the reference images. Do NOT invent, add, or modify any text or symbols. If you cannot reproduce text exactly, omit it entirely rather than rendering incorrect or gibberish text. Never add text that is not in the reference images.",
    promptBackground: "Background: Recreate the background from the original photo in the same art style. Keep it natural and consistent with the scene.",
    enableBackgroundMenu: false,
    multiSubjectMode: "reject",
    reviewMode: "off",
    enableManualReview: false,
    reviewPin: "",
    aiReviewChecks: {
        likeness: true,
        subjectCount: true,
        gender: true,
        branding: true,
        accessories: true,
        anatomy: true,
    },
    backgroundChoices: [
        { key: "gradient", name: "Soft Gradient", prompt: "Background: Clean soft gradient, light and uncluttered, suitable for printing.", files: [], mode: "ai" },
        { key: "solid-white", name: "Solid White", prompt: "Background: Pure solid white background, clean and minimal.", files: [], mode: "ai" },
        { key: "solid-black", name: "Solid Black", prompt: "Background: Pure solid black background, dramatic and clean.", files: [], mode: "ai" },
        { key: "original", name: "Original Scene", prompt: "Background: Recreate the background environment from the original photo in the same art style.", files: [], mode: "ai" },
    ],
    promptFaceDetection: "Does this image clearly show a person's face? A face must be visible -- photos of only hands, feet, backs, or other body parts without a face do NOT count. Reply with only YES or NO.",
    promptSceneAnalysis: "Analyze this photo. Count ONLY the main subject(s) who are clearly posing or the focus of the photo. IGNORE background bystanders, passersby, people partially visible at frame edges, people on screens/posters, or anyone who is not a primary subject. Reply in EXACTLY this format:\nSubjects: [number of PRIMARY subjects only]\nPets: [none OR animal type, only if the pet belongs to the subject(s)]\nPositions: [centered, left-right pair, or group]",
    promptSmartReply: "You are an AI-powered photobooth assistant at an event called \"{eventName}\". Powered by Twilio and OpenAI.\nYour job is to respond to the user's message naturally and helpfully, then direct them to send a selfie so you can transform it into art.\nAvailable art styles: {styleChoices}.\n{remainingLine}\nKeep your response concise (2-4 sentences max). Always end by encouraging them to send a selfie. Be friendly and conversational. Do not use emojis.",
    promptUserDirective: "Transform this photo into a stylized portrait.",
    printSize: process.env.PRINT_SIZE || "5x7",
    printQuality: process.env.PRINT_QUALITY || "high",
    customPrintFlags: process.env.CUSTOM_PRINT_FLAGS || "",
    activePrinters: [],
    printRelayKey: process.env.PRINT_RELAY_KEY || "",
    // Twilio
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
    // OpenAI
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    modelOrchestrator: process.env.MODEL_ORCHESTRATOR || "gpt-5.4",
    modelVisionLight: process.env.MODEL_VISION_LIGHT || "gpt-5.4-nano",
    modelImageGen: process.env.MODEL_IMAGE_GEN || "gpt-image-1.5",
    modelSmartReply: process.env.MODEL_SMART_REPLY || "gpt-5.4-nano",
    modelRefAnalysis: process.env.MODEL_REF_ANALYSIS || "gpt-5.4",
};

// ── State ───────────────────────────────────────────────────────────────────

let overrides = {};

let _writeCounter = 0;
function atomicWriteSync(filePath, data) {
    const tmp = filePath + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
}

function save() {
    atomicWriteSync(SETTINGS_FILE, JSON.stringify(overrides, null, 2));
}

function load() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            overrides = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
    } catch (err) {
        console.error(`⚠️  Failed to load settings (using defaults): ${err.message}`);
        overrides = {};
    }
    // Backward compat: migrate enableManualReview → reviewMode for existing settings
    if ("enableManualReview" in overrides && !("reviewMode" in overrides)) {
        overrides.reviewMode = overrides.enableManualReview ? "human" : "off";
        save();
    }
    // Merge per-event settings from the event profile directory.
    // After an event switch, settings.json is stripped to globals + eventName.
    // Without this merge, a restart would lose all per-event configuration.
    const currentEvent = get("eventName");
    if (currentEvent) {
        const perEventOverrides = loadEventSettings(currentEvent);
        if (Object.keys(perEventOverrides).length > 0) {
            // Keep globals from settings.json, layer per-event on top
            const globals = {};
            for (const [key, value] of Object.entries(overrides)) {
                if (GLOBAL_KEYS.has(key) || key === "eventName") {
                    globals[key] = value;
                }
            }
            overrides = { ...globals, ...perEventOverrides };
            save();
            console.log(`⚙️  Settings loaded + merged ${Object.keys(perEventOverrides).length} per-event overrides for "${currentEvent}"`);
        } else {
            console.log(`⚙️  Settings loaded${Object.keys(overrides).length > 0 ? ` (${Object.keys(overrides).length} overrides)` : " (using .env defaults)"}`);
            // Bootstrap: save current overrides to the event profile if none exists yet
            if (Object.keys(overrides).length > 0) {
                const evtPath = eventSettingsPath(currentEvent);
                if (!fs.existsSync(evtPath)) {
                    saveEventSettings(currentEvent);
                    console.log(`⚙️  Bootstrapped event profile for "${currentEvent}"`);
                }
            }
        }
    } else {
        console.log(`⚙️  Settings loaded${Object.keys(overrides).length > 0 ? ` (${Object.keys(overrides).length} overrides)` : " (using .env defaults)"}`);
    }
}

// ── Per-event settings ───────────────────────────────────────────────────────

function eventSettingsPath(eventName) {
    return path.join(EVENTS_DIR, eventName, "settings.json");
}

function saveEventSettings(eventName) {
    if (!eventName) return;
    const perEvent = {};
    for (const [key, value] of Object.entries(overrides)) {
        if (!GLOBAL_KEYS.has(key) && key !== "eventName") {
            perEvent[key] = value;
        }
    }
    const dir = path.join(EVENTS_DIR, eventName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(eventSettingsPath(eventName), JSON.stringify(perEvent, null, 2));
}

function loadEventSettings(eventName) {
    const evtPath = eventSettingsPath(eventName);
    try {
        if (fs.existsSync(evtPath)) {
            const data = JSON.parse(fs.readFileSync(evtPath, "utf-8"));
            // Backward compat: migrate enableManualReview → reviewMode for old profiles
            if ("enableManualReview" in data && !("reviewMode" in data)) {
                data.reviewMode = data.enableManualReview ? "human" : "off";
            }
            return data;
        }
    } catch { /* ignore */ }
    return {};
}

function listEventProfiles() {
    try {
        if (!fs.existsSync(EVENTS_DIR)) return [];
        return fs.readdirSync(EVENTS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(EVENTS_DIR, d.name, "settings.json")))
            .map((d) => d.name)
            .sort();
    } catch {
        return [];
    }
}

// ── Getters ─────────────────────────────────────────────────────────────────

function get(key) {
    if (key in overrides) return overrides[key];
    if (key in DEFAULTS) return DEFAULTS[key];
    return undefined;
}

function getAll() {
    return { ...DEFAULTS, ...overrides, leadCaptureFields: getLeadFields() };
}

// ── Message interpolation ────────────────────────────────────────────────────

function interpolate(template, vars) {
    if (!template) return "";
    return template.replace(/\{(\w+)\}/g, (match, key) => {
        return vars[key] !== undefined ? vars[key] : match;
    });
}

function getMsg(key, vars) {
    const messages = { ...DEFAULTS.messages, ...(overrides.messages || {}) };
    const template = messages[key] !== undefined ? messages[key] : (DEFAULTS.messages[key] || "");
    const result = vars ? interpolate(template, vars) : template;
    return result.replace(/  +/g, " ").trim();
}

function getLeadFields() {
    const defaults = DEFAULTS.leadCaptureFields;
    const custom = overrides.leadCaptureFields || {};
    const result = {};
    for (const [k, def] of Object.entries(defaults)) {
        result[k] = { ...def, ...(custom[k] || {}) };
    }
    return result;
}

// ── Computed getters ────────────────────────────────────────────────────────

function getDownloadDir(eventName) {
    return path.join(ROOT_DIR, "downloads", eventName || get("eventName"));
}

function getForEvent(key, eventName) {
    if (!eventName || eventName === get("eventName")) return get(key);
    const eventOverrides = loadEventSettings(eventName);
    if (key in eventOverrides) return eventOverrides[key];
    if (key in DEFAULTS) return DEFAULTS[key];
    return undefined;
}

function getMsgForEvent(key, eventName, vars) {
    if (!eventName || eventName === get("eventName")) return getMsg(key, vars);
    const eventOverrides = loadEventSettings(eventName);
    const messages = { ...DEFAULTS.messages, ...(eventOverrides.messages || {}) };
    const template = messages[key] !== undefined ? messages[key] : (DEFAULTS.messages[key] || "");
    const result = vars ? interpolate(template, vars) : template;
    return result.replace(/  +/g, " ").trim();
}

function getTemplatePath() {
    const file = get("templateFile");
    return file ? path.join(TEMPLATES_DIR, file) : "";
}

// ── Print dimensions ─────────────────────────────────────────────────────────

function getPrintDimensions() {
    const size = get("printSize");
    return PRINT_SIZES[size] || PRINT_SIZES["5x7"];
}

// ── Styles ──────────────────────────────────────────────────────────────────

// Lazy-require to avoid circular dependency (styles.js doesn't import settings)
let _styles = null;
function _getStylesModule() {
    if (!_styles) _styles = require("./styles");
    return _styles;
}

function getActiveStyles() {
    const { getActiveStyles: gas } = _getStylesModule();
    return gas(get("disabledStyles"), get("customStyles"), get("stylePromptOverrides"), get("promptPreserve"), get("promptComposition"));
}

function getActiveStyleList() {
    const { getActiveStyleList: gasl } = _getStylesModule();
    return gasl(get("disabledStyles"), get("customStyles"), get("stylePromptOverrides"));
}

// ── Update ──────────────────────────────────────────────────────────────────

let _onEventNameChangeCallback = null;

function onEventNameChange(callback) {
    _onEventNameChangeCallback = callback;
}

function update(changes) {
    const oldEventName = get("eventName");

    // If the event name is changing, ONLY apply the event name change.
    // Ignore any other per-event fields in the payload — they belong to
    // the old event and would contaminate the new one.
    const isEventSwitch = changes.eventName && changes.eventName !== oldEventName;
    if (isEventSwitch) {
        changes = { eventName: changes.eventName };
    }

    // Backward compat: if enableManualReview is present but reviewMode is not,
    // derive reviewMode from the boolean so old clients/profiles still work.
    if ("enableManualReview" in changes && !("reviewMode" in changes)) {
        changes.reviewMode = changes.enableManualReview ? "human" : "off";
    }

    for (const [key, value] of Object.entries(changes)) {
        if (!(key in DEFAULTS)) continue; // ignore unknown keys

        // Validate
        const validated = validate(key, value);
        if (validated === undefined) continue;

        // Store the override. For global keys, skip if it matches the default
        // to keep overrides lean. Per-event keys are always stored explicitly
        // so they survive event switching (an explicit "empty" is meaningful).
        if (GLOBAL_KEYS.has(key) && JSON.stringify(validated) === JSON.stringify(DEFAULTS[key])) {
            delete overrides[key];
        } else {
            overrides[key] = validated;
        }
    }

    // Side effects
    const newEventName = get("eventName");
    if (newEventName !== oldEventName) {
        // Save old event's per-event settings BEFORE writing new eventName
        // to disk — if we crash after save() below, old event data is safe.
        saveEventSettings(oldEventName);
        console.log(`⚙️  Saved event profile for "${oldEventName}"`);
    }

    save();

    if (newEventName !== oldEventName) {
        // Load per-event settings for the new event
        const perEventOverrides = loadEventSettings(newEventName);

        // Keep global overrides, replace per-event overrides
        const globalOverrides = {};
        for (const [key, value] of Object.entries(overrides)) {
            if (GLOBAL_KEYS.has(key)) {
                globalOverrides[key] = value;
            }
        }
        overrides = { ...globalOverrides, eventName: newEventName, ...perEventOverrides };
        save();


        if (Object.keys(perEventOverrides).length > 0) {
            console.log(`⚙️  Loaded event profile for "${newEventName}" (${Object.keys(perEventOverrides).length} overrides)`);
        } else {
            console.log(`⚙️  No saved profile for "${newEventName}" — using defaults`);
        }

        const newDir = getDownloadDir();
        if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
        console.log(`⚙️  Event name changed: "${oldEventName}" → "${newEventName}"`);
        if (_onEventNameChangeCallback) _onEventNameChangeCallback();
    } else {
        // Same event — also save to event profile to keep it in sync
        saveEventSettings(newEventName);
    }

    return getAll();
}

function validate(key, value) {
    switch (key) {
        case "eventName":
            if (typeof value !== "string" || !value.trim()) return undefined;
            return value.trim().replace(/[^a-zA-Z0-9_\-\s]/g, "");
        case "maxPrints":
            return Math.max(1, Math.floor(Number(value) || 1));
        case "maxConcurrentGeneration":
            return Math.max(1, Math.floor(Number(value) || 1));
        case "adminPhones":
            if (!Array.isArray(value)) return undefined;
            return value.map((p) => String(p).trim()).filter(Boolean);
        case "usageOverrides": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const uo = {};
            for (const [k, v] of Object.entries(value)) {
                if (typeof v === "number" && Number.isFinite(v)) uo[k] = v;
            }
            return uo;
        }
        case "templateFile":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "videoFile":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "boothDisplayMode":
            if (!["video", "static", "none"].includes(value)) return undefined;
            return value;
        case "revealAnimation":
            if (!["off", "pixel", "brush", "sketch-to-color"].includes(value)) return undefined;
            return value;
        case "photoBookAutoplay":
        case "milestonesEnabled":
            return !!value;
        case "photoBookInterval": {
            const pbInterval = parseInt(value);
            if (isNaN(pbInterval) || pbInterval < 3 || pbInterval > 120) return undefined;
            return pbInterval;
        }
        case "milestoneInterval": {
            const msInterval = parseInt(value);
            if (isNaN(msInterval) || msInterval < 10 || msInterval > 1000) return undefined;
            return msInterval;
        }
        case "boothSteps":
            if (!Array.isArray(value)) return undefined;
            return value.map(s => String(s || "").trim()).filter(Boolean);
        case "boothHeadline":
        case "boothSubline":
        case "boothQrImage":
        case "boothStep1":
        case "boothStep2":
        case "boothStep3":
        case "boothLegalText":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "printerName":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "brandPrompt":
        case "termsUrl":
        case "promoMessage":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "enablePrinting":
        case "enablePromoMessage":
        case "enableShareLinks":
        case "sharePageOnly":
        case "enableTwitterShare":
        case "enableLinkedInShare":
        case "enableInstagramShare":
        case "enableNps":
        case "enableFrameBorder":
        case "queuePaused":
            return !!value;
        case "frameBorderColor":
            if (typeof value !== "string") return undefined;
            return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : undefined;
        case "npsDelay":
            return Math.max(5, Math.floor(Number(value) || 30));
        case "dubSlugCounter":
            return Math.max(0, Math.floor(Number(value) || 0));
        case "twitterHandle":
        case "twitterShareText":
        case "linkedInShareText":
        case "linkedInCompanyUrl":
        case "instagramHandle":
        case "shareMessageText":
        case "sharePageTitle":
        case "sharePageTitlePersonalized":
        case "sharePageDescription":
        case "dubApiKey":
        case "dubDomain":
        case "dubFolderId":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "dubSlugPrefix": {
            if (typeof value !== "string") return undefined;
            const slug = value.trim().replace(/[^a-zA-Z0-9\-]/g, "");
            if (!slug) return undefined;
            return slug;
        }
        case "breakMessage":
            return typeof value === "string" ? value.trim() : "";
        case "promptPreserve":
        case "promptComposition":
        case "promptPreserveBrand":
        case "promptBrandInstruction":
        case "promptBackground":
        case "promptFaceDetection":
        case "promptSceneAnalysis":
        case "promptSmartReply":
        case "promptUserDirective":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "reviewPin":
            if (typeof value !== "string") return undefined;
            value = value.trim();
            if (value && (value.length < 4 || value.length > 6)) return undefined;
            return value;
        case "reviewMode":
            if (!["off", "human", "ai"].includes(value)) return undefined;
            return value;
        case "aiReviewChecks":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const checks = {};
            for (const k of ["likeness", "subjectCount", "gender", "branding", "accessories", "anatomy"]) {
                checks[k] = value[k] !== false;
            }
            return checks;
        case "enableBackgroundMenu":
        case "enableManualReview":
            return !!value;
        case "backgroundChoices":
            if (!Array.isArray(value)) return undefined;
            return value
                .filter(c => c && typeof c.key === "string" && typeof c.name === "string" && c.name.trim())
                .map(c => ({
                    key: c.key.trim().toLowerCase().replace(/\s+/g, "-"),
                    name: c.name.trim(),
                    prompt: (typeof c.prompt === "string" ? c.prompt.trim() : ""),
                    files: Array.isArray(c.files) ? c.files.map(f => String(f).trim()).filter(Boolean) : [],
                    mode: c.mode === "exact" ? "exact" : "ai",
                    analysis: typeof c.analysis === "string" ? c.analysis : "",
                }));
        case "defaultStyle":
            if (typeof value !== "string" || !value.trim()) return undefined;
            return value.trim();
        case "multiSubjectMode":
            if (!["normal", "caricature", "reject"].includes(value)) return undefined;
            return value;
        case "leadCaptureMode":
            if (!["disabled", "before", "after"].includes(value)) return undefined;
            return value;
        case "disabledStyles":
            if (!Array.isArray(value)) return undefined;
            return value.map((s) => String(s).trim()).filter(Boolean);
        case "stylePromptOverrides":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const promptOverrides = {};
            for (const [k, v] of Object.entries(value)) {
                if (typeof v === "string" && v.trim()) {
                    promptOverrides[k] = v.trim();
                }
            }
            return promptOverrides;
        case "customStyles":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const cleaned = {};
            for (const [k, v] of Object.entries(value)) {
                if (v && typeof v.name === "string" && typeof v.prompt === "string" && v.prompt.trim()) {
                    cleaned[k.trim().toLowerCase().replace(/\s+/g, "-")] = {
                        name: v.name.trim(),
                        prompt: v.prompt.trim(),
                        files: Array.isArray(v.files) ? v.files.map((f) => String(f).trim()).filter(Boolean) : [],
                        analysis: typeof v.analysis === "string" ? v.analysis : "",
                    };
                }
            }
            return cleaned;
        case "customBrands":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const cleanedBrands = {};
            for (const [k, v] of Object.entries(value)) {
                if (v && typeof v.name === "string" && v.name.trim()) {
                    cleanedBrands[k.trim().toLowerCase().replace(/\s+/g, "-")] = {
                        name: v.name.trim(),
                        files: Array.isArray(v.files) ? v.files.map((f) => String(f).trim()).filter(Boolean) : [],
                        brandPrompt: typeof v.brandPrompt === "string" ? v.brandPrompt.trim() : "",
                        analysis: typeof v.analysis === "string" ? v.analysis : "",
                    };
                }
            }
            return cleanedBrands;
        case "enableBrandMenu":
            return !!value;
        case "disabledBrands":
            if (!Array.isArray(value)) return undefined;
            return value.map((s) => String(s).trim()).filter(Boolean);
        case "brandPromptOverrides":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const brandOverrides = {};
            for (const [k, v] of Object.entries(value)) {
                if (typeof v === "string" && v.trim()) {
                    brandOverrides[k] = v.trim();
                }
            }
            return brandOverrides;
        case "printSize":
            if (typeof value !== "string" || !PRINT_SIZES[value]) return undefined;
            return value;
        case "printQuality":
            if (typeof value !== "string" || !PRINT_QUALITIES[value]) return undefined;
            return value;
        case "customPrintFlags":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "brandReferenceFiles":
            if (!Array.isArray(value)) return undefined;
            return value.map((f) => String(f).trim()).filter(Boolean);
        case "messages":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const msgs = {};
            for (const [k, v] of Object.entries(value)) {
                if (typeof v === "string" && k in DEFAULTS.messages) {
                    msgs[k] = v;
                }
            }
            return msgs;
        case "leadCaptureFields":
            if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
            const fields = {};
            for (const [k, v] of Object.entries(value)) {
                if (v && typeof v === "object" && k in DEFAULTS.leadCaptureFields) {
                    fields[k] = {
                        enabled: v.enabled !== false,
                        prompt: typeof v.prompt === "string" ? v.prompt : DEFAULTS.leadCaptureFields[k].prompt,
                        errorMsg: typeof v.errorMsg === "string" ? v.errorMsg : DEFAULTS.leadCaptureFields[k].errorMsg,
                    };
                }
            }
            return fields;
        case "immediateDigitalDelivery":
            return !!value;
        case "disabledPrinters":
            if (!Array.isArray(value)) return undefined;
            return value.map((p) => String(p).trim()).filter(Boolean);
        case "activePrinters":
            if (!Array.isArray(value)) return undefined;
            return value.map((p) => String(p).trim()).filter(Boolean);
        case "printRelayKey":
        case "twilioAccountSid":
        case "twilioAuthToken":
        case "twilioPhoneNumber":
        case "openaiApiKey":
        case "modelOrchestrator":
        case "modelVisionLight":
        case "modelImageGen":
        case "modelSmartReply":
        case "modelRefAnalysis":
            if (typeof value !== "string") return undefined;
            return value.trim();
        default:
            return value;
    }
}

function reset() {
    const oldEventName = get("eventName");
    overrides = {};
    save();
    console.log("⚙️  Settings reset to .env defaults");
    const newEventName = get("eventName");
    if (newEventName !== oldEventName && _onEventNameChangeCallback) {
        _onEventNameChangeCallback();
    }
    return getAll();
}

// ── File & printer discovery ────────────────────────────────────────────────

function listTemplates() {
    try {
        return fs.readdirSync(TEMPLATES_DIR)
            .filter((f) => /\.(png|jpg|jpeg|gif|svg)$/i.test(f))
            .sort();
    } catch {
        return [];
    }
}

function listVideos() {
    try {
        return fs.readdirSync(ASSETS_DIR)
            .filter((f) => /\.(mp4|webm|mov)$/i.test(f))
            .sort();
    } catch {
        return [];
    }
}

function listBrandReferences() {
    try {
        return fs.readdirSync(BRAND_REFS_DIR)
            .filter((f) => /\.(png|jpg|jpeg|gif)$/i.test(f))
            .sort();
    } catch {
        return [];
    }
}

function listStyleReferences() {
    try {
        return fs.readdirSync(STYLE_REFS_DIR)
            .filter((f) => /\.(png|jpg|jpeg|gif)$/i.test(f))
            .sort();
    } catch {
        return [];
    }
}

function listBackgroundReferences() {
    try {
        return fs.readdirSync(BG_REFS_DIR)
            .filter((f) => /\.(png|jpg|jpeg|gif)$/i.test(f))
            .sort();
    } catch {
        return [];
    }
}

function listPrinters() {
    return new Promise((resolve) => {
        exec("lpstat -p", (err, stdout) => {
            if (err) { resolve([]); return; }
            const printers = stdout.split("\n")
                .filter((l) => l.startsWith("printer "))
                .map((l) => l.split(" ")[1])
                .filter(Boolean);
            resolve(printers);
        });
    });
}

// ── Per-user settings (legacy, now pass-through to global) ──────────────────
// All saves now go directly to the global pipeline. The per-user layer was
// removed because it caused settings shown on the dashboard to diverge from
// what the SMS/print pipeline actually used.

function getAllForUser(_email) { return getAll(); }
function getForUser(_email, key) { return get(key); }
function getMsgForUser(_email, key, vars) { return getMsg(key, vars); }

function updateForUser(_email, changes) {
    update(changes);
    return getAll();
}

function saveUserToGlobal(_email) {
    // No-op: all saves already go to global.
    saveEventSettings(get("eventName"));
    return getAll();
}

function resetUser(_email) {
    return getAll();
}

// ── Exports ─────────────────────────────────────────────────────────────────

function listEvents() {
    const names = new Set();
    try {
        const dlRoot = path.join(ROOT_DIR, "downloads");
        for (const d of fs.readdirSync(dlRoot, { withFileTypes: true })) {
            if (d.isDirectory()) names.add(d.name);
        }
    } catch { /* ignore */ }
    // Also include events that have saved profiles but no downloads yet
    for (const name of listEventProfiles()) {
        names.add(name);
    }
    return [...names].sort();
}

function incrementEventCounter(key, eventName) {
    const ev = eventName || get("eventName");
    const isActive = ev === get("eventName");
    if (isActive) {
        const current = Number(get(key)) || 0;
        const next = current + 1;
        update({ [key]: next });
        return next;
    }
    // Non-active event: load profile, increment, write back directly
    const profile = loadEventSettings(ev);
    const current = Number(profile[key]) || 0;
    const next = current + 1;
    profile[key] = next;
    const dir = path.join(EVENTS_DIR, ev);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(eventSettingsPath(ev), JSON.stringify(profile, null, 2));
    return next;
}

module.exports = {
    DEFAULTS,
    load,
    get,
    getAll,
    getMsg,
    getLeadFields,
    update,
    reset,
    getDownloadDir,
    getTemplatePath,
    getPrintDimensions,
    getActiveStyles,
    getActiveStyleList,
    onEventNameChange,
    listTemplates,
    listVideos,
    listBrandReferences,
    listStyleReferences,
    listBackgroundReferences,
    listPrinters,
    listEvents,
    listEventProfiles,
    saveEventSettings,
    loadEventSettings,
    getForEvent,
    getMsgForEvent,
    getAllForUser,
    getForUser,
    getMsgForUser,
    updateForUser,
    saveUserToGlobal,
    resetUser,
    incrementEventCounter,
    USER_EXCLUDED_KEYS,
    PRINT_SIZES,
    PRINT_QUALITIES,
    BRAND_REFS_DIR,
    STYLE_REFS_DIR,
    BG_REFS_DIR,
    EVENTS_DIR,
    ROOT_DIR,
};
