const util = require("util");

const MAX_ENTRIES = 500;
const buffer = [];
const subscribers = [];
let nextId = 1;
let initialized = false;

// Emoji → category mapping
const EMOJI_CAT = {
    "\u{1F4E5}": "queue",     // 📥
    "\u{1F4E9}": "queue",     // 📩
    "\u2699":    "queue",      // ⚙️
    "\u2705":    "queue",      // ✅
    "\u{1F4A0}": "queue",     // 💀
    "\u{1F504}": "queue",     // 🔄
    "\u267B":    "queue",      // ♻️
    "\u{1F5A8}": "print",     // 🖨️
    "\u{1F3A8}": "pipeline",  // 🎨
    "\u{1F4DD}": "pipeline",  // 📝
    "\u{1F4BE}": "pipeline",  // 💾
    "\u{1F4D0}": "pipeline",  // 📐
    "\u2B07":    "pipeline",   // ⬇️
    "\u{1F464}": "pipeline",  // 👤
    "\u{1F465}": "pipeline",  // 👥
    "\u{1F6E1}": "safety",    // 🛡️
    "\u{1F6AB}": "safety",    // 🚫
    "\u{1F4F1}": "sms",       // 📱
    "\u274C":    "error",      // ❌
    "\u{1F680}": "system",    // 🚀
    "\u{1F310}": "system",    // 🌐
    "\u{1F4CA}": "system",    // 📊
    "\u23F1":    "system",     // ⏱️
    "\u{1F3E0}": "system",    // 🏠
    "\u231B":    "system",     // ⌛
    "\u{1F4C1}": "system",    // 📁
};

function detectCategory(msg) {
    if (!msg) return "app";
    // Check first few characters for emoji
    for (const [emoji, cat] of Object.entries(EMOJI_CAT)) {
        if (msg.startsWith(emoji)) return cat;
    }
    return "app";
}

function pushEntry(level, args) {
    const message = util.format(...args);
    const entry = { id: nextId++, ts: Date.now(), level, category: detectCategory(message), message };
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer.shift();
    for (const cb of subscribers) {
        try { cb(entry); } catch (_) {}
    }
}

function init() {
    if (initialized) return;
    initialized = true;

    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = function (...args) {
        origLog.apply(console, args);
        pushEntry("info", args);
    };
    console.warn = function (...args) {
        origWarn.apply(console, args);
        pushEntry("warn", args);
    };
    console.error = function (...args) {
        origError.apply(console, args);
        pushEntry("error", args);
    };
}

function getEntries() { return buffer.slice(); }
function subscribe(cb) { subscribers.push(cb); }
function unsubscribe(cb) {
    const i = subscribers.indexOf(cb);
    if (i !== -1) subscribers.splice(i, 1);
}

module.exports = { init, getEntries, subscribe, unsubscribe };
