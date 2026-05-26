const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Use a temp dir so tests don't touch real data
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-test-"));
const CONTACTS_FILE = path.join(tmpDir, "contacts.json");

// Patch DATA_DIR before requiring contacts
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = tmpDir;

// Clear require cache so DATA_DIR is picked up fresh
delete require.cache[require.resolve("../lib/contacts")];
const contacts = require("../lib/contacts");

test("recordInbound: sets lastInboundAt on first call", () => {
    const before = Date.now();
    contacts.recordInbound("+14155551111", "sms");
    const after = Date.now();
    const ts = contacts.getLastInboundAt("+14155551111");
    assert.ok(ts >= before && ts <= after, "timestamp should be in range");
});

test("recordInbound: updates lastInboundAt on repeat calls", async () => {
    contacts.recordInbound("+14155552222", "sms");
    const first = contacts.getLastInboundAt("+14155552222");
    await new Promise(r => setTimeout(r, 5));
    contacts.recordInbound("+14155552222", "sms");
    const second = contacts.getLastInboundAt("+14155552222");
    assert.ok(second > first, "second timestamp should be later");
});

test("recordInbound: sets preferredChannel on first call", () => {
    contacts.recordInbound("+14155553333", "whatsapp");
    assert.equal(contacts.getPreferredChannel("+14155553333"), "whatsapp");
});

test("recordInbound: does NOT overwrite preferredChannel on repeat", () => {
    contacts.recordInbound("+14155554444", "sms");
    contacts.recordInbound("+14155554444", "whatsapp");
    assert.equal(contacts.getPreferredChannel("+14155554444"), "sms");
});

test("getLastInboundAt: returns null for unknown phone", () => {
    assert.equal(contacts.getLastInboundAt("+19995550000"), null);
});

test("getPreferredChannel: returns null for unknown phone", () => {
    assert.equal(contacts.getPreferredChannel("+19995550001"), null);
});

test("recordInbound: persists to disk (survives re-require)", () => {
    contacts.recordInbound("+14155555555", "whatsapp");
    // Re-require contacts fresh — should load from disk
    delete require.cache[require.resolve("../lib/contacts")];
    const fresh = require("../lib/contacts");
    fresh.load();
    assert.equal(fresh.getPreferredChannel("+14155555555"), "whatsapp");
    assert.ok(fresh.getLastInboundAt("+14155555555") > 0);
});
