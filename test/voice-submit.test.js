const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const settings = require("../lib/settings");
const queue = require("../lib/queue");
const { PENDING_DIR, GENERATING_DIR, READY_DIR, REVIEW_DIR, DONE_DIR, FAILED_DIR, formatTimestamp } = require("../lib/config");
const { jobPaths } = require("../lib/pipeline");
const { createVoiceStore } = require("../lib/voice/store");
const { submitVoiceEdit } = require("../lib/voice/submit");

const BRIEF = {
    visualStyle: "watercolor", clothingOrSubject: "blue jacket", setting: "a garden",
    mood: "warm", importantDetails: "soft light", preserve: "face and glasses",
};
let seq = 0;

async function fixture({ variants = 1, reviewMode = "off" } = {}) {
    const suffix = `${process.pid}-${++seq}`;
    const eventName = `VoiceSubmit${suffix}`;
    const userPhone = `+1415555${String(seq).padStart(4, "0")}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-submit-"));
    const stagedInputPath = path.join(dir, "selfie.jpg");
    await fs.writeFile(stagedInputPath, await sharp({ create: {
        width: 64, height: 64, channels: 3, background: "#cccccc",
    } }).jpeg().toBuffer());
    const now = Date.now();
    const store = createVoiceStore({ dir: path.join(dir, "requests"), mediaDir: dir, now: () => now });
    const eventSettings = {
        maxPrints: 2, reviewMode, variantsPerReview: variants, enablePrinting: true,
        outputProfile: { width: 1500, height: 2100, aiSize: "1024x1536", orientation: "portrait" },
        promptPreserve: "Keep the original freckles.", promptComposition: "Leave room above the head.",
        promptBackground: "Keep the original background.", brandPrompt: "Add the Expo logo on a pin.",
        brandReferenceFiles: [], multiSubjectMode: "reject", aiReviewChecks: { faces: true },
    };
    const request = await store.record({
        messageSid: `SMin${suffix}`, phone: userPhone, appPhone: "+12065550199",
        channel: "sms", eventName, locale: "en", receivedAt: now, expiresAt: now + 1_800_000,
        stagedInputPath, scene: { subjects: 1, pets: "none", positions: "centered" }, eventSettings,
    });
    const claimed = await store.patch(request.id, {
        status: "claimed", callSid: `CA${suffix}`, approvedBrief: BRIEF,
        policyOutcome: { approved: true, code: "approved" },
    });
    const snapshot = {
        get(key) { return key === "eventName" ? eventName : null; },
        getForEvent(key) { return eventSettings[key]; },
    };
    const groupId = `${formatTimestamp(now)}_voice_${request.id.slice(0, 16)}`;
    async function cleanup() {
        const group = await queue.getVoiceGroup(groupId).catch(() => null);
        const prefixes = group?.filePrefixes || [groupId, ...[1, 2, 3].map((n) => `${groupId}-v${n}`)];
        for (const folder of [PENDING_DIR, GENERATING_DIR, READY_DIR, REVIEW_DIR, DONE_DIR, FAILED_DIR]) {
            for (const prefix of prefixes) await fs.rm(path.join(folder, `${prefix}.json`), { force: true });
        }
        await fs.rm(path.join(path.dirname(PENDING_DIR), "voice-groups", `${groupId}.json`), { force: true });
        await fs.rm(settings.getDownloadDir(eventName), { recursive: true, force: true });
        await fs.rm(dir, { recursive: true, force: true });
        await queue.buildUsageCache();
    }
    return { store, request: claimed, eventSettings, eventName, userPhone, snapshot, groupId, cleanup };
}

test("one-variant Voice group is durable, idempotent, and charged once after rebuild", async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const input = { store: f.store, requestId: f.request.id, brief: BRIEF, locale: "pt_BR", queue, settings: f.snapshot };
    const first = await submitVoiceEdit(input);
    assert.equal(first.status, "committed");
    assert.deepEqual(first.filePrefixes, [f.groupId]);
    assert.equal(queue.getUsageCount(f.userPhone, f.eventName), 1);
    const second = await submitVoiceEdit(input);
    assert.deepEqual(second.filePrefixes, first.filePrefixes);
    assert.equal(queue.getUsageCount(f.userPhone, f.eventName), 1);
    const job = JSON.parse(await fs.readFile(path.join(PENDING_DIR, `${f.groupId}.json`), "utf8"));
    assert.equal(job.inputMode, "voice");
    assert.equal(job.locale, "pt_BR");
    assert.equal(job.appPhone, f.request.appPhone);
    assert.equal(job.channel, "sms");
    assert.deepEqual(job.voiceBrief, BRIEF);
    assert.equal((await sharp(jobPaths(job, { staged: true }).inputPath).metadata()).format, "jpeg");
    await queue.buildUsageCache();
    assert.equal(queue.getUsageCount(f.userPhone, f.eventName), 1);
});

test("three variants each have an input copy, and a partial group resumes with identical prefixes", async (t) => {
    const f = await fixture({ variants: 3, reviewMode: "human" }); t.after(f.cleanup);
    f.eventSettings.reviewMode = "off";
    f.eventSettings.variantsPerReview = 1;
    f.eventSettings.brandPrompt = "Changed after intake";
    f.eventSettings.promptComposition = "Changed composition";
    f.eventSettings.enablePrinting = false;
    const first = await submitVoiceEdit({ store: f.store, requestId: f.request.id, brief: BRIEF,
        locale: "en", queue, settings: f.snapshot });
    assert.equal(first.filePrefixes.length, 3);
    assert.equal(first.jobs[0].voiceEventSettings.reviewMode, "human");
    assert.equal(first.jobs[0].voiceEventSettings.brandPrompt, "Add the Expo logo on a pin.");
    assert.equal(first.jobs[0].voiceEventSettings.promptComposition, "Leave room above the head.");
    assert.equal(first.jobs[0].voiceEventSettings.enablePrinting, true);
    const inputPaths = first.jobs.map((job) => jobPaths(job, { staged: true }).inputPath);
    assert.equal(new Set(inputPaths).size, 3);
    for (const inputPath of inputPaths) assert.equal((await sharp(inputPath).metadata()).format, "jpeg");
    assert.equal(queue.getUsageCount(f.userPhone, f.eventName), 1);
    await queue.buildUsageCache();
    assert.equal(queue.getUsageCount(f.userPhone, f.eventName), 1);
    const manifestPath = path.join(path.dirname(PENDING_DIR), "voice-groups", `${f.groupId}.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, status: "preparing" }));
    await fs.rm(path.join(PENDING_DIR, `${first.filePrefixes[2]}.json`));
    const resumed = await queue.enqueueVoiceGroup({ request: f.request, brief: BRIEF, locale: "en", groupId: f.groupId });
    assert.deepEqual(resumed.filePrefixes, first.filePrefixes);
    assert.equal((await queue.getVoiceGroup(f.groupId)).status, "committed");
    assert.equal((await fs.stat(path.join(PENDING_DIR, `${first.filePrefixes[2]}.json`))).isFile(), true);
    assert.equal(queue.getUsageCount(f.userPhone, f.eventName), 1);
});

test("submission requires server approval, active event, quota, and a live claim", async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const input = { store: f.store, requestId: f.request.id, brief: BRIEF, locale: "en", queue, settings: f.snapshot };
    await f.store.patch(f.request.id, { policyOutcome: { approved: false } });
    await assert.rejects(() => submitVoiceEdit(input), /approved/i);
    await f.store.patch(f.request.id, { policyOutcome: { approved: true }, approvedBrief: BRIEF });
    await assert.rejects(() => submitVoiceEdit({ ...input, brief: { ...BRIEF, visualStyle: "different" } }), /approved/i);
    await assert.rejects(() => submitVoiceEdit({ ...input, settings: { get: () => "Other" } }), /active event/i);
    await assert.rejects(() => submitVoiceEdit({ ...input, queue: { ...queue, getUsageCount: () => 2 } }), /quota/i);
    await f.store.patch(f.request.id, { status: "superseded" });
    await assert.rejects(() => submitVoiceEdit(input), /claimed/i);
});

test("pending Voice job is not claimed before its group manifest is committed", async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const first = await queue.enqueueVoiceGroup({ request: f.request, brief: BRIEF, locale: "en", groupId: f.groupId });
    const manifestPath = path.join(path.dirname(PENDING_DIR), "voice-groups", `${f.groupId}.json`);
    await fs.writeFile(manifestPath, JSON.stringify({ ...(await queue.getVoiceGroup(f.groupId)), status: "preparing" }));
    assert.equal(await queue.processGenerationQueue(), false);
    assert.equal((await fs.stat(path.join(PENDING_DIR, `${first.filePrefixes[0]}.json`))).isFile(), true);
});
