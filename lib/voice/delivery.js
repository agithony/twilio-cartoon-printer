const channels = require("../channels");
const i18n = require("../i18n");
const messaging = require("../messaging");

function createVoiceDelivery({ send, settings } = {}) {
    const resolveSend = () => send || messaging.send;
    const resolveSettings = () => settings || require("../settings");

    async function sendVoiceChannelMessage(job, key, variables, smsBody, mediaUrl) {
        const adapter = channels.ADAPTERS[job.channel];
        if (!adapter) throw new Error("Unsupported Voice delivery channel");
        if (!/^\+[1-9]\d{7,14}$/.test(job.appPhone || "")) throw new Error("Missing original Voice sender");
        const locale = i18n.normalizeLocale(job.locale) || "en";
        let result;
        if (adapter.name === "whatsapp") {
            const contentSid = resolveSettings().getContentSid(key, locale);
            if (!contentSid) throw new Error(`Missing approved ${key} template for ${locale}`);
            result = await resolveSend()(job.userPhone, key, variables, {
                adapter, locale, contentSid, contentVariables: variables,
                allowOutOfSession: true, fromPhone: job.appPhone,
            });
        } else {
            result = await resolveSend()(job.userPhone, "_raw", {}, {
                adapter, locale, _body: smsBody, ...(mediaUrl ? { mediaUrl } : {}),
                fromPhone: job.appPhone,
            });
        }
        if (!result?.sid || result.error || result.skipped) {
            throw new Error(result?.error || result?.skipped || "Voice delivery was not accepted");
        }
        return result;
    }

    async function sendVoiceDelivery(job) {
        if (!job.baseUrl || !/^https:\/\//.test(job.baseUrl)) throw new Error("Public result URL unavailable");
        const prefix = encodeURIComponent(job.filePrefix);
        const event = encodeURIComponent(job.eventName);
        const mediaPath = `s/${prefix}/${job.voiceMediaKind === "mms" ? "mms" : "img"}?e=${event}`;
        const sharePath = `s/${prefix}?e=${event}`;
        return sendVoiceChannelMessage(job, "voiceDelivery", {
            1: mediaPath, 2: sharePath,
        }, i18n.voiceText(job.locale, "delivery"), `${job.baseUrl}/s/${prefix}/mms?e=${event}`);
    }

    async function sendVoiceFailure(job, _reason) {
        return sendVoiceChannelMessage(job, "voiceFailure", {}, i18n.voiceText(job.locale, "failure"), null);
    }

    return { sendVoiceDelivery, sendVoiceFailure };
}

const defaultDelivery = createVoiceDelivery();
module.exports = { createVoiceDelivery, ...defaultDelivery };
