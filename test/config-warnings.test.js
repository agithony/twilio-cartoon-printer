const { test } = require("node:test");
const assert = require("node:assert/strict");
const { brandWarnings, styleWarnings } = require("../lib/config-warnings");

// Brand warnings

test("brand: wardrobe-plus-scene with no scenes warns loudly", () => {
    const b = { name: "Foo", category: "wardrobe-plus-scene", scenes: [] };
    const warnings = brandWarnings(b);
    assert.ok(warnings.some((w) => w.includes("scene")), "should warn about missing scenes");
});

test("brand: wardrobe-plus-scene with allowOriginal=true flags no-op", () => {
    const b = { name: "Foo", category: "wardrobe-plus-scene", scenes: [{ key: "a", name: "A" }], allowOriginal: true };
    const warnings = brandWarnings(b);
    assert.ok(warnings.some((w) => /Original.*no effect|no-op|ignored/i.test(w)));
});

test("brand: scenes without wardrobe-plus-scene category is quiet", () => {
    // A brand can have scenes without being wardrobe-plus-scene — they just
    // appear alongside Original/Plain white. Not actionable.
    const b = { name: "Foo", category: "wardrobe-only", scenes: [{ key: "a", name: "A", prompt: "a scene" }] };
    assert.equal(brandWarnings(b).length, 0);
});

test("brand: wardrobe and brandPrompt both set warns about dead brandPrompt", () => {
    const b = { name: "Foo", wardrobe: "LA Kings jersey", brandPrompt: "legacy text" };
    const warnings = brandWarnings(b);
    assert.ok(warnings.some((w) => /brandPrompt.*overridden|legacy|unused/i.test(w)));
});

test("brand: scene with empty prompt warns", () => {
    const b = { name: "Foo", scenes: [{ key: "ice", name: "Ice Rink", prompt: "" }] };
    const warnings = brandWarnings(b);
    assert.ok(warnings.some((w) => /empty prompt|prompt is empty|Ice Rink/i.test(w)));
});

test("brand: clean config returns no warnings", () => {
    const b = {
        name: "LA Kings",
        category: "wardrobe-plus-scene",
        wardrobe: "LA Kings jersey",
        scenes: [{ key: "ice", name: "Ice Rink", prompt: "hockey rink with stadium lights" }],
        allowOriginal: false,
    };
    assert.deepEqual(brandWarnings(b), []);
});

test("brand: null/undefined is safely empty", () => {
    assert.deepEqual(brandWarnings(null), []);
    assert.deepEqual(brandWarnings(undefined), []);
});

// Style warnings

test("style: themed-container with no containerDescription warns", () => {
    const s = { name: "Shaker", behavior: "themed-container", containerDescription: "" };
    const warnings = styleWarnings(s);
    assert.ok(warnings.some((w) => /container description|containerDescription/i.test(w)));
});

test("style: containerDescription on non-container behavior warns about dead field", () => {
    const s = { name: "Cartoon", behavior: "normal", containerDescription: "inside a snow globe" };
    const warnings = styleWarnings(s);
    assert.ok(warnings.some((w) => /only.*themed-container|unused|no effect/i.test(w)));
});

test("style: themed-container with description is quiet", () => {
    const s = { name: "Shaker", behavior: "themed-container", containerDescription: "inside a snow globe" };
    assert.deepEqual(styleWarnings(s), []);
});

test("style: plain normal style is quiet", () => {
    const s = { name: "Cartoon", behavior: "normal" };
    assert.deepEqual(styleWarnings(s), []);
});

test("style: null/undefined is safely empty", () => {
    assert.deepEqual(styleWarnings(null), []);
    assert.deepEqual(styleWarnings(undefined), []);
});

// Channel warnings

const { channelWarnings } = require("../lib/config-warnings");
const credentials = { twilioAccountSid: "ACtest", twilioAuthToken: "token" };

test("channelWarnings: no senders configured returns fatal error", () => {
    const w = channelWarnings({ ...credentials, twilioPhoneNumber: "", twilioMessagingServiceSid: "", twilioWhatsappNumber: "", twilioWhatsappMessagingServiceSid: "" });
    assert.ok(w.some(w => w.fatal && /no.*sender|phone number/i.test(w.message)));
});

test("channelWarnings: SMS only configured returns no errors", () => {
    const w = channelWarnings({ ...credentials, twilioPhoneNumber: "+12065551234", twilioMessagingServiceSid: "", twilioWhatsappNumber: "", twilioWhatsappMessagingServiceSid: "" });
    assert.equal(w.filter(w => w.fatal).length, 0);
});

test("channelWarnings: WhatsApp number set but malformed returns fatal error", () => {
    const w = channelWarnings({ ...credentials, twilioPhoneNumber: "+12065551234", twilioWhatsappNumber: "not-a-phone" });
    assert.ok(w.some(w => w.fatal && /whatsapp.*invalid|invalid.*whatsapp/i.test(w.message)));
});

test("channelWarnings: both configured returns no errors", () => {
    const w = channelWarnings({ ...credentials, twilioPhoneNumber: "+12065551234", twilioWhatsappNumber: "+14155238886" });
    assert.equal(w.filter(w => w.fatal).length, 0);
});

test("channelWarnings: credentials are required", () => {
    const w = channelWarnings({ twilioMessagingServiceSid: "MGtest" });
    assert.ok(w.some(issue => issue.fatal && /ACCOUNT_SID/.test(issue.message)));
    assert.ok(w.some(issue => issue.fatal && /AUTH_TOKEN/.test(issue.message)));
});
