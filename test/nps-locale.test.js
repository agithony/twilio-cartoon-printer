const { test } = require("node:test");
const assert = require("node:assert/strict");
const nps = require("../lib/nps");

test("pending rating snapshots its event and locale", () => {
    nps.markPending("+14155550000", { eventName: "Evento", locale: "pt_BR" });
    const pending = nps.getPending("+14155550000", "Evento");
    assert.equal(pending.eventName, "Evento");
    assert.equal(pending.locale, "pt_BR");
    assert.equal(nps.hasPending("+14155550000", "Outro Evento"), false);

    nps.markPending("+14155550000", { eventName: "Outro Evento", locale: "en" });
    assert.equal(nps.getPending("+14155550000", "Evento").locale, "pt_BR");
    assert.equal(nps.getPending("+14155550000", "Outro Evento").locale, "en");
    assert.equal(nps.getLatestPending("+14155550000").eventName, "Outro Evento");
});
