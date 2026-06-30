const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// shouldHideFromPrinter decides whether a ready job is withheld from the
// polling printer because it already failed there. The key regression this
// guards: a SINGLE-printer booth must never have its only printer hidden from
// a job it previously failed — otherwise the job strands in ready/ forever.
const { shouldHideFromPrinter } = require("../lib/print-relay");

// MAX_RETRIES is 3 in lib/config; the "last try" escape opens at retries >= 2.
const P = "EPSON_ET_8550_Series";

after(() => setImmediate(() => process.exit(0)));

test("unfiltered poll never hides anything", () => {
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P] }, null, [{ name: P }]), false);
});

test("job that never failed on this printer is shown", () => {
    assert.equal(shouldHideFromPrinter({ failedPrinters: [] }, P, [{ name: P }]), false);
    assert.equal(shouldHideFromPrinter({ failedPrinters: ["OtherPrinter"] }, P, [{ name: P }, { name: "OtherPrinter" }]), false);
});

test("SINGLE printer: failed job is STILL shown to its only printer (the bug fix)", () => {
    // Only this printer is checked in; it failed the job before. Must NOT hide.
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, [{ name: P }]), false);
});

test("SINGLE printer: even with no relay list at all, not hidden", () => {
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, []), false);
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, undefined), false);
});

test("MULTI printer: failed job IS hidden from the printer that failed it (failover preserved)", () => {
    // A second live printer that hasn't failed the job exists → hide from P so
    // the other one claims it.
    const relays = [{ name: P }, { name: "EPSON_ET_8550_Series_2" }];
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 1 }, P, relays), true);
});

test("MULTI printer: if the only alternative ALSO failed it, stop hiding", () => {
    const relays = [{ name: P }, { name: "P2" }];
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P, "P2"], retries: 1 }, P, relays), false);
});

test("last retry before MAX_RETRIES opens the job to everyone", () => {
    // retries >= MAX_RETRIES-1 (==2) → never hidden, even with alternatives.
    const relays = [{ name: P }, { name: "P2" }];
    assert.equal(shouldHideFromPrinter({ failedPrinters: [P], retries: 2 }, P, relays), false);
});
