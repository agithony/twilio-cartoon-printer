const i18n = require("./i18n");
const optionI18n = require("./option-i18n");
const { maskPhone } = require("./helpers");

// Pending style selections: Map<phone, { imageUrl, messageSid, body, appPhone, baseUrl, timestamp }>
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

function buildMenu(activeStyles, activeStyleList, opts = {}) {
    const lines = activeStyleList.map((key, i) => `${i + 1}. ${optionI18n.localizeOption("style", key, activeStyles[key], opts.locale).name}`);
    return i18n.t(opts.locale, "styleMenuIntro", {}, opts.eventName) + "\n\n" + lines.join("\n") + "\n\n" + i18n.t(opts.locale, "styleMenuFooter", {}, opts.eventName);
}

function normalize(str) {
    return str.toLowerCase().replace(/[\s\-]+/g, "");
}

function matchReply(body, activeStyles, activeStyleList) {
    const text = (body || "").trim();
    if (!text) return null;

    // Try number match first
    const numeric = text.match(/^(\d+)(?:\s|[.)-]|$)/);
    if (numeric) {
        const num = Number(numeric[1]);
        if (num >= 1 && num <= activeStyleList.length) return activeStyleList[num - 1];
    }

    // Try matching against style keys (normalized)
    const norm = optionI18n.fold(text);
    for (const key of activeStyleList) {
        if (optionI18n.optionAliases("style", key, activeStyles[key]).includes(norm)) return key;
    }
    for (const key of activeStyleList) {
        if (optionI18n.optionAliases("style", key, activeStyles[key]).some((alias) => alias.length >= 4 && norm.includes(alias))) return key;
    }

    return null;
}

function buildRetryMenu(activeStyles, activeStyleList, opts = {}) {
    const lines = activeStyleList.map((key, i) => `${i + 1}. ${optionI18n.localizeOption("style", key, activeStyles[key], opts.locale).name}`);
    return i18n.t(opts.locale, "styleMenuRetry", {}, opts.eventName) + "\n\n" + lines.join("\n");
}

// Cleanup stale entries (30 min timeout)
setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of pending) {
        if (now - data.timestamp > 30 * 60 * 1000) {
            console.log(`🎨 Removing stale style menu for ${maskPhone(phone)}`);
            pending.delete(phone);
        }
    }
}, 5 * 60 * 1000);

module.exports = { hasPending, setPending, getPending, clearPending, buildMenu, buildRetryMenu, matchReply };
