const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const PAPER_FILE = path.join(DATA_DIR, "paper.json");

const DEFAULTS = { remaining: 20, capacity: 20, warningThreshold: 2 };

let state = { ...DEFAULTS };

function save() {
    fs.writeFileSync(PAPER_FILE, JSON.stringify(state, null, 2));
}

function load() {
    try {
        if (fs.existsSync(PAPER_FILE)) {
            state = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(PAPER_FILE, "utf-8")) };
        } else {
            state = { ...DEFAULTS };
            save();
        }
    } catch {
        state = { ...DEFAULTS };
        save();
    }
    console.log(`📄 Paper counter loaded: ${state.remaining}/${state.capacity} sheets (warn at ${state.warningThreshold})`);
}

function getState() {
    return {
        ...state,
        isWarning: state.remaining > 0 && state.remaining <= state.warningThreshold,
        isEmpty: state.remaining <= 0,
    };
}

function decrement() {
    state.remaining = Math.max(0, state.remaining - 1);
    save();
    const s = getState();
    if (s.isEmpty) {
        console.log("🚨 PAPER EMPTY! Reload the printer tray.");
    } else if (s.isWarning) {
        console.log(`⚠️  Paper low: ${state.remaining} sheet${state.remaining === 1 ? "" : "s"} remaining!`);
    }
    return s;
}

function reset() {
    state.remaining = state.capacity;
    save();
    console.log(`📄 Paper counter reset to ${state.capacity} sheets.`);
    return getState();
}

function updateConfig({ capacity, warningThreshold }) {
    if (capacity !== undefined) state.capacity = Math.max(1, Math.floor(capacity));
    if (warningThreshold !== undefined) state.warningThreshold = Math.max(0, Math.floor(warningThreshold));
    save();
    console.log(`📄 Paper config updated: capacity=${state.capacity}, warn at ${state.warningThreshold}`);
    return getState();
}

module.exports = { load, getState, decrement, reset, updateConfig };
