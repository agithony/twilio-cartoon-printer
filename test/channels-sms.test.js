const { test } = require("node:test");
const assert = require("node:assert/strict");

// Stub settings before requiring the adapter
const settingsStub = { _data: {}, get(k) { return this._data[k]; } };
require.cache[require.resolve("../lib/settings")] = { id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings"), loaded: true, exports: settingsStub };

const sms = require("../lib/channels/sms");

test("sms.normalizeFrom: returns raw value unchanged", () => {
    assert.equal(sms.normalizeFrom("+14155551234"), "+14155551234");
    assert.equal(sms.normalizeFrom("+14155551234"), "+14155551234"); // idempotent
});

test("sms.formatTo: returns phone unchanged", () => {
    assert.equal(sms.formatTo("+14155551234"), "+14155551234");
});

test("sms.isConfigured: false when no phone or MSSID", () => {
    settingsStub._data = {};
    assert.equal(sms.isConfigured(), false);
});

test("sms.isConfigured: true when twilioPhoneNumber set", () => {
    settingsStub._data = { twilioPhoneNumber: "+12065551234" };
    assert.equal(sms.isConfigured(), true);
});

test("sms.isConfigured: true when twilioMessagingServiceSid set", () => {
    settingsStub._data = { twilioMessagingServiceSid: "MGabc" };
    assert.equal(sms.isConfigured(), true);
});

test("sms.senderId: prefers Messaging Service over phone number", () => {
    settingsStub._data = { twilioMessagingServiceSid: "MGabc", twilioPhoneNumber: "+12065551234" };
    assert.deepEqual(sms.senderId(), { messagingServiceSid: "MGabc" });
});

test("sms.senderId: falls back to from when no MSSID", () => {
    settingsStub._data = { twilioPhoneNumber: "+12065551234" };
    assert.deepEqual(sms.senderId(), { from: "+12065551234" });
});

test("sms.senderId: throws when phone number missing", () => {
    settingsStub._data = {};
    assert.throws(() => sms.senderId(), /twilioPhoneNumber not configured/);
});
