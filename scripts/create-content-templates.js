#!/usr/bin/env node

require("dotenv").config();
const crypto = require("crypto");
const { getTwilioClient } = require("../lib/helpers");
const settings = require("../lib/settings");

function buildDefinitions(baseUrl, samplePortraitPath) {
    if (!samplePortraitPath) throw new Error("TWILIO_TEMPLATE_SAMPLE_PORTRAIT_PATH is required");
    const definitions = {
        delivery: {
            friendlyName: "pb_delivery", language: "en",
            variables: { 1: "Cartoon", 2: samplePortraitPath, 3: "photogallery" },
            types: {
                "twilio/card": {
                    title: "Your {{1}} portrait is ready!",
                    subtitle: "Created at the Twilio AI Photo Booth",
                    media: [`${baseUrl}/{{2}}`],
                    actions: [{ type: "URL", title: "View & Share", url: `${baseUrl}/{{3}}` }],
                },
                "twilio/text": { body: `Your {{1}} portrait is ready. View and share it: ${baseUrl}/{{3}}` },
            },
        },
        rating: {
            friendlyName: "pb_rating", language: "en",
            types: {
                "twilio/quick-reply": {
                    body: "How would you rate your portrait experience?",
                    actions: [
                        { type: "QUICK_REPLY", title: "5 - Loved it", id: "nps_5" },
                        { type: "QUICK_REPLY", title: "4 - Great", id: "nps_4" },
                        { type: "QUICK_REPLY", title: "3 - Good", id: "nps_3" },
                        { type: "QUICK_REPLY", title: "2 - Fair", id: "nps_2" },
                        { type: "QUICK_REPLY", title: "1 - Not for me", id: "nps_1" },
                    ],
                },
                "twilio/text": { body: "How would you rate your portrait experience? Reply with a number from 1 to 5, where 5 means you loved it." },
            },
        },
        promo: {
            friendlyName: "pb_promo", language: "en",
            types: {
                "twilio/call-to-action": {
                    body: "Want to build experiences like this? See what you can create with Twilio.",
                    actions: [{ type: "URL", title: "Explore Twilio", url: "https://www.twilio.com" }],
                },
                "twilio/text": { body: "Want to build experiences like this? See what you can create with Twilio: https://www.twilio.com" },
            },
        },
        nudgeDropoff: {
            friendlyName: "pb_nudge_dropoff", language: "en", variables: { 1: "our event" },
            types: { "twilio/text": { body: "Still want your AI portrait from {{1}}? Reply with a selfie to get started. Reply STOP to opt out." } },
        },
    };
    for (const definition of Object.values(definitions)) {
        const baseName = definition.friendlyName;
        const version = crypto.createHash("sha256")
            .update(JSON.stringify({ language: definition.language, variables: definition.variables, types: definition.types }))
            .digest("hex").slice(0, 10);
        definition.friendlyName = `${baseName}_${version}`;
    }
    return definitions;
}

const approvalCategories = {
    delivery: "UTILITY", rating: "UTILITY", promo: "MARKETING", nudgeDropoff: "MARKETING",
};

async function main({ client = getTwilioClient(), settingsModule = settings, baseUrl = process.env.BASE_URL, samplePortraitPath = process.env.TWILIO_TEMPLATE_SAMPLE_PORTRAIT_PATH, printOnly = process.argv.includes("--print-only") } = {}) {
    baseUrl = String(baseUrl || "").replace(/\/$/, "");
    if (!/^https:\/\//.test(baseUrl)) throw new Error("BASE_URL must be the public HTTPS app URL");
    settingsModule.load();
    const definitions = buildDefinitions(baseUrl, samplePortraitPath);
    const existing = await client.content.v1.contents.list({ limit: 1000 });
    const allSids = {};
    const approvedSids = {};

    for (const [key, definition] of Object.entries(definitions)) {
        const found = existing.find((item) => item.friendlyName === definition.friendlyName);
        const content = found || await client.content.v1.contents.create(definition);
        allSids[key] = content.sid;
        console.log(`${key}: ${content.sid}${found ? " (existing)" : " (created)"}`);
        let status = null;
        try {
            const approval = await client.content.v1.contents(content.sid).approvalFetch().fetch();
            status = approval.whatsapp && approval.whatsapp.status;
        } catch (err) {
            if (err.status !== 404) throw err;
        }
        if (status && status.toLowerCase() !== "unsubmitted") {
            console.log(`${key}: WhatsApp approval status is ${status}`);
            if (status.toLowerCase() === "approved") approvedSids[key] = content.sid;
        } else {
            await client.content.v1.contents(content.sid).approvalCreate.create({
                name: definition.friendlyName,
                category: approvalCategories[key],
            });
            console.log(`${key}: submitted for WhatsApp approval`);
        }
    }

    if (!printOnly) {
        const active = { ...(settingsModule.get("contentTemplates") || {}) };
        // Keep the currently approved version live while a replacement is
        // pending. Only swap a key when the new version is approved.
        Object.assign(active, approvedSids);
        settingsModule.update({ contentTemplates: active });
        console.log(`Saved ${Object.keys(approvedSids).length} approved template SID(s).`);
    }
    return { allSids, approvedSids };
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`Template creation failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { buildDefinitions, approvalCategories, main };
