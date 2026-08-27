const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const TEST_SESSION_SECRET = "review-auth-test-session-secret-32-chars";
const EVENT = "__review_auth_test__";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.ADMIN_PIN = "AdminPin9";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const settings = require("../lib/settings");
const { mountAuth, __test: authTest } = require("../lib/auth");
const { requireStagedMediaAuth } = require("../lib/review-auth");
const { mountPhotoGallery } = require("../lib/photogallery");
const { mountReview } = require("../lib/review");

const eventDir = settings.getDownloadDir(EVENT);
const stagingDir = path.join(eventDir, ".staging");
const originalSettingsGet = settings.get;
const runtimeSettings = {
    eventName: EVENT,
    reviewMode: "human",
    enableManualReview: true,
    reviewPin: "1234",
};
let server;
let baseUrl;

function cookiePair(response, name) {
    const setCookie = response.headers.get("set-cookie") || "";
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
    return match ? `${name}=${match[1]}` : "";
}

function setCookies(response) {
    if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
    return (response.headers.get("set-cookie") || "").split(/,(?=\s*[^;,]+=)/);
}

function cookiePayload(cookie) {
    const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
    return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
}

async function postForm(route, values, client) {
    return fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": client,
        },
        body: new URLSearchParams(values),
        redirect: "manual",
    });
}

async function reviewLogin(pin, client) {
    return postForm("/review/auth", { pin }, client);
}

async function adminLogin(pin, client) {
    return postForm("/auth/pin", { pin, next: "/review/queue" }, client);
}

before(async () => {
    settings.get = (key) => Object.prototype.hasOwnProperty.call(runtimeSettings, key)
        ? runtimeSettings[key]
        : originalSettingsGet(key);

    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "staged.txt"), "staged-media");
    fs.writeFileSync(path.join(eventDir, "approved.txt"), "approved-media");

    const app = express();
    app.set("trust proxy", 1);
    mountAuth(app);
    app.use("/assets", express.static(path.join(__dirname, "..", "assets")));
    app.use("/images/staging", requireStagedMediaAuth, express.static(stagingDir));
    app.use("/images", express.static(eventDir));
    mountPhotoGallery(app);
    mountReview(app);

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    authTest.pinFailures.clear();
    runtimeSettings.reviewPin = "1234";
    process.env.ADMIN_PIN = "AdminPin9";
});

after(async () => {
    settings.get = originalSettingsGet;
    fs.rmSync(eventDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("review PIN uses a separately scoped five-attempt rate limit", async () => {
    const client = "192.0.2.40";
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await reviewLogin("9999", client);
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), "/review?error=1");
    }

    const limited = await reviewLogin(runtimeSettings.reviewPin, client);
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /Too many failed attempts/);
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 900);

    const admin = await adminLogin(process.env.ADMIN_PIN, client);
    assert.equal(admin.status, 302);
    assert.ok(cookiePair(admin, "session"));
});

test("successful review login cannot clear the admin PIN rate limit", async () => {
    const client = "192.0.2.46";
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await adminLogin("WrongPin9", client);
        assert.equal(response.status, 401);
    }

    const review = await reviewLogin(runtimeSettings.reviewPin, client);
    assert.equal(review.status, 302);
    assert.ok(cookiePair(review, "review_token"));

    const limited = await adminLogin(process.env.ADMIN_PIN, client);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("review login rejects ADMIN_PIN and links to the separate admin login", async () => {
    const landing = await fetch(`${baseUrl}/review`);
    const html = await landing.text();
    assert.equal(landing.status, 200);
    assert.match(html, />Admin login<\/a>/);
    assert.match(html, /\/auth\/login\?next=%2Freview%2Fqueue/);

    const response = await reviewLogin(process.env.ADMIN_PIN, "192.0.2.47");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/review?error=1");
    assert.equal(cookiePair(response, "review_token"), "");
});

test("review tokens record their method, migrate the cookie path, and expire when the Review PIN rotates", async () => {
    const reviewLoginResponse = await reviewLogin(runtimeSettings.reviewPin, "192.0.2.41");
    const reviewCookie = cookiePair(reviewLoginResponse, "review_token");
    const reviewPayload = cookiePayload(reviewCookie);
    const cookies = setCookies(reviewLoginResponse);

    assert.equal(reviewLoginResponse.status, 302);
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some((cookie) => /^review_token=.+;.*Path=\/;.*Max-Age=/i.test(cookie)));
    assert.ok(cookies.some((cookie) => /^review_token=;.*Path=\/review;.*Max-Age=0/i.test(cookie)));
    assert.equal(reviewPayload.method, "reviewPin");
    assert.equal(typeof reviewPayload.credentialFingerprint, "string");
    assert.equal(JSON.stringify(reviewPayload).includes(runtimeSettings.reviewPin), false);

    let response = await fetch(`${baseUrl}/review/queue`, { headers: { cookie: reviewCookie }, redirect: "manual" });
    assert.equal(response.status, 200);

    runtimeSettings.reviewPin = "5678";
    response = await fetch(`${baseUrl}/review/queue`, { headers: { cookie: reviewCookie }, redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/review?reason=expired");

    const fullAdminLogin = await adminLogin(process.env.ADMIN_PIN, "192.0.2.43");
    response = await fetch(`${baseUrl}/review/queue`, {
        headers: { cookie: cookiePair(fullAdminLogin, "session") },
        redirect: "manual",
    });
    assert.equal(response.status, 200);
});

test("photo gallery media routes reject decoded and encoded traversal segments", async () => {
    const reviewResponse = await reviewLogin(runtimeSettings.reviewPin, "192.0.2.48");
    const reviewCookie = cookiePair(reviewResponse, "review_token");
    const requests = [
        [`/photogallery/img/${EVENT}%2F.staging/staged.txt`, {}],
        [`/photogallery/img/${EVENT}%5C.staging/staged.txt`, {}],
        ["/photogallery/img/.staging/staged.txt", {}],
        [`/photogallery/img/${EVENT}/%252e%252e%252Fapproved.txt`, {}],
        [`/photogallery/staging/${EVENT}%2F.staging/staged.txt`, { cookie: reviewCookie }],
        [`/photogallery/staging/${EVENT}/%252e%252e%252Fapproved.txt`, { cookie: reviewCookie }],
    ];

    for (const [requestPath, headers] of requests) {
        const response = await fetch(`${baseUrl}${requestPath}`, { headers });
        assert.equal(response.status, 400, requestPath);
        assert.notEqual(await response.text(), "staged-media", requestPath);
    }
});

test("staged media accepts review or admin sessions while approved media stays public", async () => {
    const reviewResponse = await reviewLogin(runtimeSettings.reviewPin, "192.0.2.44");
    const reviewCookie = cookiePair(reviewResponse, "review_token");
    const adminResponse = await adminLogin(process.env.ADMIN_PIN, "192.0.2.45");
    const adminCookie = cookiePair(adminResponse, "session");
    const stagedPaths = [
        "/images/staging/staged.txt",
        `/photogallery/staging/${EVENT}/staged.txt`,
    ];

    for (const requestPath of stagedPaths) {
        let response = await fetch(`${baseUrl}${requestPath}`);
        assert.equal(response.status, 401);

        response = await fetch(`${baseUrl}${requestPath}`, { headers: { cookie: reviewCookie } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(await response.text(), "staged-media");

        response = await fetch(`${baseUrl}${requestPath}`, { headers: { cookie: adminCookie } });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "staged-media");
    }

    for (const requestPath of ["/images/approved.txt", `/photogallery/img/${EVENT}/approved.txt`]) {
        const response = await fetch(`${baseUrl}${requestPath}`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "approved-media");
    }

    const reviewPageAsset = await fetch(`${baseUrl}/assets/twilio-brand.css`);
    assert.equal(reviewPageAsset.status, 200);
});
