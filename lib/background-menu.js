const i18n = require("./i18n");
const optionI18n = require("./option-i18n");
const { maskPhone } = require("./helpers");

// Pending background selections: Map<phone, { imageUrl, messageSid, style, appPhone, baseUrl, timestamp }>
const pending = new Map();

function hasPending(phone) {
    return pending.has(phone);
}

function setPending(phone, data) {
    pending.set(phone, { ...data, timestamp: Date.now() });
}

function getPending(phone) {
    return pending.get(phone);
}

function clearPending(phone) {
    pending.delete(phone);
}

function buildMenu(choices, opts = {}) {
    const lines = choices.map((c, i) => `${i + 1}. ${optionI18n.localizeOption("background", c.key, c, opts.locale).name}`);
    return i18n.t(opts.locale, "backgroundMenuIntro", {}, opts.eventName) + "\n\n" + lines.join("\n") + "\n\n" + i18n.t(opts.locale, "backgroundMenuFooter", {}, opts.eventName);
}

function normalize(str) {
    return str.toLowerCase().replace(/[\s\-]+/g, "");
}

function matchReply(body, choices) {
    const text = (body || "").trim();
    if (!text) return null;

    // Try number match first
    const numeric = text.match(/^(\d+)(?:\s|[.)-]|$)/);
    if (numeric) {
        const num = Number(numeric[1]);
        if (num >= 1 && num <= choices.length) return choices[num - 1].key;
    }

    // Try matching against keys (normalized)
    const norm = optionI18n.fold(text);
    for (const c of choices) {
        if (optionI18n.optionAliases("background", c.key, c).includes(norm)) return c.key;
    }
    for (const c of choices) {
        if (optionI18n.optionAliases("background", c.key, c).some((alias) => alias.length >= 4 && norm.includes(alias))) return c.key;
    }

    return null;
}

function buildRetryMenu(choices, opts = {}) {
    const lines = choices.map((c, i) => `${i + 1}. ${optionI18n.localizeOption("background", c.key, c, opts.locale).name}`);
    return i18n.t(opts.locale, "backgroundMenuRetry", {}, opts.eventName) + "\n\n" + lines.join("\n");
}

// Cleanup stale entries (30 min timeout)
setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of pending) {
        if (now - data.timestamp > 30 * 60 * 1000) {
            console.log(`🖼️ Removing stale background menu for ${maskPhone(phone)}`);
            pending.delete(phone);
        }
    }
}, 5 * 60 * 1000).unref();

module.exports = { hasPending, setPending, getPending, clearPending, buildMenu, buildRetryMenu, matchReply };
