const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const sharp = require("sharp");
const channels = require("../channels");
const helpers = require("../helpers");
const i18n = require("../i18n");
const messaging = require("../messaging");
const { atomicWriteFile } = require("../atomic-write");
const { normalizePhone } = require("./store");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 30_000_000;
const INTAKE_MS = 30 * 60 * 1000;
const SESSION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEDIA_DIR = path.join(__dirname, "..", "..", "data", "voice-media");

class RejectedPhoto extends Error {
    constructor(reason) { super(reason); this.reason = reason; }
}

async function assessImageStrict(base64) {
    const [moderation, hasFace, description] = await Promise.all([
        helpers.moderateImage(base64, { strict: true }),
        helpers.detectPerson(base64, { strict: true }),
        helpers.analyzeScene(base64, { strict: true }),
    ]);
    if (!/^Subjects:\s*\d+/im.test(description)) throw new Error("Scene analysis unavailable");
    return { flagged: moderation.flagged, hasFace, scene: helpers.parseScene(description) };
}

function createVoiceIntake({ store, downloadImage = helpers.downloadImage,
    assessImage = assessImageStrict, send = messaging.send, settings = require("../settings"),
    now = Date.now, mediaDir = DEFAULT_MEDIA_DIR } = {}) {
    if (!store) throw new Error("Voice intake requires a store");
    const privateMediaDir = path.resolve(mediaDir);
    let recovery = null;

    async function cleanupStaged(request) {
        if (!request?.stagedInputPath) return;
        const candidate = path.resolve(request.stagedInputPath);
        if (candidate.startsWith(`${privateMediaDir}${path.sep}`)) {
            await fs.unlink(candidate).catch((error) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }

    async function acceptSelfie(payload) {
        if (!payload?.messageSid) throw new Error("Voice selfie needs MessageSid");
        const channel = payload.channel || (String(payload.phone).startsWith("whatsapp:") ? "whatsapp" : "sms");
        if (!channels.ADAPTERS[channel]) throw new Error("Unsupported Voice intake channel");
        const receivedAt = Number.isFinite(payload.receivedAt) ? payload.receivedAt : now();
        const request = await store.record({
            messageSid: payload.messageSid,
            phone: normalizePhone(payload.phone),
            appPhone: normalizePhone(payload.appPhone),
            channel,
            eventName: payload.eventName,
            locale: payload.locale || null,
            eventSettings: payload.eventSettings || {},
            imageUrl: payload.MediaUrl0 || payload.imageUrl || null,
            imageContentType: payload.MediaContentType0 || payload.imageContentType || null,
            receivedAt,
            expiresAt: receivedAt + INTAKE_MS,
        });
        await store.supersedeOlder(request.id);
        return request;
    }

    async function sendNotice(request, key) {
        const adapter = channels.ADAPTERS[request.channel];
        if (!adapter) return false;
        const locale = i18n.normalizeLocale(request.locale) || "en";
        const outsideWindow = request.channel === "whatsapp" && now() - request.receivedAt >= SESSION_MS;
        let result;
        try {
            if (outsideWindow) {
                const contentSid = settings.getContentSid?.("voiceFailure", locale);
                if (!contentSid) return false;
                result = await send(request.phone, "voiceFailure", {}, {
                    adapter, locale, contentSid, allowOutOfSession: true, fromPhone: request.appPhone,
                });
            } else {
                const body = i18n.voiceText(request.locale, key);
                result = await send(request.phone, "_raw", {}, {
                    adapter, locale, _body: body, fromPhone: request.appPhone,
                });
            }
        } catch (error) {
            result = { error: error.message };
        }
        if (!result?.sid) {
            await store.patch(request.id, { lastNoticeError: result?.error || result?.skipped || "send failed" });
            return false;
        }
        await store.patch(request.id, { noticePending: false, noticeSid: result.sid });
        return true;
    }

    async function reject(request, reason) {
        const updated = await store.patch(request.id, {
            status: "rejected", failureReason: reason, noticePending: true,
        }, { ifStatus: ["received", "preflighting", "inviting"] });
        if (updated) {
            await cleanupStaged(updated);
            await sendNotice(updated, ["group", "expired", "noFace"].includes(reason) ? reason : "invalid");
        }
    }

    async function stageImage(request) {
        const stagedInputPath = path.join(privateMediaDir, `${request.id}.jpg`);
        try {
            const existing = await fs.readFile(stagedInputPath);
            if ((await sharp(existing).metadata()).format === "jpeg") return stagedInputPath;
        } catch (error) {
            if (error.code !== "ENOENT") await fs.unlink(stagedInputPath).catch(() => {});
        }
        if (!request.imageUrl || !/^image\/(jpeg|png)$/i.test(request.imageContentType || "")) {
            throw new RejectedPhoto("invalid-media");
        }
        await fs.mkdir(privateMediaDir, { recursive: true });
        const downloadPath = path.join(privateMediaDir, `${request.id}.download.${randomUUID()}`);
        try {
            await downloadImage(request.imageUrl, downloadPath);
            const stat = await fs.stat(downloadPath);
            if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new RejectedPhoto("invalid-media");
            let jpeg;
            try {
                const input = sharp(downloadPath, { limitInputPixels: MAX_PIXELS, failOnError: true });
                const metadata = await input.metadata();
                if (!["jpeg", "png"].includes(metadata.format)
                    || metadata.width * metadata.height > MAX_PIXELS) throw new RejectedPhoto("invalid-media");
                jpeg = await input.rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
            } catch (error) {
                if (error instanceof RejectedPhoto) throw error;
                throw new RejectedPhoto("invalid-media");
            }
            await atomicWriteFile(stagedInputPath, jpeg);
            return stagedInputPath;
        } catch (error) {
            if (/too large|exceeded.*limit/i.test(error.message)) throw new RejectedPhoto("invalid-media");
            throw error;
        } finally {
            await fs.unlink(downloadPath).catch(() => {});
        }
    }

    async function preflight(request) {
        if (request.eventName !== settings.get("eventName")) {
            await store.patch(request.id, { status: "superseded" });
            await cleanupStaged(request);
            return;
        }
        if (now() - request.receivedAt >= INTAKE_MS) {
            await reject(request, "expired");
            return;
        }
        if (request.status === "received") {
            request = await store.patch(request.id, { status: "preflighting" }, { ifStatus: "received" });
            if (!request) return;
        }
        try {
            const stagedInputPath = await stageImage(request);
            if (!await store.patch(request.id, { stagedInputPath }, { ifStatus: "preflighting" })) {
                await cleanupStaged({ stagedInputPath });
                return;
            }
            const assessment = await assessImage((await fs.readFile(stagedInputPath)).toString("base64"));
            if (!assessment || typeof assessment.flagged !== "boolean" || typeof assessment.hasFace !== "boolean"
                || !Number.isInteger(assessment.scene?.subjects) || assessment.scene.subjects < 1) {
                throw new Error("Image assessment unavailable");
            }
            if (assessment.flagged) throw new RejectedPhoto("moderation");
            if (!assessment.hasFace) throw new RejectedPhoto("no-face");
            if (request.eventSettings.multiSubjectMode === "reject" && assessment.scene.subjects > 1) {
                throw new RejectedPhoto("group");
            }
            const scene = {
                subjects: assessment.scene.subjects,
                pets: String(assessment.scene.pets || "none").slice(0, 100),
                positions: String(assessment.scene.positions || "centered").slice(0, 100),
            };
            const inviting = await store.patch(request.id, { status: "inviting", scene }, { ifStatus: "preflighting" });
            if (!inviting) {
                await cleanupStaged({ stagedInputPath });
                return;
            }
            await invite(inviting);
        } catch (error) {
            if (error instanceof RejectedPhoto) {
                await reject(request, error.reason);
                return;
            }
            const current = await store.get(request.id);
            if (!current.retryNoticeSent) {
                const sent = await sendNotice(current, "retry");
                if (sent) await store.patch(request.id, { retryNoticeSent: true });
            }
            await store.patch(request.id, { lastPreflightError: String(error.message).slice(0, 120) });
        }
    }

    async function invite(request) {
        if (!request || request.status !== "inviting") return;
        if (request.eventName !== settings.get("eventName")) {
            await store.patch(request.id, { status: "superseded" });
            await cleanupStaged(request);
            return;
        }
        if (now() - request.receivedAt >= INTAKE_MS) {
            await reject(request, "expired");
            return;
        }
        const body = i18n.voiceText(request.locale, "invitation", { number: settings.get("twilioVoiceNumber") });
        let result;
        try {
            result = await send(request.phone, "_raw", {}, {
                adapter: channels.ADAPTERS[request.channel],
                locale: request.locale || "en", _body: body, fromPhone: request.appPhone,
            });
        } catch (error) {
            result = { error: error.message };
        }
        if (result?.sid) {
            await store.patch(request.id, {
                status: "awaiting_call", invitationSid: result.sid,
                invitedAt: now(), expiresAt: now() + INTAKE_MS,
            }, { ifStatus: "inviting" });
        } else {
            await store.patch(request.id, { lastInvitationError: result?.error || result?.skipped || "send failed" });
        }
    }

    async function runRecovery() {
        const pending = (await store.list()).filter((request) =>
            ["received", "preflighting", "inviting"].includes(request.status)
            || (request.status === "rejected" && request.noticePending));
        pending.sort((a, b) => a.receivedAt - b.receivedAt);
        for (const request of pending) {
            if (request.status === "rejected") {
                await sendNotice(request, ["group", "expired", "noFace"].includes(request.failureReason)
                    ? request.failureReason : "invalid");
            } else if (request.status === "inviting") await invite(request);
            else await preflight(request);
        }
    }

    function recover() {
        if (recovery) return recovery;
        recovery = runRecovery().finally(() => { recovery = null; });
        return recovery;
    }

    return { acceptSelfie, recover };
}

module.exports = { createVoiceIntake, assessImageStrict };
