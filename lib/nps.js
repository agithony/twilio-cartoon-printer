const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const NPS_FILE = path.join(DATA_DIR, "nps.json");

// { "phone:event": { phone, eventName, score, timestamp } }
let scores = {};
// Phones with a pending NPS prompt (awaiting reply)
const pending = new Map();
const pendingTimestamps = new Map();
const NPS_STALE_TIMEOUT = 60 * 60 * 1000; // 60 minutes

function load() {
    try {
        if (fs.existsSync(NPS_FILE)) {
            scores = JSON.parse(fs.readFileSync(NPS_FILE, "utf-8"));
        }
    } catch {
        scores = {};
    }
}

let _writeCounter = 0;
function save() {
    const tmp = NPS_FILE + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmp, JSON.stringify(scores, null, 2));
    fs.renameSync(tmp, NPS_FILE);
}

function key(phone, event) {
    return `${phone}:${event}`;
}

function pendingKey(phone, eventName) {
    return key(phone, eventName || "");
}

function markPending(phone, data = {}) {
    const id = pendingKey(phone, data.eventName);
    pending.set(id, { phone, ...data, timestamp: Date.now() });
    pendingTimestamps.set(id, Date.now());
}

function hasPending(phone, eventName) {
    return pending.has(pendingKey(phone, eventName));
}

function getPending(phone, eventName) {
    return pending.get(pendingKey(phone, eventName)) || null;
}

function getLatestPending(phone) {
    let latest = null;
    for (const entry of pending.values()) {
        if (entry.phone === phone && (!latest || entry.timestamp >= latest.timestamp)) latest = entry;
    }
    return latest;
}

function hasCompleted(phone, event) {
    return !!scores[key(phone, event)];
}

function recordScore(phone, event, score) {
    scores[key(phone, event)] = {
        phone,
        eventName: event,
        score,
        timestamp: Date.now(),
    };
    const id = pendingKey(phone, event);
    pending.delete(id);
    pendingTimestamps.delete(id);
    save();
}

// Clean up stale NPS prompts that were never answered
setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of pendingTimestamps) {
        if (now - ts > NPS_STALE_TIMEOUT) {
            pending.delete(id);
            pendingTimestamps.delete(id);
        }
    }
}, 5 * 60 * 1000);

function getScores(eventFilter) {
    const result = [];
    for (const entry of Object.values(scores)) {
        if (!eventFilter || entry.eventName === eventFilter) {
            result.push(entry);
        }
    }
    return result;
}

function getStats(eventFilter) {
    const entries = getScores(eventFilter);
    if (entries.length === 0) {
        return { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    }
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const e of entries) {
        sum += e.score;
        distribution[e.score] = (distribution[e.score] || 0) + 1;
    }
    return {
        average: Math.round((sum / entries.length) * 10) / 10,
        count: entries.length,
        distribution,
    };
}

module.exports = { load, markPending, hasPending, getPending, getLatestPending, hasCompleted, recordScore, getScores, getStats };
