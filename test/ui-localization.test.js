const { test } = require("node:test");
const assert = require("node:assert/strict");
const optionI18n = require("../lib/option-i18n");
const ui = require("../lib/ui-i18n");
const { buildKioskHtml } = require("../lib/kiosk");
const { localizeDisplayHtml } = require("../lib/home");
const { resolveShareLocale } = require("../lib/share");
const { buildPageHtml } = require("../lib/photogallery");
const vm = require("node:vm");

test("built-in attendee options are localized without changing IDs", () => {
    const option = optionI18n.localizeOption("style", "watercolor", { name: "Watercolor", core: "AI prompt" }, "pt_BR");
    assert.equal(option.key, "watercolor");
    assert.equal(option.name, "Aquarela");
    assert.doesNotMatch(option.description, /AI prompt/);
});

test("Portuguese share and display catalogs cover core attendee controls", () => {
    assert.equal(resolveShareLocale({ locale: "pt_BR" }, "Evento"), "pt_BR");
    assert.equal(ui.htmlLang("pt_BR"), "pt-BR");
    assert.equal(ui.t("pt_BR", "downloadImage"), "Baixar imagem");
    const html = localizeDisplayHtml('<html lang="en"><h1>Get Your AI Portrait</h1><button>Fullscreen</button>', "pt_BR");
    assert.match(html, /lang="pt-BR"/);
    assert.match(html, /Crie seu retrato com IA/);
});

test("Portuguese kiosk renders localized controls and style labels", () => {
    const html = buildKioskHtml({ styleOptions: [{ key: "watercolor", name: "Aquarela" }], eventName: "Evento", locale: "pt_BR", languageMode: "pt_BR" });
    assert.match(html, /lang="pt-BR"/);
    assert.match(html, /Tire uma selfie/);
    assert.match(html, /Aquarela/);
    assert.match(html, /qs\.set\("locale", "pt_BR"\)/);
    assert.doesNotMatch(html, /Thanks! We're on it|Your portrait is generating now|Tap "Start camera" to begin/);
    const script = html.match(/<script>\nconst STYLES[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, "");
    assert.doesNotThrow(() => new vm.Script(script));
});

test("Portuguese photo book localizes public controls", () => {
    const html = buildPageHtml("Evento", "pt_BR");
    assert.match(html, /Álbum de fotos/);
    assert.match(html, /retratos criados/);
    assert.match(html, /Ver original/);
    assert.match(html, /lang="pt-BR"/);
});
