const { test } = require("node:test");
const assert = require("node:assert/strict");

// Settings stub — configure both adapters
const settingsStub = { _data: {}, get(k) { return this._data[k]; } };
require.cache[require.resolve("../lib/settings")] = { id: require.resolve("../lib/settings"), filename: require.resolve("../lib/settings"), loaded: true, exports: settingsStub };

const channels = require("../lib/channels/index");

test("detectChannel: whatsapp: prefix → whatsapp adapter", () => {
    const adapter = channels.detectChannel({ From: "whatsapp:+14155551234" });
    assert.equal(adapter.name, "whatsapp");
});

test("detectChannel: E.164 → sms adapter", () => {
    const adapter = channels.detectChannel({ From: "+14155551234" });
    assert.equal(adapter.name, "sms");
});

test("detectChannel: empty From → sms adapter (default)", () => {
    const adapter = channels.detectChannel({});
    assert.equal(adapter.name, "sms");
});

test("getConfiguredAdapters: returns only configured adapters", () => {
    settingsStub._data = { twilioPhoneNumber: "+12065551234" };
    const names = channels.getConfiguredAdapters().map(a => a.name);
    assert.deepEqual(names, ["sms"]);
});

test("getConfiguredAdapters: returns both when both configured", () => {
    settingsStub._data = { twilioPhoneNumber: "+12065551234", twilioWhatsappNumber: "+14155238886" };
    const names = channels.getConfiguredAdapters().map(a => a.name);
    assert.ok(names.includes("sms"));
    assert.ok(names.includes("whatsapp"));
});

test("getConfiguredAdapters: returns empty when nothing configured", () => {
    settingsStub._data = {};
    assert.equal(channels.getConfiguredAdapters().length, 0);
});
