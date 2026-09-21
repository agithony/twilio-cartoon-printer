const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const vm = require("node:vm");
const { isPublicRoute } = require("../lib/auth");
const { createAttendeeStartRouter } = require("../lib/attendee-start");

const eventSettings = {
    "Active Event": {
        languageMode: "ask",
        boothShowSms: true,
        boothSmsPhone: "+5511999990000",
        boothSmsInstructionText: "Hit send to start",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+5511988880000",
        boothWhatsappPrefillText: "Hi",
        boothWhatsappInstructionText: "Open WhatsApp to start",
        boothLegalText: "<script>alert('no')</script>",
        termsUrl: "javascript:alert(1)",
    },
    "Archived Event": {
        languageMode: "en",
        boothShowSms: true,
        boothSmsPhone: "+14155550100",
        boothShowWhatsapp: false,
    },
};

const settingsStub = {
    get(key) {
        if (key === "eventName") return "Active Event";
        if (key === "twilioAuthToken") return "must-not-leak";
        return eventSettings["Active Event"][key];
    },
    getForEvent() { throw new Error("public chooser must not read archived profiles"); },
    listEventProfiles() { throw new Error("public chooser must not scan event profiles"); },
};

let server;
let baseUrl;

before(async () => {
    const app = express();
    app.use((req, res, next) => isPublicRoute(req) ? next() : res.status(401).send("Unauthorized"));
    app.use("/start", createAttendeeStartRouter({ settingsModule: settingsStub }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("only exact read-only chooser paths are public", () => {
    assert.equal(isPublicRoute({ method: "GET", path: "/start" }), true);
    assert.equal(isPublicRoute({ method: "HEAD", path: "/start/" }), true);
    assert.equal(isPublicRoute({ method: "GET", path: "/start/open" }), true);
    assert.equal(isPublicRoute({ method: "POST", path: "/start" }), false);
    assert.equal(isPublicRoute({ method: "POST", path: "/start/open" }), false);
    assert.equal(isPublicRoute({ method: "GET", path: "/start/admin" }), false);
    assert.equal(isPublicRoute({ method: "GET", path: "/starter" }), false);
});

test("chooser renders the requested event and locale without leaking settings", async () => {
    const response = await fetch(`${baseUrl}/start?event=Active+Event&lang=pt-BR`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("content-language"), "pt-BR");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(body, /Escolha como começar/);
    assert.match(body, /href="\/start\/open\?event=Active\+Event&amp;lang=pt_BR&amp;channel=sms&amp;carry=1"/);
    assert.match(body, /href="\/start\/open\?event=Active\+Event&amp;lang=pt_BR&amp;channel=whatsapp&amp;carry=1"/);
    assert.match(body, /&lt;script&gt;alert\(&#39;no&#39;\)&lt;\/script&gt;/);
    assert.doesNotMatch(body, /javascript:alert|must-not-leak|Archived Event/);
    const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
});

test("launch route revalidates the event and adapts SMS links for iOS", async () => {
    const sms = await fetch(`${baseUrl}/start/open?event=Active+Event&lang=pt_BR&channel=sms&carry=1`, {
        headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
        redirect: "manual",
    });
    assert.equal(sms.status, 302);
    assert.equal(sms.headers.get("location"), "sms:+5511999990000&body=Portugu%C3%AAs");

    const whatsapp = await fetch(`${baseUrl}/start/open?event=Active+Event&lang=pt_BR&channel=whatsapp&carry=1`, { redirect: "manual" });
    assert.equal(whatsapp.status, 302);
    assert.equal(whatsapp.headers.get("location"), "https://wa.me/5511988880000?text=Portugu%C3%AAs");

    const stale = await fetch(`${baseUrl}/start/open?event=Archived+Event&lang=en&channel=sms`, { redirect: "manual" });
    assert.equal(stale.status, 404);
});

test("chooser rejects unsafe, duplicate, unknown, and non-read requests", async () => {
    const requests = await Promise.all([
        fetch(`${baseUrl}/start?event=..%2Fsecret`),
        fetch(`${baseUrl}/start?event=Active+Event&event=Archived+Event`),
        fetch(`${baseUrl}/start?event=Archived+Event`),
        fetch(`${baseUrl}/start?event=Active+Event`, { method: "POST" }),
        fetch(`${baseUrl}/start/admin?event=Active+Event`),
    ]);
    assert.deepEqual(requests.map((response) => response.status), [400, 400, 404, 401, 401]);
});

test("HEAD chooser requests are public and bodyless", async () => {
    const response = await fetch(`${baseUrl}/start/?event=Active+Event`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
});
