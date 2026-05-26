const channels = require("./channels");
const settings = require("./settings");
const contacts = require("./contacts");
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
        console.error(`📱 Send failed (${templateKey}) to ${maskPhone(toPhone)}: ${err.message} — retrying in 10s`);
        setTimeout(async () => {
            const retryStart = Date.now();
            try {
                await getTwilioClient().messages.create(payload);
                trackApiCall("twilio", true, Date.now() - retryStart);
            } catch (retryErr) {
                trackApiCall("twilio", false, Date.now() - retryStart);
                console.error(`📱 Retry failed (${templateKey}) for ${maskPhone(toPhone)}: ${retryErr.message}`);
            }
        }, 10000);
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

    if (adapter.sessionAware && opts.requiresSession) {
        const last = contacts.getLastInboundAt(toPhone);
        if (!last || Date.now() - last > WA_SESSION_MS) {
            console.warn(`📵 Out-of-session skip: ${templateKey} → ${maskPhone(toPhone)}`);
            return { skipped: "out-of-session" };
        }
    }

    const sid = settings.getContentSid(templateKey);
    const base = { to: adapter.formatTo(toPhone), ...adapter.senderId() };
    let payload;
    if (sid) {
        payload = { ...base, contentSid: sid, contentVariables: JSON.stringify(vars) };
    } else {
        const body = settings.getMsg(templateKey, vars);
        console.warn(`📝 Template fallback: "${templateKey}" has no contentSid`);
        incrementFallbackCounter(templateKey);
        payload = { ...base, body };
    }
    if (opts.mediaUrl) payload.mediaUrl = [opts.mediaUrl];

    return sendWithRetry(payload, templateKey, toPhone);
}

module.exports = { send, getFallbackCounts };
