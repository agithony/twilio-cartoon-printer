const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const channels = require("../lib/channels");
const messaging = require("../lib/messaging");
const leads = require("../lib/leads");
const settings = require("../lib/settings");

const EVENT = "__lead_session_event_test__";
const eventDir = path.join(settings.EVENTS_DIR, EVENT);

after(() => fs.rmSync(eventDir, { recursive: true, force: true }));

test("lead surveys persist explicit locale and originating adapter", async () => {
    const phone = "+14155550199";
    const sent = [];
    const originalSend = messaging.send;
    messaging.send = async (...args) => {
        sent.push(args);
        return { sid: "SM_TEST" };
    };

    try {
        await leads.startSurvey(phone, "+12065550199", "Evento", "before", null, "pt_BR", "whatsapp");
        assert.match(sent[0][3]._body, /primeiro nome/i);
        assert.equal(sent[0][3].adapter, channels.ADAPTERS.whatsapp);

        await leads.processResponse(phone, "Ana");
        assert.match(sent[1][3]._body, /sobrenome/i);
        assert.equal(sent[1][3].adapter, channels.ADAPTERS.whatsapp);
        assert.equal(leads.getActiveLocale(phone, "Evento"), "pt_BR");
    } finally {
        leads.cancelSurvey(phone);
        messaging.send = originalSend;
    }
});

test("lead surveys resolve and retain fields from their originating event", async () => {
    const phone = "+14155550200";
    const sent = [];
    const originalSend = messaging.send;
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        leadCaptureFields: {
            firstName: { enabled: true, prompt: "Origin event first name?", errorMsg: "Origin event error" },
            lastName: { enabled: true, prompt: "Origin event last name?", errorMsg: "Origin event error" },
            country: { enabled: false },
            email: { enabled: false },
            personalEmail: { enabled: false },
            company: { enabled: false },
            jobTitle: { enabled: false },
        },
    }));
    messaging.send = async (...args) => {
        sent.push(args);
        return { sid: "SM_TEST" };
    };

    try {
        await leads.startSurvey(phone, "+12065550200", EVENT, "before", null, "en", "sms");
        assert.match(sent[0][3]._body, /Origin event first name\?/);
        await leads.processResponse(phone, "Ada");
        assert.match(sent[1][3]._body, /Origin event last name\?/);
    } finally {
        leads.cancelSurvey(phone);
        messaging.send = originalSend;
    }
});
