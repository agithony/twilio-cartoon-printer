// Messaging channel tracking (SMS vs WhatsApp).
//
// The app identifies users by their raw E.164 phone number (e.g. "+14155551234")
// everywhere: usage quotas, admin checks, contacts, job.userPhone, lead state,
// still-working timers. Twilio delivers WhatsApp traffic with a "whatsapp:"
// prefix on the address (e.g. "whatsapp:+14155551234"), which would otherwise
// fork every user into two identities and break admin matching + quotas.
//
// This module keeps the phone identity raw and tracks the channel separately,
// so we can:
//   1. Normalize inbound "whatsapp:+123" → { channel: "whatsapp", phone: "+123" }.
//   2. Remember which channel a phone last used (durable across restarts) so
//      asynchronous sends (delivery, still-working, NPS, outreach) reply on the
//      same channel the user reached us on.
//   3. Re-apply the "whatsapp:" prefix when formatting an outbound address.

const fs = require("fs");
const path = require("path");

const CHANNEL_FILE = path.join(__dirname, "..", "data", "channels.json");
const WHATSAPP_PREFIX = "whatsapp:";

// { "+14155551234": "whatsapp" | "sms" }
let channelData = {};

// ── Persistence (mirrors lib/contacts.js) ────────────────────────────────────

function load() {
    try {
        if (fs.existsSync(CHANNEL_FILE)) {
            channelData = JSON.parse(fs.readFileSync(CHANNEL_FILE, "utf-8"));
        }
    } catch {
        channelData = {};
    }
    const count = Object.keys(channelData).length;
    if (count > 0) console.log(`💬 Channel map loaded (${count} records)`);
}

let _writeCounter = 0;
function save() {
    try {
        const tmp = CHANNEL_FILE + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmp, JSON.stringify(channelData, null, 2));
        fs.renameSync(tmp, CHANNEL_FILE);
    } catch (err) {
        console.error(`⚠️  Failed to persist channel map: ${err.message}`);
    }
}

// ── Address parsing / formatting ─────────────────────────────────────────────

// Split an inbound Twilio address into its channel and raw phone number.
// "whatsapp:+123" → { channel: "whatsapp", phone: "+123" }
// "+123"          → { channel: "sms",      phone: "+123" }
function parseAddress(addr) {
    if (!addr || typeof addr !== "string") return { channel: "sms", phone: addr || "" };
    if (addr.startsWith(WHATSAPP_PREFIX)) {
        return { channel: "whatsapp", phone: addr.slice(WHATSAPP_PREFIX.length) };
    }
    return { channel: "sms", phone: addr };
}

// Strip any channel prefix, returning the bare phone identity used internally.
function normalizePhone(addr) {
    return parseAddress(addr).phone;
}

// Format a raw phone into a Twilio address for the given channel. When no
// channel is passed, falls back to the last-known channel for that phone.
// Synthetic "api:" phones (kiosk / API entry points) are never sent to Twilio,
// so they pass through untouched.
function toAddress(phone, ch) {
    if (!phone || typeof phone !== "string") return phone;
    if (phone.startsWith("api:")) return phone;
    if (phone.startsWith(WHATSAPP_PREFIX)) return phone; // already prefixed
    const channel = ch || get(phone);
    return channel === "whatsapp" ? `${WHATSAPP_PREFIX}${phone}` : phone;
}

// ── Channel memory ───────────────────────────────────────────────────────────

// Remember the channel a phone last used. Only writes to disk when the value
// actually changes, keeping the hot inbound path cheap.
function record(phone, ch) {
    if (!phone || !ch) return;
    const key = normalizePhone(phone);
    if (channelData[key] === ch) return;
    channelData[key] = ch;
    save();
}

// Look up the channel for a phone; defaults to "sms" for unknown numbers so
// legacy behaviour is preserved for anyone not seen on WhatsApp.
function get(phone) {
    if (!phone) return "sms";
    return channelData[normalizePhone(phone)] || "sms";
}

module.exports = {
    WHATSAPP_PREFIX,
    load,
    save,
    parseAddress,
    normalizePhone,
    toAddress,
    record,
    get,
};
