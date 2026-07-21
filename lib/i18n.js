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
    pickupPrint: "Pode levar um ou dois minutos. Enviaremos uma mensagem quando estiver pronto para retirada no estande da Twilio.",
    pickupDigital: "Pode levar um ou dois minutos. Enviaremos assim que estiver pronto.",
    stillWorking: "Ainda estamos trabalhando no seu retrato. Nossa IA está caprichando nos detalhes. Aguarde só mais um pouco!",
    twilioBlurb: "Esta experiência é desenvolvida com a Twilio: recebemos sua foto, transformamos com IA e enviamos o resultado pelas APIs da Twilio.",
    deliveryDigital: "Seu retrato em estilo {styleName} está pronto!",
    deliveryPrint: "Seu retrato em estilo {styleName} foi enviado para a impressora! Retire-o no estande da Twilio.",
    lastPortrait: "Esse foi seu último retrato. Obrigado por participar!",
    moderationFail: "Não conseguimos usar essa foto. Envie outra selfie. Ela não contou para o seu limite.",
    noFace: "Precisamos ver seu rosto. Envie uma selfie com o rosto visível. Essa tentativa não contou para o seu limite.",
    multiSubjectReject: "Fotos em grupo não são aceitas nesta experiência. Envie uma selfie apenas com você.",
    styleMenuIntro: "Ótima selfie! Escolha o estilo do seu retrato:",
    styleMenuFooter: "Responda com o número ou nome do estilo.",
    styleMenuRetry: "Essa opção não está na lista. Escolha um número ou estilo:",
    brandMenuIntro: "Agora escolha um tema para o seu retrato:",
    brandMenuFooter: "Responda com o número ou nome do tema.",
    brandMenuRetry: "Essa opção não corresponde a um tema. Tente novamente:",
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

function interpolate(template, vars = {}) {
    return String(template || "").replace(/\{(\w+)\}/g, (match, key) => {
        if (vars[key] === undefined) return match;
        return key === "styleName" && typeof vars[key] === "string" ? vars[key].toLowerCase() : vars[key];
    }).replace(/  +/g, " ").trim();
}

function t(locale, key, vars, eventName) {
    const resolved = normalizeLocale(locale) || DEFAULT_LOCALE;
    if (resolved === "en") {
        return typeof settings.getMsgForEvent === "function"
            ? settings.getMsgForEvent(key, eventName, vars)
            : settings.getMsg(key, vars);
    }
    const template = catalogs[resolved] && catalogs[resolved][key];
    if (template === undefined) throw new Error(`Missing ${resolved} translation for ${key}`);
    return interpolate(template, vars);
}

function languagePrompt(channel) {
    if (channel === "whatsapp") return "Choose your language / Escolha seu idioma";
    return "Choose your language / Escolha seu idioma\n\n1. English\n2. Português";
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
    t,
    languagePrompt,
};
