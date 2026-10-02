const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const twilio = require("twilio");
const WebSocket = require("ws");
const sharp = require("sharp");
const settings = require("../lib/settings");
const messaging = require("../lib/messaging");
const leads = require("../lib/leads");
const queue = require("../lib/queue");
const { PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR } = require("../lib/config");
const { jobPaths } = require("../lib/pipeline");
const { createVoiceStore } = require("../lib/voice/store");
const { createVoiceIntake } = require("../lib/voice/preflight");
const { routeVoiceInbound } = require("../lib/voice/inbound-route");
const { createVoiceAgent } = require("../lib/voice/agent");
const { submitVoiceEdit, recoverVoiceSubmissions } = require("../lib/voice/submit");
const { mountVoiceHttp, attachVoiceSocket } = require("../lib/voice/transport");

const PHONE = "+14155550100";
const APP = "+14155550101";
const VOICE = "+14155550102";
const BASE = "https://booth.example";
const ACCOUNT = "ACvoiceflow";
const TOKEN = "voice-flow-token";
const BRIEF = { visualStyle: "watercolor", clothingOrSubject: "space suit", setting: "Mars",
    mood: "bright", importantDetails: "red sky", preserve: "face and glasses" };
let sequence = 0;

async function createVoiceFlowHarness({ channel = "sms", locale = "en", reviewMode = "human",
    enablePrinting = true, leadCaptureMode = "after", sendResult } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-flow-"));
    const eventName = `VoiceFlow${process.pid}${++sequence}`;
    const mediaDir = path.join(root, "media");
    const store = createVoiceStore({ dir: path.join(root, "requests"), mediaDir });
    const originalSend = messaging.send;
    const originalContentSid = settings.getContentSid;
    const originalSurvey = leads.startSurvey;
    const sent = [];
    const events = [];
    const send = async (...args) => {
        sent.push(args); events.push(args[1] === "voiceDelivery" || args[3]?._body?.includes("portrait is ready") ? "portrait" : "message");
        return sendResult ? sendResult(args, sent.length) : { sid: `SMsent${sent.length}` };
    };
    messaging.send = send;
    settings.getContentSid = (key, selectedLocale) => `HX${key}${selectedLocale}`;
    leads.startSurvey = async () => { events.push("survey"); return { status: "started" }; };
    const config = { eventName, twilioAccountSid: ACCOUNT, twilioAuthToken: TOKEN, twilioVoiceNumber: VOICE };
    const voiceSettings = { get: (key) => config[key], getForEvent: (key) => rules[key],
        getContentSid: settings.getContentSid };
    const rules = { maxPrints: 2, adminPhones: [], multiSubjectMode: "reject", reviewMode,
        variantsPerReview: 1, enablePrinting, leadCaptureMode, enableNps: false,
        immediateDigitalDelivery: false, outputProfile: settings.getOutputProfile(eventName),
        promptPreserve: "Preserve recognizable face", promptComposition: "Portrait framing",
        promptBackground: "", brandPrompt: "", brandReferenceFiles: [], aiReviewChecks: {} };
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 4,
        background: "#b08080" } }).png().toBuffer();
    const intake = createVoiceIntake({ store, mediaDir, settings: voiceSettings,
        downloadImage: async (_url, target) => fs.writeFile(target, bytes),
        assessImage: async () => ({ flagged: false, hasFace: true,
            scene: { subjects: 1, pets: "none", positions: "centered" } }), send,
        recordInboundSession: () => {} });
    const agent = createVoiceAgent({ store,
        respond: async () => ({ speech: "That sounds good.", readyToConfirm: true, brief: BRIEF }),
        moderate: async () => ({ flagged: false }),
        submit: (args) => submitVoiceEdit({ ...args, queue, settings: voiceSettings, mediaDir }),
    });
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    mountVoiceHttp(app, { store, settings: voiceSettings, agent, baseUrl: BASE });
    const server = http.createServer(app);
    const relay = attachVoiceSocket(server, { store, settings: voiceSettings, agent, baseUrl: BASE });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    async function post(route, fields) {
        const signature = twilio.getExpectedTwilioSignature(TOKEN, `${BASE}${route}`, fields);
        return fetch(`${local}${route}`, { method: "POST", headers: {
            "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature,
        }, body: new URLSearchParams(fields) });
    }
    function socket() {
        const signature = twilio.getExpectedTwilioSignature(TOKEN, `${BASE.replace(/^https:/, "wss:")}/voice/ws`, {});
        const ws = new WebSocket(local.replace(/^http/, "ws") + "/voice/ws", { headers: { "x-twilio-signature": signature } });
        const inbox = [];
        const waiters = [];
        ws.on("message", (raw) => { const message = JSON.parse(String(raw)); const waiter = waiters.shift();
            if (waiter) waiter(message); else inbox.push(message); });
        const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("No relay message")), 2000);
            waiters.push((message) => { clearTimeout(timer); resolve(message); });
        });
        return { ws, send: (message) => ws.send(JSON.stringify(message)), next,
            async cycle() { const chunks = []; while (true) { const message = await next();
                if (message.type !== "text") throw new Error(`Unexpected relay ${message.type}`);
                chunks.push(message.token); if (message.last) return { speech: chunks.join(""), chunks }; } },
        };
    }
    async function sendSelfie(messageSid = `SMflow${sequence}`, overrides = {}) {
        const result = await routeVoiceInbound({ body: { NumMedia: "1", MessageSid: messageSid,
            MediaUrl0: `https://api.twilio.com/${messageSid}`, MediaContentType0: "image/png" },
        eventName, sender: PHONE, appPhone: APP, adapter: { name: channel }, locale,
        store, intake, quota: { used: queue.getUsageCount(PHONE, eventName), max: 2 },
        enabled: true, baseUrl: BASE, eventSettings: rules, send,
        recordInboundSession: () => {}, ...overrides });
        await intake.recover();
        return result;
    }
    async function call(callSid = `CAflow${sequence}`, from = PHONE) {
        const fields = { From: from, To: VOICE, CallSid: callSid, AccountSid: ACCOUNT };
        const response = await post("/voice/inbound", fields);
        const xml = await response.text();
        if (!xml.includes("ConversationRelay")) return { xml, response };
        const current = (await store.list()).find((request) => request.callSid === callSid);
        const c = socket();
        await new Promise((resolve) => c.ws.once("open", resolve));
        c.send({ type: "setup", accountSid: ACCOUNT, callSid, from, to: VOICE,
            customParameters: { requestId: current.id } });
        return { xml, response, c, request: current };
    }
    async function close() {
        for (const ws of relay.clients) ws.terminate();
        relay.close();
        await new Promise((resolve) => server.close(resolve));
        await store.reconcileClaims(new Set());
        for (const request of await store.list()) {
            if (!request.groupId) continue;
            const group = await queue.getVoiceGroup(request.groupId).catch(() => null);
            for (const prefix of group?.filePrefixes || [request.groupId]) {
                for (const dir of [PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
                    await fs.rm(path.join(dir, `${prefix}.json`), { force: true });
                }
            }
            await fs.rm(path.join(path.dirname(PENDING_DIR), "voice-groups", `${request.groupId}.json`), { force: true });
        }
        await fs.rm(settings.getDownloadDir(eventName), { recursive: true, force: true });
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
        messaging.send = originalSend;
        settings.getContentSid = originalContentSid;
        leads.startSurvey = originalSurvey;
        await queue.buildUsageCache();
    }
    return { root, mediaDir, eventName, store, intake, agent, rules, sent, events,
        sendSelfie, call, post, close };
}

test("SMS selfie, signed call, spoken approval, review, and delivery use one durable queue group", async (t) => {
    const f = await createVoiceFlowHarness(); t.after(f.close);
    await f.sendSelfie();
    const request = (await f.store.list())[0];
    assert.equal(request.status, "awaiting_call");
    assert.equal((await sharp(request.stagedInputPath).metadata()).format, "jpeg");
    assert.match(f.sent[0][3]._body, /Call.*\+14155550102/i);
    assert.match((await f.call("CAother", "+14155550888")).xml, /send.*selfie|same phone/i);
    const { c } = await f.call();
    c.send({ type: "prompt", voicePrompt: "Watercolor spacesuit on Mars", last: true });
    const readback = await c.cycle();
    assert.match(readback.speech, /watercolor.*Mars/i);
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    const replay = await c.cycle();
    assert.equal((await f.store.get(request.id)).status, "claimed");
    c.send({ type: "interrupt", utteranceUntilInterrupt: "I heard that" });
    c.send({ type: "prompt", voicePrompt: "Still watercolor on Mars", last: true });
    const revised = await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "start" });
    for (const token of revised.chunks) c.send({ type: "info", name: "tokensPlayed", value: token });
    c.send({ type: "prompt", voicePrompt: "yes, do it", last: true });
    assert.match((await c.cycle()).speech, /hang up/i);
    assert.equal((await f.store.get(request.id)).status, "queued");
    const group = await queue.getVoiceGroup((await f.store.get(request.id)).groupId);
    assert.equal(group.status, "committed");
    assert.equal(group.jobs.length, 1);
    assert.equal(queue.getUsageCount(PHONE, f.eventName), 1);
    const job = group.jobs[0];
    f.rules.promptPreserve = "Changed by operator after the call";
    assert.equal(job.voiceEventSettings.promptPreserve, "Preserve recognizable face");
    await queue.buildUsageCache();
    assert.equal(queue.getUsageCount(PHONE, f.eventName), 1);
    const paths = jobPaths(job, { staged: true });
    assert.equal((await sharp(paths.inputPath).metadata()).format, "jpeg");
    const png = await sharp(paths.inputPath).png().toBuffer();
    await fs.writeFile(paths.outputPath, png);
    await fs.writeFile(paths.mmsPath, await fs.readFile(paths.inputPath));
    await fs.rename(path.join(PENDING_DIR, `${job.filePrefix}.json`), path.join(REVIEW_DIR, `${job.filePrefix}.json`));
    await queue.approveJob(`${job.filePrefix}.json`);
    const ready = JSON.parse(await fs.readFile(path.join(READY_DIR, `${job.filePrefix}.json`), "utf8"));
    assert.equal(ready.voiceDeliveryState, "sent");
    assert.equal(f.sent.at(-1)[1], "_raw");
    assert.equal(f.sent.at(-1)[3].fromPhone, APP);
    assert.ok(f.events.indexOf("survey") > f.events.indexOf("portrait"));
    c.ws.close();
});

test("a delayed WhatsApp template failure stays pending and retries without a raw fallback", async (t) => {
    let deliveryAttempts = 0;
    const f = await createVoiceFlowHarness({ channel: "whatsapp", locale: "en",
        leadCaptureMode: "disabled", sendResult: (args, n) => {
            if (args[1] === "voiceDelivery" && ++deliveryAttempts === 1) return { error: "Twilio unavailable" };
            return { sid: `SMsent${n}` };
        } });
    t.after(f.close);
    await f.sendSelfie();
    const { c } = await f.call();
    c.send({ type: "prompt", voicePrompt: "Watercolor on Mars", last: true });
    const readback = await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "start" });
    for (const token of readback.chunks) c.send({ type: "info", name: "tokensPlayed", value: token });
    c.send({ type: "prompt", voicePrompt: "yes, do it", last: true });
    await c.cycle();
    const request = (await f.store.list())[0];
    const job = (await queue.getVoiceGroup(request.groupId)).jobs[0];
    const paths = jobPaths(job, { staged: true });
    await fs.writeFile(paths.outputPath, await sharp(paths.inputPath).png().toBuffer());
    await fs.writeFile(paths.mmsPath, await fs.readFile(paths.inputPath));
    await fs.rename(path.join(PENDING_DIR, `${job.filePrefix}.json`), path.join(REVIEW_DIR, `${job.filePrefix}.json`));
    await queue.approveJob(`${job.filePrefix}.json`);
    let stored = JSON.parse(await fs.readFile(path.join(READY_DIR, `${job.filePrefix}.json`), "utf8"));
    assert.equal(stored.voiceDeliveryState, "pending");
    assert.equal(stored.smsSentAt, undefined);
    assert.equal(f.sent.filter((item) => item[1] === "voiceDelivery").length, 1);
    assert.equal(f.sent.filter((item) => item[1] === "_raw").length, 1, "only the invitation may be freeform");
    await queue.retryVoiceDelivery(`${job.filePrefix}.json`);
    stored = JSON.parse(await fs.readFile(path.join(READY_DIR, `${job.filePrefix}.json`), "utf8"));
    assert.equal(stored.voiceDeliveryState, "sent");
    assert.equal(f.sent.filter((item) => item[1] === "voiceDelivery").length, 2);
    c.ws.close();
});

test("restart completes a submitting request and never creates another group", async (t) => {
    const f = await createVoiceFlowHarness({ reviewMode: "off", enablePrinting: false }); t.after(f.close);
    await f.sendSelfie();
    const request = (await f.store.list())[0];
    await f.store.claimLatest({ phone: PHONE, eventName: f.eventName, callSid: "CArestart" });
    await f.store.patch(request.id, { approvedBrief: BRIEF,
        policyOutcome: { approved: true, code: "approved" } });
    const groupId = `${require("../lib/config").formatTimestamp(request.receivedAt)}_voice_${request.id.slice(0, 16)}`;
    await f.store.patch(request.id, { status: "submitting", groupId, brief: BRIEF, locale: "en" });
    const recovered = await recoverVoiceSubmissions({ store: f.store, queue,
        settings: { get: () => f.eventName, getForEvent: (key) => f.rules[key] }, mediaDir: f.mediaDir });
    assert.equal(recovered.length, 1);
    assert.equal((await f.store.get(request.id)).status, "queued");
    assert.equal((await queue.getVoiceGroup(groupId)).status, "committed");
    assert.equal(queue.getUsageCount(PHONE, f.eventName), 1);
    assert.equal((await recoverVoiceSubmissions({ store: f.store, queue,
        settings: { get: () => f.eventName }, mediaDir: f.mediaDir })).length, 0);
});

test("Portuguese WhatsApp caller receives an approved template after delayed review", async (t) => {
    const f = await createVoiceFlowHarness({ channel: "whatsapp", locale: null }); t.after(f.close);
    await f.sendSelfie();
    const { c } = await f.call();
    assert.match((await f.store.list())[0].invitationSid, /SMsent/);
    c.send({ type: "prompt", voicePrompt: "Português", last: true });
    assert.deepEqual(await c.next(), { type: "language", ttsLanguage: "pt-BR", transcriptionLanguage: "pt-BR" });
    assert.match((await c.cycle()).speech, /como.*foto/i);
    c.send({ type: "prompt", voicePrompt: "Quero aquarela em Marte com roupa espacial", last: true });
    const readback = await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "start" });
    for (const token of readback.chunks) c.send({ type: "info", name: "tokensPlayed", value: token });
    c.send({ type: "prompt", voicePrompt: "pode fazer", last: true });
    assert.match((await c.cycle()).speech, /desligar/i);
    const request = (await f.store.list())[0];
    const group = await queue.getVoiceGroup(request.groupId);
    const job = group.jobs[0];
    assert.equal(job.locale, "pt_BR");
    assert.equal(job.channel, "whatsapp");
    const paths = jobPaths(job, { staged: true });
    await fs.writeFile(paths.outputPath, await sharp(paths.inputPath).png().toBuffer());
    await fs.writeFile(paths.mmsPath, await fs.readFile(paths.inputPath));
    await fs.rename(path.join(PENDING_DIR, `${job.filePrefix}.json`), path.join(REVIEW_DIR, `${job.filePrefix}.json`));
    await queue.approveJob(`${job.filePrefix}.json`);
    const delivery = f.sent.find((item) => item[1] === "voiceDelivery");
    assert.ok(delivery);
    assert.equal(delivery[3].contentSid, "HXvoiceDeliverypt_BR");
    assert.equal(delivery[3].allowOutOfSession, true);
    assert.equal(delivery[3].fromPhone, APP);
    assert.equal(f.sent.filter((item) => item[1] === "voiceDelivery").length, 1);
    assert.equal(f.events.includes("survey"), false);
    c.ws.close();
});

test("new selfie stays separate from active call and MENU waits until the call ends", async (t) => {
    const f = await createVoiceFlowHarness({ reviewMode: "off", enablePrinting: false }); t.after(f.close);
    await f.sendSelfie("SMfirst");
    const { c, request: first } = await f.call("CAactive");
    await f.sendSelfie("SMsecond");
    const records = await f.store.list();
    const second = records.find((request) => request.messageSid === "SMsecond");
    assert.equal((await f.store.get(first.id)).status, "claimed");
    assert.equal(second.status, "awaiting_call");
    const menuArgs = { body: { Body: "MENU", NumMedia: "0", MessageSid: "SMmenu" },
        eventName: f.eventName, sender: PHONE, appPhone: APP, adapter: { name: "sms" },
        locale: "en", store: f.store, intake: f.intake, enabled: false,
        quota: { used: 0, max: 2 }, recordInboundSession: () => {} };
    const busy = await routeVoiceInbound({ ...menuArgs, send: async (...args) => { f.sent.push(args); return { sid: "SMbusy" }; } });
    assert.deepEqual(busy, { handled: true, status: 204 });
    assert.equal((await f.store.get(first.id)).status, "claimed");
    c.ws.close();
    await new Promise((resolve) => c.ws.once("close", resolve));
    for (let i = 0; i < 20 && (await f.store.get(first.id)).status === "claimed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const menu = await routeVoiceInbound(menuArgs);
    assert.equal(menu.fallback.requestId, second.id);
    assert.equal((await f.store.get(first.id)).status, "superseded");
    assert.equal((await f.store.get(second.id)).status, "menu_fallback");
});
