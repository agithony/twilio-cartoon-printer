// Stores contact info captured on the /kiosk page tied to a specific
// portrait's filePrefix. This is distinct from lib/leads.js (which runs a
// multi-step SMS survey keyed on phone+event) — kiosk submissions are a
// single-shot form filled in at the booth, and may have no phone, no email,
// or both. Admins use the outreach tab to see these records and manually
// follow up by email until a proper SendGrid integration is wired up.
//
// Persisted as JSONL at data/kiosk-submissions.jsonl so new records are a
// simple append (no read-modify-write races).

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "kiosk-submissions.jsonl");

function ensureDir() {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function add({ filePrefix, event, phone, email, style, baseUrl }) {
    if (!filePrefix || !event) throw new Error("filePrefix and event required");
    ensureDir();
    const record = {
        filePrefix,
        event,
        phone: phone || "",
        email: email || "",
        style: style || "",
        baseUrl: baseUrl || "",
        submittedAt: Date.now(),
        emailedAt: null,
    };
    fs.appendFileSync(FILE, JSON.stringify(record) + "\n");
    return record;
}

function readAll() {
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
}

// Return the latest record per filePrefix. JSONL is append-only, so edits
// (e.g. marking emailed) are written as new lines; the freshest one wins.
function listByEvent(eventName) {
    const records = readAll();
    const latest = new Map();
    for (const r of records) {
        if (eventName && r.event !== eventName) continue;
        latest.set(r.filePrefix, r);
    }
    return [...latest.values()].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
}

function markEmailed(filePrefix, event) {
    const all = readAll();
    const existing = all.reverse().find((r) => r.filePrefix === filePrefix && r.event === event);
    if (!existing) return null;
    const updated = { ...existing, emailedAt: Date.now() };
    ensureDir();
    fs.appendFileSync(FILE, JSON.stringify(updated) + "\n");
    return updated;
}

function unmarkEmailed(filePrefix, event) {
    const all = readAll();
    const existing = all.reverse().find((r) => r.filePrefix === filePrefix && r.event === event);
    if (!existing) return null;
    const updated = { ...existing, emailedAt: null };
    ensureDir();
    fs.appendFileSync(FILE, JSON.stringify(updated) + "\n");
    return updated;
}

// Wipe all submissions for an event. Called from the Reset Event Data
// admin action and when a per-user delete in outreach should also clear
// their kiosk record. Because the store is JSONL append-only, we rewrite
// the file without the matching records.
function deleteByEvent(eventName) {
    if (!eventName) return 0;
    if (!fs.existsSync(FILE)) return 0;
    const records = readAll();
    const keep = records.filter((r) => r.event !== eventName);
    const removed = records.length - keep.length;
    if (removed === 0) return 0;
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = keep.length ? keep.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
    return removed;
}

// Wipe records for a specific filePrefix + event. Used when an admin
// deletes one user in outreach and we want to remove their kiosk record
// as part of the same operation.
function deleteByFilePrefix(filePrefix, eventName) {
    if (!filePrefix || !eventName) return 0;
    if (!fs.existsSync(FILE)) return 0;
    const records = readAll();
    const keep = records.filter((r) => !(r.filePrefix === filePrefix && r.event === eventName));
    const removed = records.length - keep.length;
    if (removed === 0) return 0;
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = keep.length ? keep.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
    return removed;
}

// Batched version — takes an array of {filePrefix, eventName} and rewrites
// the JSONL file once. Avoids the O(N×file_size) cliff when an admin bulk-
// deletes a user with many portraits.
function deleteBatch(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return 0;
    if (!fs.existsSync(FILE)) return 0;
    const matchKeys = new Set(targets.map((t) => `${t.filePrefix}:${t.eventName}`));
    const records = readAll();
    const keep = records.filter((r) => !matchKeys.has(`${r.filePrefix}:${r.event}`));
    const removed = records.length - keep.length;
    if (removed === 0) return 0;
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = keep.length ? keep.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
    return removed;
}

// Admin edit. Appends a new record with the updated email; listByEvent()
// returns the freshest one per filePrefix. Empty string clears the email.
function setEmail(filePrefix, event, email) {
    const all = readAll();
    const existing = all.reverse().find((r) => r.filePrefix === filePrefix && r.event === event);
    if (!existing) return null;
    const updated = { ...existing, email: (email || "").trim() };
    ensureDir();
    fs.appendFileSync(FILE, JSON.stringify(updated) + "\n");
    return updated;
}

module.exports = { add, listByEvent, markEmailed, unmarkEmailed, setEmail, deleteByEvent, deleteByFilePrefix, deleteBatch };
