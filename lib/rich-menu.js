const contentTemplates = require("./content-templates");
const messaging = require("./messaging");

async function sendMenu(toPhone, adapter, menuKind, options, copy) {
    if (!adapter || adapter.name !== "whatsapp") return { rich: false };
    const contentSid = await contentTemplates.getOrCreateListPicker(menuKind, options, copy.body, copy.button, copy.locale || "en");
    if (!contentSid) return { rich: false };
    const result = await messaging.send(toPhone, menuKind, {}, { adapter, contentSid });
    return result && result.error ? { rich: false, error: result.error } : { rich: true, sid: result && result.sid };
}

module.exports = { sendMenu };
