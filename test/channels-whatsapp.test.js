const { test } = require("node:test");
const assert = require("node:assert/strict");

const settingsStub = { _data: {}, get(k) { return this._data[k]; } };
require.cache[require.resolve("../lib/settings")] = { id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings"), loaded: true, exports: settingsStub };

const wa = require("../lib/channels/whatsapp");

test("wa.normalizeFrom: strips whatsapp: prefix", () => {
    assert.equal(wa.normalizeFrom("whatsapp:+14155551234"), "+14155551234");
});

test("wa.normalizeFrom: idempotent on plain E.164", () => {
    assert.equal(wa.normalizeFrom("+14155551234"), "+14155551234");
});

test("wa.formatTo: adds whatsapp: prefix", () => {
    assert.equal(wa.formatTo("+14155551234"), "whatsapp:+14155551234");
});

test("wa.formatTo: idempotent if already prefixed", () => {
    assert.equal(wa.formatTo("whatsapp:+14155551234"), "whatsapp:+14155551234");
});

test("wa.isConfigured: false when no number or MSSID", () => {
    settingsStub._data = {};
    assert.equal(wa.isConfigured(), false);
});

test("wa.isConfigured: true when twilioWhatsappNumber set", () => {
    settingsStub._data = { twilioWhatsappNumber: "+14155238886" };
    assert.equal(wa.isConfigured(), true);
});

test("wa.senderId: prefers Messaging Service", () => {
    settingsStub._data = { twilioWhatsappMessagingServiceSid: "MGxyz", twilioWhatsappNumber: "+14155238886" };
    assert.deepEqual(wa.senderId(), { messagingServiceSid: "MGxyz" });
});

test("wa.senderId: uses prefixed from when no MSSID", () => {
    settingsStub._data = { twilioWhatsappNumber: "+14155238886" };
    assert.deepEqual(wa.senderId(), { from: "whatsapp:+14155238886" });
});

test("wa.senderId: throws when number missing", () => {
    settingsStub._data = {};
    assert.throws(() => wa.senderId(), /twilioWhatsappNumber/);
});
