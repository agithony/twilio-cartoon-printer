// Follow-up "still working on your portrait" SMS scheduler.
// Goal: reduce perceived wait anxiety when the pickup→delivery gap is long
// (usually 2-4 minutes for print). Armed when the user's enqueue SMS is sent;
// cancelled when delivery SMS fires (whichever comes first).
//
// In-memory only — if the process restarts, pending timers are lost and no
// stale reassurance ping goes out. That's the safe failure mode.

const { sendSms, maskPhone } = require("./helpers");
const settings = require("./settings");

// Keyed by userPhone so we never double-schedule for the same user.
// Value: NodeJS.Timeout handle.
const _timers = new Map();

// Arm a "still working" follow-up for this user. Safe to call repeatedly —
// earlier timers for the same phone are cancelled so we only send one.
function arm(userPhone, appPhone, eventName) {
    if (!userPhone) return;
    cancel(userPhone);

    const enabled = settings.getForEvent("stillWorkingEnabled", eventName) !== false;
    if (!enabled) return;

    const delaySec = Math.max(15, Math.min(600,
        Number(settings.getForEvent("stillWorkingDelay", eventName)) || 60));

    const timer = setTimeout(async () => {
        _timers.delete(userPhone);
        try {
            const msg = settings.getMsgForEvent("stillWorking", eventName);
            if (msg) {
                await sendSms(userPhone, appPhone, msg);
                console.log(`⏱️  Still-working SMS sent to ${maskPhone(userPhone)} after ${delaySec}s`);
            }
        } catch (err) {
            console.error(`❌ Still-working SMS failed for ${maskPhone(userPhone)}: ${err.message}`);
        }
    }, delaySec * 1000);

    _timers.set(userPhone, timer);
}

// Cancel a pending still-working timer for this user. Called when the real
// delivery SMS is about to fire, so the user never gets both messages.
function cancel(userPhone) {
    if (!userPhone) return;
    const existing = _timers.get(userPhone);
    if (existing) {
        clearTimeout(existing);
        _timers.delete(userPhone);
    }
}

module.exports = { arm, cancel };
