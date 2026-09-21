const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    buildChannelOptions,
    buildChannelLaunchPath,
    buildChannelLaunchUrl,
    buildStartUrl,
    resolveEventLocale,
    resolvePublicBaseUrl,
} = require("../lib/channel-entry");

function getter(values) {
    return (key) => values[key];
}

test("channel options build localized SMS and WhatsApp deep links", () => {
    const getSetting = getter({
        boothShowSms: true,
        boothSmsPhone: "+55 (11) 99999-0000",
        boothSmsInstructionText: "Hit send to start",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "whatsapp:+55 (11) 98888-0000",
        boothWhatsappPrefillText: "Hi",
        boothWhatsappInstructionText: "Open WhatsApp to start",
    });

    const channels = buildChannelOptions({ locale: "pt_BR", getSetting });

    assert.equal(channels.sms.href, "sms:+5511999990000?body=Toque%20em%20enviar%20para%20come%C3%A7ar");
    assert.equal(channels.whatsapp.href, "https://wa.me/5511988880000?text=Ol%C3%A1");
    assert.equal(channels.sms.title, "Enviar por SMS");
    assert.equal(channels.whatsapp.title, "Abrir WhatsApp");
});

test("channel launch URLs preserve event, locale, and channel", () => {
    const path = buildChannelLaunchPath("Developer Week 2026", "pt-BR", "sms", true);
    assert.equal(path, "/start/open?event=Developer+Week+2026&lang=pt_BR&channel=sms&carry=1");
    assert.equal(
        buildChannelLaunchUrl("https://booth.example.com", "Developer Week 2026", "en", "whatsapp"),
        "https://booth.example.com/start/open?event=Developer+Week+2026&lang=en&channel=whatsapp",
    );
});

test("event locale honors overrides only in ask mode", () => {
    assert.equal(resolveEventLocale(getter({ languageMode: "ask" }), "pt-BR"), "pt_BR");
    assert.equal(resolveEventLocale(getter({ languageMode: "en" }), "pt-BR"), "en");
});

test("ask mode carries the selected language into the first message", () => {
    const getSetting = getter({
        languageMode: "ask",
        boothShowSms: true,
        boothSmsPhone: "+5511999990000",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+5511988880000",
    });
    const channels = buildChannelOptions({ locale: "pt_BR", getSetting, carryLocale: true });

    assert.match(channels.sms.href, /body=Portugu%C3%AAs$/);
    assert.match(channels.sms.iosHref, /&body=Portugu%C3%AAs$/);
    assert.match(channels.whatsapp.href, /text=Portugu%C3%AAs$/);
});

test("chooser URL preserves the exact event and normalized locale", () => {
    const url = buildStartUrl("https://booth.example.com/base/", "Developer Week 2026", "pt-BR");
    assert.equal(url, "https://booth.example.com/start?event=Developer+Week+2026&lang=pt_BR");
});

test("chooser URL safely supports configured Unicode event names", () => {
    const url = buildStartUrl("https://booth.example.com", "São Paulo", "en");
    assert.equal(new URL(url).searchParams.get("event"), "São Paulo");
});

test("configured public origin wins over request headers", () => {
    const req = { protocol: "http", headers: { host: "spoofed.example", "x-forwarded-proto": "http" } };
    assert.equal(resolvePublicBaseUrl(req, "https://booth.example.com/"), "https://booth.example.com");
});
