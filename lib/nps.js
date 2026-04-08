const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const NPS_FILE = path.join(DATA_DIR, "nps.json");

// { "phone:event": { phone, eventName, score, timestamp } }
let scores = {};
// Phones with a pending NPS prompt (awaiting reply)
const pending = new Set();
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

function markPending(phone) {
    pending.add(phone);
    pendingTimestamps.set(phone, Date.now());
}

function hasPending(phone) {
    return pending.has(phone);
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
    pending.delete(phone);
    pendingTimestamps.delete(phone);
    save();
}

// Clean up stale NPS prompts that were never answered
setInterval(() => {
    const now = Date.now();
    for (const [phone, ts] of pendingTimestamps) {
        if (now - ts > NPS_STALE_TIMEOUT) {
            pending.delete(phone);
            pendingTimestamps.delete(phone);
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

module.exports = { load, markPending, hasPending, hasCompleted, recordScore, getScores, getStats };
