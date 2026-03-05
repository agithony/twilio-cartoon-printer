const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const TEMPLATES_DIR = path.join(ROOT_DIR, "templates");
const ASSETS_DIR = path.join(ROOT_DIR, "assets");

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
    maxConcurrentGeneration: parseInt(process.env.MAX_CONCURRENT_GENERATION || "3", 10),
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
    defaultStyle: process.env.DEFAULT_STYLE || "cartoon",
    leadCaptureMode: "disabled",
    disabledStyles: [],
    stylePromptOverrides: {},
    customStyles: {},
    promoMessage: process.env.PROMO_MESSAGE || "",
    printSize: process.env.PRINT_SIZE || "5x7",
    printQuality: process.env.PRINT_QUALITY || "high",
    customPrintFlags: process.env.CUSTOM_PRINT_FLAGS || "",
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
    return gas(get("disabledStyles"), get("customStyles"), get("stylePromptOverrides"));
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
        const newDir = getDownloadDir();
        if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
        console.log(`⚙️  Event name changed: "${oldEventName}" → "${newEventName}"`);
        if (_onEventNameChangeCallback) _onEventNameChangeCallback();
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
            return !!value;
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
    try {
        const dlRoot = path.join(ROOT_DIR, "downloads");
        return fs.readdirSync(dlRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
    } catch {
        return [];
    }
}

module.exports = {
    load,
    get,
    getAll,
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
    listPrinters,
    listEvents,
    PRINT_SIZES,
    PRINT_QUALITIES,
};
