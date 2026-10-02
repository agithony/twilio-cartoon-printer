const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createVoiceStore } = require("../lib/voice/store");

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-store-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let clock = 10_000;
    const dir = path.join(root, "requests");
    const mediaDir = path.join(root, "voice-media");
    const store = createVoiceStore({ dir, mediaDir, now: () => clock });
    return { root, dir, mediaDir, store, setTime: (value) => { clock = value; } };
}

async function pending(store, sid, phone, receivedAt, eventName = "Expo", channel = "sms") {
    const request = await store.record({ messageSid: sid, phone, eventName, channel, receivedAt });
    return store.patch(request.id, { status: "awaiting_call", expiresAt: receivedAt + 1_800_000 });
}

test("duplicate MessageSid keeps one durable record and never rewinds its status", async (t) => {
    const { dir, store } = fixture(t);
    const [first, duplicate] = await Promise.all([
        store.record({ messageSid: "SMduplicate", phone: "+14155550100", eventName: "Expo" }),
        store.record({ messageSid: "SMduplicate", phone: "+14155550100", eventName: "Expo" }),
    ]);
    assert.equal(first.id, duplicate.id);
    await store.patch(first.id, { status: "awaiting_call", expiresAt: 1_810_000 });
    const retried = await store.record({ messageSid: "SMduplicate", phone: "+14155550100", eventName: "Expo" });
    assert.equal(retried.status, "awaiting_call");
    const files = await fsp.readdir(dir);
    assert.deepEqual(files, [`${createHash("sha256").update("SMduplicate").digest("hex")}.json`]);
    assert.equal(files[0].includes("14155550100"), false);
});

test("latest eligible SMS or WhatsApp selfie is claimed but a concurrent call is blocked", async (t) => {
    const { store } = fixture(t);
    await pending(store, "SMold", "+14155550100", 8_000);
    const newer = await pending(store, "SMnew", "whatsapp:+14155550100", 9_000, "Expo", "whatsapp");
    const claimed = await store.claimLatest({ phone: "+14155550100", eventName: "Expo", callSid: "CAfirst" });
    assert.equal(claimed.id, newer.id);
    assert.equal(claimed.phone, "+14155550100");
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claimedAt, 10_000);
    assert.equal(await store.claimLatest({ phone: "+14155550100", eventName: "Expo", callSid: "CAsecond" }), null);
    assert.equal((await store.claimLatest({ phone: "+14155550100", eventName: "Expo", callSid: "CAfirst" })).id, newer.id);
});

test("a newer selfie cannot replace an active call and supersedes the older one on release", async (t) => {
    const { store } = fixture(t);
    const first = await pending(store, "SMfirst", "+14155550100", 8_000);
    assert.equal((await store.claimLatest({ phone: first.phone, eventName: "Expo", callSid: "CAfirst" })).id, first.id);
    const newer = await pending(store, "SMnext", first.phone, 9_000);
    assert.equal(await store.claimLatest({ phone: first.phone, eventName: "Expo", callSid: "CAother" }), null);
    await store.release("CAfirst");
    assert.equal((await store.get(first.id)).status, "superseded");
    assert.equal((await store.claimLatest({ phone: first.phone, eventName: "Expo", callSid: "CAnext" })).id, newer.id);
});

test("expiry and event changes remove only private staged media", async (t) => {
    const { root, mediaDir, store, setTime } = fixture(t);
    await fsp.mkdir(mediaDir, { recursive: true });
    const privatePhoto = path.join(mediaDir, "first.jpg");
    const outsidePhoto = path.join(root, "keep.jpg");
    await fsp.writeFile(privatePhoto, "private");
    await fsp.writeFile(outsidePhoto, "keep");
    const first = await pending(store, "SMfirst", "+14155550100", 8_000);
    const second = await pending(store, "SMsecond", "+14155550101", 8_000);
    await store.patch(first.id, { stagedInputPath: privatePhoto });
    await store.patch(second.id, { stagedInputPath: outsidePhoto });
    await store.expire({ activeEventName: "Other" });
    assert.equal((await store.get(first.id)).status, "superseded");
    assert.equal((await store.get(second.id)).status, "superseded");
    assert.equal(fs.existsSync(privatePhoto), false);
    assert.equal(fs.existsSync(outsidePhoto), true);

    const thirdPhoto = path.join(mediaDir, "third.jpg");
    await fsp.writeFile(thirdPhoto, "private");
    const third = await pending(store, "SMthird", "+14155550102", 9_000);
    await store.patch(third.id, { stagedInputPath: thirdPhoto });
    setTime(1_810_000);
    await store.expire({ activeEventName: "Expo" });
    assert.equal((await store.get(third.id)).status, "expired");
    assert.equal(fs.existsSync(thirdPhoto), false);
});

test("MENU keeps its private selfie through later choices but expires within two hours", async (t) => {
    const { mediaDir, store, setTime } = fixture(t);
    await fsp.mkdir(mediaDir, { recursive: true });
    const photo = path.join(mediaDir, "menu.jpg");
    await fsp.writeFile(photo, "private selfie");
    const request = await pending(store, "SMmenuLease", "+14155550100", 9_000);
    await store.patch(request.id, { stagedInputPath: photo });
    const originalExpiry = request.expiresAt;
    const menuAt = originalExpiry - 1_000;

    setTime(menuAt);
    assert.equal((await store.menuFallback({ phone: request.phone, eventName: "Expo" })).status, "ready");
    setTime(originalExpiry + 1);
    await store.expire({ activeEventName: "Expo" });
    assert.equal((await store.get(request.id)).status, "menu_fallback");
    assert.equal(await fsp.readFile(photo, "utf8"), "private selfie");

    for (const minutes of [30, 60, 90]) {
        setTime(menuAt + minutes * 60_000);
        assert.equal((await store.touchMenuFallback(request.id, "Expo")).status, "menu_fallback");
        if (minutes < 90) {
            setTime(menuAt + (minutes + 5) * 60_000 + 1);
            assert.deepEqual(await store.expire({ activeEventName: "Expo" }), []);
            assert.equal(await fsp.readFile(photo, "utf8"), "private selfie");
        }
    }
    assert.equal((await store.menuFallback({ phone: request.phone, eventName: "Expo" })).request.menuFallbackAt, menuAt);
    setTime(menuAt + 2 * 60 * 60_000 - 1);
    assert.deepEqual(await store.expire({ activeEventName: "Expo" }), []);
    assert.equal(await fsp.readFile(photo, "utf8"), "private selfie");
    setTime(menuAt + 2 * 60 * 60_000);
    assert.deepEqual(await store.expire({ activeEventName: "Expo" }), [request.id]);
    assert.equal((await store.get(request.id)).status, "expired");
    assert.equal(fs.existsSync(photo), false);
    assert.equal(await store.touchMenuFallback(request.id, "Expo"), null);
});

test("claim lease survives a brief restart, then releases when no socket exists", async (t) => {
    const { dir, mediaDir, store, setTime } = fixture(t);
    const request = await pending(store, "SMlease", "+14155550100", 8_000);
    await store.claimLatest({ phone: request.phone, eventName: "Expo", callSid: "CAold" });
    const reloaded = createVoiceStore({ dir, mediaDir, now: () => 10_000 });
    assert.equal((await reloaded.get(request.id)).callSid, "CAold");
    assert.equal((await reloaded.reconcileClaims(new Set(), 129_999)).length, 0);
    assert.equal((await reloaded.get(request.id)).status, "claimed");
    const released = await reloaded.reconcileClaims(new Set(), 130_000);
    assert.deepEqual(released, [request.id]);
    assert.equal((await reloaded.claimLatest({ phone: request.phone, eventName: "Expo", callSid: "CAnew" })).id, request.id);
    setTime(130_001);
    assert.equal((await store.get(request.id)).callSid, "CAnew");
});

test("active sockets extend claims and queued requests cannot be unqueued", async (t) => {
    const { store, setTime } = fixture(t);
    const request = await pending(store, "SMguard", "+14155550100", 8_000);
    await store.claimLatest({ phone: request.phone, eventName: "Expo", callSid: "CAguard" });
    setTime(100_000);
    await store.touchCall("CAguard");
    assert.equal((await store.reconcileClaims(new Set(["CAguard"]), 250_000)).length, 0);
    assert.equal((await store.get(request.id)).status, "claimed");
    await store.patch(request.id, { status: "queued", groupId: "group-1" });
    await assert.rejects(store.patch(request.id, { status: "awaiting_call" }), /queued/);
    await store.release("CAguard");
    assert.equal((await store.get(request.id)).status, "queued");
});

test("selfie and call lookups do not rescan old request files after loading", async (t) => {
    const { dir, store } = fixture(t);
    const first = await pending(store, "SMindexed-first", "+14155550100", 8_000);
    assert.equal((await store.findLatest({ phone: first.phone, eventName: "Expo" })).id, first.id);

    const originalReaddir = fsp.readdir;
    let directoryScans = 0;
    fsp.readdir = async function (...args) {
        if (args[0] === dir) directoryScans++;
        return originalReaddir.apply(this, args);
    };
    try {
        const newer = await pending(store, "SMindexed-newer", first.phone, 9_000);
        assert.deepEqual(await store.supersedeOlder(newer.id), [first.id]);
        assert.equal((await store.claimLatest({ phone: first.phone, eventName: "Expo", callSid: "CAindexed" })).id, newer.id);
        assert.equal((await store.touchCall("CAindexed")).id, newer.id);
        assert.equal((await store.release("CAindexed")).status, "awaiting_call");
        assert.deepEqual(await store.reconcileClaims(), []);
        assert.deepEqual(await store.expire({ activeEventName: "Expo" }), []);
        assert.equal((await store.findLatest({ phone: first.phone, eventName: "Expo" })).id, newer.id);
        assert.equal((await store.list()).length, 2);
        assert.equal(directoryScans, 0);
    } finally {
        fsp.readdir = originalReaddir;
    }
});
