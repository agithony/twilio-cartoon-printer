const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWriteFile } = require("../atomic-write");

const DEFAULT_DIR = path.join(__dirname, "..", "..", "data", "voice-requests");
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const MENU_IDLE_MS = 35 * 60 * 1000;
const MENU_MAX_MS = 2 * 60 * 60 * 1000;
const PENDING_STATUSES = new Set(["received", "preflighting", "inviting", "awaiting_call", "claimed", "menu_fallback"]);
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
    let loading = null;
    const byId = new Map();
    const idsByPhoneEvent = new Map();
    const idByCallSid = new Map();
    const pendingIds = new Set();

    function serialize(operation) {
        const result = tail.then(async () => {
            await ensureLoaded();
            return operation();
        });
        tail = result.then(() => {}, () => {});
        return result;
    }

    function phoneEventKey(phone, eventName) { return `${phone}\0${eventName}`; }

    function copy(request) { return request ? JSON.parse(JSON.stringify(request)) : null; }

    function indexRecord(request) {
        const previous = byId.get(request.id);
        if (previous) {
            const previousKey = phoneEventKey(previous.phone, previous.eventName);
            const nextKey = phoneEventKey(request.phone, request.eventName);
            if (previousKey !== nextKey) {
                const ids = idsByPhoneEvent.get(previousKey);
                ids?.delete(request.id);
                if (ids?.size === 0) idsByPhoneEvent.delete(previousKey);
            }
            if (previous.status === "claimed" && idByCallSid.get(previous.callSid) === request.id) {
                idByCallSid.delete(previous.callSid);
            }
        }
        byId.set(request.id, request);
        const key = phoneEventKey(request.phone, request.eventName);
        if (!idsByPhoneEvent.has(key)) idsByPhoneEvent.set(key, new Set());
        idsByPhoneEvent.get(key).add(request.id);
        if (request.status === "claimed" && request.callSid) idByCallSid.set(request.callSid, request.id);
        if (PENDING_STATUSES.has(request.status)) pendingIds.add(request.id);
        else pendingIds.delete(request.id);
    }

    function recordsForPhone(phone, eventName) {
        return Array.from(idsByPhoneEvent.get(phoneEventKey(phone, eventName)) || [], (id) => byId.get(id));
    }

    async function ensureLoaded() {
        if (!loading) {
            loading = listUnlocked().then((records) => {
                for (const record of records) indexRecord(record);
            }).catch((error) => {
                loading = null;
                throw error;
            });
        }
        return loading;
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
        const json = JSON.stringify(request);
        await atomicWriteFile(file, json);
        indexRecord(JSON.parse(json));
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
            const existing = byId.get(id);
            if (existing) return copy(existing);
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
            const records = recordsForPhone(normalized, eventName);
            const active = records.find((request) => request.status === "claimed"
                && Number(request.expiresAt) > at);
            if (active) return active.callSid === callSid ? copy(active) : null;
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
            const request = byId.get(idByCallSid.get(callSid));
            if (!request) return null;
            return writeUnlocked({ ...request, lastSocketAt: now() });
        });
    }

    async function release(callSid) {
        return serialize(async () => {
            const request = byId.get(idByCallSid.get(callSid));
            return request ? releaseUnlocked(request, now(), recordsForPhone(request.phone, request.eventName)) : null;
        });
    }

    async function menuFallback({ phone, eventName }) {
        return serialize(async () => {
            const normalized = normalizePhone(phone);
            const at = now();
            const records = recordsForPhone(normalized, eventName)
                .filter((request) => Number(request.expiresAt) > at);
            const activeCall = records.find((request) => request.status === "claimed");
            if (activeCall) return { status: "in_call", request: copy(activeCall) };
            const eligible = records.filter((request) => ["received", "preflighting", "inviting", "awaiting_call", "menu_fallback"].includes(request.status))
                .sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
            const request = eligible[0];
            if (!request) return { status: "none" };
            if (!["awaiting_call", "menu_fallback"].includes(request.status) || !request.stagedInputPath) return { status: "not_ready" };
            try { await fsp.access(request.stagedInputPath); }
            catch { return { status: "not_ready" }; }
            if (request.status === "menu_fallback") {
                const startedAt = Number.isFinite(request.menuFallbackAt) ? request.menuFallbackAt : at;
                const expiresAt = Math.min(at + MENU_IDLE_MS, startedAt + MENU_MAX_MS);
                if (expiresAt <= at) return { status: "none" };
                const next = await writeUnlocked({ ...request, menuFallbackAt: startedAt, expiresAt });
                return { status: "ready", request: next };
            }
            const next = await writeUnlocked({ ...request, status: "menu_fallback",
                menuFallbackAt: at, expiresAt: at + MENU_IDLE_MS, callSid: null });
            return { status: "ready", request: next };
        });
    }

    async function touchMenuFallback(requestId, eventName) {
        return serialize(async () => {
            const request = await readUnlocked(requestId);
            if (!request || request.status !== "menu_fallback" || request.eventName !== eventName) return null;
            const at = now();
            const startedAt = Number(request.menuFallbackAt);
            const expiry = Math.min(Number(request.expiresAt), startedAt + MENU_MAX_MS);
            if (!Number.isFinite(expiry) || expiry <= at || !request.stagedInputPath) {
                await writeUnlocked({ ...request, status: "expired" });
                await removePrivateMedia(request);
                return null;
            }
            try { await fsp.access(request.stagedInputPath); }
            catch {
                await writeUnlocked({ ...request, status: "expired" });
                return null;
            }
            return writeUnlocked({ ...request, expiresAt: Math.min(at + MENU_IDLE_MS, startedAt + MENU_MAX_MS) });
        });
    }

    async function completeMenuFallback(requestId, jobPrefix) {
        return serialize(async () => {
            const request = await readUnlocked(requestId);
            if (!request || request.status !== "menu_fallback") return null;
            const next = await writeUnlocked({ ...request, status: "menu_queued", menuJobPrefix: jobPrefix,
                menuQueuedAt: now() });
            await removePrivateMedia(next);
            return next;
        });
    }

    async function reconcileClaims(activeCallSids = new Set(), at = now()) {
        return serialize(async () => {
            const active = new Set(activeCallSids);
            const released = [];
            for (const requestId of new Set(idByCallSid.values())) {
                const request = byId.get(requestId);
                if (!request || active.has(request.callSid)) continue;
                const lastSeen = request.lastSocketAt || request.claimedAt || 0;
                if (at - lastSeen < CLAIM_LEASE_MS) continue;
                await releaseUnlocked(request, at, recordsForPhone(request.phone, request.eventName));
                released.push(request.id);
            }
            return released;
        });
    }

    async function supersedeOlder(requestId) {
        return serialize(async () => {
            const current = byId.get(requestId);
            if (!current) return [];
            const records = recordsForPhone(current.phone, current.eventName);
            const changed = [];
            for (const request of records) {
                if (request.id === requestId || request.receivedAt >= current.receivedAt
                    || !["received", "preflighting", "inviting", "awaiting_call", "menu_fallback"].includes(request.status)) continue;
                await writeUnlocked({ ...request, status: "superseded" });
                await removePrivateMedia(request);
                changed.push(request.id);
            }
            return changed;
        });
    }

    async function findLatest({ phone, eventName, statuses = ["awaiting_call", "claimed", "queued"] }) {
        await ensureLoaded();
        const normalized = normalizePhone(phone);
        const at = now();
        const records = recordsForPhone(normalized, eventName).filter((request) => statuses.includes(request.status)
            && (!PENDING_STATUSES.has(request.status) || Number(request.expiresAt) > at));
        records.sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
        return copy(records[0]);
    }

    async function expire({ activeEventName, activeCallSids = new Set() } = {}) {
        return serialize(async () => {
            const at = now();
            const changed = [];
            for (const requestId of Array.from(pendingIds)) {
                const request = byId.get(requestId);
                if (!request) continue;
                if (request.status === "claimed" && activeCallSids.has(request.callSid)
                    && request.eventName === activeEventName) continue;
                const switched = activeEventName && request.eventName !== activeEventName;
                let expiry = Number.isFinite(request.expiresAt)
                    ? request.expiresAt : Number(request.receivedAt) + 1_800_000;
                if (request.status === "menu_fallback" && Number.isFinite(request.menuFallbackAt)) {
                    expiry = Math.min(expiry, request.menuFallbackAt + MENU_MAX_MS);
                }
                if (!switched && expiry > at) continue;
                const next = { ...request, status: switched ? "superseded" : "expired", callSid: null };
                await writeUnlocked(next);
                await removePrivateMedia(next);
                changed.push(next.id);
            }
            return changed;
        });
    }

    async function list() {
        await ensureLoaded();
        return Array.from(byId.values(), copy);
    }

    return { record, get, patch, claimLatest, touchCall, release, reconcileClaims,
        menuFallback, touchMenuFallback, completeMenuFallback,
        supersedeOlder, findLatest, list, expire };
}

module.exports = { createVoiceStore, normalizePhone, idForSid };
