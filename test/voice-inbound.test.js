const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createVoiceStore } = require("../lib/voice/store");
const { routeVoiceInbound } = require("../lib/voice/inbound-route");
const queue = require("../lib/queue");
const settings = require("../lib/settings");
const { PENDING_DIR } = require("../lib/config");
const { jobPaths } = require("../lib/pipeline");
const sharp = require("sharp");

const PHONE = "+14155550100";
const APP = "+14155550101";

async function fixture({ channel = "sms", locale = "en" } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-inbound-"));
    const store = createVoiceStore({ dir: path.join(root, "requests"), mediaDir: path.join(root, "media") });
    const calls = [];
    const sent = [];
    const intake = {
        async acceptSelfie(payload) {
            calls.push(payload);
            const record = await store.record({ messageSid: payload.messageSid, phone: payload.phone,
                appPhone: payload.appPhone, channel: payload.channel, eventName: payload.eventName,
                locale: payload.locale, imageUrl: payload.imageUrl, imageContentType: payload.imageContentType,
                receivedAt: Date.now(), expiresAt: Date.now() + 30_000 });
            await store.supersedeOlder(record.id);
            return record;
        },
        recover() { return Promise.resolve(); },
    };
    const adapter = { name: channel };
    const send = async (_to, _kind, _vars, options) => { sent.push(options._body); return { sid: "SMreply" }; };
    const defaults = { eventName: "Expo", sender: PHONE, appPhone: APP, adapter, locale,
        store, intake, send, quota: { used: 0, max: 2, unlimited: false }, enabled: true,
        baseUrl: "https://example.com", eventSettings: { maxPrints: 2 } };
    const route = (body, overrides = {}) => routeVoiceInbound({ ...defaults, body, ...overrides });
    const selfie = (sid = "SM1", extra = {}) => ({ From: channel === "whatsapp" ? `whatsapp:${PHONE}` : PHONE,
        To: channel === "whatsapp" ? `whatsapp:${APP}` : APP,
        NumMedia: "1", MessageSid: sid, MediaUrl0: `https://api.twilio.com/${sid}`,
        MediaContentType0: "image/jpeg", ...extra });
    return { root, store, calls, sent, route, selfie,
        close: () => fs.rm(root, { recursive: true, force: true }) };
}

test("SMS and WhatsApp Voice selfies bypass menu state and dedupe by MessageSid", async (t) => {
    for (const channel of ["sms", "whatsapp"]) {
        const f = await fixture({ channel, locale: null }); t.after(f.close);
        assert.deepEqual(await f.route(f.selfie()), { handled: true, status: 204 });
        assert.deepEqual(await f.route(f.selfie()), { handled: true, status: 204 });
        assert.equal(f.calls.length, 2);
        const records = await f.store.list();
        assert.equal(records.length, 1);
        assert.equal(records[0].channel, channel);
        assert.equal(records[0].locale, null);
        assert.equal(records[0].status, "received");
    }
});

test("Voice route leaves multi-photo and text traffic to the existing flow; quota replies before intake", async (t) => {
    const f = await fixture(); t.after(f.close);
    assert.deepEqual(await f.route(f.selfie("SM2", { NumMedia: "2" })), { handled: false });
    assert.deepEqual(await f.route({ MessageSid: "SM3", Body: "hi", NumMedia: "0" }), { handled: false });
    const result = await f.route(f.selfie(), { quota: { used: 2, max: 2, unlimited: false } });
    assert.deepEqual(result, { handled: true, status: 204 });
    assert.equal(f.calls.length, 0);
    assert.match(f.sent[0], /used|free|limit/i);
});

test("newer selfie supersedes unclaimed earlier selfie", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.route(f.selfie("SM1"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await f.route(f.selfie("SM2"));
    const records = await f.store.list();
    assert.equal(records.find((r) => r.messageSid === "SM1").status, "superseded");
    assert.equal(records.find((r) => r.messageSid === "SM2").status, "received");
});

test("MENU atomically transfers a staged selfie into menu context, even after Voice is disabled", async (t) => {
    const f = await fixture({ locale: "pt_BR" }); t.after(f.close);
    await f.route(f.selfie());
    const [record] = await f.store.list();
    const sourceImagePath = path.join(f.root, "media", `${record.id}.jpg`);
    await fs.mkdir(path.dirname(sourceImagePath), { recursive: true });
    await fs.writeFile(sourceImagePath, "private selfie");
    await f.store.patch(record.id, { status: "awaiting_call", stagedInputPath: sourceImagePath });
    const menu = await f.route({ Body: " MENU ", NumMedia: "0", MessageSid: "SMmenu" }, { enabled: false });
    assert.equal(menu.handled, true);
    assert.equal(menu.status, 204);
    assert.equal(menu.fallback.sourceImagePath, sourceImagePath);
    assert.equal(menu.fallback.messageSid, "SM1");
    assert.equal(menu.fallback.locale, "pt_BR");
    assert.equal((await f.store.get(record.id)).status, "menu_fallback");
    assert.equal(await fs.readFile(sourceImagePath, "utf8"), "private selfie");
    const retried = await f.route({ Body: "MENU", NumMedia: "0", MessageSid: "SMmenuRetry" }, { enabled: false });
    assert.equal(retried.fallback.sourceImagePath, sourceImagePath);
    assert.equal((await f.store.get(record.id)).status, "menu_fallback");
    assert.equal(await f.store.claimLatest({ phone: PHONE, eventName: "Expo", callSid: "CAfallback" }), null);
    await f.store.completeMenuFallback(record.id, "job1");
    assert.equal((await f.store.get(record.id)).status, "menu_queued");
    await assert.rejects(fs.access(sourceImagePath));
});

test("MENU during an active call replies without changing the claim; release permits fallback", async (t) => {
    const f = await fixture({ locale: "pt_BR" }); t.after(f.close);
    await f.route(f.selfie());
    const [record] = await f.store.list();
    const sourceImagePath = path.join(f.root, "media", `${record.id}.jpg`);
    await fs.mkdir(path.dirname(sourceImagePath), { recursive: true });
    await fs.writeFile(sourceImagePath, "private selfie");
    await f.store.patch(record.id, { status: "awaiting_call", stagedInputPath: sourceImagePath });
    await f.store.claimLatest({ phone: PHONE, eventName: "Expo", callSid: "CA1" });
    const busy = await f.route({ Body: "MENU", NumMedia: "0", MessageSid: "SMmenu" });
    assert.deepEqual(busy, { handled: true, status: 204 });
    assert.match(f.sent.at(-1), /ligação|chamada|desligue/i);
    assert.equal((await f.store.get(record.id)).status, "claimed");
    await f.store.release("CA1");
    const menu = await f.route({ Body: "MENU", NumMedia: "0", MessageSid: "SMmenu2" });
    assert.equal(menu.fallback.sourceImagePath, sourceImagePath);
    assert.equal((await f.store.get(record.id)).status, "menu_fallback");
});

test("MENU cannot use a request from another event or an expired selfie", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.route(f.selfie());
    const [record] = await f.store.list();
    await f.store.patch(record.id, { status: "awaiting_call", stagedInputPath: path.join(f.root, "media", "photo.jpg") });
    assert.deepEqual(await f.route({ Body: "MENU", NumMedia: "0" }, { eventName: "Other" }), { handled: false });
    await f.store.patch(record.id, { expiresAt: Date.now() - 1 });
    assert.deepEqual(await f.route({ Body: "MENU", NumMedia: "0" }), { handled: false });
});

test("menu fallback copies its private selfie into every variant before publishing job files", async (t) => {
    const eventName = `VoiceMenu${process.pid}${Date.now()}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-menu-copy-"));
    const sourceImagePath = path.join(dir, "source.jpg");
    const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3,
        background: "#cccccc" } }).jpeg().toBuffer();
    await fs.writeFile(sourceImagePath, jpeg);
    const originalGetForEvent = settings.getForEvent;
    settings.getForEvent = (key, event) => event === eventName
        ? ({ reviewMode: "human", variantsPerReview: 2 })[key]
        : originalGetForEvent(key, event);
    let queued;
    t.after(async () => {
        settings.getForEvent = originalGetForEvent;
        if (queued) {
            for (const prefix of [queued.filePrefix.replace(/-v1$/, "-v1"), queued.filePrefix.replace(/-v1$/, "-v2")]) {
                await fs.rm(path.join(PENDING_DIR, `${prefix}.json`), { force: true });
            }
        }
        await fs.rm(settings.getDownloadDir(eventName), { recursive: true, force: true });
        await fs.rm(dir, { recursive: true, force: true });
        await queue.buildUsageCache();
    });
    queued = queue.enqueueJob("https://api.twilio.com/expired", `SMmenu${Date.now()}`,
        "+14155550999", APP, "cartoon", "https://example.com", null, null,
        { eventName, channel: "sms", sourceImagePath, menuFallbackRequestId: "request1" });
    assert.ok(queued?.parentJobId);
    for (const n of [1, 2]) {
        const prefix = `${queued.parentJobId}-v${n}`;
        const job = JSON.parse(await fs.readFile(path.join(PENDING_DIR, `${prefix}.json`), "utf8"));
        assert.equal(job.sourceImagePath, undefined);
        assert.deepEqual(await fs.readFile(jobPaths(job, { staged: true }).inputPath), jpeg);
    }
    await fs.rm(sourceImagePath);
    for (const n of [1, 2]) {
        const prefix = `${queued.parentJobId}-v${n}`;
        const job = JSON.parse(await fs.readFile(path.join(PENDING_DIR, `${prefix}.json`), "utf8"));
        assert.deepEqual(await fs.readFile(jobPaths(job, { staged: true }).inputPath), jpeg);
    }
});
