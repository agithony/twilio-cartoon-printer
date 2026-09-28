const settings = require("./settings");
const channels = require("./channels");

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

function whatsappDeliveryIsImmediate(eventName, settingsModule) {
    return !settingsModule.getForEvent("enablePrinting", eventName)
        || settingsModule.getForEvent("immediateDigitalDelivery", eventName) !== false;
}

function getKioskDeliveryChannels(eventName, locale, {
    settingsModule = settings,
    adapters = channels.ADAPTERS,
} = {}) {
    const available = [];
    if (settingsModule.getForEvent("boothShowSms", eventName) !== false && adapters.sms.isConfigured()) {
        available.push("sms");
    }
    if (
        settingsModule.getForEvent("boothShowWhatsapp", eventName) === true
        && adapters.whatsapp.isConfigured()
        && settingsModule.getContentSid("delivery", locale)
        && whatsappDeliveryIsImmediate(eventName, settingsModule)
    ) {
        available.push("whatsapp");
    }
    return available;
}

function assertChannelReady(channel, eventName, locale, { settingsModule, adapters }) {
    const adapter = adapters[channel];
    if (!adapter || !adapter.isConfigured()) {
        throw httpError(409, `${channel === "whatsapp" ? "WhatsApp" : "SMS"} delivery is not configured`);
    }
    if (channel === "whatsapp" && !settingsModule.getContentSid("delivery", locale)) {
        throw httpError(409, `WhatsApp delivery template is not configured for locale ${locale}`);
    }
    if (channel === "whatsapp" && !whatsappDeliveryIsImmediate(eventName, settingsModule)) {
        throw httpError(409, "WhatsApp kiosk delivery requires Digital Only or Send digital copy immediately");
    }
}

function resolveKioskDeliveryChannel({
    requestedChannel,
    hasPhone,
    kioskSubmission,
    eventName,
    locale,
}, {
    settingsModule = settings,
    adapters = channels.ADAPTERS,
} = {}) {
    if (!hasPhone) return null;

    const requested = String(requestedChannel || "").trim().toLowerCase();
    if (requested && !Object.prototype.hasOwnProperty.call(adapters, requested)) {
        throw httpError(400, `Unknown delivery channel "${requested}"`);
    }

    if (kioskSubmission) {
        const available = getKioskDeliveryChannels(eventName, locale, { settingsModule, adapters });
        if (available.length === 0) throw httpError(409, "Phone delivery is not configured for this kiosk");
        if (!requested && available.length > 1) {
            throw httpError(400, "Choose SMS or WhatsApp delivery");
        }
        const selected = requested || available[0];
        assertChannelReady(selected, eventName, locale, { settingsModule, adapters });
        if (!available.includes(selected)) {
            throw httpError(409, `${selected === "whatsapp" ? "WhatsApp" : "SMS"} delivery is not available for this kiosk`);
        }
        return selected;
    }

    const selected = requested || "sms";
    assertChannelReady(selected, eventName, locale, { settingsModule, adapters });
    return selected;
}

module.exports = { getKioskDeliveryChannels, resolveKioskDeliveryChannel };
