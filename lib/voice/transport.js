const { URL } = require("node:url");
const express = require("express");
const twilio = require("twilio");
const { WebSocketServer, WebSocket } = require("ws");
const { buildRequestUrl, createTwilioWebhookValidator } = require("../twilio-webhook");
const { normalizePhone } = require("./store");

const NO_SELFIE = "I couldn't find a selfie from this phone. Please send one in the chat, then call from the same phone.";
const IN_CALL = "A photo call is already in progress for this phone. Please finish that call before trying again.";
const IN_PROGRESS = "Your portrait has already started. I'll send it to the same chat when it's ready.";
const UNAVAILABLE = "The photo service is unavailable right now. Please try calling again shortly.";

function publicBaseUrl(settings, explicit) {
    const value = explicit || process.env.BASE_URL || settings.get?.("baseUrl") || "";
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password
            || url.search || url.hash || url.pathname !== "/") return null;
        return url.origin;
    } catch { return null; }
}

function xmlSay(message, locale = "en") {
    const response = new twilio.twiml.VoiceResponse();
    response.say({ language: locale === "pt_BR" ? "pt-BR" : "en-US" }, message);
    return response.toString();
}

function currentEvent(settings) { return settings.get("eventName"); }

function mountVoiceHttp(app, { store, settings, agent, baseUrl } = {}) {
    if (!app || !store || !settings || !agent) throw new Error("Voice HTTP transport requires app, store, settings, and agent");
    const parse = express.urlencoded({ extended: false, limit: "8kb" });
    const validate = createTwilioWebhookValidator({
        getAuthToken: () => settings.get("twilioAuthToken"),
        baseUrl: publicBaseUrl(settings, baseUrl),
        allowSkip: false,
    });

    app.post("/voice/inbound", parse, validate, async (req, res) => {
        const publicUrl = publicBaseUrl(settings, baseUrl);
        if (!publicUrl) return res.status(503).send("Voice public URL is not configured");
        const { AccountSid, CallSid, From, To } = req.body || {};
        if (AccountSid !== settings.get("twilioAccountSid")
            || To !== settings.get("twilioVoiceNumber") || !/^CA[A-Za-z0-9]+$/.test(CallSid || "")) {
            return res.status(403).send("Invalid Voice call");
        }
        let caller;
        try { caller = normalizePhone(From); } catch {
            return res.type("text/xml").send(xmlSay(NO_SELFIE));
        }
        const eventName = currentEvent(settings);
        try {
            const request = await store.claimLatest({ phone: caller, eventName, callSid: CallSid });
            if (!request) {
                const latest = await store.findLatest({ phone: caller, eventName,
                    statuses: ["claimed", "queued", "submitting"] });
                const message = latest?.status === "claimed" ? IN_CALL
                    : latest && ["queued", "submitting"].includes(latest.status) ? IN_PROGRESS : NO_SELFIE;
                return res.type("text/xml").send(xmlSay(message));
            }
            const response = new twilio.twiml.VoiceResponse();
            const greeting = agent.opening({ requestId: request.id, callSid: CallSid, locale: request.locale }).speech;
            const relay = response.connect({ action: `${publicUrl}/voice/action` }).conversationRelay({
                url: `${publicUrl.replace(/^https:/, "wss:")}/voice/ws`,
                welcomeGreeting: greeting,
                welcomeGreetingInterruptible: "speech",
                interruptible: "speech",
                interruptSensitivity: "medium",
                reportInputDuringAgentSpeech: "speech",
                events: "speaker-events tokens-played",
                language: request.locale === "pt_BR" ? "pt-BR" : request.locale === "en" ? "en-US" : "multi",
                ttsProvider: "ElevenLabs",
                transcriptionProvider: "Deepgram",
            });
            relay.parameter({ name: "requestId", value: request.id });
            return res.type("text/xml").send(response.toString());
        } catch {
            return res.status(503).type("text/xml").send(xmlSay(UNAVAILABLE));
        }
    });

    app.post("/voice/action", parse, validate, async (req, res) => {
        if (req.body?.AccountSid !== settings.get("twilioAccountSid")) {
            return res.status(403).send("Invalid Voice account");
        }
        if (typeof req.body?.CallSid === "string") await store.release(req.body.CallSid);
        return res.type("text/xml").send(new twilio.twiml.VoiceResponse().toString());
    });
}

function shortChunks(speech) {
    const words = String(speech || "").match(/\S+\s*/g) || [];
    const chunks = [];
    let current = "";
    for (const word of words) {
        if (current && current.length + word.length > 95) {
            chunks.push(current);
            current = "";
        }
        current += word;
    }
    if (current) chunks.push(current);
    return chunks;
}

function normalized(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function attachVoiceSocket(server, { store, settings, agent, baseUrl } = {}) {
    if (!server || !store || !settings || !agent) throw new Error("Voice socket requires server, store, settings, and agent");
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    const active = new Map();
    server.on("upgrade", (request, socket, head) => {
        if (request.url !== "/voice/ws") return;
        const publicUrl = publicBaseUrl(settings, baseUrl);
        const signature = request.headers["x-twilio-signature"];
        const token = settings.get("twilioAuthToken");
        const valid = publicUrl && token && signature
            && twilio.validateRequest(token, signature, `${publicUrl.replace(/^https:/, "wss:")}/voice/ws`, {});
        if (!valid) {
            socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });

    wss.on("connection", (ws) => {
        let session = null;
        let setupPromise = null;
        let outputEpoch = 0;
        let pendingOutput = null;
        let closed = false;
        const send = (message) => {
            if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        };
        const reject = () => ws.close(1008, "Invalid Voice session");

        function speak(result, epoch) {
            if (closed || epoch !== outputEpoch || !result || result.stale) return;
            const chunks = shortChunks(result.speech);
            if (!chunks.length) return;
            pendingOutput = result.kind === "readback"
                ? { generationId: result.generationId, speech: normalized(result.speech), played: "", started: false }
                : null;
            chunks.forEach((token, index) => send({ type: "text", token,
                last: index === chunks.length - 1, interruptible: true,
                ...(index === 0 ? { preemptible: true } : {}) }));
        }

        async function handle(message) {
            if (!message || typeof message.type !== "string") return reject();
            if (!session) {
                if (message.type !== "setup" || !message.customParameters
                    || typeof message.customParameters.requestId !== "string") return reject();
                const request = await store.get(message.customParameters.requestId);
                if (closed) return;
                const account = settings.get("twilioAccountSid");
                const voiceNumber = settings.get("twilioVoiceNumber");
                let caller;
                try { caller = normalizePhone(message.from); } catch { return reject(); }
                if (!request || request.status !== "claimed" || request.callSid !== message.callSid
                    || request.id !== message.customParameters.requestId || caller !== request.phone
                    || message.to !== voiceNumber || message.accountSid !== account
                    || request.eventName !== currentEvent(settings) || active.has(message.callSid)) return reject();
                session = { requestId: request.id, callSid: message.callSid, locale: request.locale,
                    phase: request.locale ? "collecting" : "language_choice", history: [] };
                active.set(message.callSid, ws);
                await store.touchCall(message.callSid);
                return;
            }
            if (message.type === "setup") return reject();
            if (message.type === "interrupt") {
                outputEpoch++;
                pendingOutput = null;
                agent.onInterrupt(session, message.utteranceUntilInterrupt || "");
                return;
            }
            if (message.type === "info" && message.name === "agentSpeaking" && pendingOutput) {
                const value = String(message.value ?? "").toLowerCase();
                if (!["false", "stopped", "stop", "end", "ended", "0"].includes(value)) {
                    pendingOutput.started = true;
                }
                return;
            }
            if (message.type === "info" && message.name === "tokensPlayed" && pendingOutput) {
                if (!pendingOutput.started) return;
                const played = typeof message.value === "string" ? message.value : "";
                if (!played) return;
                const cumulative = pendingOutput.played + played;
                const direct = normalized(played);
                pendingOutput.played = pendingOutput.speech.startsWith(normalized(cumulative)) ? cumulative
                    : pendingOutput.speech.startsWith(direct) ? played : "";
                if (normalized(pendingOutput.played) === pendingOutput.speech) {
                    agent.onPlaybackComplete(session, pendingOutput.generationId);
                    pendingOutput = null;
                }
                return;
            }
            if (message.type === "prompt" && message.last === true) {
                const transcript = typeof message.voicePrompt === "string" ? message.voicePrompt.trim() : "";
                if (!transcript) return;
                const epoch = ++outputEpoch;
                pendingOutput = null;
                const previousLocale = session.locale;
                const result = await agent.onPrompt(session, transcript);
                if (closed || epoch !== outputEpoch) return;
                if (session.locale !== previousLocale && ["en", "pt_BR"].includes(session.locale)) {
                    const lang = session.locale === "pt_BR" ? "pt-BR" : "en-US";
                    send({ type: "language", ttsLanguage: lang, transcriptionLanguage: lang });
                }
                speak(result, epoch);
            }
        }

        ws.on("message", (raw) => {
            let message;
            try { message = JSON.parse(String(raw)); } catch { return reject(); }
            if (!session && !setupPromise) {
                if (message.type !== "setup") return reject();
                setupPromise = handle(message).catch(() => reject());
                return;
            }
            void (async () => {
                await setupPromise;
                if (!closed) await handle(message);
            })().catch(() => reject());
        });
        ws.on("close", () => {
            closed = true;
            outputEpoch++;
            if (!session) return;
            agent.onClose(session);
            active.delete(session.callSid);
            void store.release(session.callSid).catch(() => {});
        });
    });
    wss.activeCallSids = () => new Set(active.keys());
    return wss;
}

module.exports = { mountVoiceHttp, attachVoiceSocket, shortChunks };
