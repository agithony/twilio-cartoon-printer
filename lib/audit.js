const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.jsonl");

// ── Ensure data directory exists ───────────────────────────────────────────

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Write an audit entry ───────────────────────────────────────────────────

async function logSettingsChange(actor, eventName, before, after) {
    const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        actor: actor || "unknown",
        action: "settings.update",
        eventName: eventName || "unknown",
        before,
        after,
        reverted: false,
    };
    await fsp.appendFile(AUDIT_FILE, JSON.stringify(entry) + "\n");
    return entry;
}

async function logRevert(actor, eventName, originalId, before, after) {
    const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        actor: actor || "unknown",
        action: "settings.revert",
        eventName: eventName || "unknown",
        originalId,
        before,
        after,
        reverted: false,
    };
    await fsp.appendFile(AUDIT_FILE, JSON.stringify(entry) + "\n");
    return entry;
}

// ── Read audit log ─────────────────────────────────────────────────────────

async function getAuditLog(limit = 50, offset = 0) {
    try {
        const raw = await fsp.readFile(AUDIT_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const entries = [];
        for (const line of lines) {
            try { entries.push(JSON.parse(line)); } catch {}
        }
        // Newest first
        entries.reverse();
        const total = entries.length;
        const page = entries.slice(offset, offset + limit);
        return { entries: page, total };
    } catch (err) {
        if (err.code === "ENOENT") return { entries: [], total: 0 };
        throw err;
    }
}

// ── Revert a settings change ───────────────────────────────────────────────

async function revertEntry(id, actor) {
    const settings = require("./settings");

    // Read the full log to find the entry
    const { entries } = await getAuditLog(10000, 0);
    const entry = entries.find(e => e.id === id);
    if (!entry) throw new Error("Audit entry not found");
    if (entry.action !== "settings.update") throw new Error("Only settings changes can be reverted");
    if (entry.reverted) throw new Error("Already reverted");

    // Snapshot current values for the keys being reverted
    if (!entry.before || typeof entry.before !== "object") throw new Error("Audit entry has no revertible data");
    const currentValues = {};
    for (const key of Object.keys(entry.before)) {
        currentValues[key] = settings.get(key);
    }

    // Apply the "before" values
    settings.update(entry.before);

    // Mark the original entry as reverted by rewriting the file
    await markReverted(id);

    // Log the revert action
    await logRevert(actor, entry.eventName, id, currentValues, entry.before);

    return { success: true, reverted: entry.before };
}

// ── Mark an entry as reverted ──────────────────────────────────────────────

async function markReverted(id) {
    try {
        const raw = await fsp.readFile(AUDIT_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const updated = lines.map(line => {
            try {
                const entry = JSON.parse(line);
                if (entry.id === id) {
                    entry.reverted = true;
                    return JSON.stringify(entry);
                }
                return line;
            } catch {
                return line;
            }
        });
        const tmp = AUDIT_FILE + ".tmp." + process.pid;
        await fsp.writeFile(tmp, updated.join("\n") + "\n");
        await fsp.rename(tmp, AUDIT_FILE);
    } catch (err) {
        console.error("📝 Failed to mark audit entry as reverted:", err.message);
    }
}

module.exports = { logSettingsChange, logRevert, getAuditLog, revertEntry };
