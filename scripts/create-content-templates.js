#!/usr/bin/env node

require("dotenv").config();
const crypto = require("crypto");
const { getTwilioClient } = require("../lib/helpers");
const settings = require("../lib/settings");

function buildDefinitions(baseUrl, samplePortraitPath, locale = "en", voiceNumber = "") {
    if (!samplePortraitPath) throw new Error("TWILIO_TEMPLATE_SAMPLE_PORTRAIT_PATH is required");
    const pt = locale === "pt_BR";
    const localeSlug = locale.toLowerCase();
    const definitions = {
        voiceDelivery: {
            friendlyName: `pb_voice_delivery_${localeSlug}`, language: locale,
            variables: { 1: samplePortraitPath, 2: samplePortraitPath },
            types: {
                "twilio/card": {
                    title: pt ? "Seu retrato criado por voz está pronto!" : "Your voice-guided portrait is ready!",
                    subtitle: pt ? "Criado na cabine de fotos com IA da Twilio" : "Created at the Twilio AI Photo Booth",
                    media: [`${baseUrl}/{{1}}`],
                    actions: [{ type: "URL", title: pt ? "Ver e compartilhar" : "View & Share", url: `${baseUrl}/{{2}}` }],
                },
                "twilio/text": { body: pt ? `Seu retrato criado por voz está pronto. Veja e compartilhe: ${baseUrl}/{{2}}` : `Your voice-guided portrait is ready. View and share it: ${baseUrl}/{{2}}` },
            },
        },
        voiceFailure: {
            friendlyName: `pb_voice_failure_${localeSlug}`, language: locale,
            types: { "twilio/text": { body: pt
                ? "Não conseguimos finalizar seu retrato desta vez. Envie outra selfie para tentar novamente."
                : "We couldn't finish your voice-guided portrait this time. Send another selfie to try again." } },
        },
        delivery: {
            friendlyName: `pb_delivery_${localeSlug}`, language: locale,
            variables: { 1: "Cartoon", 2: samplePortraitPath, 3: "photogallery" },
            types: {
                "twilio/card": {
                    title: pt ? "Seu retrato em estilo {{1}} está pronto!" : "Your {{1}} portrait is ready!",
                    subtitle: pt ? "Criado na cabine de fotos com IA da Twilio" : "Created at the Twilio AI Photo Booth",
                    media: [`${baseUrl}/{{2}}`],
                    actions: [{ type: "URL", title: pt ? "Ver e compartilhar" : "View & Share", url: `${baseUrl}/{{3}}` }],
                },
                "twilio/text": { body: pt ? `Seu retrato em estilo {{1}} está pronto. Veja e compartilhe: ${baseUrl}/{{3}}` : `Your {{1}} portrait is ready. View and share it: ${baseUrl}/{{3}}` },
            },
        },
        rating: {
            friendlyName: `pb_rating_${localeSlug}`, language: locale,
            types: {
                "twilio/quick-reply": {
                    body: pt ? "Como você avalia sua experiência com o retrato?" : "How would you rate your portrait experience?",
                    actions: [
                        { type: "QUICK_REPLY", title: pt ? "5 - Adorei" : "5 - Loved it", id: "nps_5" },
                        { type: "QUICK_REPLY", title: pt ? "4 - Ótima" : "4 - Great", id: "nps_4" },
                        { type: "QUICK_REPLY", title: pt ? "3 - Boa" : "3 - Good", id: "nps_3" },
                        { type: "QUICK_REPLY", title: pt ? "2 - Regular" : "2 - Fair", id: "nps_2" },
                        { type: "QUICK_REPLY", title: pt ? "1 - Não gostei" : "1 - Not for me", id: "nps_1" },
                    ],
                },
                "twilio/text": { body: pt ? "Como você avalia sua experiência com o retrato? Responda de 1 a 5, onde 5 significa que você adorou." : "How would you rate your portrait experience? Reply with a number from 1 to 5, where 5 means you loved it." },
            },
        },
        promo: {
            friendlyName: `pb_promo_${localeSlug}`, language: locale,
            types: {
                "twilio/call-to-action": {
                    body: pt ? "Quer criar experiências como esta? Veja o que você pode construir com a Twilio." : "Want to build experiences like this? See what you can create with Twilio.",
                    actions: [{ type: "URL", title: pt ? "Conheça a Twilio" : "Explore Twilio", url: "https://www.twilio.com" }],
                },
                "twilio/text": { body: pt ? "Quer criar experiências como esta? Veja o que você pode construir com a Twilio: https://www.twilio.com" : "Want to build experiences like this? See what you can create with Twilio: https://www.twilio.com" },
            },
        },
        nudgeDropoff: {
            friendlyName: `pb_nudge_dropoff_${localeSlug}`, language: locale, variables: { 1: pt ? "nosso evento" : "our event" },
            types: { "twilio/text": { body: pt ? "Ainda quer seu retrato com IA do evento {{1}}? Responda com uma selfie para começar. Responda STOP para cancelar." : "Still want your AI portrait from {{1}}? Reply with a selfie to get started. Reply STOP to opt out." } },
        },
    };
    if (/^\+[1-9]\d{7,14}$/.test(voiceNumber)) {
        definitions.voiceInvitation = {
            friendlyName: `pb_voice_invitation_${localeSlug}`, language: locale,
            types: {
                "twilio/call-to-action": {
                    body: pt
                        ? "Ótima selfie! Toque em Ligar por telefone abaixo para fazer uma ligação normal do mesmo celular que enviou a foto em até 30 minutos. Conte ao nosso agente como quer que sua foto fique, por exemplo, como aquarela, no espaço ou com roupa vintage."
                        : "Great selfie! Tap Call by phone below to place a regular phone call from the same phone you used to send your photo within 30 minutes. Tell our agent how you want your photo to look, such as a watercolor portrait, a space setting, or a vintage outfit.",
                    actions: [{ type: "PHONE_NUMBER", title: pt ? "Ligar por telefone" : "Call by phone", phone: voiceNumber }],
                },
            },
        };
    }
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
    voiceDelivery: "UTILITY", voiceFailure: "UTILITY", voiceInvitation: "UTILITY",
    delivery: "UTILITY", rating: "UTILITY", promo: "MARKETING", nudgeDropoff: "MARKETING",
};

async function getContentName(client, content) {
    if (content.friendlyName) return content.friendlyName;
    try {
        const approval = await client.content.v1.contents(content.sid).approvalFetch().fetch();
        return approval.whatsapp && approval.whatsapp.name;
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}

async function main({ client, settingsModule = settings, baseUrl = process.env.BASE_URL, samplePortraitPath = process.env.TWILIO_TEMPLATE_SAMPLE_PORTRAIT_PATH, printOnly = process.argv.includes("--print-only") } = {}) {
    baseUrl = String(baseUrl || "").replace(/\/$/, "");
    if (!/^https:\/\//.test(baseUrl)) throw new Error("BASE_URL must be the public HTTPS app URL");
    settingsModule.load();
    const configuredVoiceNumber = String(settingsModule.get("twilioVoiceNumber") || "").trim();
    const voiceNumber = /^\+[1-9]\d{7,14}$/.test(configuredVoiceNumber) ? configuredVoiceNumber : "";
    if (!voiceNumber) console.warn("Voice invitation template skipped: configure a valid E.164 Twilio Voice number.");
    if (printOnly) {
        const definitions = {};
        for (const locale of ["en", "pt_BR"]) definitions[locale] = buildDefinitions(baseUrl, samplePortraitPath, locale, voiceNumber);
        console.log(JSON.stringify(definitions, null, 2));
        return { definitions };
    }

    client = client || getTwilioClient();
    const existing = await client.content.v1.contents.list({ limit: 1000 });
    const existingByName = new Map();
    for (const content of existing) {
        const name = await getContentName(client, content);
        if (name) existingByName.set(name, content);
    }
    const allSids = { en: {}, pt_BR: {} };
    const approvedSids = { en: {}, pt_BR: {} };

    for (const locale of ["en", "pt_BR"]) {
      const definitions = buildDefinitions(baseUrl, samplePortraitPath, locale, voiceNumber);
      for (const [key, definition] of Object.entries(definitions)) {
        const found = existingByName.get(definition.friendlyName);
        const content = found || await client.content.v1.contents.create(definition);
        allSids[locale][key] = content.sid;
        console.log(`${locale}.${key}: ${content.sid}${found ? " (existing)" : " (created)"}`);
        let status = null;
        try {
            const approval = await client.content.v1.contents(content.sid).approvalFetch().fetch();
            status = approval.whatsapp && approval.whatsapp.status;
        } catch (err) {
            if (err.status !== 404) throw err;
        }
        if (status && status.toLowerCase() !== "unsubmitted") {
            console.log(`${key}: WhatsApp approval status is ${status}`);
            if (status.toLowerCase() === "approved") {
                approvedSids[locale][key] = content.sid;
                if (key === "voiceInvitation") approvedSids[locale].voiceInvitationPhone = voiceNumber;
            }
        } else {
            await client.content.v1.contents(content.sid).approvalCreate.create({
                name: definition.friendlyName,
                category: approvalCategories[key],
            });
            console.log(`${key}: submitted for WhatsApp approval`);
        }
      }
    }

    const current = settingsModule.get("contentTemplates") || {};
    const currentByLocale = { en: current.en || current, pt_BR: current.pt_BR || {} };
    const active = {
        en: { ...currentByLocale.en, ...approvedSids.en },
        pt_BR: { ...currentByLocale.pt_BR, ...approvedSids.pt_BR },
    };
    let savedCount = 0;
    let hasUpdates = false;
    for (const locale of ["en", "pt_BR"]) {
        for (const [key, sid] of Object.entries(approvedSids[locale])) {
            if (currentByLocale[locale][key] !== sid) {
                hasUpdates = true;
                if (key !== "voiceInvitationPhone") savedCount++;
            }
        }
    }
    if (hasUpdates) settingsModule.update({ contentTemplates: active });
    console.log(`Saved ${savedCount} newly approved template SID(s).`);
    return { allSids, approvedSids };
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`Template creation failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { buildDefinitions, approvalCategories, getContentName, main };
