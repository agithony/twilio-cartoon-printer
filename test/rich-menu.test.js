const { test } = require("node:test");
const assert = require("node:assert/strict");

let generatedSid = "HXpicker";
let sendArgs;
require.cache[require.resolve("../lib/content-templates")] = { exports: { getOrCreateListPicker: async () => generatedSid } };
require.cache[require.resolve("../lib/messaging")] = { exports: { send: async (...args) => { sendArgs = args; return { sid: "SM1" }; } } };
delete require.cache[require.resolve("../lib/rich-menu")];
const richMenu = require("../lib/rich-menu");

test("SMS bypasses rich menu creation", async () => {
    sendArgs = null;
    assert.deepEqual(await richMenu.sendMenu("+1", { name: "sms" }, "style", [], {}), { rich: false });
    assert.equal(sendArgs, null);
});

test("WhatsApp sends a runtime list-picker SID", async () => {
    const adapter = { name: "whatsapp" };
    const result = await richMenu.sendMenu("+1", adapter, "style", [{ key: "a", name: "A" }], { body: "Pick", button: "Open" });
    assert.equal(result.rich, true);
    assert.equal(sendArgs[3].contentSid, "HXpicker");
});

test("Content API failure requests text fallback", async () => {
    generatedSid = null;
    assert.deepEqual(await richMenu.sendMenu("+1", { name: "whatsapp" }, "style", [], { body: "Pick", button: "Open" }), { rich: false });
});
