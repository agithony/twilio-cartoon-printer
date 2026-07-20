const { test } = require("node:test");
const assert = require("node:assert/strict");
const settings = require("../lib/settings");
const i18n = require("../lib/i18n");

test("Portuguese catalog covers every attendee message key", () => {
    assert.deepEqual(
        Object.keys(i18n.catalogs.pt_BR).sort(),
        Object.keys(settings.DEFAULTS.messages).sort(),
    );
});

test("locale normalization accepts common English and Portuguese forms", () => {
    assert.equal(i18n.normalizeLocale("Português"), "pt_BR");
    assert.equal(i18n.normalizeLocale("pt-BR"), "pt_BR");
    assert.equal(i18n.normalizeLocale("English"), "en");
    assert.equal(i18n.normalizeLocale("unknown"), null);
});

test("language button payloads remain independent of display text", () => {
    assert.equal(i18n.parseLanguageSelection("lang_en"), "en");
    assert.equal(i18n.parseLanguageSelection("lang_pt_BR"), "pt_BR");
});

test("Portuguese messages interpolate variables", () => {
    assert.equal(
        i18n.t("pt_BR", "leadComplete", { firstName: "Ana" }),
        "Obrigado, Ana!",
    );
});

test("Portuguese lead fields use localized prompts", () => {
    const leads = require("../lib/leads");
    const fields = leads.__getActiveSurveyFieldsForTest("pt_BR");
    assert.match(fields[0].prompt, /primeiro nome/i);
});

test("Portuguese menu framing is localized while IDs remain stable", () => {
    const brandMenu = require("../lib/brand-menu");
    const brands = { twilio: { name: "Twilio" } };
    const text = brandMenu.buildMenu(brands, ["twilio"], { includeNone: true, locale: "pt_BR", eventName: "Evento" });
    assert.match(text, /escolha um tema/i);
    assert.match(text, /Nenhum/);
    assert.equal(brandMenu.matchReply("nenhum", brands, ["twilio"], { includeNone: true }), "__none__");
});
