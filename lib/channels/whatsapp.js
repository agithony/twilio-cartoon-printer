const settings = require("../settings");

const PREFIX = "whatsapp:";

module.exports = {
    name: "whatsapp",
    sessionAware: true,
    normalizeFrom(raw) {
        return raw && raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
    },
    formatTo(phone) {
        return phone.startsWith(PREFIX) ? phone : `${PREFIX}${phone}`;
    },
    isConfigured() {
        return !!(settings.get("twilioWhatsappNumber") || settings.get("twilioWhatsappMessagingServiceSid"));
    },
    senderId() {
        const mssid = settings.get("twilioWhatsappMessagingServiceSid");
        if (mssid) return { messagingServiceSid: mssid };
        const num = settings.get("twilioWhatsappNumber");
        if (!num) throw new Error("WhatsApp channel active but twilioWhatsappNumber not configured");
        return { from: `${PREFIX}${num}` };
    },
};
