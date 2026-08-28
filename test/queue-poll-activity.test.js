const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PENDING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const { processGenerationQueue, processPrintQueue } = require("../lib/queue");

test("empty generation queue reports idle for poll backoff", async () => {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const existing = fs.readdirSync(PENDING_DIR).filter((name) => name.endsWith(".json"));
    assert.deepEqual(existing, [], "test requires an empty pending queue");
    assert.equal(await processGenerationQueue(), false);
});

test("relay mode reports local print polling as idle", async () => {
    const originalGet = settings.get;
    settings.get = function patchedGet(key, ...args) {
        if (key === "printRelayKey") return "configured-relay";
        return originalGet.call(settings, key, ...args);
    };
    try {
        assert.equal(await processPrintQueue(), false);
    } finally {
        settings.get = originalGet;
    }
});
