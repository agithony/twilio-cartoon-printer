const { test } = require("node:test");
const assert = require("node:assert/strict");
const twilio = require("twilio");
const { buildDefinitions, approvalCategories, getContentName, main } = require("../scripts/create-content-templates");

test("static template inventory and samples are valid", () => {
    const definitions = buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", "en", "+14155550100");
    assert.deepEqual(Object.keys(definitions).sort(), ["delivery", "nudgeDropoff", "promo", "rating", "voiceDelivery", "voiceFailure", "voiceInvitation"]);
    assert.equal(definitions.delivery.variables[2], "assets/template-sample-portrait.png");
    assert.equal(definitions.voiceDelivery.variables[2], "assets/template-sample-portrait.png");
    assert.equal(definitions.delivery.types["twilio/card"].actions.length, 1);
    assert.equal(definitions.delivery.types["twilio/card"].subtitle, "Created at the Twilio AI Photo Booth");
    assert.equal(definitions.rating.types["twilio/quick-reply"].actions.length, 5);
    assert.equal(definitions.promo.variables, undefined);
    assert.equal(approvalCategories.delivery, "UTILITY");
    assert.equal(approvalCategories.voiceDelivery, "UTILITY");
    assert.equal(approvalCategories.voiceFailure, "UTILITY");
    assert.equal(approvalCategories.voiceInvitation, "UTILITY");
    assert.equal(approvalCategories.promo, "MARKETING");
});

test("Voice invitations offer a regular phone call in both languages without a tappable WhatsApp number", () => {
    for (const [locale, buttonName, samePhone] of [
        ["en", /call.*phone/i, /same phone/i],
        ["pt_BR", /ligar.*telefone/i, /mesmo celular/i],
    ]) {
        const number = "+14155550100";
        const definitions = buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", locale, number);
        const invite = definitions.voiceInvitation.types["twilio/call-to-action"];
        assert.equal(invite.actions.length, 1);
        assert.equal(invite.actions[0].type, "PHONE_NUMBER");
        assert.equal(invite.actions[0].phone, number);
        assert.ok(invite.actions[0].title.length <= 20);
        assert.match(invite.actions[0].title, buttonName);
        assert.match(invite.body, samePhone);
        assert.match(invite.body, /30/);
        assert.doesNotMatch(invite.body, /\+\d{8,15}/);
    }
    const oldNumber = buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", "en", "+14155550100");
    const newNumber = buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", "en", "+14155550101");
    assert.notEqual(oldNumber.voiceInvitation.friendlyName, newNumber.voiceInvitation.friendlyName);
    assert.equal(buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", "en", "").voiceInvitation, undefined);
});

test("Portuguese templates preserve payload IDs and field limits", () => {
    const definitions = buildDefinitions("https://booth.example.com", "assets/template-samples/sample-portrait.jpg", "pt_BR");
    assert.equal(definitions.delivery.language, "pt_BR");
    assert.match(definitions.delivery.friendlyName, /^pb_delivery_pt_br_[a-f0-9]+$/);
    assert.match(definitions.delivery.types["twilio/card"].title, /retrato/i);
    assert.equal(definitions.delivery.types["twilio/card"].subtitle, "Criado na cabine de fotos com IA da Twilio");
    assert.equal(definitions.rating.types["twilio/quick-reply"].actions[0].id, "nps_5");
    for (const action of definitions.rating.types["twilio/quick-reply"].actions) {
        assert.ok(action.title.length <= 20);
    }
});

test("print-only mode builds both locales without calling Twilio", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
        const result = await main({
            client: new Proxy({}, { get() { throw new Error("Twilio should not be called"); } }),
            settingsModule: {
                load() { this.loaded = true; },
                get(key) { return key === "twilioVoiceNumber" && this.loaded ? "+14155550100" : ""; },
            },
            baseUrl: "https://booth.example.com",
            samplePortraitPath: "assets/template-sample-portrait.png",
            printOnly: true,
        });
        assert.deepEqual(Object.keys(result.definitions), ["en", "pt_BR"]);
        assert.equal(result.definitions.en.voiceInvitation.types["twilio/call-to-action"].actions[0].phone, "+14155550100");
        assert.equal(result.definitions.pt_BR.voiceInvitation.types["twilio/call-to-action"].actions[0].phone, "+14155550100");
    } finally {
        console.log = originalLog;
    }
});

test("print-only mode skips the Voice invitation clearly when no valid Voice number is configured", async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const warnings = [];
    console.log = () => {};
    console.warn = (line) => warnings.push(line);
    try {
        const result = await main({
            client: new Proxy({}, { get() { throw new Error("Twilio should not be called"); } }),
            settingsModule: { load() {}, get() { return "invalid"; } },
            baseUrl: "https://booth.example.com",
            samplePortraitPath: "assets/template-sample-portrait.png",
            printOnly: true,
        });
        assert.equal(result.definitions.en.voiceInvitation, undefined);
        assert.equal(result.definitions.pt_BR.voiceInvitation, undefined);
        assert.match(warnings.join(" "), /Voice invitation.*skipped.*E\.164/i);
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
});

function fakeContentClient(existing, created, submitted) {
    const newSids = new Set();
    const contents = (sid) => ({
        approvalFetch: () => ({ fetch: async () => {
            if (newSids.has(sid)) {
                const error = new Error("Unsubmitted");
                error.status = 404;
                throw error;
            }
            return { whatsapp: { status: "approved" } };
        } }),
        approvalCreate: { create: async (options) => submitted.push({ sid, ...options }) },
    });
    contents.list = async () => existing;
    contents.create = async (definition) => {
        const sid = `HXnew${created.length + 1}`;
        newSids.add(sid);
        created.push(definition);
        return { sid };
    };
    return { content: { v1: { contents } } };
}

test("template creation submits only newly added Voice invitations when earlier templates already exist", async () => {
    const number = "+14155550100";
    const existing = [];
    const current = { en: {}, pt_BR: {} };
    for (const locale of ["en", "pt_BR"]) {
        const definitions = buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", locale, number);
        for (const [key, definition] of Object.entries(definitions)) {
            if (key !== "voiceInvitation") {
                const sid = `HXexisting${existing.length + 1}`;
                existing.push({ sid, friendlyName: definition.friendlyName });
                current[locale][key] = sid;
            }
        }
    }
    const created = [];
    const submitted = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
        await main({
            client: fakeContentClient(existing, created, submitted),
            settingsModule: {
                load() {},
                get(key) { return key === "twilioVoiceNumber" ? number : current; },
                update() { throw new Error("No newly approved SID should be saved"); },
            },
            baseUrl: "https://booth.example.com",
            samplePortraitPath: "assets/template-sample-portrait.png",
            printOnly: false,
        });
    } finally {
        console.log = originalLog;
    }
    assert.equal(created.length, 2);
    assert.equal(submitted.length, 2);
    assert.ok(created.every((definition) => definition.types["twilio/call-to-action"].actions[0].phone === number));
    assert.ok(submitted.every((request) => request.category === "UTILITY"));
});

test("pending replacement templates do not erase configured approved Voice SIDs", async () => {
    const current = {
        en: { voiceDelivery: "HXapprovedEnResult", voiceFailure: "HXapprovedEnFailure" },
        pt_BR: { voiceDelivery: "HXapprovedPtResult", voiceFailure: "HXapprovedPtFailure" },
    };
    let saved;
    const created = [];
    const submitted = [];
    const existing = [{
        sid: "HXnewlyApprovedDelivery",
        friendlyName: buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", "en", "+14155550100").delivery.friendlyName,
    }];
    const originalLog = console.log;
    console.log = () => {};
    try {
        await main({
            client: fakeContentClient(existing, created, submitted),
            settingsModule: {
                load() {},
                get(key) { return key === "twilioVoiceNumber" ? "+14155550100" : current; },
                update(changes) { saved = changes.contentTemplates; },
            },
            baseUrl: "https://booth.example.com",
            samplePortraitPath: "assets/template-sample-portrait.png",
            printOnly: false,
        });
    } finally {
        console.log = originalLog;
    }
    assert.equal(created.length, 13);
    assert.equal(submitted.length, 13);
    assert.equal(saved.en.delivery, "HXnewlyApprovedDelivery");
    assert.equal(saved.en.voiceDelivery, current.en.voiceDelivery);
    assert.equal(saved.en.voiceFailure, current.en.voiceFailure);
    assert.equal(saved.pt_BR.voiceDelivery, current.pt_BR.voiceDelivery);
    assert.equal(saved.pt_BR.voiceFailure, current.pt_BR.voiceFailure);
});

test("approved Voice invitation SIDs retain their approved phone number", async () => {
    const number = "+14155550100";
    const existing = [];
    for (const locale of ["en", "pt_BR"]) {
        const definitions = buildDefinitions("https://booth.example.com", "assets/template-sample-portrait.png", locale, number);
        for (const definition of Object.values(definitions)) {
            existing.push({ sid: `HXexisting${existing.length + 1}`, friendlyName: definition.friendlyName });
        }
    }
    let saved;
    const originalLog = console.log;
    console.log = () => {};
    try {
        await main({
            client: fakeContentClient(existing, [], []),
            settingsModule: {
                load() {},
                get(key) { return key === "twilioVoiceNumber" ? number : { en: {}, pt_BR: {} }; },
                update(changes) { saved = changes.contentTemplates; },
            },
            baseUrl: "https://booth.example.com",
            samplePortraitPath: "assets/template-sample-portrait.png",
            printOnly: false,
        });
    } finally {
        console.log = originalLog;
    }
    assert.ok(saved.en.voiceInvitation.startsWith("HX"));
    assert.ok(saved.pt_BR.voiceInvitation.startsWith("HX"));
    assert.equal(saved.en.voiceInvitationPhone, number);
    assert.equal(saved.pt_BR.voiceInvitationPhone, number);
});

test("existing submitted templates resolve their name from WhatsApp approval", async () => {
    const client = {
        content: { v1: { contents: () => ({
            approvalFetch: () => ({ fetch: async () => ({ whatsapp: { name: "pb_delivery_en_abc123" } }) }),
        }) } },
    };
    assert.equal(await getContentName(client, { sid: "HXexisting", friendlyName: null }), "pb_delivery_en_abc123");
});

test("installed Twilio SDK exposes approval methods used by script", () => {
    const client = twilio("AC00000000000000000000000000000000", "test");
    const context = client.content.v1.contents("HX00000000000000000000000000000000");
    assert.equal(typeof context.approvalFetch().fetch, "function");
    assert.equal(typeof context.approvalCreate.create, "function");
});
