const { test } = require("node:test");
const assert = require("node:assert/strict");
const twilio = require("twilio");
const { isPublicRoute } = require("../lib/auth");
const { buildRequestUrl, createTwilioWebhookValidator } = require("../lib/twilio-webhook");

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; return this; },
    };
}

test("legacy and current Twilio webhook paths remain public", () => {
    assert.equal(isPublicRoute({ method: "POST", path: "/sms" }), true);
    assert.equal(isPublicRoute({ method: "POST", path: "/inbound" }), true);
});

test("request URL uses the configured public base URL", () => {
    const req = { originalUrl: "/sms?foo=bar", headers: {}, protocol: "http" };
    assert.equal(buildRequestUrl(req, "https://example.com/"), "https://example.com/sms?foo=bar");
});

test("validator accepts a genuine Twilio signature and rejects a bad one", () => {
    const authToken = "test-auth-token";
    const url = "https://example.com/sms";
    const body = { From: "+14155551234", Body: "hello" };
    const signature = twilio.getExpectedTwilioSignature(authToken, url, body);
    const validator = createTwilioWebhookValidator({ getAuthToken: () => authToken, baseUrl: "https://example.com" });
    let nextCalls = 0;

    const validReq = { originalUrl: "/sms", body, headers: {}, get: () => signature };
    validator(validReq, response(), () => { nextCalls++; });
    assert.equal(nextCalls, 1);

    const invalidRes = response();
    const invalidReq = { originalUrl: "/sms", body, headers: {}, get: () => "bad-signature" };
    validator(invalidReq, invalidRes, () => { nextCalls++; });
    assert.equal(invalidRes.statusCode, 403);
    assert.equal(nextCalls, 1);
});
