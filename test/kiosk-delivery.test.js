const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { PENDING_DIR } = require("../lib/config");
const channelRegistry = require("../lib/channels");
const settings = require("../lib/settings");
const kioskSubmissions = require("../lib/kiosk-submissions");
const { mountApiGenerate } = require("../lib/api-generate");
const { buildKioskHtml } = require("../lib/kiosk");
const { getKioskDeliveryChannels, resolveKioskDeliveryChannel } = require("../lib/kiosk-delivery");
const { __jobAdapterForTest: jobAdapter } = require("../lib/queue");

function dependencies({
    sms = true,
    whatsapp = true,
    showSms = true,
    showWhatsapp = true,
    deliverySid = "HXdelivery",
    enablePrinting = true,
    immediateDigitalDelivery = true,
} = {}) {
    const eventSettings = { boothShowSms: showSms, boothShowWhatsapp: showWhatsapp, enablePrinting, immediateDigitalDelivery };
    return {
        settingsModule: {
            getForEvent: (key) => eventSettings[key],
            getContentSid: (key) => key === "delivery" ? deliverySid : null,
        },
        adapters: {
            sms: { isConfigured: () => sms },
            whatsapp: { isConfigured: () => whatsapp },
        },
    };
}

test("kiosk offers configured SMS and template-backed WhatsApp delivery", () => {
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies()), ["sms", "whatsapp"]);
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies({ deliverySid: "" })), ["sms"]);
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies({ immediateDigitalDelivery: false })), ["sms"]);
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies({ showSms: false })), ["whatsapp"]);
});

test("kiosk requires an explicit choice when both delivery channels are available", () => {
    assert.throws(() => resolveKioskDeliveryChannel({
        requestedChannel: "",
        hasPhone: true,
        kioskSubmission: true,
        eventName: "Event",
        locale: "en",
    }, dependencies()), (err) => err.status === 400 && /Choose SMS or WhatsApp/.test(err.message));

    assert.equal(resolveKioskDeliveryChannel({
        requestedChannel: "whatsapp",
        hasPhone: true,
        kioskSubmission: true,
        eventName: "Event",
        locale: "en",
    }, dependencies()), "whatsapp");
});

test("generate API keeps SMS compatibility and rejects unsafe WhatsApp delivery", () => {
    assert.equal(resolveKioskDeliveryChannel({
        requestedChannel: "",
        hasPhone: true,
        kioskSubmission: false,
        eventName: "Event",
        locale: "en",
    }, dependencies()), "sms");

    assert.throws(() => resolveKioskDeliveryChannel({
        requestedChannel: "whatsapp",
        hasPhone: true,
        kioskSubmission: false,
        eventName: "Event",
        locale: "en",
    }, dependencies({ deliverySid: "" })), (err) => err.status === 409 && /template/.test(err.message));

    assert.equal(resolveKioskDeliveryChannel({
        requestedChannel: "whatsapp",
        hasPhone: false,
        kioskSubmission: true,
        eventName: "Event",
        locale: "en",
    }, dependencies()), null);
});

test("queued kiosk delivery never falls back to a different channel", () => {
    const originalWhatsapp = channelRegistry.ADAPTERS.whatsapp.isConfigured;
    const originalSms = channelRegistry.ADAPTERS.sms.isConfigured;
    channelRegistry.ADAPTERS.whatsapp.isConfigured = () => false;
    channelRegistry.ADAPTERS.sms.isConfigured = () => true;
    try {
        assert.throws(() => jobAdapter({ channel: "whatsapp", userPhone: "+14155551234" }), /not configured/);
    } finally {
        channelRegistry.ADAPTERS.whatsapp.isConfigured = originalWhatsapp;
        channelRegistry.ADAPTERS.sms.isConfigured = originalSms;
    }
});

test("kiosk renders localized SMS and WhatsApp delivery controls", () => {
    const english = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Event",
        locale: "en",
        deliveryChannels: ["sms", "whatsapp"],
    });
    assert.match(english, /name="deliveryChannel" value="sms"/);
    assert.match(english, /name="deliveryChannel" value="whatsapp"/);
    assert.match(english, /qs\.set\("channel", deliveryChannel\)/);
    assert.match(english, /qs\.set\("kiosk", "1"\)/);
    assert.match(english, /By choosing WhatsApp/);

    const portuguese = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Desenho" }],
        eventName: "Evento",
        locale: "pt_BR",
        languageMode: "pt_BR",
        deliveryChannels: ["sms", "whatsapp"],
    });
    assert.match(portuguese, /Enviar retrato por/);
    assert.match(portuguese, /Ao escolher o WhatsApp/);
    assert.doesNotMatch(portuguese, /By choosing WhatsApp/);
    const script = portuguese.match(/<script>\nconst STYLES[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, "");
    assert.doesNotThrow(() => new vm.Script(script));
});

test("kiosk WhatsApp submission persists the selected job channel", async () => {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-whatsapp-"));
    const prefix = "29990102_030405";
    const pendingPath = path.join(PENDING_DIR, `${prefix}.json`);
    const fixedNow = new Date(2999, 0, 2, 3, 4, 5).getTime();
    const originals = {
        now: Date.now,
        get: settings.get,
        getForEvent: settings.getForEvent,
        getContentSid: settings.getContentSid,
        getActiveStyleList: settings.getActiveStyleList,
        getActiveStyles: settings.getActiveStyles,
        getDownloadDir: settings.getDownloadDir,
        getOutputProfile: settings.getOutputProfile,
        addSubmission: kioskSubmissions.add,
    };
    let submission = null;
    let server;

    Date.now = () => fixedNow;
    settings.get = (key, ...args) => {
        if (key === "eventName") return "__kiosk_whatsapp_test__";
        if (key === "adminPhones") return [];
        if (key === "twilioWhatsappNumber") return "+14155550100";
        if (key === "twilioWhatsappMessagingServiceSid") return "";
        if (key === "twilioPhoneNumber") return "+14155550200";
        if (key === "twilioMessagingServiceSid") return "";
        return originals.get.call(settings, key, ...args);
    };
    settings.getForEvent = (key) => ({
        languageMode: "en",
        boothShowSms: true,
        boothShowWhatsapp: true,
        enablePrinting: false,
        immediateDigitalDelivery: true,
        reviewMode: "off",
        enableManualReview: false,
        variantsPerReview: 1,
    })[key];
    settings.getContentSid = (key, locale) => key === "delivery" && locale === "en" ? "HXdelivery" : null;
    settings.getActiveStyleList = () => ["cartoon"];
    settings.getActiveStyles = () => ({ cartoon: { name: "Cartoon" } });
    settings.getDownloadDir = () => tempDir;
    settings.getOutputProfile = () => ({ printSize: "6x4", printQuality: "high", orientation: "landscape" });
    kioskSubmissions.add = (record) => { submission = record; return record; };

    try {
        const app = express();
        mountApiGenerate(app);
        server = await new Promise((resolve) => {
            const listening = app.listen(0, () => resolve(listening));
        });
        const image = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                port: server.address().port,
                method: "POST",
                path: "/api/generate?style=cartoon&phone=%2B14155551234&channel=whatsapp&kiosk=1&locale=en",
                headers: { "content-type": "image/jpeg", "content-length": image.length },
            }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
            });
            req.on("error", reject);
            req.end(image);
        });

        assert.equal(response.status, 202);
        assert.equal(response.body.filePrefix, prefix);
        const job = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
        assert.equal(job.channel, "whatsapp");
        assert.equal(job.kioskSubmission, true);
        assert.equal(job.userPhone, "+14155551234");
        assert.equal(job.appPhone, "+14155550100");
        assert.equal(submission.channel, "whatsapp");
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        Date.now = originals.now;
        settings.get = originals.get;
        settings.getForEvent = originals.getForEvent;
        settings.getContentSid = originals.getContentSid;
        settings.getActiveStyleList = originals.getActiveStyleList;
        settings.getActiveStyles = originals.getActiveStyles;
        settings.getDownloadDir = originals.getDownloadDir;
        settings.getOutputProfile = originals.getOutputProfile;
        kioskSubmissions.add = originals.addSubmission;
        fs.rmSync(pendingPath, { force: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
