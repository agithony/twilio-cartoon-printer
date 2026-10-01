const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createVoiceStore } = require("../lib/voice/store");
const { createVoiceIntake } = require("../lib/voice/preflight");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 1, 12);
let sequence = 0;

async function image(format = "jpeg") {
    const input = sharp({ create: { width: 64, height: 64, channels: 4, background: "#c08080" } });
    return input[format]().toBuffer();
}

async function fixture(overrides = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-preflight-"));
    const mediaDir = path.join(dir, "voice-media");
    const sent = [];
    let time = NOW;
    let activeEvent = "Demo";
    const store = createVoiceStore({ dir: path.join(dir, "requests"), mediaDir, now: () => time });
    const settings = {
        get(key) { return key === "eventName" ? activeEvent : key === "twilioVoiceNumber" ? "+12065550100" : null; },
        getContentSid(key, locale) { return key === "voiceFailure" ? `HXfailure-${locale}` : null; },
    };
    const bytes = overrides.bytes || await image(overrides.format || "jpeg");
    const downloadImage = overrides.downloadImage || (async (_url, target) => fs.writeFile(target, bytes));
    const assessImage = overrides.assessImage || (async () => ({ flagged: false, hasFace: true, scene: { subjects: 1, pets: "none", positions: "centered" } }));
    const send = overrides.send || (async (...args) => { sent.push(args); return { sid: `SMout${sent.length}` }; });
    const intake = createVoiceIntake({ store, downloadImage, assessImage, send, settings, now: () => time, mediaDir });
    const selfie = {
        messageSid: `SMin${++sequence}`, phone: "+14155550123", appPhone: "+12065550199",
        channel: "sms", eventName: "Demo", locale: "en", receivedAt: time,
        MediaUrl0: "https://api.twilio.com/media/one", MediaContentType0: "image/jpeg",
        eventSettings: { multiSubjectMode: "reject" },
    };
    return {
        dir, mediaDir, sent, store, settings, intake, selfie,
        setTime(value) { time = value; },
        setEvent(value) { activeEvent = value; },
        cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
}

test("a selfie is durable before ACK, normalized to real JPEG, then invited on its original channel", async (t) => {
    const f = await fixture({ format: "png" }); t.after(f.cleanup);
    const selfie = { ...f.selfie, MediaContentType0: "image/png" };
    const accepted = await f.intake.acceptSelfie(selfie);
    assert.equal(accepted.status, "received");
    assert.equal(f.sent.length, 0);
    await f.intake.recover();
    const record = await f.store.get(accepted.id);
    assert.equal(record.status, "awaiting_call");
    assert.equal(record.scene.subjects, 1);
    assert.equal(record.invitationSid, "SMout1");
    assert.equal((await sharp(record.stagedInputPath).metadata()).format, "jpeg");
    assert.equal(f.sent[0][3].fromPhone, selfie.appPhone);
    assert.equal(f.sent[0][3].adapter.name, "sms");
    assert.match(f.sent[0][3]._body, /call.*\+12065550100/i);
    await f.intake.acceptSelfie(selfie);
    await f.intake.recover();
    assert.equal(f.sent.length, 1);
});

test("unknown locale receives a bilingual invitation", async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const record = await f.intake.acceptSelfie({ ...f.selfie, locale: null });
    await f.intake.recover();
    assert.equal((await f.store.get(record.id)).status, "awaiting_call");
    assert.match(f.sent[0][3]._body, /call.*\+12065550100/i);
    assert.match(f.sent[0][3]._body, /ligue.*\+12065550100/i);
});

test("group selfie is rejected before invitation with localized notice", async (t) => {
    const f = await fixture({ assessImage: async () => ({ flagged: false, hasFace: true, scene: { subjects: 2 } }) }); t.after(f.cleanup);
    const record = await f.intake.acceptSelfie({ ...f.selfie, locale: "pt_BR", channel: "whatsapp" });
    await f.intake.recover();
    const stored = await f.store.get(record.id);
    assert.equal(stored.status, "rejected");
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0][3]._body, /grupo/i);
    assert.equal(f.sent[0][3].adapter.name, "whatsapp");
    await f.intake.recover();
    assert.equal(f.sent.length, 1);
});

test("invalid type, invalid bytes, oversized image, flagged image, and missing face never invite", async (t) => {
    const cases = [
        { contentType: "image/gif" },
        { missingUrl: true },
        { bytes: Buffer.from("not an image") },
        { bytes: Buffer.alloc(20 * 1024 * 1024 + 1) },
        { assessImage: async () => ({ flagged: true, hasFace: true, scene: { subjects: 1 } }) },
        { assessImage: async () => ({ flagged: false, hasFace: false, scene: { subjects: 1 } }) },
    ];
    for (const item of cases) {
        const f = await fixture(item); t.after(f.cleanup);
        const record = await f.intake.acceptSelfie({ ...f.selfie, MediaContentType0: item.contentType || "image/jpeg",
            MediaUrl0: item.missingUrl ? null : f.selfie.MediaUrl0 });
        await f.intake.recover();
        assert.equal((await f.store.get(record.id)).status, "rejected");
        assert.equal(f.sent.length, 1);
        assert.doesNotMatch(f.sent[0][3]._body, /call|ligue/i);
    }
});

test("uncertain image assessment fails closed and recovers without repeated notice", async (t) => {
    let attempts = 0;
    const f = await fixture({ assessImage: async () => {
        if (++attempts === 1) throw new Error("vision unavailable");
        return { flagged: false, hasFace: true, scene: { subjects: 1 } };
    } }); t.after(f.cleanup);
    const record = await f.intake.acceptSelfie(f.selfie);
    await f.intake.recover();
    assert.equal((await f.store.get(record.id)).status, "preflighting");
    assert.equal(f.sent.length, 1);
    assert.doesNotMatch(f.sent[0][3]._body, /call/i);
    await f.intake.recover();
    assert.equal((await f.store.get(record.id)).status, "awaiting_call");
    assert.equal(f.sent.length, 2);
});

test("event switch suppresses invitation", async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const record = await f.intake.acceptSelfie(f.selfie);
    f.setEvent("Next Event");
    await f.intake.recover();
    assert.equal((await f.store.get(record.id)).status, "superseded");
    assert.equal(f.sent.length, 0);
});

test("failed invitation resumes from durable state after restart", async (t) => {
    let attempts = 0;
    const f = await fixture({ send: async (...args) => {
        f.sent.push(args);
        return ++attempts === 1 ? { error: "offline" } : { sid: "SMretry" };
    } }); t.after(f.cleanup);
    const record = await f.intake.acceptSelfie(f.selfie);
    await f.intake.recover();
    assert.equal((await f.store.get(record.id)).status, "inviting");
    const restarted = createVoiceIntake({ store: f.store,
        downloadImage: async () => { throw new Error("should reuse staging"); },
        assessImage: async () => { throw new Error("should reuse assessment"); },
        send: async (...args) => { f.sent.push(args); return { sid: "SMretry" }; },
        settings: f.settings, now: () => NOW, mediaDir: f.mediaDir });
    await restarted.recover();
    assert.equal((await f.store.get(record.id)).status, "awaiting_call");
    assert.equal(f.sent.length, 2);
});

test("stale received WhatsApp record uses approved failure template and never invites", async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const record = await f.intake.acceptSelfie({ ...f.selfie, channel: "whatsapp", receivedAt: NOW - 25 * HOUR });
    await f.intake.recover();
    const stored = await f.store.get(record.id);
    assert.equal(stored.status, "rejected");
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0][1], "voiceFailure");
    assert.equal(f.sent[0][3].contentSid, "HXfailure-en");
    assert.equal(f.sent[0][3].allowOutOfSession, true);
});

test("strict image helper errors are rethrown after module reload; menu defaults still fail open", async () => {
    const configPath = require.resolve("../lib/config");
    const helpersPath = require.resolve("../lib/helpers");
    const config = require(configPath);
    const original = { getOpenAI: config.getOpenAI, getModels: config.getModels };
    config.getOpenAI = () => ({
        moderations: { create: async () => { throw new Error("moderation offline"); } },
        responses: { create: async () => { throw new Error("vision offline"); } },
    });
    config.getModels = () => ({ visionLight: "stub" });
    delete require.cache[helpersPath];
    try {
        const reloaded = require(helpersPath);
        await assert.rejects(() => reloaded.moderateImage("abc", { strict: true }), /moderation offline/);
        await assert.rejects(() => reloaded.detectPerson("abc", { strict: true }), /vision offline/);
        await assert.rejects(() => reloaded.analyzeScene("abc", { strict: true }), /vision offline/);
        assert.equal((await reloaded.moderateImage("abc")).flagged, false);
        assert.equal(await reloaded.detectPerson("abc"), true);
        assert.equal(await reloaded.analyzeScene("abc"), "");
    } finally {
        Object.assign(config, original);
        delete require.cache[helpersPath];
        require(helpersPath);
    }
});
