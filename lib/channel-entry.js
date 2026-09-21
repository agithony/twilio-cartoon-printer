const i18n = require("./i18n");
const ui = require("./ui-i18n");

function normalizeSmsPhone(value) {
    const raw = String(value || "").trim().replace(/^sms:/i, "");
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 3 || digits.length > 15) return "";
    return raw.startsWith("+") ? `+${digits}` : digits;
}

function normalizeWhatsappPhone(value) {
    const digits = String(value || "").replace(/^whatsapp:/i, "").replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15 ? digits : "";
}

function resolveEventLocale(getSetting, requestedLocale) {
    const mode = getSetting("languageMode");
    if (mode === "ask") return i18n.normalizeLocale(requestedLocale) || i18n.DEFAULT_LOCALE;
    return i18n.resolveAttendeeLocale(mode) || i18n.DEFAULT_LOCALE;
}

function buildChannelOptions({ locale = i18n.DEFAULT_LOCALE, getSetting, carryLocale = false }) {
    const resolvedLocale = i18n.normalizeLocale(locale) || i18n.DEFAULT_LOCALE;
    const languageMode = getSetting("languageMode");
    const languageSelection = resolvedLocale === "pt_BR" ? "Português" : "English";
    const smsPhoneRaw = getSetting("boothSmsPhone") || getSetting("twilioPhoneNumber") || "";
    const smsPhone = normalizeSmsPhone(smsPhoneRaw);
    const configuredSmsText = getSetting("boothSmsInstructionText") || "Hit send to start";
    const localizedSmsText = resolvedLocale === "pt_BR" && configuredSmsText === "Hit send to start"
        ? ui.t(resolvedLocale, "hitSend") : configuredSmsText;
    const smsText = languageMode === "ask" && carryLocale ? languageSelection : localizedSmsText;

    const whatsappPhoneRaw = getSetting("boothWhatsappPhone") || getSetting("twilioWhatsappNumber") || "";
    const whatsappPhone = normalizeWhatsappPhone(whatsappPhoneRaw);
    const configuredWhatsappText = getSetting("boothWhatsappPrefillText") || "Hi";
    const localizedWhatsappText = resolvedLocale === "pt_BR" && configuredWhatsappText === "Hi"
        ? "Olá" : configuredWhatsappText;
    const whatsappText = languageMode === "ask" && carryLocale ? languageSelection : localizedWhatsappText;
    const configuredWhatsappInstruction = getSetting("boothWhatsappInstructionText") || "Open WhatsApp to start";
    const whatsappInstruction = resolvedLocale === "pt_BR" && configuredWhatsappInstruction === "Open WhatsApp to start"
        ? ui.t(resolvedLocale, "openWhatsapp")
        : configuredWhatsappInstruction;

    return {
        sms: {
            id: "sms",
            enabled: getSetting("boothShowSms") !== false,
            phone: smsPhoneRaw,
            href: smsPhone ? `sms:${smsPhone}?body=${encodeURIComponent(smsText)}` : "",
            iosHref: smsPhone ? `sms:${smsPhone}&body=${encodeURIComponent(smsText)}` : "",
            title: ui.t(resolvedLocale, "textWithSms"),
            description: ui.t(resolvedLocale, "smsChooserHint"),
        },
        whatsapp: {
            id: "whatsapp",
            enabled: !!getSetting("boothShowWhatsapp"),
            phone: whatsappPhoneRaw,
            href: whatsappPhone ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(whatsappText)}` : "",
            title: ui.t(resolvedLocale, "whatsappChooserTitle"),
            description: whatsappInstruction,
        },
    };
}

function normalizePublicBaseUrl(value) {
    try {
        const url = new URL(String(value || "").trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        return url.origin;
    } catch {
        return "";
    }
}

function resolvePublicBaseUrl(req, configuredBaseUrl = process.env.BASE_URL) {
    const configured = normalizePublicBaseUrl(configuredBaseUrl);
    if (configured) return configured;
    const headers = req && req.headers || {};
    const forwarded = String(headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    const protocol = forwarded === "https" ? "https" : (req && req.protocol === "https" ? "https" : "http");
    const host = req && typeof req.get === "function" ? req.get("host") : headers.host;
    return host ? normalizePublicBaseUrl(`${protocol}://${host}`) : "";
}

function buildStartUrl(baseUrl, eventName, locale) {
    const origin = normalizePublicBaseUrl(baseUrl);
    if (!origin || !isValidEventName(eventName)) return "";
    const url = new URL("/start", origin);
    url.searchParams.set("event", eventName);
    url.searchParams.set("lang", i18n.normalizeLocale(locale) || i18n.DEFAULT_LOCALE);
    return url.toString();
}

function buildChannelLaunchPath(eventName, locale, channel, carryLocale = false) {
    if (!isValidEventName(eventName) || !["sms", "whatsapp"].includes(channel)) return "";
    const params = new URLSearchParams({
        event: eventName,
        lang: i18n.normalizeLocale(locale) || i18n.DEFAULT_LOCALE,
        channel,
    });
    if (carryLocale) params.set("carry", "1");
    return `/start/open?${params.toString()}`;
}

function buildChannelLaunchUrl(baseUrl, eventName, locale, channel, carryLocale = false) {
    const origin = normalizePublicBaseUrl(baseUrl);
    const launchPath = buildChannelLaunchPath(eventName, locale, channel, carryLocale);
    return origin && launchPath ? new URL(launchPath, origin).toString() : "";
}

function isValidEventName(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 256
        && value.trim() === value
        && /^[\p{L}\p{N}_-](?:[\p{L}\p{N} _-]*[\p{L}\p{N}_-])?$/u.test(value);
}

module.exports = {
    buildChannelOptions,
    buildChannelLaunchPath,
    buildChannelLaunchUrl,
    buildStartUrl,
    isValidEventName,
    normalizePublicBaseUrl,
    resolveEventLocale,
    resolvePublicBaseUrl,
};
