const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const express = require("express");
const twilio = require("twilio");
const WebSocket = require("ws");
const { createVoiceStore } = require("../lib/voice/store");
const { createVoiceAgent } = require("../lib/voice/agent");
const { mountVoiceHttp, attachVoiceSocket } = require("../lib/voice/transport");

const BASE = "https://example.com";
const PHONE = "+14155550100";
const VOICE = "+14155550101";
const ACCOUNT = "ACtest";
const TOKEN = "test-token";
const BRIEF = { visualStyle: "watercolor", clothingOrSubject: "blue jacket", setting: "Mars",
    mood: "bright", importantDetails: "red sky", preserve: "face and glasses" };

async function fixture({ locale = "en", withRequest = true, respond } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transport-"));
    const store = createVoiceStore({ dir, mediaDir: path.join(dir, "media") });
    let request;
    if (withRequest) {
        request = await store.record({ messageSid: "SM1", phone: PHONE, appPhone: PHONE,
            channel: "sms", eventName: "demo", locale, expiresAt: Date.now() + 30_000,
            stagedInputPath: path.join(dir, "media", "photo.jpg"), preflightApproved: true,
            scene: { subjects: 1 }, eventSettings: { multiSubjectMode: "reject" } });
        request = await store.patch(request.id, { status: "awaiting_call" });
    }
    const submissions = [];
    const agent = createVoiceAgent({ store,
        respond: respond || (async () => ({ speech: "I can do that.", readyToConfirm: true, brief: BRIEF })),
        moderate: async () => ({ flagged: false }),
        submit: async (args) => { submissions.push(args); return { status: "committed" }; },
    });
    const playbackCompletions = [];
    const onPlaybackComplete = agent.onPlaybackComplete;
    agent.onPlaybackComplete = (session, generationId) => {
        const completed = onPlaybackComplete(session, generationId);
        playbackCompletions.push(completed);
        return completed;
    };
    const config = { eventName: "demo", twilioAccountSid: ACCOUNT, twilioAuthToken: TOKEN,
        twilioVoiceNumber: VOICE, enableVoice: false };
    const settings = { get: (key) => config[key] };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    mountVoiceHttp(app, { store, settings, agent, baseUrl: BASE });
    const server = http.createServer(app);
    const socket = attachVoiceSocket(server, { store, settings, agent, baseUrl: BASE });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    async function post(route, fields, signed = true) {
        const signature = signed ? twilio.getExpectedTwilioSignature(TOKEN, `${BASE}${route}`, fields) : "invalid";
        return fetch(`${local}${route}`, { method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
            body: new URLSearchParams(fields) });
    }
    function connect(signed = true) {
        const signature = signed ? twilio.getExpectedTwilioSignature(TOKEN, "wss://example.com/voice/ws", {}) : "invalid";
        const ws = new WebSocket(local.replace(/^http/, "ws") + "/voice/ws", {
            headers: { "x-twilio-signature": signature },
        });
        const messages = [];
        const waiters = [];
        ws.on("message", (raw) => {
            const message = JSON.parse(String(raw));
            const waiter = waiters.shift();
            if (waiter) waiter(message); else messages.push(message);
        });
        const connection = { ws, send: (message) => ws.send(JSON.stringify(message)),
            next: () => messages.length ? Promise.resolve(messages.shift())
                : new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error("Timed out waiting for relay message")), 2000);
                    waiters.push((message) => { clearTimeout(timeout); resolve(message); });
                }),
        };
        connection.cycle = async () => {
            let token = "";
            const chunks = [];
            while (true) {
                const message = await connection.next();
                assert.equal(message.type, "text");
                token += message.token;
                chunks.push(message.token);
                if (message.last) return { token, chunks };
            }
        };
        return connection;
    }
    async function close() {
        for (const client of socket.clients) client.terminate();
        socket.close();
        await new Promise((resolve) => server.close(resolve));
        await store.reconcileClaims(new Set());
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
    return { store, request, submissions, playbackCompletions, post, connect, close };
}

function setup(requestId, overrides = {}) {
    return { type: "setup", accountSid: ACCOUNT, callSid: "CA1", from: PHONE, to: VOICE,
        customParameters: { requestId }, ...overrides };
}

test("signed caller is matched by phone and gets interruptible relay TwiML", async (t) => {
    const f = await fixture(); t.after(f.close);
    const fields = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    assert.equal((await f.post("/voice/inbound", fields, false)).status, 403);
    const response = await f.post("/voice/inbound", fields);
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.match(xml, /<ConversationRelay[^>]*interruptible="speech"/);
    assert.match(xml, /welcomeGreetingInterruptible="speech"/);
    assert.match(xml, /interruptSensitivity="medium"/);
    assert.match(xml, /reportInputDuringAgentSpeech="speech"/);
    assert.match(xml, /events="speaker-events tokens-played"/);
    assert.match(xml, /how.*photo.*look/i);
    assert.match(xml, /Mars|watercolor/i);
    assert.match(xml, new RegExp(`<Parameter name="requestId" value="${f.request.id}"`));
    assert.equal((await f.store.get(f.request.id)).status, "claimed");
});

test("wrong account or destination is rejected; unknown and queued callers hear generic copy", async (t) => {
    const f = await fixture(); t.after(f.close);
    const base = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    assert.equal((await f.post("/voice/inbound", { ...base, AccountSid: "ACwrong" })).status, 403);
    assert.equal((await f.post("/voice/inbound", { ...base, To: "+14155550999" })).status, 403);
    const unknown = await f.post("/voice/inbound", { ...base, From: "+14155550888" });
    assert.match(await unknown.text(), /send.*selfie|same phone/i);
    const first = await f.post("/voice/inbound", base);
    assert.equal(first.status, 200);
    const concurrent = await f.post("/voice/inbound", { ...base, CallSid: "CA2" });
    assert.match(await concurrent.text(), /already.*call|call.*progress/i);
    await f.store.patch(f.request.id, { status: "queued" });
    const queued = await f.post("/voice/inbound", { ...base, CallSid: "CA3" });
    assert.match(await queued.text(), /already.*progress|already.*started/i);
});

test("signed socket rejects mismatched setup and unsigned upgrades before agent work", async (t) => {
    const f = await fixture(); t.after(f.close);
    const fields = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    await f.post("/voice/inbound", fields);
    const unsigned = f.connect(false);
    const rejected = await new Promise((resolve) => unsigned.ws.once("unexpected-response", (_req, response) => resolve(response.statusCode)));
    assert.equal(rejected, 403);
    for (const overrides of [{ accountSid: "ACwrong" }, { callSid: "CAwrong" },
        { from: "+14155550888" }, { to: "+14155550888" },
        { customParameters: { requestId: "f".repeat(64) } }]) {
        const c = f.connect();
        await new Promise((resolve) => c.ws.once("open", resolve));
        c.send(setup(f.request.id, overrides));
        const code = await new Promise((resolve) => c.ws.once("close", resolve));
        assert.notEqual(code, 1000);
    }
    assert.equal((await f.store.get(f.request.id)).status, "claimed");
});

test("an interrupted readback needs content confirmation without looping", async (t) => {
    const f = await fixture({ locale: null }); t.after(f.close);
    const fields = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    await f.post("/voice/inbound", fields);
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Português", last: true });
    assert.deepEqual(await c.next(), { type: "language", ttsLanguage: "pt-BR", transcriptionLanguage: "pt-BR" });
    assert.match((await c.cycle()).token, /como.*foto/i);
    c.send({ type: "prompt", voicePrompt: "Aquarela em Marte", last: true });
    const readback = await c.cycle();
    assert.match(readback.token, /aquarela|watercolor/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "interrupt", utteranceUntilInterrupt: "Entendi" });
    c.send({ type: "prompt", voicePrompt: "pode fazer", last: true });
    const fallback = await c.cycle();
    assert.match(fallback.token, /aquarela/i);
    assert.equal(f.submissions.length, 0);
    // A late playback report from the interrupted readback is ignored.
    c.send({ type: "info", name: "tokensPlayed", value: readback.token });
    c.send({ type: "prompt", voicePrompt: "pode fazer", last: true });
    assert.match((await c.cycle()).token, /repita/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "sim, Aquarela em Marte", last: true });
    const closing = await c.cycle();
    assert.match(closing.token, /desligar/i);
    assert.equal(f.submissions.length, 1);
    assert.deepEqual(f.playbackCompletions, []);
    c.ws.close();
});

test("speaker stop without matching played text requires content confirmation", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "true" });
    c.send({ type: "info", name: "tokensPlayed", value: "I heard your watercolor request." });
    c.send({ type: "info", name: "agentSpeaking", value: "false" });
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    assert.match((await c.cycle()).token, /repeat each change.*watercolor/i);
    assert.deepEqual(f.playbackCompletions, []);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "yes, watercolor", last: true });
    assert.match((await c.cycle()).token, /hang up/i);
    assert.equal(f.submissions.length, 1);
    c.ws.close();
});

test("content-bearing yes during readback confirms without repeating it", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    await c.cycle();
    c.send({ type: "prompt", voicePrompt: "yes, watercolor", last: true });
    assert.match((await c.cycle()).token, /hang up/i);
    assert.equal(f.submissions.length, 1);
    c.ws.close();
});

test("yes during active readback requires content confirmation and never loops", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "true" });
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    const fallback = await c.cycle();
    assert.match(fallback.token, /watercolor/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    assert.match((await c.cycle()).token, /repeat each change/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "yes, watercolor", last: true });
    const closing = await c.cycle();
    assert.match(closing.token, /hang up/i);
    assert.equal(f.submissions.length, 1);
    c.ws.close();
});

test("yes before readback playback starts needs content confirmation", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    await c.cycle();
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    assert.match((await c.cycle()).token, /watercolor/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    assert.match((await c.cycle()).token, /repeat each change/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "yes, watercolor", last: true });
    assert.match((await c.cycle()).token, /hang up/i);
    assert.equal(f.submissions.length, 1);
    c.ws.close();
});

test("speaker stop followed by a late interrupt does not approve an unheard readback", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "true" });
    c.send({ type: "info", name: "agentSpeaking", value: "false" });
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    c.send({ type: "interrupt", utteranceUntilInterrupt: "Got it: watercolor" });
    const fallback = await c.cycle();
    assert.match(fallback.token, /watercolor/i);
    assert.equal(f.submissions.length, 0);
    c.send({ type: "prompt", voicePrompt: "yes, watercolor", last: true });
    assert.match((await c.cycle()).token, /hang up/i);
    assert.equal(f.submissions.length, 1);
    c.ws.close();
});

test("a late interrupt for the old readback does not cancel a revised model turn", async (t) => {
    let releaseRevision;
    let revisionStarted;
    const started = new Promise((resolve) => { revisionStarted = resolve; });
    const f = await fixture({ respond: async ({ text }) => {
        if (/snowy/i.test(text)) {
            revisionStarted();
            return new Promise((resolve) => { releaseRevision = resolve; });
        }
        return { speech: "Ready", readyToConfirm: true, brief: BRIEF };
    } });
    t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    await c.cycle();
    c.send({ type: "prompt", voicePrompt: "Actually make it snowy", last: true });
    await started;
    c.send({ type: "interrupt", utteranceUntilInterrupt: "Got it: water" });
    releaseRevision({ speech: "Ready", readyToConfirm: true,
        brief: { visualStyle: "snowy", clothingOrSubject: "", setting: "",
            mood: "", importantDetails: "", preserve: "" } });
    assert.match((await c.cycle()).token, /snowy/i);
    assert.equal(f.submissions.length, 0);
    c.ws.close();
});

test("cutting into a clarification does not invalidate a completed readback", async (t) => {
    const f = await fixture(); t.after(f.close);
    await f.post("/voice/inbound", { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT });
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it watercolor", last: true });
    const readback = await c.cycle();
    c.send({ type: "info", name: "agentSpeaking", value: "true" });
    c.send({ type: "info", name: "tokensPlayed", value: readback.token });
    c.send({ type: "info", name: "agentSpeaking", value: "false" });
    c.send({ type: "prompt", voicePrompt: "okay", last: true });
    const clarification = await c.cycle();
    assert.match(clarification.token, /say yes/i);
    c.send({ type: "interrupt", utteranceUntilInterrupt: "Please say" });
    c.send({ type: "prompt", voicePrompt: "yes", last: true });
    const closing = await c.cycle();
    assert.match(closing.token, /hang up/i);
    assert.equal(f.submissions.length, 1);
    c.ws.close();
});

test("caller can change language during the call and stale model work is discarded after a cut-in", async (t) => {
    let resolveModel;
    const f = await fixture({ respond: () => new Promise((resolve) => { resolveModel = resolve; }) });
    t.after(f.close);
    const fields = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    await f.post("/voice/inbound", fields);
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    c.send({ type: "prompt", voicePrompt: "Make it a watercolor", last: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    c.send({ type: "interrupt", utteranceUntilInterrupt: "" });
    resolveModel({ speech: "Done", readyToConfirm: true, brief: BRIEF });
    c.send({ type: "prompt", voicePrompt: "Português", last: true });
    const language = await c.next();
    assert.deepEqual(language, { type: "language", ttsLanguage: "pt-BR", transcriptionLanguage: "pt-BR" });
    assert.match((await c.cycle()).token, /como.*foto/i);
    assert.equal(f.submissions.length, 0);
    c.ws.close();
});

test("socket disconnect releases its unsubmitted selfie for a later call", async (t) => {
    const f = await fixture(); t.after(f.close);
    const fields = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    await f.post("/voice/inbound", fields);
    const c = f.connect();
    await new Promise((resolve) => c.ws.once("open", resolve));
    c.send(setup(f.request.id));
    await new Promise((resolve) => setTimeout(resolve, 10));
    c.ws.close();
    await new Promise((resolve) => c.ws.once("close", resolve));
    for (let attempt = 0; attempt < 20 && (await f.store.get(f.request.id)).status !== "awaiting_call"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await f.store.get(f.request.id)).status, "awaiting_call");
    const next = await f.post("/voice/inbound", { ...fields, CallSid: "CA2" });
    assert.match(await next.text(), /ConversationRelay/);
});

test("signed action and socket close release only unsubmitted claims; expired lease recovers after restart", async (t) => {
    const f = await fixture(); t.after(f.close);
    const fields = { From: PHONE, To: VOICE, CallSid: "CA1", AccountSid: ACCOUNT };
    await f.post("/voice/inbound", fields);
    assert.equal((await f.post("/voice/action", { CallSid: "CAwrong", AccountSid: ACCOUNT })).status, 200);
    assert.equal((await f.store.get(f.request.id)).status, "claimed");
    assert.equal((await f.post("/voice/action", { CallSid: "CA1", AccountSid: ACCOUNT }, false)).status, 403);
    await f.post("/voice/action", { CallSid: "CA1", AccountSid: ACCOUNT });
    assert.equal((await f.store.get(f.request.id)).status, "awaiting_call");
    await f.post("/voice/inbound", { ...fields, CallSid: "CA2" });
    await f.store.patch(f.request.id, { claimedAt: Date.now() - 180_000 });
    await f.store.reconcileClaims(new Set());
    assert.equal((await f.store.get(f.request.id)).status, "awaiting_call");
});
