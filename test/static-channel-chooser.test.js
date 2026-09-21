const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildStaticPanelHtml } = require("../lib/home");

function panelSettings(overrides = {}) {
    const values = {
        eventName: "Developer Week 2026",
        boothHeadline: "Get Your AI Portrait",
        boothSubline: "",
        boothQrImage: "",
        boothSteps: ["Scan the QR code with your phone camera", "Send the pre-filled text message", "Take a selfie and reply with your photo"],
        boothLegalText: "",
        termsUrl: "",
        boothShowSms: true,
        boothSmsPhone: "+14155550100",
        boothSmsInstructionText: "Hit send to start",
        boothSmsQrSource: "auto",
        boothSmsQrImage: "",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+14155550200",
        boothWhatsappPrefillText: "Hi",
        boothWhatsappInstructionText: "Open WhatsApp to start",
        boothWhatsappQrSource: "auto",
        boothWhatsappQrImage: "",
        ...overrides,
    };
    return (key) => values[key];
}

function bodyMarkup(html) {
    return html.slice(html.indexOf("<body>"));
}

test("dual-channel static display renders one chooser QR", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings(),
    });
    const body = bodyMarkup(html);

    assert.equal((body.match(/data:image\/png/g) || []).length, 1);
    assert.match(body, /Scan to choose SMS or WhatsApp/);
    assert.doesNotMatch(body, /<div class="qr-two-up">/);
});

test("single-channel static display keeps its direct QR", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothShowWhatsapp: false }),
    });
    const body = bodyMarkup(html);

    assert.equal((body.match(/data:image\/png/g) || []).length, 1);
    assert.doesNotMatch(body, /Scan to choose SMS or WhatsApp|<div class="qr-two-up">/);
});

test("dual-channel display does not show a broken second QR", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothWhatsappPhone: "" }),
    });
    const body = bodyMarkup(html);

    assert.equal((body.match(/data:image\/png/g) || []).length, 1);
    assert.doesNotMatch(body, /<div class="qr-two-up">/);
});

test("explicit uploaded channel QRs preserve the two-code layout", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothSmsQrSource: "upload", boothSmsQrImage: "sms.png" }),
    });
    assert.match(bodyMarkup(html), /<div class="qr-two-up">/);
});
