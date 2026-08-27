const { test } = require("node:test");
const assert = require("node:assert/strict");

const { claimMatches, relayHeartbeats: apiHeartbeats } = require("../lib/print-relay");
const relayHeartbeats = require("../lib/relay-heartbeats");
const { RelayEngine } = require("../relay-app/relay");

test("claim fencing accepts only the current 1.3 claim", () => {
    assert.equal(claimMatches({ claimId: "claim-a" }, "claim-a"), true);
    assert.equal(claimMatches({ claimId: "claim-a" }, "claim-b"), false);
    assert.equal(claimMatches({ claimId: "claim-a" }, undefined), false);
});

test("legacy active claims can finish during coordinated upgrade", () => {
    assert.equal(claimMatches({}, undefined), true);
    assert.equal(claimMatches({}, "unexpected-new-claim"), false);
});

test("recovered jobs revoke claim-ID and legacy completion rights", () => {
    const recovered = { claimRevokedAt: 1234 };
    assert.equal(claimMatches(recovered, undefined), false);
    assert.equal(claimMatches(recovered, "old-claim"), false);
});

test("heartbeat registry is claim-scoped and clearable without queue writes", () => {
    assert.equal(apiHeartbeats, relayHeartbeats);
    relayHeartbeats.record("job.json", "claim-a", 1234);
    assert.equal(relayHeartbeats.get("job.json", "claim-a"), 1234);
    assert.equal(relayHeartbeats.get("job.json", "claim-b"), null);
    relayHeartbeats.clear("job.json", "claim-b");
    assert.equal(relayHeartbeats.get("job.json", "claim-a"), 1234);
    relayHeartbeats.clear("job.json", "claim-a");
    assert.equal(relayHeartbeats.get("job.json", "claim-a"), null);
});

test("a late old heartbeat response cannot stop the next claim heartbeat", async () => {
    const engine = new RelayEngine();
    const responses = [];
    engine._request = () => new Promise((resolve) => responses.push(resolve));

    engine._startHeartbeat("old.json", "claim-a");
    const oldHeartbeat = engine.activeHeartbeat;
    engine._startHeartbeat("new.json", "claim-b");
    const newHeartbeat = engine.activeHeartbeat;

    responses[0]({ status: 409 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.notEqual(oldHeartbeat, newHeartbeat);
    assert.equal(engine.activeHeartbeat, newHeartbeat);
    engine._stopHeartbeat();
});
