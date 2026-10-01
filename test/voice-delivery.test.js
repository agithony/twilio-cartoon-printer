const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createVoiceDelivery } = require("../lib/voice/delivery");
const { READY_DIR, PRINTING_DIR, REVIEW_DIR, DONE_DIR, FAILED_DIR } = require("../lib/config");
const queue = require("../lib/queue");
const messaging = require("../lib/messaging");
const leads = require("../lib/leads");
const settings = require("../lib/settings");
const { jobPaths } = require("../lib/pipeline");
const sharp = require("sharp");
const { buildDefinitions, approvalCategories } = require("../scripts/create-content-templates");

let seq = 0;
function voiceJob(overrides = {}) {
    return {
        inputMode: "voice", voiceGroupId: `group-${++seq}`, filePrefix: `voice-test-${seq}`,
        userPhone: "+14155550123", appPhone: "+12065550199", eventName: "VoiceDemo",
        channel: "whatsapp", locale: "pt_BR", baseUrl: "https://booth.example",
        voiceEventSettings: { enablePrinting: true, immediateDigitalDelivery: false, leadCaptureMode: "after" },
        ...overrides,
    };
}

test("late WhatsApp result uses the approved media card and original sender", async () => {
    const sent = [];
    const delivery = createVoiceDelivery({
        settings: { getContentSid(key, locale) { return key === "voiceDelivery" && locale === "pt_BR" ? "HXapproved" : null; } },
        send: async (...args) => { sent.push(args); return { sid: "SMdelivered" }; },
    });
    const result = await delivery.sendVoiceDelivery(voiceJob());
    assert.equal(result.sid, "SMdelivered");
    assert.equal(sent[0][1], "voiceDelivery");
    assert.equal(sent[0][3].contentSid, "HXapproved");
    assert.equal(sent[0][3].allowOutOfSession, true);
    assert.equal(sent[0][3].fromPhone, "+12065550199");
    assert.equal(sent[0][3].adapter.name, "whatsapp");
    assert.match(sent[0][3].contentVariables[1], /\/img\?/);
    assert.equal(sent.some((entry) => entry[1] === "_raw"), false);
});

test("missing or failed WhatsApp Content SID never falls back to raw, including terminal failure", async () => {
    const sent = [];
    const missing = createVoiceDelivery({
        settings: { getContentSid() { return null; } },
        send: async (...args) => { sent.push(args); return { sid: "SHOULD-NOT-SEND" }; },
    });
    await assert.rejects(() => missing.sendVoiceDelivery(voiceJob()), /approved voiceDelivery/i);
    await assert.rejects(() => missing.sendVoiceFailure(voiceJob(), "generation"), /approved voiceFailure/i);
    assert.equal(sent.length, 0);
    const failed = createVoiceDelivery({
        settings: { getContentSid() { return "HXapproved"; } },
        send: async (...args) => { sent.push(args); return { error: "Twilio unavailable" }; },
    });
    await assert.rejects(() => failed.sendVoiceDelivery(voiceJob()), /Twilio unavailable/);
    await assert.rejects(() => failed.sendVoiceFailure(voiceJob(), "review_rejected"), /Twilio unavailable/);
    assert.equal(sent.every((entry) => entry[1] !== "_raw"), true);
});

test("SMS Voice result and failure stay in the selfie conversation", async () => {
    const sent = [];
    const delivery = createVoiceDelivery({ send: async (...args) => { sent.push(args); return { sid: "SMok" }; } });
    await delivery.sendVoiceDelivery(voiceJob({ channel: "sms", locale: "en" }));
    await delivery.sendVoiceFailure(voiceJob({ channel: "sms", locale: "en" }), "generation");
    assert.deepEqual(sent.map((entry) => entry[1]), ["_raw", "_raw"]);
    assert.equal(sent[0][3].fromPhone, "+12065550199");
    assert.match(sent[0][3].mediaUrl, /\/mms\?/);
    assert.match(sent[0][3]._body, /portrait/i);
    assert.equal(sent[1][3].mediaUrl, undefined);
});

test("ready, done, and failed Voice sends remain pending after failure and recover once", async (t) => {
    const originalSend = messaging.send;
    let attempts = 0;
    messaging.send = async () => (++attempts % 2) === 1 ? { error: "temporary" } : { sid: `SMok${attempts}` };
    t.after(() => { messaging.send = originalSend; });
    const cases = [
        { dir: READY_DIR, kind: "result" },
        { dir: PRINTING_DIR, kind: "result" },
        { dir: DONE_DIR, kind: "result" },
        { dir: FAILED_DIR, kind: "failure" },
    ];
    for (const item of cases) {
        const job = voiceJob({ channel: "sms", locale: "en", voiceEventSettings: { enablePrinting: item.dir === READY_DIR } });
        const filename = `${job.filePrefix}.json`;
        await fs.mkdir(item.dir, { recursive: true });
        const file = path.join(item.dir, filename);
        await fs.writeFile(file, JSON.stringify({ ...job, voiceDeliveryKind: item.kind,
            voiceDeliveryState: "pending", voiceDeliveryPendingAt: Date.now() }));
        t.after(() => fs.rm(file, { force: true }));
        await queue.retryVoiceDelivery(filename);
        let stored = JSON.parse(await fs.readFile(file, "utf8"));
        assert.equal(stored.voiceDeliveryState, "pending");
        assert.equal(stored.smsSentAt, undefined);
        assert.equal(stored.voiceDeliveryAttempts, 1);
        assert.match(stored.voiceDeliveryLastError, /temporary/);
        await queue.sweepVoiceDeliveries();
        stored = JSON.parse(await fs.readFile(file, "utf8"));
        assert.equal(stored.voiceDeliveryAttempts, 1, "backoff should prevent an immediate retry");
        await queue.retryVoiceDelivery(filename);
        stored = JSON.parse(await fs.readFile(file, "utf8"));
        assert.equal(stored.voiceDeliveryState, "sent");
        assert.ok(stored.voiceDeliverySid);
        assert.ok(stored.smsSentAt);
        assert.equal(stored.voiceDeliveryAttempts, 2);
    }
});

test("approved Voice review sends the digital portrait before printing even when immediate delivery is off", async (t) => {
    const sent = [];
    const originalSend = messaging.send;
    messaging.send = async (...args) => { sent.push(args); return { sid: "SMreview" }; };
    t.after(() => { messaging.send = originalSend; });
    const job = voiceJob({ channel: "sms", locale: "en", voiceEventSettings: {
        reviewMode: "human", enablePrinting: true, immediateDigitalDelivery: false,
        leadCaptureMode: "disabled", enableNps: false,
    } });
    const filename = `${job.filePrefix}.json`;
    const reviewPath = path.join(REVIEW_DIR, filename);
    const readyPath = path.join(READY_DIR, filename);
    const staged = jobPaths(job, { staged: true });
    const final = jobPaths(job);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#eeeeee" } }).jpeg().toBuffer();
    const png = await sharp(jpeg).png().toBuffer();
    await fs.mkdir(REVIEW_DIR, { recursive: true });
    await fs.writeFile(reviewPath, JSON.stringify(job));
    await fs.writeFile(staged.inputPath, jpeg);
    await fs.writeFile(staged.outputPath, png);
    await fs.writeFile(staged.mmsPath, jpeg);
    t.after(async () => {
        await fs.rm(reviewPath, { force: true }); await fs.rm(readyPath, { force: true });
        await fs.rm(settings.getDownloadDir(job.eventName), { recursive: true, force: true });
    });
    await queue.approveJob(filename);
    const stored = JSON.parse(await fs.readFile(readyPath, "utf8"));
    assert.equal(stored.voiceDeliveryState, "sent");
    assert.equal(stored.smsSentAt > 0, true);
    assert.equal((await fs.stat(final.outputPath)).isFile(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1], "_raw");
    assert.equal(sent[0][3].fromPhone, job.appPhone);
});

test("a Voice review rejection sends the approved WhatsApp failure template after a long delay", async (t) => {
    const sent = [];
    const originalSend = messaging.send;
    const originalSid = settings.getContentSid;
    messaging.send = async (...args) => { sent.push(args); return { sid: "SMfailure" }; };
    settings.getContentSid = (key) => key === "voiceFailure" ? "HXfailure" : null;
    t.after(() => { messaging.send = originalSend; settings.getContentSid = originalSid; });
    const job = voiceJob({ channel: "whatsapp", locale: "pt_BR", voiceEventSettings: {
        reviewMode: "human", enablePrinting: false, leadCaptureMode: "disabled", enableNps: false,
    } });
    const filename = `${job.filePrefix}.json`;
    const reviewPath = path.join(REVIEW_DIR, filename);
    const failedPath = path.join(FAILED_DIR, filename);
    await fs.mkdir(REVIEW_DIR, { recursive: true });
    await fs.writeFile(reviewPath, JSON.stringify(job));
    t.after(async () => { await fs.rm(reviewPath, { force: true }); await fs.rm(failedPath, { force: true }); });
    await queue.rejectJob(filename, true, false, null);
    await queue.retryVoiceDelivery(filename);
    const stored = JSON.parse(await fs.readFile(failedPath, "utf8"));
    assert.equal(stored.voiceDeliveryState, "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1], "voiceFailure");
    assert.equal(sent[0][3].contentSid, "HXfailure");
    assert.equal(sent[0][3].allowOutOfSession, true);
    assert.equal(sent[0][3].fromPhone, job.appPhone);
});

test("after-delivery survey starts only after the Voice result is accepted", async (t) => {
    const events = [];
    const originalSend = messaging.send;
    const originalSurvey = leads.startSurvey;
    messaging.send = async () => { events.push("portrait"); return { sid: "SMportrait" }; };
    leads.startSurvey = async () => { events.push("survey"); return { status: "started" }; };
    t.after(() => { messaging.send = originalSend; leads.startSurvey = originalSurvey; });
    const job = voiceJob({ channel: "sms", locale: "en", voiceEventSettings: {
        enablePrinting: true, immediateDigitalDelivery: false, leadCaptureMode: "after", enableNps: false,
    } });
    const filename = `${job.filePrefix}.json`;
    await fs.mkdir(READY_DIR, { recursive: true });
    const file = path.join(READY_DIR, filename);
    await fs.writeFile(file, JSON.stringify({ ...job, voiceDeliveryKind: "result",
        voiceDeliveryState: "pending", voiceDeliveryPendingAt: Date.now() }));
    t.after(() => fs.rm(file, { force: true }));
    await queue.retryVoiceDelivery(filename);
    assert.deepEqual(events.slice(0, 2), ["portrait", "survey"]);
});

test("template script defines approved utility cards and text failures in both locales", () => {
    for (const locale of ["en", "pt_BR"]) {
        const definitions = buildDefinitions("https://booth.example", "s/example/img", locale);
        assert.ok(definitions.voiceDelivery.types["twilio/card"].media.length);
        assert.ok(definitions.voiceFailure.types["twilio/text"].body);
        assert.equal(approvalCategories.voiceDelivery, "UTILITY");
        assert.equal(approvalCategories.voiceFailure, "UTILITY");
    }
});
