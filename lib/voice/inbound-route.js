const i18n = require("../i18n");
const messaging = require("../messaging");
const contacts = require("../contacts");

const COPY = {
    en: {
        in_call: "Please finish or end your photo call, then send MENU again to use the message choices.",
        not_ready: "I'm still checking your selfie. Please send MENU again in a moment.",
    },
    pt_BR: {
        in_call: "Termine ou desligue sua chamada sobre a foto e envie MENU novamente para usar as opções por mensagem.",
        not_ready: "Ainda estou verificando sua selfie. Envie MENU novamente daqui a pouco.",
    },
};

async function routeVoiceInbound({ body, eventName, sender, appPhone, adapter, locale,
    store, intake, quota, enabled = true, baseUrl, eventSettings,
    send = messaging.send, recordInboundSession = contacts.recordInbound } = {}) {
    if (!store || !intake || !sender || !eventName) throw new Error("Voice inbound route dependencies are missing");
    const text = String(body?.Body || "").trim();
    const numMedia = Number.parseInt(body?.NumMedia || "0", 10) || 0;
    const chosenLocale = i18n.normalizeLocale(locale);
    if (numMedia === 0 && /^menu$/i.test(text)) {
        const outcome = await store.menuFallback({ phone: sender, eventName });
        if (outcome.status === "ready") {
            await recordInboundSession(sender, adapter.name);
            const request = outcome.request;
            return { handled: true, status: 204, fallback: {
                requestId: request.id, sourceImagePath: request.stagedInputPath,
                imageUrl: request.imageUrl, messageSid: request.messageSid,
                eventName: request.eventName, channel: request.channel,
                appPhone: request.appPhone, baseUrl: request.baseUrl,
                locale: request.locale,
            } };
        }
        if (["in_call", "not_ready"].includes(outcome.status)) {
            await recordInboundSession(sender, adapter.name);
            const resolvedLocale = i18n.normalizeLocale(outcome.request?.locale) || chosenLocale || "en";
            await send(sender, "_raw", {}, { _body: COPY[resolvedLocale][outcome.status],
                adapter, locale: resolvedLocale, fromPhone: appPhone });
            return { handled: true, status: 204 };
        }
        return { handled: false };
    }
    if (!enabled || numMedia !== 1) return { handled: false };
    await recordInboundSession(sender, adapter.name);
    if (quota && !quota.unlimited && quota.used >= quota.max) {
        const printing = !!eventSettings?.enablePrinting;
        const units = chosenLocale === "pt_BR" ? (printing ? "impressões" : "retratos")
            : (printing ? "prints" : "portraits");
        await send(sender, "_raw", {}, { _body: i18n.t(chosenLocale, "quotaExceeded",
            { maxPrints: quota.max, units, eventName }, eventName), adapter,
            locale: chosenLocale || "en", fromPhone: appPhone });
        return { handled: true, status: 204 };
    }
    await intake.acceptSelfie({
        messageSid: body.MessageSid, phone: sender, appPhone, channel: adapter.name,
        eventName, locale: chosenLocale, baseUrl,
        imageUrl: body.MediaUrl0, imageContentType: body.MediaContentType0,
        eventSettings,
    });
    void intake.recover().catch((error) => {
        console.error(`Voice intake recovery failed: ${String(error.message || error).slice(0, 120)}`);
    });
    return { handled: true, status: 204 };
}

module.exports = { routeVoiceInbound };
