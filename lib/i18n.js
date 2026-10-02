const settings = require("./settings");

const DEFAULT_LOCALE = "en";
const SUPPORTED_LOCALES = ["en", "pt_BR"];

const pt_BR = {
    welcome: "Envie uma selfie e vamos transformá-la em arte!",
    welcomeCount: "Você tem direito a {maxPrints} {unit} grátis no evento {eventName}.",
    remainingCount: "Você ainda tem {remaining} {unit}.",
    multiplePhotos: "Uma foto por vez! Envie apenas uma selfie para continuarmos.",
    quotaExceeded: "Você já usou suas {maxPrints} {units} grátis no evento {eventName}. Obrigado por participar!",
    enqueued: "{confirmLabel} está sendo criado!",
    pickupPrint: "Pode levar um ou dois minutos. Enviaremos uma mensagem quando estiver pronto. Local de retirada: {pickupLocation}.",
    pickupDigital: "Pode levar um ou dois minutos. Enviaremos assim que estiver pronto.",
    stillWorking: "Ainda estamos trabalhando no seu retrato. Nossa IA está caprichando nos detalhes. Aguarde só mais um pouco!",
    twilioBlurb: "Esta experiência é desenvolvida com a Twilio: recebemos sua foto, transformamos com IA e enviamos o resultado pelas APIs da Twilio.",
    deliveryDigital: "Seu retrato em estilo {styleName} está pronto!",
    deliveryPrint: "Seu retrato em estilo {styleName} foi enviado para a impressora! Local de retirada: {pickupLocation}.",
    lastPortrait: "Esse foi seu último retrato. Obrigado por participar!",
    moderationFail: "Não conseguimos usar essa foto. Envie outra selfie. Ela não contou para o seu limite.",
    noFace: "Precisamos ver seu rosto. Envie uma selfie com o rosto visível. Essa tentativa não contou para o seu limite.",
    multiSubjectReject: "Fotos em grupo não são aceitas nesta experiência. Envie uma selfie apenas com você.",
    styleMenuIntro: "Ótima selfie! Escolha o estilo do seu retrato:",
    styleMenuFooter: "Responda com o número ou nome do estilo.",
    styleMenuRetry: "Essa opção não está na lista. Escolha um número ou estilo:",
    brandMenuIntro: "Agora escolha uma opção de marca para o seu retrato:",
    brandMenuFooter: "Responda com o número ou nome da opção de marca.",
    brandMenuRetry: "Essa opção de marca não está na lista. Tente novamente:",
    backgroundMenuIntro: "Agora escolha o fundo do seu retrato:",
    backgroundMenuFooter: "Responda com o número ou nome do fundo.",
    backgroundMenuRetry: "Essa opção não corresponde a um fundo. Tente novamente:",
    leadIntroBefore: "Antes de criar seu retrato, precisamos de algumas informações rápidas.",
    leadIntroAfter: "Temos algumas perguntas rápidas para você.",
    leadComplete: "Obrigado, {firstName}!",
    leadCompleteWithCta: "Obrigado, {firstName}! Agora envie uma selfie para transformarmos em arte.",
    npsPrompt: "Como você avalia sua experiência com o retrato? Responda com um número de 1 a 5, onde 5 significa que você adorou.",
    npsThanks: "Obrigado pela avaliação! Agradecemos sua participação.",
    reviewReject: "Não conseguimos usar essa foto. Envie outra para tentarmos novamente.",
    reviewFailed: "Não conseguimos finalizar seu retrato desta vez. Tente novamente com outra foto.",
    nudgeDropoff: "Ainda quer seu retrato com IA? Envie uma selfie para começar.",
};

const catalogs = { pt_BR };

const voiceCopy = {
    en: {
        invitation: "Great selfie! Call {number} from the phone you used to send it. Tell our voice agent how you want your photo to look—for example, a watercolor portrait, a space setting, or a vintage outfit. Please call within 30 minutes.",
        invitationWhatsappIntro: "Use the Call by phone button in the next message for a regular phone call, not a WhatsApp call. Call from this phone within 30 minutes.",
        invalid: "We couldn't use that photo. Please send a clear JPEG or PNG selfie. This attempt did not count toward your limit.",
        noFace: "We need to see your face. Please send a selfie with your face visible. This attempt did not count toward your limit.",
        group: "Group selfies aren't supported for this event. Please send a selfie with only you in it.",
        retry: "We couldn't check your photo yet. We're retrying; if this takes too long, please send a new selfie.",
        expired: "We couldn't finish checking that selfie in time. Please send a new one. This attempt did not count toward your limit.",
        delivery: "Your voice-guided portrait is ready!",
        failure: "We couldn't finish your voice-guided portrait this time. Please send a new selfie to try again.",
    },
    pt_BR: {
        invitation: "Ótima selfie! Ligue para {number} do telefone usado para enviá-la. Diga ao nosso agente de voz como você quer que sua foto fique—por exemplo, uma aquarela, um cenário espacial ou uma roupa vintage. Ligue em até 30 minutos.",
        invitationWhatsappIntro: "Use o botão \"Call by phone\" na próxima mensagem para fazer uma ligação comum, não uma chamada pelo WhatsApp. Ligue deste celular em até 30 minutos. Conte ao agente como quer que sua foto fique, por exemplo, como aquarela, em Marte ou com roupa vintage.",
        invalid: "Não conseguimos usar essa foto. Envie uma selfie nítida em JPEG ou PNG. Esta tentativa não contou para o seu limite.",
        noFace: "Precisamos ver seu rosto. Envie uma selfie com o rosto visível. Esta tentativa não contou para o seu limite.",
        group: "Fotos em grupo não são aceitas neste evento. Envie uma selfie apenas com você.",
        retry: "Ainda não conseguimos verificar sua foto. Vamos tentar novamente; se demorar, envie outra selfie.",
        expired: "Não conseguimos verificar essa selfie a tempo. Envie outra. Esta tentativa não contou para o seu limite.",
        delivery: "Seu retrato criado com ajuda do agente de voz está pronto!",
        failure: "Não conseguimos finalizar seu retrato desta vez. Envie outra selfie para tentar novamente.",
    },
};

function normalizeLocale(value) {
    const normalized = String(value || "").trim().toLowerCase().replace("-", "_");
    if (["pt", "pt_br", "português", "portugues", "2"].includes(normalized)) return "pt_BR";
    if (["en", "en_us", "english", "inglês", "ingles", "1"].includes(normalized)) return "en";
    return null;
}

function parseLanguageSelection(value) {
    const text = String(value || "").trim();
    if (/^lang_(en|pt_BR)$/i.test(text)) return text.toLowerCase() === "lang_en" ? "en" : "pt_BR";
    return normalizeLocale(text);
}

function isExplicitLanguageSelection(value) {
    const text = String(value || "").trim().toLowerCase().replace("-", "_");
    return /^lang_(en|pt_br)$/.test(text)
        || ["en", "en_us", "english", "inglês", "ingles", "pt", "pt_br", "português", "portugues"].includes(text);
}

function shouldApplyLanguageSelection(languageMode, value, { activeLocale, selectionPending } = {}) {
    return languageMode === "ask"
        && !normalizeLocale(activeLocale)
        && (selectionPending || isExplicitLanguageSelection(value));
}

function resolveAttendeeLocale(languageMode, preferredLocale, activeLocale) {
    const active = normalizeLocale(activeLocale);
    if (active) return active;
    if (languageMode === "ask") return normalizeLocale(preferredLocale);
    return normalizeLocale(languageMode) || DEFAULT_LOCALE;
}

function resolvePickupLocation(locale, configuredLocation) {
    const configured = String(configuredLocation || "").trim();
    if (configured) return configured;
    return normalizeLocale(locale) === "pt_BR" ? "estande da Twilio" : "Twilio booth";
}

function interpolate(template, vars = {}) {
    return String(template || "").replace(/\{(\w+)\}/g, (match, key) => {
        if (vars[key] === undefined) return match;
        return key === "styleName" && typeof vars[key] === "string" ? vars[key].toLowerCase() : vars[key];
    }).replace(/  +/g, " ").trim();
}

function t(locale, key, vars, eventName) {
    const resolved = normalizeLocale(locale) || DEFAULT_LOCALE;
    if (resolved === "en") {
        let rendered = typeof settings.getMsgForEvent === "function"
            ? settings.getMsgForEvent(key, eventName, vars)
            : settings.getMsg(key, vars);
        if ((key === "pickupPrint" || key === "deliveryPrint") && vars && vars.pickupLocation) {
            rendered = rendered.replace(/Twilio booth/g, vars.pickupLocation);
        }
        return rendered;
    }
    const template = catalogs[resolved] && catalogs[resolved][key];
    if (template === undefined) throw new Error(`Missing ${resolved} translation for ${key}`);
    return interpolate(template, vars);
}

function languagePrompt(channel) {
    if (channel === "whatsapp") return "Choose your language / Escolha seu idioma";
    return "Choose your language / Escolha seu idioma\n\n1. English\n2. Português";
}

function voiceText(locale, key, vars = {}) {
    const resolved = normalizeLocale(locale);
    if (resolved) return interpolate(voiceCopy[resolved][key], vars);
    if (key === "invitation") return `${interpolate(voiceCopy.en[key], vars)}\n\n${interpolate(voiceCopy.pt_BR[key], vars)}`;
    return `${interpolate(voiceCopy.en[key], vars)}\n${interpolate(voiceCopy.pt_BR[key], vars)}`;
}

module.exports = {
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    catalogs,
    normalizeLocale,
    parseLanguageSelection,
    isExplicitLanguageSelection,
    shouldApplyLanguageSelection,
    resolveAttendeeLocale,
    resolvePickupLocation,
    t,
    languagePrompt,
    voiceText,
};
