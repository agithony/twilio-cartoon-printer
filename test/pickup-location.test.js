const { test } = require("node:test");
const assert = require("node:assert/strict");

const legacyMessages = {
    pickupPrint: "It may take a minute or two -- we'll text you when it's ready for pickup at the Twilio booth.",
    deliveryPrint: "Your {styleName} portrait has been sent to the printer! Head to the Twilio booth to pick it up.",
};
const settingsStub = {
    getMsgForEvent(key, _eventName, vars = {}) {
        return legacyMessages[key].replace(/\{(\w+)\}/g, (match, name) => vars[name] === undefined ? match : vars[name]);
    },
};
require.cache[require.resolve("../lib/settings")] = { exports: settingsStub };
delete require.cache[require.resolve("../lib/i18n")];
const i18n = require("../lib/i18n");

test("pickup location defaults are localized", () => {
    assert.equal(i18n.resolvePickupLocation("en", ""), "Twilio booth");
    assert.equal(i18n.resolvePickupLocation("pt_BR", ""), "estande da Twilio");
});

test("custom pickup location is used verbatim in both languages", () => {
    const location = i18n.resolvePickupLocation("pt_BR", "Twilio Experience Station");
    assert.equal(location, "Twilio Experience Station");
    assert.equal(
        i18n.t("pt_BR", "deliveryPrint", { styleName: "Aquarela", pickupLocation: location }),
        "Seu retrato em estilo aquarela foi enviado para a impressora! Local de retirada: Twilio Experience Station.",
    );
});

test("legacy English event messages replace Twilio booth without resetting copy", () => {
    const location = "Twilio Experience Station";
    assert.equal(
        i18n.t("en", "pickupPrint", { pickupLocation: location }, "Evento"),
        "It may take a minute or two -- we'll text you when it's ready for pickup at the Twilio Experience Station.",
    );
    assert.equal(
        i18n.t("en", "deliveryPrint", { styleName: "Cartoon", pickupLocation: location }, "Evento"),
        "Your Cartoon portrait has been sent to the printer! Head to the Twilio Experience Station to pick it up.",
    );
});
