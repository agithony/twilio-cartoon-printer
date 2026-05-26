const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

// ── State ────────────────────────────────────────────────────────────────────

let contactsData = {};

// ── Persistence ──────────────────────────────────────────────────────────────

function load() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            contactsData = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
        }
    } catch {
        contactsData = {};
    }
    const count = Object.keys(contactsData).length;
    if (count > 0) console.log(`📇 Contacts loaded (${count} records)`);
}

let _writeCounter = 0;
function atomicWriteSync(filePath, data) {
    const tmp = filePath + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
}

function save() {
    atomicWriteSync(CONTACTS_FILE, JSON.stringify(contactsData, null, 2));
}

// ── Record first contact ─────────────────────────────────────────────────────

function recordContact(phone, appPhone, eventName) {
    const key = `${phone}:${eventName}`;
    if (contactsData[key]) return; // already tracked
    contactsData[key] = {
        phone,
        appPhone,
        eventName,
        firstContactAt: Date.now(),
        nudgedAt: null,
    };
    save();
}

// ── Session tracking ─────────────────────────────────────────────────────────

function recordInbound(phone, channelName) {
    if (!phone) return;
    const sessionKey = `__session__:${phone}`;
    if (!contactsData[sessionKey]) {
        contactsData[sessionKey] = { phone, preferredChannel: channelName, lastInboundAt: Date.now() };
    } else {
        contactsData[sessionKey].lastInboundAt = Date.now();
        // preferredChannel locked on first contact — never overwrite
    }
    save();
}

function getLastInboundAt(phone) {
    const record = contactsData[`__session__:${phone}`];
    return record ? record.lastInboundAt : null;
}

function getPreferredChannel(phone) {
    const record = contactsData[`__session__:${phone}`];
    return record ? record.preferredChannel : null;
}

// ── Query drop-offs ──────────────────────────────────────────────────────────

function getDropOffs(eventName, activeJobs, adminPhones) {
    // Build set of phone:event pairs that have any job in the pipeline
    const activeSet = new Set();
    for (const job of activeJobs) {
        if (job.userPhone && job.eventName) {
            activeSet.add(`${job.userPhone}:${job.eventName}`);
        }
    }

    const adminSet = new Set(adminPhones || []);
    const dropOffs = [];

    for (const [key, contact] of Object.entries(contactsData)) {
        // Filter by event
        if (eventName && eventName !== "all" && contact.eventName !== eventName) continue;
        // Skip admins
        if (adminSet.has(contact.phone)) continue;
        // Skip users with active or completed jobs
        if (activeSet.has(key)) continue;

        dropOffs.push(contact);
    }

    // Sort by most recent first
    dropOffs.sort((a, b) => (b.firstContactAt || 0) - (a.firstContactAt || 0));
    return dropOffs;
}

// ── Nudge ────────────────────────────────────────────────────────────────────

function markNudged(phone, eventName) {
    const key = `${phone}:${eventName}`;
    if (!contactsData[key]) return false;
    contactsData[key].nudgedAt = Date.now();
    save();
    return true;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function deleteByPhone(phone, eventName) {
    let deleted = 0;
    for (const key of Object.keys(contactsData)) {
        if (key.startsWith(phone + ":") && (!eventName || key === `${phone}:${eventName}`)) {
            delete contactsData[key];
            deleted++;
        }
    }
    if (deleted > 0) save();
    return deleted;
}

function deleteByEvent(eventName) {
    let deleted = 0;
    for (const key of Object.keys(contactsData)) {
        if (key.endsWith(":" + eventName)) {
            delete contactsData[key];
            deleted++;
        }
    }
    if (deleted > 0) save();
    return deleted;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { load, recordContact, recordInbound, getLastInboundAt, getPreferredChannel, getDropOffs, markNudged, deleteByPhone, deleteByEvent };
