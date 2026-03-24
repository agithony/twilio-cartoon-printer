const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const TEMPLATES_DIR = path.join(ROOT_DIR, "templates");
const ASSETS_DIR = path.join(ROOT_DIR, "assets");
const BRAND_REFS_DIR = path.join(ROOT_DIR, "brand-references");

// Keys that are global (shared across all events, not saved per-event)
const GLOBAL_KEYS = new Set([
    "twilioAccountSid", "twilioAuthToken", "twilioPhoneNumber",
    "openaiApiKey", "modelOrchestrator", "modelVisionLight", "modelImageGen", "modelSmartReply",
    "adminPhones", "activePrinters", "maxConcurrentGeneration", "queuePaused",
]);

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
    templateFile: process.env.TEMPLATE_FILE || "",
    videoFile: process.env.VIDEO_FILE || "get-started.mp4",
    printerName: process.env.PRINTER_NAME || "",
    termsUrl: process.env.TERMS_URL || "",
    enablePrinting: process.env.ENABLE_PRINTING !== "false",
    brandPrompt: process.env.BRAND_PROMPT || "",
    brandReferenceFiles: [],
    enableFrameBorder: true,
    frameBorderColor: "#000000",
    defaultStyle: process.env.DEFAULT_STYLE || "cartoon",
    leadCaptureMode: "disabled",
    disabledStyles: [],
    stylePromptOverrides: {},
    customStyles: {},
    enablePromoMessage: false,
    promoMessage: process.env.PROMO_MESSAGE || "",
    enableShareLinks: false,
    twitterHandle: process.env.TWITTER_HANDLE || "@twilio",
    linkedInShareText: process.env.LINKEDIN_SHARE_TEXT || "Check out my AI portrait from {eventName}, powered by Twilio!",
    enableNps: false,
    npsDelay: 30,
    queuePaused: false,
    breakMessage: "",
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
        // Style menu
        styleMenuIntro: "Great selfie! Pick your art style:",
        styleMenuFooter: "Reply with a number or style name.",
        styleMenuRetry: "That one isn't on the menu! Reply with a number or style name:",
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
    },
    // ── Configurable Lead Capture Fields ──────────────────────────────────────
    leadCaptureFields: {
        firstName: { enabled: true, prompt: "What's your first name?", errorMsg: "Please enter your first name." },
        lastName: { enabled: true, prompt: "And your last name?", errorMsg: "Please enter your last name." },
        country: { enabled: true, prompt: "What country are you from? (2-letter code, e.g. US, UK, CA, DE, FR, JP)", errorMsg: "That doesn't look like a country code. Please enter a 2-letter code like US, UK, CA, DE, FR, AU, JP, BR, IN, etc." },
        email: { enabled: true, prompt: "What's your business email? (Must be a company email, not personal like Gmail)", errorMsg: "We need a work email address -- personal emails like @gmail.com, @yahoo.com, @hotmail.com, etc. aren't accepted. What's your company email?" },
        company: { enabled: true, prompt: "What company do you work for?", errorMsg: "Please enter your company name." },
        jobTitle: { enabled: true, prompt: "Last one -- what's your job title?", errorMsg: "Please enter your job title." },
    },
    // ── Configurable AI Prompts ───────────────────────────────────────────────
    promptPreserve: "Preserve accurately for every subject: skin tone, eye color, hair color, hairstyle, facial hair, glasses, jewelry, clothing, and any visible accessories or distinguishing features.",
    promptComposition: "Composition: Portrait framing from the chest up, with all subjects positioned naturally as they appear in the original photo.",
    promptPreserveBrand: "Preserve accurately: skin tone, eye color, hair color and style, facial hair, glasses, facial structure.",
    promptBrandInstruction: "Do NOT change, alter, or reinterpret any logos, text, crests, or designs from the reference images. Reproduce them EXACTLY pixel-for-pixel.",
    promptBackground: "Background: Recreate the background from the original photo in the same art style. Keep it natural and consistent with the scene.",
    enableBackgroundMenu: false,
    backgroundChoices: [
        { key: "gradient", name: "Soft Gradient", prompt: "Background: Clean soft gradient, light and uncluttered, suitable for printing." },
        { key: "solid-white", name: "Solid White", prompt: "Background: Pure solid white background, clean and minimal." },
        { key: "solid-black", name: "Solid Black", prompt: "Background: Pure solid black background, dramatic and clean." },
        { key: "original", name: "Original Scene", prompt: "Background: Recreate the background environment from the original photo in the same art style." },
    ],
    promptFaceDetection: "Does this image clearly show a person's face? A face must be visible -- photos of only hands, feet, backs, or other body parts without a face do NOT count. Reply with only YES or NO.",
    promptSceneAnalysis: "Analyze this photo. Reply in EXACTLY this format:\nSubjects: [number of people]\nPets: [none OR animal type]\nPositions: [centered, left-right pair, or group]",
    promptSmartReply: "You are an AI-powered photobooth assistant at an event called \"{eventName}\". Powered by Twilio and OpenAI.\nYour job is to respond to the user's message naturally and helpfully, then direct them to send a selfie so you can transform it into art.\nAvailable art styles: {styleChoices}.\n{remainingLine}\nKeep your response concise (2-4 sentences max). Always end by encouraging them to send a selfie. Be friendly and conversational. Do not use emojis.",
    promptUserDirective: "Transform this photo into a stylized portrait.",
    printSize: process.env.PRINT_SIZE || "5x7",
    printQuality: process.env.PRINT_QUALITY || "high",
    customPrintFlags: process.env.CUSTOM_PRINT_FLAGS || "",
    activePrinters: [],
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
};

// ── State ───────────────────────────────────────────────────────────────────

let overrides = {};

function save() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(overrides, null, 2));
}

function load() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            overrides = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
    } catch {
        overrides = {};
    }
    console.log(`⚙️  Settings loaded${Object.keys(overrides).length > 0 ? ` (${Object.keys(overrides).length} overrides)` : " (using .env defaults)"}`);

    // Bootstrap: save current overrides to the active event's profile if none exists yet
    const currentEvent = get("eventName");
    if (currentEvent && Object.keys(overrides).length > 0) {
        const evtPath = eventSettingsPath(currentEvent);
        if (!fs.existsSync(evtPath)) {
            saveEventSettings(currentEvent);
            console.log(`⚙️  Bootstrapped event profile for "${currentEvent}"`);
        }
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
    fs.writeFileSync(eventSettingsPath(eventName), JSON.stringify(perEvent, null, 2));
}

function loadEventSettings(eventName) {
    const evtPath = eventSettingsPath(eventName);
    try {
        if (fs.existsSync(evtPath)) {
            return JSON.parse(fs.readFileSync(evtPath, "utf-8"));
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
    return { ...DEFAULTS, ...overrides };
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
    return vars ? interpolate(template, vars) : template;
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

function getDownloadDir() {
    return path.join(ROOT_DIR, "downloads", get("eventName"));
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

    for (const [key, value] of Object.entries(changes)) {
        if (!(key in DEFAULTS)) continue; // ignore unknown keys

        // Validate
        const validated = validate(key, value);
        if (validated === undefined) continue;

        // Store override (or remove if it matches the default)
        if (JSON.stringify(validated) === JSON.stringify(DEFAULTS[key])) {
            delete overrides[key];
        } else {
            overrides[key] = validated;
        }
    }

    save();

    // Side effects
    const newEventName = get("eventName");
    if (newEventName !== oldEventName) {
        // Save per-event settings for the old event
        saveEventSettings(oldEventName);
        console.log(`⚙️  Saved event profile for "${oldEventName}"`);

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
        case "templateFile":
            if (typeof value !== "string") return undefined;
            return value.trim();
        case "videoFile":
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
        case "enableNps":
        case "enableFrameBorder":
        case "queuePaused":
            return !!value;
        case "frameBorderColor":
            if (typeof value !== "string") return undefined;
            return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : undefined;
        case "npsDelay":
            return Math.max(5, Math.floor(Number(value) || 30));
        case "twitterHandle":
        case "linkedInShareText":
            if (typeof value !== "string") return undefined;
            return value.trim();
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
        case "enableBackgroundMenu":
            return !!value;
        case "backgroundChoices":
            if (!Array.isArray(value)) return undefined;
            return value
                .filter(c => c && typeof c.key === "string" && typeof c.name === "string" && typeof c.prompt === "string" && c.prompt.trim())
                .map(c => ({ key: c.key.trim().toLowerCase().replace(/\s+/g, "-"), name: c.name.trim(), prompt: c.prompt.trim() }));
        case "defaultStyle":
            if (typeof value !== "string" || !value.trim()) return undefined;
            return value.trim();
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
                    };
                }
            }
            return cleaned;
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
        case "activePrinters":
            if (!Array.isArray(value)) return undefined;
            return value.map((p) => String(p).trim()).filter(Boolean);
        case "twilioAccountSid":
        case "twilioAuthToken":
        case "twilioPhoneNumber":
        case "openaiApiKey":
        case "modelOrchestrator":
        case "modelVisionLight":
        case "modelImageGen":
        case "modelSmartReply":
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
    listPrinters,
    listEvents,
    listEventProfiles,
    saveEventSettings,
    loadEventSettings,
    PRINT_SIZES,
    PRINT_QUALITIES,
    BRAND_REFS_DIR,
    EVENTS_DIR,
};
