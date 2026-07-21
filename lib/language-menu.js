const pending = new Map();
const STALE_MS = 30 * 60 * 1000;

function setPending(phone, value) {
    pending.set(phone, { ...value, timestamp: Date.now() });
}

function getPending(phone) { return pending.get(phone) || null; }
function clearPending(phone) { pending.delete(phone); }

const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [phone, value] of pending) {
        if (now - value.timestamp > STALE_MS) pending.delete(phone);
    }
}, 5 * 60 * 1000);
cleanup.unref();

module.exports = { setPending, getPending, clearPending };
