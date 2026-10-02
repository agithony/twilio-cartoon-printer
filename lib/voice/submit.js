const fs = require("node:fs/promises");
const path = require("node:path");
const { formatTimestamp } = require("../config");
const { normalizeLocale } = require("../i18n");
const { isUnlimitedQuota } = require("../settings");

const BRIEF_FIELDS = ["visualStyle", "clothingOrSubject", "setting", "mood", "importantDetails", "preserve"];
const DEFAULT_MEDIA_DIR = path.join(__dirname, "..", "..", "data", "voice-media");

function canonicalBrief(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Voice brief is not approved");
    const result = {};
    for (const key of BRIEF_FIELDS) {
        if (typeof value[key] !== "string" || value[key].length > 500) throw new Error("Voice brief is not approved");
        result[key] = value[key].trim();
    }
    if (Object.values(result).every((text) => !text)) throw new Error("Voice brief is not approved");
    return result;
}

async function cleanupPrivateInput(request, mediaDir) {
    if (!request.stagedInputPath) return;
    const root = path.resolve(mediaDir);
    const candidate = path.resolve(request.stagedInputPath);
    if (!candidate.startsWith(`${root}${path.sep}`)) return;
    await fs.unlink(candidate).catch((error) => {
        if (error.code !== "ENOENT") throw error;
    });
}

async function submitVoiceEdit({ store, requestId, brief, locale, queue,
    settings = require("../settings"), now = Date.now, mediaDir = DEFAULT_MEDIA_DIR } = {}) {
    if (!store || !queue || !requestId) throw new Error("Voice submission dependencies are missing");
    let request = await store.get(requestId);
    if (!request) throw new Error("Voice request not found");
    const groupId = `${formatTimestamp(request.receivedAt)}_voice_${request.id.slice(0, 16)}`;
    if (request.status === "queued") {
        const group = await queue.getVoiceGroup(groupId);
        if (!group || group.status !== "committed") throw new Error("Queued Voice group is missing");
        return group;
    }
    if (!["claimed", "submitting"].includes(request.status)) throw new Error("Voice request must be claimed");
    const approved = canonicalBrief(request.approvedBrief);
    const submitted = canonicalBrief(brief || request.brief);
    if (!request.policyOutcome?.approved || JSON.stringify(approved) !== JSON.stringify(submitted)) {
        throw new Error("Voice brief is not approved");
    }
    const chosenLocale = normalizeLocale(locale || request.locale);
    if (!chosenLocale) throw new Error("A supported Voice locale is required");

    if (request.status === "claimed") {
        if (request.eventName !== settings.get("eventName")) throw new Error("Voice request belongs to another active event");
        if (Number(request.expiresAt) <= now()) throw new Error("Voice request expired");
        const maxPrints = Number(request.eventSettings?.maxPrints
            ?? settings.getForEvent?.("maxPrints", request.eventName) ?? 0);
        const isAdmin = (settings.getForEvent?.("adminPhones", request.eventName) || []).includes(request.phone);
        if (!isAdmin && !isUnlimitedQuota(maxPrints) && request.eventName.toLowerCase() !== "testing"
            && queue.getUsageCount(request.phone, request.eventName) >= maxPrints) {
            throw new Error("Voice portrait quota exhausted");
        }
        const submitting = await store.patch(request.id, {
            status: "submitting", groupId, brief: approved, locale: chosenLocale,
            submittedAt: now(),
        }, { ifStatus: "claimed" });
        request = submitting || await store.get(request.id);
        if (request.status === "queued") return queue.getVoiceGroup(groupId);
        if (request.status !== "submitting") throw new Error("Voice request is no longer claimed");
    }

    const group = await queue.enqueueVoiceGroup({ request, brief: request.brief || approved,
        locale: request.locale || chosenLocale, groupId });
    if (!group || group.status !== "committed" || group.jobs.length !== group.filePrefixes.length) {
        throw new Error("Voice group was not durably committed");
    }
    await store.patch(request.id, { status: "queued", groupId, queuedAt: now() }, { ifStatus: "submitting" });
    await cleanupPrivateInput(request, mediaDir);
    return group;
}

async function recoverVoiceSubmissions({ store, queue, settings = require("../settings"),
    mediaDir = DEFAULT_MEDIA_DIR } = {}) {
    if (!store || !queue) throw new Error("Voice submission recovery dependencies are missing");
    const pending = (await store.list()).filter((request) => request.status === "submitting");
    const recovered = [];
    for (const request of pending) {
        try {
            await submitVoiceEdit({ store, queue, settings, mediaDir, requestId: request.id,
                brief: request.brief, locale: request.locale });
            recovered.push(request.id);
        } catch (error) {
            console.error(`Voice submission ${request.id} will retry: ${String(error.message || error).slice(0, 120)}`);
        }
    }
    return recovered;
}

module.exports = { submitVoiceEdit, recoverVoiceSubmissions, canonicalBrief };
