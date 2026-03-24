const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const NPS_FILE = path.join(DATA_DIR, "nps.json");

// { "phone:event": { phone, eventName, score, timestamp } }
let scores = {};
// Phones with a pending NPS prompt (awaiting reply)
const pending = new Set();

function load() {
    try {
        if (fs.existsSync(NPS_FILE)) {
            scores = JSON.parse(fs.readFileSync(NPS_FILE, "utf-8"));
        }
    } catch {
        scores = {};
    }
}

function save() {
    fs.writeFileSync(NPS_FILE, JSON.stringify(scores, null, 2));
}

function key(phone, event) {
    return `${phone}:${event}`;
}

function markPending(phone) {
    pending.add(phone);
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
    save();
}

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
