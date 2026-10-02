const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createVoiceAgent } = require("../lib/voice/agent");

const BRIEF = {
    visualStyle: "watercolor", clothingOrSubject: "blue jacket", setting: "Mars",
    mood: "bright", importantDetails: "red sky", preserve: "face and glasses",
};

function fixture({ locale = "en", respond } = {}) {
    const submissions = [];
    let request = {
        id: "request1", status: "claimed", locale, scene: { subjects: 1 },
        stagedInputPath: "/private/photo.jpg", expiresAt: Date.now() + 60_000,
        eventSettings: { multiSubjectMode: "reject" },
    };
    const store = {
        async get() { return request; },
        async patch(_id, changes) { request = { ...request, ...changes }; return request; },
    };
    const agent = createVoiceAgent({
        respond: respond || (async () => ({ speech: "I can do that.", readyToConfirm: true, brief: BRIEF })),
        moderate: async () => ({ flagged: false }),
        submit: async (input) => { submissions.push(input); return { status: "committed", filePrefixes: ["one"] }; },
        store,
    });
    const session = { requestId: "request1", callSid: "CA1", locale, phase: locale ? "collecting" : "language_choice", history: [] };
    return { agent, session, submissions, get request() { return request; } };
}

test("opening asks specifically how the selfie should look and gives examples", () => {
    const f = fixture();
    const opening = f.agent.opening(f.session);
    assert.match(opening.speech, /how.*photo.*look/i);
    assert.match(opening.speech, /outfit|Mars|watercolor/i);
});

test("opening compliments the accepted selfie in English and Portuguese", () => {
    const english = fixture();
    assert.match(english.agent.opening(english.session).speech, /great (selfie|photo)/i);
    const portuguese = fixture({ locale: "pt_BR" });
    assert.match(portuguese.agent.opening(portuguese.session).speech, /ótima selfie/i);
});

test("unknown-locale caller chooses Portuguese before describing the picture", async () => {
    const f = fixture({ locale: null });
    assert.match(f.agent.opening(f.session).speech, /English.*Português/i);
    const response = await f.agent.onPrompt(f.session, "Português");
    assert.equal(f.session.locale, "pt_BR");
    assert.equal(f.request.locale, "pt_BR");
    assert.match(response.speech, /como.*foto/i);
});

test("clarification stays conversational and does not submit", async () => {
    const f = fixture({ respond: async () => ({ speech: "Retro as clothing, setting, or art style?", readyToConfirm: false, brief: BRIEF }) });
    const result = await f.agent.onPrompt(f.session, "Make it retro");
    assert.match(result.speech, /clothing, setting, or art style/i);
    assert.equal(f.session.phase, "collecting");
    assert.equal(f.submissions.length, 0);
});

test("only a fully played readback followed by explicit yes submits", async () => {
    const f = fixture();
    const readback = await f.agent.onPrompt(f.session, "Watercolor on Mars in a blue jacket");
    assert.equal(f.session.phase, "reading_back");
    assert.equal(readback.kind, "readback");
    assert.match(readback.speech, /watercolor.*Mars/i);
    assert.equal(f.submissions.length, 0);
    const early = await f.agent.onPrompt(f.session, "yes");
    assert.equal(f.submissions.length, 0);
    assert.equal(early.kind, "readback");
    assert.notEqual(early.generationId, readback.generationId);
    f.agent.onPlaybackComplete(f.session, readback.generationId);
    assert.equal(f.session.phase, "reading_back");
    f.agent.onPlaybackComplete(f.session, early.generationId);
    assert.equal(f.session.phase, "awaiting_confirmation");
    const closing = await f.agent.onPrompt(f.session, "yes, do it");
    assert.equal(f.submissions.length, 1);
    assert.equal(closing.kind, "closing");
    assert.match(closing.speech, /hang up.*same chat/i);
});

test("ambiguous okay and revision do not submit", async () => {
    const f = fixture();
    const readback = await f.agent.onPrompt(f.session, "Watercolor on Mars");
    f.agent.onPlaybackComplete(f.session, readback.generationId);
    const ambiguous = await f.agent.onPrompt(f.session, "okay");
    assert.match(ambiguous.speech, /yes|sim/i);
    assert.equal(f.submissions.length, 0);
    await f.agent.onPrompt(f.session, "Actually make the background snowy");
    assert.equal(f.submissions.length, 0);
    assert.equal(f.session.phase, "reading_back");
});

test("interruption invalidates readback and trims unspoken agent text", async () => {
    const f = fixture({ respond: async () => ({ speech: "Let me change that to snow.", readyToConfirm: false, brief: BRIEF }) });
    f.session.phase = "reading_back";
    f.session.readbackGenerationId = 9;
    f.session.history = [{ role: "assistant", content: "I will make your photo look like watercolor on Mars." }];
    f.agent.onInterrupt(f.session, "I will make your photo");
    assert.equal(f.session.phase, "collecting");
    assert.equal(f.session.history[0].content, "I will make your photo");
    await f.agent.onPrompt(f.session, "Actually snowy background");
    assert.equal(f.submissions.length, 0);
    f.agent.onPlaybackComplete(f.session, 9);
    assert.notEqual(f.session.phase, "awaiting_confirmation");
});

test("moderation rejection and service errors invite revision without readback", async () => {
    for (const outcome of [{ flagged: true }, new Error("offline")]) {
        const f = fixture();
        const agent = createVoiceAgent({
            respond: async () => ({ speech: "Sure", readyToConfirm: true, brief: BRIEF }),
            moderate: async () => { if (outcome instanceof Error) throw outcome; return outcome; },
            submit: async () => { f.submissions.push("bad"); }, store: {
                get: async () => f.request,
                patch: async (_id, changes) => Object.assign(f.request, changes),
            },
        });
        const response = await agent.onPrompt(f.session, "Do this edit");
        assert.equal(f.session.phase, "collecting");
        assert.equal(response.kind, "say");
        assert.equal(f.submissions.length, 0);
    }
});

test("late model response after an interruption is discarded", async () => {
    let resolve;
    const f = fixture({ respond: () => new Promise((r) => { resolve = r; }) });
    const inFlight = f.agent.onPrompt(f.session, "Start an edit");
    await new Promise((r) => setImmediate(r));
    f.agent.onInterrupt(f.session, "");
    resolve({ speech: "Approved", readyToConfirm: true, brief: BRIEF });
    const result = await inFlight;
    assert.equal(result.stale, true);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.request.approvedBrief, undefined);
});

test("interruption during a slow policy check cannot persist approval", async () => {
    let releaseModeration;
    const f = fixture();
    const agent = createVoiceAgent({
        respond: async () => ({ speech: "Ready", readyToConfirm: true, brief: BRIEF }),
        moderate: () => new Promise((resolve) => { releaseModeration = resolve; }),
        submit: async () => { f.submissions.push("bad"); },
        store: { get: async () => f.request, patch: async (_id, changes) => Object.assign(f.request, changes) },
    });
    const inFlight = agent.onPrompt(f.session, "Make it watercolor");
    await new Promise((resolve) => setImmediate(resolve));
    agent.onInterrupt(f.session, "");
    releaseModeration({ flagged: false });
    assert.equal((await inFlight).stale, true);
    assert.equal(f.request.approvedBrief, undefined);
    assert.equal(f.submissions.length, 0);
});

test("conversation memory is bounded to the most recent sixteen turns", async () => {
    let seen;
    const f = fixture({ respond: async (args) => {
        seen = args.history;
        return { speech: "Which setting?", readyToConfirm: false, brief: BRIEF };
    } });
    f.session.history = Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `turn ${index}` }));
    await f.agent.onPrompt(f.session, "A new idea");
    assert.equal(seen.length, 16);
    assert.equal(f.session.history.length, 16);
});

test("Portuguese confirmation starts the portrait only after playback", async () => {
    const f = fixture({ locale: "pt_BR" });
    const readback = await f.agent.onPrompt(f.session, "Quero aquarela em Marte");
    f.agent.onPlaybackComplete(f.session, readback.generationId);
    const closing = await f.agent.onPrompt(f.session, "pode fazer");
    assert.equal(f.submissions.length, 1);
    assert.match(closing.speech, /desligar.*conversa/i);
});
