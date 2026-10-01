const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWriteFile } = require("../atomic-write");

const DEFAULT_DIR = path.join(__dirname, "..", "..", "data", "voice-requests");
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const PENDING_STATUSES = new Set(["received", "preflighting", "inviting", "awaiting_call", "claimed"]);
const NEWER_STATUSES = new Set([...PENDING_STATUSES, "submitting", "queued"]);

function normalizePhone(raw) {
    const phone = String(raw || "").replace(/^whatsapp:/i, "");
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Invalid caller phone number");
    return phone;
}

function idForSid(messageSid) {
    if (typeof messageSid !== "string" || !messageSid.trim()) throw new Error("MessageSid is required");
    return createHash("sha256").update(messageSid).digest("hex");
}

function createVoiceStore({ dir = DEFAULT_DIR, mediaDir = path.join(path.dirname(dir), "voice-media"), now = Date.now } = {}) {
    const requestsDir = path.resolve(dir);
    const privateMediaDir = path.resolve(mediaDir);
    let tail = Promise.resolve();

    function serialize(operation) {
        const result = tail.then(operation);
        tail = result.then(() => {}, () => {});
        return result;
    }

    function fileFor(id) {
        if (!/^[a-f0-9]{64}$/.test(id || "")) return null;
        return path.join(requestsDir, `${id}.json`);
    }

    async function readUnlocked(id) {
        const file = fileFor(id);
        if (!file) return null;
        try {
            return JSON.parse(await fsp.readFile(file, "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    async function listUnlocked() {
        let files;
        try {
            files = (await fsp.readdir(requestsDir)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
        const records = [];
        for (const file of files) {
            try {
                records.push(JSON.parse(await fsp.readFile(path.join(requestsDir, file), "utf8")));
            } catch (error) {
                if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
            }
        }
        return records;
    }

    async function writeUnlocked(request) {
        const file = fileFor(request.id);
        if (!file) throw new Error("Invalid Voice request ID");
        await atomicWriteFile(file, JSON.stringify(request));
        return request;
    }

    async function removePrivateMedia(request) {
        if (!request?.stagedInputPath) return;
        const candidate = path.resolve(request.stagedInputPath);
        if (!candidate.startsWith(`${privateMediaDir}${path.sep}`)) return;
        await fsp.unlink(candidate).catch((error) => {
            if (error.code !== "ENOENT") throw error;
        });
    }

    function newerExists(request, records) {
        return records.some((candidate) => candidate.id !== request.id
            && candidate.phone === request.phone
            && candidate.eventName === request.eventName
            && NEWER_STATUSES.has(candidate.status)
            && (candidate.receivedAt > request.receivedAt
                || (candidate.receivedAt === request.receivedAt && candidate.id > request.id)));
    }

    async function releaseUnlocked(request, at, records) {
        if (request.status !== "claimed") return null;
        const expired = Number(request.expiresAt) <= at;
        const superseded = !expired && newerExists(request, records);
        const next = {
            ...request,
            status: expired ? "expired" : superseded ? "superseded" : "awaiting_call",
            callSid: null,
            claimedAt: null,
            lastSocketAt: null,
        };
        await writeUnlocked(next);
        if (expired || superseded) await removePrivateMedia(next);
        return next;
    }

    async function record(payload) {
        return serialize(async () => {
            const id = idForSid(payload?.messageSid);
            const existing = await readUnlocked(id);
            if (existing) return existing;
            const request = {
                ...payload,
                id,
                phone: normalizePhone(payload.phone),
                status: "received",
                receivedAt: Number.isFinite(payload.receivedAt) ? payload.receivedAt : now(),
            };
            return writeUnlocked(request);
        });
    }

    async function get(id) {
        return readUnlocked(id);
    }

    async function patch(id, changes, { ifStatus } = {}) {
        return serialize(async () => {
            const current = await readUnlocked(id);
            if (!current) return null;
            if (ifStatus && ![].concat(ifStatus).includes(current.status)) return null;
            if (["id", "messageSid", "phone", "eventName", "receivedAt"].some((key) => key in changes)) {
                throw new Error("Voice request identity cannot change");
            }
            if (current.status === "queued" && changes.status && changes.status !== "queued") {
                throw new Error("A queued Voice request cannot be unqueued");
            }
            if (current.status === "submitting" && changes.status
                && !["submitting", "queued", "failed"].includes(changes.status)) {
                throw new Error("A submitting Voice request cannot return to intake");
            }
            return writeUnlocked({ ...current, ...changes });
        });
    }

    async function claimLatest({ phone, eventName, callSid }) {
        return serialize(async () => {
            if (!callSid || !eventName) return null;
            const normalized = normalizePhone(phone);
            const at = now();
            const records = (await listUnlocked()).filter((request) => request.phone === normalized
                && request.eventName === eventName);
            const active = records.find((request) => request.status === "claimed"
                && Number(request.expiresAt) > at);
            if (active) return active.callSid === callSid ? active : null;
            const eligible = records.filter((request) => request.status === "awaiting_call"
                && Number(request.expiresAt) > at);
            eligible.sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
            const request = eligible[0];
            if (!request) return null;
            return writeUnlocked({ ...request, status: "claimed", callSid, claimedAt: at, lastSocketAt: null });
        });
    }

    async function touchCall(callSid) {
        return serialize(async () => {
            const request = (await listUnlocked()).find((entry) => entry.status === "claimed" && entry.callSid === callSid);
            if (!request) return null;
            return writeUnlocked({ ...request, lastSocketAt: now() });
        });
    }

    async function release(callSid) {
        return serialize(async () => {
            const records = await listUnlocked();
            const request = records.find((entry) => entry.status === "claimed" && entry.callSid === callSid);
            return request ? releaseUnlocked(request, now(), records) : null;
        });
    }

    async function reconcileClaims(activeCallSids = new Set(), at = now()) {
        return serialize(async () => {
            const active = new Set(activeCallSids);
            const records = await listUnlocked();
            const released = [];
            for (const request of records) {
                if (request.status !== "claimed" || active.has(request.callSid)) continue;
                const lastSeen = request.lastSocketAt || request.claimedAt || 0;
                if (at - lastSeen < CLAIM_LEASE_MS) continue;
                await releaseUnlocked(request, at, records);
                released.push(request.id);
            }
            return released;
        });
    }

    async function supersedeOlder(requestId) {
        return serialize(async () => {
            const records = await listUnlocked();
            const current = records.find((request) => request.id === requestId);
            if (!current) return [];
            const changed = [];
            for (const request of records) {
                if (request.id === requestId || request.phone !== current.phone
                    || request.eventName !== current.eventName || request.receivedAt >= current.receivedAt
                    || !["received", "preflighting", "inviting", "awaiting_call"].includes(request.status)) continue;
                await writeUnlocked({ ...request, status: "superseded" });
                await removePrivateMedia(request);
                changed.push(request.id);
            }
            return changed;
        });
    }

    async function findLatest({ phone, eventName, statuses = ["awaiting_call", "claimed", "queued"] }) {
        const normalized = normalizePhone(phone);
        const at = now();
        const records = (await listUnlocked()).filter((request) => request.phone === normalized
            && request.eventName === eventName && statuses.includes(request.status)
            && (!PENDING_STATUSES.has(request.status) || Number(request.expiresAt) > at));
        records.sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
        return records[0] || null;
    }

    async function expire({ activeEventName } = {}) {
        return serialize(async () => {
            const records = await listUnlocked();
            const at = now();
            const changed = [];
            for (const request of records) {
                if (!PENDING_STATUSES.has(request.status)) continue;
                const switched = activeEventName && request.eventName !== activeEventName;
                const expiry = Number.isFinite(request.expiresAt)
                    ? request.expiresAt : Number(request.receivedAt) + 1_800_000;
                if (!switched && expiry > at) continue;
                const next = { ...request, status: switched ? "superseded" : "expired", callSid: null };
                await writeUnlocked(next);
                await removePrivateMedia(next);
                changed.push(next.id);
            }
            return changed;
        });
    }

    return { record, get, patch, claimLatest, touchCall, release, reconcileClaims,
        supersedeOlder, findLatest, list: listUnlocked, expire };
}

module.exports = { createVoiceStore, normalizePhone, idForSid };
