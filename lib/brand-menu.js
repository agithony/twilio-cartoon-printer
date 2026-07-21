const i18n = require("./i18n");
const { maskPhone } = require("./helpers");

// Pending brand selections: Map<phone, { imageUrl, messageSid, style, appPhone, baseUrl, body, timestamp }>
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

function buildMenu(activeBrands, brandList, opts) {
    const includeNone = opts && opts.includeNone;
    const lines = brandList.map((key, i) => `${i + 1}. ${activeBrands[key].name}`);
    if (includeNone) {
        lines.push(`${brandList.length + 1}. ${opts && opts.locale === "pt_BR" ? "Nenhum" : "None"}`);
    }
    return i18n.t(opts && opts.locale, "brandMenuIntro", {}, opts && opts.eventName) + "\n\n" + lines.join("\n") + "\n\n" + i18n.t(opts && opts.locale, "brandMenuFooter", {}, opts && opts.eventName);
}

function normalize(str) {
    return str.toLowerCase().replace(/[\s\-]+/g, "");
}

function matchReply(body, activeBrands, brandList, opts) {
    const text = (body || "").trim();
    if (!text) return null;
    const includeNone = opts && opts.includeNone;

    // Try number match first
    const num = parseInt(text, 10);
    if (!isNaN(num)) {
        if (num >= 1 && num <= brandList.length) return brandList[num - 1];
        if (includeNone && num === brandList.length + 1) return "__none__";
    }

    if (includeNone && ["none", "nenhum", "nenhuma"].includes(normalize(text))) return "__none__";

    const norm = normalize(text);
    for (const key of brandList) {
        if (norm === normalize(key)) return key;
    }
    for (const key of brandList) {
        if (norm.includes(normalize(key))) return key;
    }
    for (const key of brandList) {
        if (norm === normalize(activeBrands[key].name)) return key;
    }
    for (const key of brandList) {
        if (norm.includes(normalize(activeBrands[key].name))) return key;
    }

    return null;
}

function buildRetryMenu(activeBrands, brandList, opts) {
    const includeNone = opts && opts.includeNone;
    const lines = brandList.map((key, i) => `${i + 1}. ${activeBrands[key].name}`);
    if (includeNone) {
        lines.push(`${brandList.length + 1}. ${opts && opts.locale === "pt_BR" ? "Nenhum" : "None"}`);
    }
    return i18n.t(opts && opts.locale, "brandMenuRetry", {}, opts && opts.eventName) + "\n\n" + lines.join("\n");
}

// Cleanup stale entries (30 min timeout)
setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of pending) {
        if (now - data.timestamp > 30 * 60 * 1000) {
            console.log(`🏷️ Removing stale brand menu for ${maskPhone(phone)}`);
            pending.delete(phone);
        }
    }
}, 5 * 60 * 1000).unref();

module.exports = { hasPending, setPending, getPending, clearPending, buildMenu, buildRetryMenu, matchReply };
