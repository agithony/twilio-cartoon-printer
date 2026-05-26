const sms = require("./sms");
const whatsapp = require("./whatsapp");

const ADAPTERS = { sms, whatsapp };

function getConfiguredAdapters() {
    return Object.values(ADAPTERS).filter(a => a.isConfigured());
}

function detectChannel(reqBody) {
    return (reqBody.From || "").startsWith("whatsapp:") ? whatsapp : sms;
}

module.exports = { getConfiguredAdapters, detectChannel, ADAPTERS };
