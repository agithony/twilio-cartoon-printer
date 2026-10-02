const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { once } = require("node:events");

const { readinessIssues } = require("../lib/voice/readiness");
const settings = require("../lib/settings");
const { buildHomeHtml } = require("../lib/home");
const { mountDashboard } = require("../lib/dashboard");

const settingsFile = path.join(__dirname, "..", "data", "settings.json");
const profileFile = path.join(__dirname, "..", "data", "events", "default", "settings.json");
const otherEvent = "Voice Readiness Other Event";
const otherProfileFile = path.join(__dirname, "..", "data", "events", otherEvent, "settings.json");
const originals = new Map();
const originalBaseUrl = process.env.BASE_URL;
let otherDownloadExisted = false;

before(() => {
    for (const file of [settingsFile, profileFile, otherProfileFile]) {
        originals.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    }
    otherDownloadExisted = fs.existsSync(settings.getDownloadDir(otherEvent));
    process.env.BASE_URL = "https://booth.example";
    settings.load();
});

after(() => {
    for (const [file, bytes] of originals) {
        if (bytes === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, bytes);
    }
    const otherProfileDir = path.dirname(otherProfileFile);
    if (fs.existsSync(otherProfileDir) && fs.readdirSync(otherProfileDir).length === 0) {
        fs.rmdirSync(otherProfileDir);
    }
    if (!otherDownloadExisted) {
        fs.rmSync(settings.getDownloadDir(otherEvent), { recursive: true, force: true });
    }
    if (originalBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = originalBaseUrl;
});

const ready = {
    twilioVoiceNumber: "+14155550100",
    twilioAccountSid: "ACtest",
    twilioAuthToken: "test-token",
    openaiApiKey: "test-key",
    leadCaptureMode: "disabled",
    twilioWhatsappNumber: "",
    twilioWhatsappMessagingServiceSid: "",
    contentTemplates: { en: {}, pt_BR: {} },
};

test("Voice readiness accepts a configured SMS-only booth and rejects missing local prerequisites", () => {
    assert.deepEqual(readinessIssues(ready, "https://booth.example"), []);
    assert.match(readinessIssues({ ...ready, twilioVoiceNumber: "" }, "https://booth.example").join(" "), /Voice number/);
    assert.match(readinessIssues(ready, "http://booth.example").join(" "), /HTTPS/);
    assert.match(readinessIssues({ ...ready, leadCaptureMode: "before" }, "https://booth.example").join(" "), /lead capture/);
    assert.match(readinessIssues({ ...ready, openaiApiKey: "" }, "https://booth.example").join(" "), /OpenAI/);
});

test("WhatsApp Voice readiness needs result and failure templates in both languages", () => {
    const issues = readinessIssues({ ...ready, twilioWhatsappNumber: "+14155550101" }, "https://booth.example");
    assert.equal(issues.length, 4);
    assert.match(issues.join(" "), /en voiceDelivery/);
    assert.match(issues.join(" "), /pt_BR voiceFailure/);
    assert.deepEqual(readinessIssues({
        ...ready,
        twilioWhatsappNumber: "+14155550101",
        contentTemplates: {
            en: { voiceDelivery: "HXenResult", voiceFailure: "HXenFail" },
            pt_BR: { voiceDelivery: "HXptResult", voiceFailure: "HXptFail" },
        },
    }, "https://booth.example"), []);
});

test("settings rejects Voice plus before-survey atomically and keeps Voice event-scoped", () => {
    settings.update({ ...ready, enableVoice: false });
    assert.throws(() => settings.update({ enableVoice: true, leadCaptureMode: "before" }), /Voice.*lead capture/);
    assert.equal(settings.get("enableVoice"), false);
    assert.equal(settings.get("leadCaptureMode"), "disabled");

    settings.update({ enableVoice: true });
    assert.equal(settings.get("enableVoice"), true);
    assert.equal(settings.get("twilioVoiceNumber"), "+14155550100");
    settings.update({ eventName: otherEvent });
    assert.equal(settings.get("enableVoice"), false);
    assert.equal(settings.get("twilioVoiceNumber"), "+14155550100");
    settings.update({ eventName: "default" });
    assert.equal(settings.get("enableVoice"), true);
    settings.update({ enableVoice: false });
});

test("settings API returns 400 and reasons for Voice plus before-survey", async () => {
    settings.update({ ...ready, enableVoice: false });
    const app = express();
    app.use((req, _res, next) => { req.user = { email: "test@example.com" }; next(); });
    mountDashboard(app);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard/api/settings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enableVoice: true, leadCaptureMode: "before" }),
        });
        assert.equal(response.status, 400);
        assert.match(JSON.stringify(await response.json()), /lead capture/);
        assert.equal(settings.get("enableVoice"), false);
    } finally {
        server.close();
    }
});

test("operator settings expose the Voice switch, number, and readiness note", () => {
    const html = buildHomeHtml();
    assert.match(html, /id="sEnableVoice"/);
    assert.match(html, /id="sTwilioVoiceNumber"/);
    assert.match(html, /id="voiceReadiness"/);
    assert.match(html, /test call/i);
});
