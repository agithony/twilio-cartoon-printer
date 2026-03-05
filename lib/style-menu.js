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

function buildMenu(activeStyles, activeStyleList) {
    const lines = activeStyleList.map((key, i) => `${i + 1}. ${activeStyles[key].name}`);
    return "Great selfie! Pick your art style:\n\n" + lines.join("\n") + "\n\nReply with a number or style name.";
}

function normalize(str) {
    return str.toLowerCase().replace(/[\s\-]+/g, "");
}

function matchReply(body, activeStyles, activeStyleList) {
    const text = (body || "").trim();
    if (!text) return null;

    // Try number match first
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= activeStyleList.length) {
        return activeStyleList[num - 1];
    }

    // Try matching against style keys (normalized)
    const norm = normalize(text);
    for (const key of activeStyleList) {
        if (norm === normalize(key)) return key;
    }
    for (const key of activeStyleList) {
        if (norm.includes(normalize(key))) return key;
    }

    // Try matching against display names
    for (const key of activeStyleList) {
        if (norm === normalize(activeStyles[key].name)) return key;
    }
    for (const key of activeStyleList) {
        if (norm.includes(normalize(activeStyles[key].name))) return key;
    }

    return null;
}

function buildRetryMenu(activeStyles, activeStyleList) {
    const lines = activeStyleList.map((key, i) => `${i + 1}. ${activeStyles[key].name}`);
    return "That one isn't on the menu! Reply with a number or style name:\n\n" + lines.join("\n");
}

// Cleanup stale entries (30 min timeout)
setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of pending) {
        if (now - data.timestamp > 30 * 60 * 1000) {
            console.log(`🎨 Removing stale style menu for ${phone}`);
            pending.delete(phone);
        }
    }
}, 5 * 60 * 1000);

module.exports = { hasPending, setPending, getPending, clearPending, buildMenu, buildRetryMenu, matchReply };
