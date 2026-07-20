const { test } = require("node:test");
const assert = require("node:assert/strict");

// Stubs
const settingsStub = {
    _data: { contentTemplates: {} },
    get(k) { return this._data[k]; },
    getContentSid(k, locale = "en") {
        const templates = this._data.contentTemplates || {};
        return (templates[locale] && templates[locale][k]) || templates[k] || null;
    },
    getMsg(k) { return `fallback:${k}`; },
};
const contactsStub = {
    _channel: null, _ts: null, _tsByChannel: {},
    getPreferredChannel() { return this._channel; },
    getLastInboundAt(_phone, channel) { return this._tsByChannel[channel] || this._ts; },
};

let lastPayload = null;
const twilioStub = { messages: { create: async (p) => { lastPayload = p; return { sid: "SM123" }; } } };
const helpersStub = { trackApiCall() {}, maskPhone(p) { return p; }, getTwilioClient: () => twilioStub };

// Inject stubs BEFORE loading adapters (they require ../settings at call time)
require.cache[require.resolve("../lib/settings")] = { exports: settingsStub, loaded: true, id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings") };
require.cache[require.resolve("../lib/contacts")] = { exports: contactsStub, loaded: true, id: require.resolve("../lib/contacts"), filename: require.resolve("../lib/contacts") };
require.cache[require.resolve("../lib/helpers")] = { exports: helpersStub, loaded: true, id: require.resolve("../lib/helpers"), filename: require.resolve("../lib/helpers") };

// Clear any cached channel modules so they pick up the stub
delete require.cache[require.resolve("../lib/channels/sms")];
delete require.cache[require.resolve("../lib/channels/whatsapp")];
delete require.cache[require.resolve("../lib/channels/index")];
delete require.cache[require.resolve("../lib/messaging")];

const smsAdapter = require("../lib/channels/sms");
const waAdapter = require("../lib/channels/whatsapp");
const messaging = require("../lib/messaging");

test("send: uses contentSid when configured", async () => {
    settingsStub._data.contentTemplates = { styleMenu: "HXabc" };
    contactsStub._channel = "sms";
    settingsStub._data.twilioPhoneNumber = "+12065551234";
    await messaging.send("+14155551234", "styleMenu", { "1": "Anime" }, { adapter: smsAdapter });
    assert.equal(lastPayload.contentSid, "HXabc");
    assert.equal(lastPayload.contentVariables, JSON.stringify({ "1": "Anime" }));
    assert.equal(lastPayload.to, "+14155551234");
});

test("send: explicit contentSid and variables override settings", async () => {
    settingsStub._data.contentTemplates = { styleMenu: "HXold" };
    await messaging.send("+14155551234", "styleMenu", { 1: "old" }, {
        adapter: smsAdapter,
        contentSid: "HXruntime",
        contentVariables: { 1: "new" },
    });
    assert.equal(lastPayload.contentSid, "HXruntime");
    assert.equal(lastPayload.contentVariables, JSON.stringify({ 1: "new" }));
});

test("send: resolves locale-specific static Content SID", async () => {
    settingsStub._data.contentTemplates = {
        en: { delivery: "HXenglish" },
        pt_BR: { delivery: "HXportuguese" },
    };
    await messaging.send("+14155551234", "delivery", { 1: "Cartoon" }, { adapter: smsAdapter, locale: "pt_BR" });
    assert.equal(lastPayload.contentSid, "HXportuguese");
});

test("send: omits mediaUrl when using Content API", async () => {
    settingsStub._data.contentTemplates = { delivery: "HXdelivery" };
    await messaging.send("+14155551234", "delivery", { 1: "Cartoon" }, {
        adapter: smsAdapter,
        mediaUrl: "https://example.com/image.jpg",
    });
    assert.equal(lastPayload.contentSid, "HXdelivery");
    assert.equal(lastPayload.mediaUrl, undefined);
});

test("send: falls back to plain body when no contentSid", async () => {
    settingsStub._data.contentTemplates = {};
    await messaging.send("+14155551234", "enqueued", {}, { adapter: smsAdapter });
    assert.equal(lastPayload.body, "fallback:enqueued");
    assert.equal(lastPayload.contentSid, undefined);
});

test("send: WhatsApp adapter formats to with prefix", async () => {
    settingsStub._data.contentTemplates = { enqueued: "HXdef" };
    settingsStub._data.twilioWhatsappNumber = "+14155238886";
    delete settingsStub._data.twilioWhatsappMessagingServiceSid;
    contactsStub._tsByChannel.whatsapp = Date.now();
    await messaging.send("+14155551234", "enqueued", {}, { adapter: waAdapter });
    assert.equal(lastPayload.to, "whatsapp:+14155551234");
    assert.ok(lastPayload.from === "whatsapp:+14155238886" || lastPayload.messagingServiceSid);
});

test("send: skips every free-form out-of-session WhatsApp send", async () => {
    contactsStub._ts = null;
    contactsStub._tsByChannel.whatsapp = null;
    lastPayload = null;
    settingsStub._data.contentTemplates = {};
    const result = await messaging.send("+14155551234", "promo", {}, { adapter: waAdapter });
    assert.equal(result.skipped, "out-of-session");
    assert.equal(lastPayload, null);
});

test("send: proceeds when in-session (lastInboundAt within 24h)", async () => {
    settingsStub._data.contentTemplates = { promo: "HXghi" };
    settingsStub._data.twilioWhatsappNumber = "+14155238886";
    contactsStub._ts = Date.now();
    contactsStub._tsByChannel.whatsapp = Date.now();
    lastPayload = null;
    await messaging.send("+14155551234", "promo", {}, { adapter: waAdapter, requiresSession: true });
    assert.ok(lastPayload !== null);
});

test("send: allows an approved template outside the WhatsApp session", async () => {
    settingsStub._data.contentTemplates = { promo: "HXapproved" };
    contactsStub._ts = null;
    contactsStub._tsByChannel.whatsapp = null;
    lastPayload = null;
    await messaging.send("+14155551234", "promo", {}, { adapter: waAdapter, allowOutOfSession: true });
    assert.equal(lastPayload.contentSid, "HXapproved");
});

test("send: includes mediaUrl when provided", async () => {
    settingsStub._data.contentTemplates = {};
    await messaging.send("+14155551234", "enqueued", {}, { adapter: smsAdapter, mediaUrl: "https://example.com/img.jpg" });
    assert.deepEqual(lastPayload.mediaUrl, ["https://example.com/img.jpg"]);
});

test("send: resolves adapter from preferredChannel when no opts.adapter", async () => {
    settingsStub._data.contentTemplates = {};
    settingsStub._data.twilioPhoneNumber = "+12065551234";
    contactsStub._channel = "sms";
    await messaging.send("+14155551234", "enqueued", {});
    assert.equal(lastPayload.to, "+14155551234"); // SMS path, no prefix
});

test("send: returns error object when Twilio API throws", async () => {
    const originalCreate = twilioStub.messages.create;
    twilioStub.messages.create = async () => { throw new Error("Rate limit"); };
    const result = await messaging.send("+14155551234", "enqueued", {}, { adapter: smsAdapter });
    assert.equal(result.error, "Rate limit");
    twilioStub.messages.create = originalCreate;
});

test("getFallbackCounts: increments counter on each template fallback", async () => {
    settingsStub._data.contentTemplates = {};
    const before = (messaging.getFallbackCounts().testCounter || 0);
    await messaging.send("+14155551234", "testCounter", {}, { adapter: smsAdapter });
    await messaging.send("+14155551234", "testCounter", {}, { adapter: smsAdapter });
    const counts = messaging.getFallbackCounts();
    assert.ok(counts.testCounter >= 2);
});
