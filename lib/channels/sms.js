const settings = require("../settings");

module.exports = {
    name: "sms",
    sessionAware: false,
    normalizeFrom(raw) { return raw; },
    formatTo(phone) { return phone; },
    isConfigured() {
        return !!(settings.get("twilioPhoneNumber") || settings.get("twilioMessagingServiceSid"));
    },
    senderId() {
        const mssid = settings.get("twilioMessagingServiceSid");
        if (mssid) return { messagingServiceSid: mssid };
        return { from: settings.get("twilioPhoneNumber") };
    },
};
