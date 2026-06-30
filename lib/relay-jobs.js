// Pure helpers for relay/queue job visibility and integrity.
//
// Extracted as a dependency-free module so the decision logic can be unit
// tested without pulling in the heavy queue.js / dashboard.js import chains
// (settings, twilio, openai, timers). Everything here is a pure function of
// its arguments — no filesystem, no network, no module-load side effects.

// Stages that represent an in-flight (not-yet-terminal) job. These live in
// READY_DIR / PRINTING_DIR and previously showed only as queue counts on the
// dashboard — never as rows in the Jobs table. shapeActiveJob() turns a raw
// job record into the same row shape the Done/Failed tabs already use, plus a
// derived `status` so a single render path can show all three.
const ACTIVE_STAGES = ["ready", "printing"];

// Decide whether a job sitting in READY_DIR is a permanent orphan whose
// print-resolution output image is gone. A job only ever reaches READY_DIR
// AFTER pipeline.moveStagedToFinal() has moved its _output.png into the final
// downloads dir (see queue.js processPrintQueue), so a ready job with no PNG
// on disk is not a transient race — the file was lost/deleted later. Such a
// job loops forever: the relay claims it, the server's ack handler finds no
// image and returns HTTP 400 + bounces it back to ready, the relay marks it
// "processed" for 10 min, then retries and bounces again. It can never print
// and never reaches DONE_DIR, so it shows as a phantom "1 Ready" that never
// clears and a user never gets their portrait.
//
// `outputExists` is supplied by the caller (it does the fs check) so this stays
// pure and testable. We only ever fail READY jobs here — a job actively in
// PRINTING_DIR is owned by a relay and must not be yanked out from under it.
function isMissingOutput(stage, outputExists) {
    return stage === "ready" && outputExists === false;
}

// Shape a raw job record (as stored in the queue JSON files) into the row the
// dashboard Jobs table renders. `stage` is the queue dir it came from
// ("ready" | "printing"). `maskPhone` is injected so this module never has to
// know how phones are masked (kept identical to dashboard.js/print-relay.js).
function shapeActiveJob(job, stage, maskPhone) {
    const enteredAt = job.stateChangedAt || job.printingAt || job.readyAt || job.createdAt || null;
    return {
        filename: `${job.filePrefix}.json`,
        filePrefix: job.filePrefix || null,
        eventName: job.eventName || null,
        phone: typeof maskPhone === "function" ? maskPhone(job.userPhone) : (job.userPhone || null),
        style: job.style || "unknown",
        printerName: job.printerName || null,
        // Derived display status. A job in PRINTING_DIR is actively on a
        // printer; one in READY_DIR is queued and waiting for a relay to claim
        // it. The client renders these with their own badge + no Reprint/Retry
        // action (they're not terminal yet).
        status: stage === "printing" ? "printing" : "ready",
        stage,
        enteredAt,
        readyAt: job.readyAt || null,
        retries: job.retries || 0,
        // failedPrinters lets the UI explain why a ready job keeps bouncing
        // (every printer that already rejected it).
        failedPrinters: job.failedPrinters || [],
    };
}

module.exports = { ACTIVE_STAGES, isMissingOutput, shapeActiveJob };
