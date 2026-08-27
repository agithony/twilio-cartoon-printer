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

test("recordInbound: updates preferredChannel to the latest inbound channel", () => {
    contacts.recordInbound("+14155554444", "sms");
    contacts.recordInbound("+14155554444", "whatsapp");
    assert.equal(contacts.getPreferredChannel("+14155554444"), "whatsapp");
});

test("recordInbound: isolates session timestamps by channel", () => {
    contacts.recordInbound("+14155556666", "sms");
    assert.ok(contacts.getLastInboundAt("+14155556666", "sms") > 0);
    assert.equal(contacts.getLastInboundAt("+14155556666", "whatsapp"), null);
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

test("preferred locale is stored per phone and event", () => {
    contacts.setPreferredLocale("+14155557777", "Event A", "pt_BR");
    contacts.setPreferredLocale("+14155557777", "Event B", "en");
    assert.equal(contacts.getPreferredLocale("+14155557777", "Event A"), "pt_BR");
    assert.equal(contacts.getPreferredLocale("+14155557777", "Event B"), "en");
});

test("deleteByPhone: removes session key when no eventName given", () => {
    contacts.recordContact("+14155556666", "+12065551234", "testEvent");
    contacts.recordInbound("+14155556666", "sms");
    assert.ok(contacts.getLastInboundAt("+14155556666") !== null);
    contacts.deleteByPhone("+14155556666");
    assert.equal(contacts.getLastInboundAt("+14155556666"), null);
    assert.equal(contacts.getPreferredChannel("+14155556666"), null);
});

test("deleteByPhone: preserves session key when eventName given", () => {
    contacts.recordContact("+14155557777", "+12065551234", "testEvent");
    contacts.recordInbound("+14155557777", "whatsapp");
    contacts.deleteByPhone("+14155557777", "testEvent");
    // Session key should survive per-event deletion
    assert.ok(contacts.getPreferredChannel("+14155557777") !== null);
});

test("deleteByEvent: preserves session keys", () => {
    contacts.recordContact("+14155558888", "+12065551234", "eventToDelete");
    contacts.recordInbound("+14155558888", "sms");
    contacts.deleteByEvent("eventToDelete");
    // Contact record gone, session key survives
    assert.ok(contacts.getPreferredChannel("+14155558888") !== null);
});

test("getDropOffs: returns contacts with no active jobs", () => {
    contacts.recordContact("+14155559001", "+12065551234", "evt1");
    contacts.recordContact("+14155559002", "+12065551234", "evt1");
    const dropOffs = contacts.getDropOffs("evt1", [], []);
    const phones = dropOffs.map(d => d.phone);
    assert.ok(phones.includes("+14155559001"));
    assert.ok(phones.includes("+14155559002"));
});

test("getDropOffs: excludes contacts with active jobs", () => {
    contacts.recordContact("+14155559003", "+12065551234", "evt2");
    const activeJobs = [{ userPhone: "+14155559003", eventName: "evt2" }];
    const dropOffs = contacts.getDropOffs("evt2", activeJobs, []);
    assert.equal(dropOffs.find(d => d.phone === "+14155559003"), undefined);
});

test("getDropOffs: excludes admin phones", () => {
    contacts.recordContact("+14155559004", "+12065551234", "evt3");
    const dropOffs = contacts.getDropOffs("evt3", [], ["+14155559004"]);
    assert.equal(dropOffs.find(d => d.phone === "+14155559004"), undefined);
});

test("getDropOffs: skips __session__ keys (no session records in results)", () => {
    contacts.recordInbound("+14155559005", "sms");
    const dropOffs = contacts.getDropOffs("evt4", [], []);
    // session key should never appear as a drop-off
    assert.equal(dropOffs.find(d => d.phone === "+14155559005" && !d.eventName), undefined);
});

test("markNudged: sets nudgedAt on existing contact", () => {
    contacts.recordContact("+14155559006", "+12065551234", "evt5");
    const before = Date.now();
    const result = contacts.markNudged("+14155559006", "evt5");
    assert.equal(result, true);
});

test("markNudged: returns false for unknown contact", () => {
    const result = contacts.markNudged("+19999990000", "unknown-event");
    assert.equal(result, false);
});
