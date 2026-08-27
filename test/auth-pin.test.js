const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

const TEST_SESSION_SECRET = "unit-test-session-secret-not-for-production";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.ADMIN_PIN = "24682468";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { mountAuth, requireAuth, __test: authTest } = require("../lib/auth");

let server;
let baseUrl;

before(async () => {
    const app = express();
    app.set("trust proxy", 1);
    mountAuth(app);
    app.get("/protected", requireAuth, (req, res) => res.json({ user: req.user }));
    app.get("/api/private", requireAuth, (req, res) => res.json({ ok: true, user: req.user }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

function clientHeaders(client, extra = {}) {
    return { "x-forwarded-for": client, ...extra };
}

async function postPin(pin, { next = "/protected", client = "192.0.2.1" } = {}) {
    const body = new URLSearchParams({ next });
    if (pin !== undefined) body.set("pin", pin);
    return fetch(`${baseUrl}/auth/pin`, {
        method: "POST",
        headers: clientHeaders(client, { "content-type": "application/x-www-form-urlencoded" }),
        body,
        redirect: "manual",
    });
}

function cookiePair(response, name) {
    const setCookie = response.headers.get("set-cookie") || "";
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
    return match ? `${name}=${match[1]}` : "";
}

function sessionCookie(response) {
    return cookiePair(response, "session");
}

function tokenFromCookie(cookie) {
    return decodeURIComponent(cookie.slice("session=".length));
}

function payloadFromCookie(cookie) {
    const [payload] = tokenFromCookie(cookie).split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString());
}

function signedToken(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto.createHmac("sha256", TEST_SESSION_SECRET).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function signedOAuthState(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto.createHmac("sha256", TEST_SESSION_SECRET).update(`oauth-state:${payload}`).digest("base64url");
    return `${payload}.${signature}`;
}

function tokenPayload(token) {
    return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
}

async function startOAuth(next = "/protected") {
    const response = await fetch(`${baseUrl}/auth/google?next=${encodeURIComponent(next)}`, { redirect: "manual" });
    const authHref = response.headers.get("location");
    return {
        response,
        state: new URL(authHref).searchParams.get("state"),
        cookie: cookiePair(response, "oauth_nonce"),
    };
}

test("numeric PIN creates the shared HttpOnly session and accesses protected page and API routes", async () => {
    process.env.ADMIN_PIN = "24682468";
    const login = await postPin("24682468", { next: "/protected", client: "192.0.2.10" });

    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/protected");
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /^session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const cookie = sessionCookie(login);
    const payload = payloadFromCookie(cookie);
    assert.equal(payload.authMethod, "pin");
    assert.equal(typeof payload.pinFingerprint, "string");
    assert.ok(payload.pinFingerprint.length > 20);
    assert.equal(JSON.stringify(payload).includes(process.env.ADMIN_PIN), false);

    const page = await fetch(`${baseUrl}/protected`, { headers: { cookie }, redirect: "manual" });
    assert.equal(page.status, 200);
    assert.equal((await page.json()).user.name, "PIN Admin");

    const api = await fetch(`${baseUrl}/api/private`, { headers: { cookie } });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).user.authMethod, "pin");

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.deepEqual(await me.json(), { email: "", name: "PIN Admin", picture: "", authMethod: "pin" });
});

test("alphanumeric PIN is case-sensitive and successful login clears failures", async () => {
    process.env.ADMIN_PIN = "Alpha420";
    const client = "192.0.2.11";
    const wrong = await postPin("alpha420", { client });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.has("set-cookie"), false);
    assert.equal((await wrong.text()).includes("alpha420"), false);

    const success = await postPin("Alpha420", { client });
    assert.equal(success.status, 302);

    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await postPin("Wrong420", { client });
        assert.equal(response.status, 401);
    }
    const limited = await postPin("Wrong420", { client });
    assert.equal(limited.status, 429);
});

test("login page shows only configured methods and sends defensive headers", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    delete process.env.ADMIN_PIN;
    let response = await fetch(`${baseUrl}/auth/login?next=%2Fprotected`);
    let html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Sign in with Google/);
    assert.match(html, /href="\/auth\/google\?next=%2Fprotected"/);
    assert.doesNotMatch(html, /name="pin"/);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);

    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.ADMIN_PIN = "PinOnly7";
    response = await fetch(`${baseUrl}/auth/login`);
    html = await response.text();
    assert.match(html, /name="pin"/);
    assert.match(html, /minlength="8"/);
    assert.match(html, /pattern="\[A-Za-z0-9\]\{8,64\}"/);
    assert.doesNotMatch(html, /Sign in with Google/);

    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    response = await fetch(`${baseUrl}/auth/login`);
    html = await response.text();
    assert.match(html, /Sign in with Google/);
    assert.match(html, /name="pin"/);
    assert.match(html, />or</);
});

test("incomplete and weak methods are unavailable and unconfigured gates return 503 pages or 401 APIs", async () => {
    delete process.env.ADMIN_PIN;
    process.env.GOOGLE_CLIENT_ID = "id-without-secret";
    delete process.env.GOOGLE_CLIENT_SECRET;

    const login = await fetch(`${baseUrl}/auth/login`);
    assert.equal(login.status, 503);
    assert.doesNotMatch(await login.text(), /Sign in with Google/);

    const page = await fetch(`${baseUrl}/protected`, { redirect: "manual" });
    assert.equal(page.status, 503);
    const api = await fetch(`${baseUrl}/api/private`);
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: "Authentication not configured" });

    for (const weakPin of ["1234567", "Abc1234", "bad-pin", "abcdefgh!", "abcdefgh\n", "Abcdefgø", "A".repeat(65)]) {
        process.env.ADMIN_PIN = weakPin;
        const invalidPinLogin = await fetch(`${baseUrl}/auth/login`);
        assert.equal(invalidPinLogin.status, 503);
        assert.doesNotMatch(await invalidPinLogin.text(), /name="pin"/);
    }
});

test("tampered, expired, and rotated PIN sessions are rejected while Google sessions survive rotation", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.ADMIN_PIN = "OldPin44";
    const login = await postPin("OldPin44", { client: "192.0.2.12" });
    const cookie = sessionCookie(login);
    const token = tokenFromCookie(cookie);
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    let response = await fetch(`${baseUrl}/protected`, {
        headers: { cookie: `session=${tamperedToken}` },
        redirect: "manual",
    });
    assert.equal(response.status, 302);

    const expiredPayload = { ...payloadFromCookie(cookie), exp: Date.now() - 1 };
    response = await fetch(`${baseUrl}/protected`, {
        headers: { cookie: `session=${signedToken(expiredPayload)}` },
        redirect: "manual",
    });
    assert.equal(response.status, 302);

    process.env.ADMIN_PIN = "NewPin55";
    response = await fetch(`${baseUrl}/protected`, { headers: { cookie }, redirect: "manual" });
    assert.equal(response.status, 302);

    const googleToken = signedToken({
        email: "admin@example.com",
        name: "Google Admin",
        picture: "",
        authMethod: "google",
        exp: Date.now() + 60_000,
    });
    response = await fetch(`${baseUrl}/protected`, { headers: { cookie: `session=${googleToken}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.authMethod, "google");
});

test("next redirects accept local single-slash paths and reject open redirects", async () => {
    process.env.ADMIN_PIN = "Redirect8";
    for (const unsafe of ["https://evil.example/path", "//evil.example/path", "/\\evil.example/path"]) {
        const response = await postPin("Redirect8", { next: unsafe, client: "192.0.2.13" });
        assert.equal(response.headers.get("location"), "/dashboard");
    }

    const local = await postPin("Redirect8", { next: "/protected?tab=jobs", client: "192.0.2.13" });
    assert.equal(local.headers.get("location"), "/protected?tab=jobs");

    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    const oauth = await startOAuth("//evil.example/path");
    const state = tokenPayload(oauth.state);
    assert.equal(state.purpose, "oauth-state");
    assert.equal(state.next, "/dashboard");
    assert.match(state.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(state.exp > Date.now());
});

test("Google OAuth accepts a signed state only with its bound nonce cookie", async () => {
    delete process.env.ADMIN_PIN;
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    const oauth = await startOAuth("/protected?tab=jobs");
    const nonceSetCookie = oauth.response.headers.get("set-cookie");
    assert.match(nonceSetCookie, /oauth_nonce=/);
    assert.match(nonceSetCookie, /HttpOnly/i);
    assert.match(nonceSetCookie, /SameSite=Lax/i);
    assert.match(nonceSetCookie, /Path=\/auth\/callback/i);
    assert.match(nonceSetCookie, /Max-Age=600/i);

    // Background requests that render the login page must not replace the
    // nonce created by the explicit Google sign-in action.
    const backgroundLogin = await fetch(`${baseUrl}/auth/login?next=%2Ffavicon.ico`);
    assert.equal(backgroundLogin.headers.has("set-cookie"), false);

    const originalPost = axios.post;
    let exchanges = 0;
    axios.post = async (url, body) => {
        exchanges++;
        assert.equal(url, "https://oauth2.googleapis.com/token");
        assert.equal(body.code, "valid-code");
        const idPayload = Buffer.from(JSON.stringify({
            email: "admin@twilio.com",
            email_verified: true,
            hd: "twilio.com",
            name: "OAuth Admin",
            picture: "",
        })).toString("base64url");
        return { data: { id_token: `header.${idPayload}.signature` } };
    };

    try {
        const callback = await fetch(`${baseUrl}/auth/callback?code=valid-code&state=${encodeURIComponent(oauth.state)}`, {
            headers: { cookie: oauth.cookie },
            redirect: "manual",
        });
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.get("location"), "/protected?tab=jobs");
        assert.equal(exchanges, 1);
        const setCookie = callback.headers.get("set-cookie");
        assert.match(setCookie, /oauth_nonce=;/);
        assert.match(setCookie, /Path=\/auth\/callback/i);
        assert.match(setCookie, /Max-Age=0/i);
        assert.match(setCookie, /session=/);

        const cookie = sessionCookie(callback);
        const protectedResponse = await fetch(`${baseUrl}/protected`, { headers: { cookie } });
        assert.equal(protectedResponse.status, 200);
        assert.equal((await protectedResponse.json()).user.authMethod, "google");
    } finally {
        axios.post = originalPost;
    }
});

test("Google OAuth rejects missing, mismatched, tampered, and expired state before token exchange", async () => {
    delete process.env.ADMIN_PIN;
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    const originalPost = axios.post;
    let exchanges = 0;
    axios.post = async () => {
        exchanges++;
        throw new Error("token exchange must not run");
    };

    try {
        const missingState = await startOAuth();
        const first = await fetch(`${baseUrl}/auth/callback?code=code`, {
            headers: { cookie: missingState.cookie },
            redirect: "manual",
        });

        const missingCookie = await startOAuth();
        const second = await fetch(`${baseUrl}/auth/callback?code=code&state=${encodeURIComponent(missingCookie.state)}`, {
            redirect: "manual",
        });

        const stateOwner = await startOAuth();
        const cookieOwner = await startOAuth();
        const third = await fetch(`${baseUrl}/auth/callback?code=code&state=${encodeURIComponent(stateOwner.state)}`, {
            headers: { cookie: cookieOwner.cookie },
            redirect: "manual",
        });

        const tampered = await startOAuth();
        const tamperedState = `${tampered.state.slice(0, -1)}${tampered.state.endsWith("A") ? "B" : "A"}`;
        const fourth = await fetch(`${baseUrl}/auth/callback?code=code&state=${encodeURIComponent(tamperedState)}`, {
            headers: { cookie: tampered.cookie },
            redirect: "manual",
        });

        const expiredNonce = crypto.randomBytes(32).toString("base64url");
        const expiredState = signedOAuthState({
            purpose: "oauth-state",
            next: "/protected",
            nonce: expiredNonce,
            exp: Date.now() - 1,
        });
        const fifth = await fetch(`${baseUrl}/auth/callback?code=code&state=${encodeURIComponent(expiredState)}`, {
            headers: { cookie: `oauth_nonce=${expiredNonce}` },
            redirect: "manual",
        });

        for (const response of [first, second, third, fourth, fifth]) {
            assert.equal(response.status, 400);
            assert.match(response.headers.get("set-cookie"), /oauth_nonce=;/);
            assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
            assert.doesNotMatch(response.headers.get("set-cookie"), /session=/);
        }
        assert.equal(exchanges, 0);
    } finally {
        axios.post = originalPost;
    }
});

test("PIN credential is accepted only in POST bodies and is not disclosed in responses, tokens, or logs", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const configuredPin = "NoLeak77";
    process.env.ADMIN_PIN = configuredPin;
    const capturedLogs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => capturedLogs.push(args.join(" "));
    console.error = (...args) => capturedLogs.push(args.join(" "));

    try {
        const getResponse = await fetch(`${baseUrl}/auth/pin?pin=${configuredPin}`);
        assert.equal(getResponse.status, 405);
        assert.equal((await getResponse.text()).includes(configuredPin), false);

        const wrong = await postPin("SubmittedWrong77", { client: "192.0.2.14" });
        assert.equal((await wrong.text()).includes("SubmittedWrong77"), false);

        const success = await postPin(configuredPin, { client: "192.0.2.14" });
        assert.equal(success.status, 302);
        assert.equal((success.headers.get("set-cookie") || "").includes(configuredPin), false);
        assert.equal(JSON.stringify(payloadFromCookie(sessionCookie(success))).includes(configuredPin), false);
        assert.equal(capturedLogs.join("\n").includes(configuredPin), false);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
});

test("rate limit allows five failures per client in 15 minutes and returns Retry-After", async () => {
    process.env.ADMIN_PIN = "RateLimit9";
    const client = "192.0.2.15";
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await postPin("Wrong999", { client });
        assert.equal(response.status, 401);
    }

    const limited = await postPin("RateLimit9", { client });
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 900);
});

test("PIN failure tracking evicts the oldest entry at its bound and prunes expired entries", () => {
    const { pinFailures, recordPinFailure, prunePinFailures, PIN_FAILURE_MAX_ENTRIES } = authTest;
    const now = Date.now();
    pinFailures.clear();
    try {
        for (let index = 0; index < PIN_FAILURE_MAX_ENTRIES; index++) {
            recordPinFailure({ key: `client-${index}`, now, count: 0, resetAt: now + 60_000 });
        }
        recordPinFailure({ key: "overflow-client", now, count: 0, resetAt: now + 60_000 });

        assert.equal(pinFailures.size, PIN_FAILURE_MAX_ENTRIES);
        assert.equal(pinFailures.has("client-0"), false);
        assert.equal(pinFailures.has("overflow-client"), true);

        pinFailures.clear();
        pinFailures.set("expired-client", { count: 1, resetAt: now - 1 });
        pinFailures.set("active-client", { count: 1, resetAt: now + 1 });
        prunePinFailures(now);
        assert.deepEqual([...pinFailures.keys()], ["active-client"]);
    } finally {
        pinFailures.clear();
    }
});
