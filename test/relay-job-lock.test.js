const { test } = require("node:test");
const assert = require("node:assert/strict");

const { acquireRelayJobLock } = require("../lib/relay-job-lock");

test("relay job lock serializes transitions for the same filename", async () => {
    const releaseFirst = await acquireRelayJobLock("portrait.json");
    let secondEntered = false;
    const second = (async () => {
        const releaseSecond = await acquireRelayJobLock("portrait.json");
        secondEntered = true;
        releaseSecond();
    })();

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondEntered, false);
    releaseFirst();
    await second;
    assert.equal(secondEntered, true);
});

test("relay job locks do not block different filenames", async () => {
    const releaseFirst = await acquireRelayJobLock("first.json");
    const releaseSecond = await acquireRelayJobLock("second.json");
    releaseSecond();
    releaseFirst();
});
