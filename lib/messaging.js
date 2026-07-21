const channels = require("./channels");
const settings = require("./settings");
const contacts = require("./contacts");
const i18n = require("./i18n");
const { trackApiCall, getTwilioClient, maskPhone } = require("./helpers");

const WA_SESSION_MS = 24 * 60 * 60 * 1000;

let _fallbackCounts = {};
function incrementFallbackCounter(key) {
    _fallbackCounts[key] = (_fallbackCounts[key] || 0) + 1;
}
function getFallbackCounts() { return { ..._fallbackCounts }; }

async function sendWithRetry(payload, templateKey, toPhone) {
    const start = Date.now();
    try {
        const msg = await getTwilioClient().messages.create(payload);
        trackApiCall("twilio", true, Date.now() - start);
        return { sid: msg.sid };
    } catch (err) {
        trackApiCall("twilio", false, Date.now() - start);
        console.error(`📱 Send failed (${templateKey}) to ${maskPhone(toPhone)}: ${err.message}`);
        return { error: err.message };
    }
}

async function send(toPhone, templateKey, vars = {}, opts = {}) {
    let adapter = opts.adapter;
    if (!adapter) {
        const preferred = contacts.getPreferredChannel(toPhone);
        adapter = preferred ? channels.ADAPTERS[preferred] : null;
        if (!adapter) adapter = channels.getConfiguredAdapters()[0];
    }
    if (!adapter) throw new Error(`No channel adapter available for ${maskPhone(toPhone)}`);

    const base = { to: adapter.formatTo(toPhone), ...adapter.senderId() };
    let payload;
    if (templateKey === "_raw" && opts._body !== undefined) {
        payload = { ...base, body: opts._body };
    } else {
        const sid = opts.contentSid || settings.getContentSid(templateKey, opts.locale || "en");
        if (sid) {
            const contentVariables = opts.contentVariables || vars;
            payload = { ...base, contentSid: sid };
            if (Object.keys(contentVariables).length > 0) {
                payload.contentVariables = JSON.stringify(contentVariables);
            }
        } else {
            let body;
            try {
                body = i18n.t(opts.locale || "en", templateKey, vars, opts.eventName);
            } catch {
                body = settings.getMsg(templateKey, vars);
            }
            console.warn(`📝 Template fallback: "${templateKey}" has no contentSid`);
            incrementFallbackCounter(templateKey);
            payload = { ...base, body };
        }
    }
    if (opts.mediaUrl && !payload.contentSid) payload.mediaUrl = [opts.mediaUrl];

    const maySendOutOfSession = opts.allowOutOfSession === true && !!payload.contentSid;
    if (adapter.sessionAware && !maySendOutOfSession) {
        const last = contacts.getLastInboundAt(toPhone, adapter.name);
        if (!last || Date.now() - last > WA_SESSION_MS) {
            console.warn(`📵 Out-of-session skip: ${templateKey} → ${maskPhone(toPhone)}`);
            return { skipped: "out-of-session" };
        }
    }

    return sendWithRetry(payload, templateKey, toPhone);
}

module.exports = { send, getFallbackCounts };
