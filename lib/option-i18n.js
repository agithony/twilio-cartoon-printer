const { normalizeLocale } = require("./i18n");

const COPY = {
    style: {
        cartoon: { pt_BR: { name: "Desenho animado", description: "Retrato 3D com cores quentes e acabamento cinematográfico" } },
        "pop-art": { pt_BR: { name: "Pop art", description: "Cores vibrantes, alto contraste e pontos de meio-tom" } },
        watercolor: { pt_BR: { name: "Aquarela", description: "Pinceladas suaves, transparências e textura de papel" } },
        anime: { pt_BR: { name: "Anime", description: "Ilustração com traços limpos e olhos expressivos" } },
        sketch: { pt_BR: { name: "Esboço", description: "Desenho a lápis com sombreamento e textura de grafite" } },
        "pixel-art": { pt_BR: { name: "Arte em pixels", description: "Visual retrô inspirado em videogames de 16 bits" } },
    },
    brand: {
        twilio: {
            en: { name: "Twilio branded", description: "Includes Twilio colors and brand elements" },
            pt_BR: { name: "Com marca Twilio", description: "Inclui cores e elementos visuais da Twilio" },
        },
    },
    background: {
        gradient: { pt_BR: { name: "Degradê suave", description: "Fundo limpo com um degradê suave" } },
        "solid-white": { pt_BR: { name: "Branco sólido", description: "Fundo branco, limpo e minimalista" } },
        "plain-white": { pt_BR: { name: "Branco sólido", description: "Fundo branco, limpo e minimalista" } },
        "solid-black": { pt_BR: { name: "Preto sólido", description: "Fundo preto, marcante e minimalista" } },
        original: { pt_BR: { name: "Cena original", description: "Mantém o ambiente da foto original" } },
    },
};

const PT_STYLE_DESCRIPTION_HINTS = [
    { terms: ["oil-painting", "oil painting", "pintura a óleo"], description: "Pinceladas expressivas, textura de tela e acabamento clássico" },
    { terms: ["magazine", "magazine cover", "capa de revista"], description: "Capa editorial com fotografia marcante e tipografia de revista" },
    { terms: ["action-figure", "action figure", "figura de ação"], description: "Boneco colecionável em uma embalagem temática de brinquedo" },
    { terms: ["twilio-illustration", "twilio illustration", "ilustração Twilio"], description: "Ilustração moderna inspirada nas formas e cores da Twilio" },
];

const GENERIC_DESCRIPTION = {
    en: { style: "Tap to choose this style", brand: "Tap to choose this theme", background: "Tap to choose this background" },
    pt_BR: { style: "Toque para escolher este estilo", brand: "Toque para escolher este tema", background: "Toque para escolher este fundo" },
};

function fold(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "");
}

function inferPortugueseStyleDescription(key, option, localizedName) {
    const searchable = [key, option.name, option.labels && option.labels.en && option.labels.en.name,
        option.labels && option.labels.pt_BR && option.labels.pt_BR.name]
        .filter(Boolean)
        .map(fold);
    const match = PT_STYLE_DESCRIPTION_HINTS.find((entry) =>
        entry.terms.some((term) => searchable.some((value) => value.includes(fold(term)))),
    );
    return match ? match.description : `Retrato transformado no estilo ${localizedName}`;
}

function unbrandedOption(locale = "en") {
    const resolved = normalizeLocale(locale) || "en";
    return resolved === "pt_BR"
        ? { key: "none", name: "Sem marca", description: "Sem logotipos, cores ou elementos de marca" }
        : { key: "none", name: "Unbranded", description: "No logos, brand colors, or branded elements" };
}

function localizeOption(type, key, option = {}, locale = "en") {
    const resolved = normalizeLocale(locale) || "en";
    const custom = option.labels && option.labels[resolved] || {};
    const builtIn = COPY[type] && COPY[type][key] && COPY[type][key][resolved] || {};
    const name = custom.name || builtIn.name || option.name || key;
    const inferredDescription = type === "style" && resolved === "pt_BR"
        ? inferPortugueseStyleDescription(key, option, name)
        : "";
    const description = custom.description || builtIn.description || inferredDescription || option.description
        || (GENERIC_DESCRIPTION[resolved] && GENERIC_DESCRIPTION[resolved][type])
        || GENERIC_DESCRIPTION.en[type];
    return { ...option, key, name, description };
}

function optionAliases(type, key, option) {
    const values = [key, option && option.name];
    for (const locale of ["en", "pt_BR"]) {
        const localized = localizeOption(type, key, option, locale);
        values.push(localized.name);
        if (option && option.labels && option.labels[locale]) values.push(option.labels[locale].name);
    }
    return [...new Set(values.filter(Boolean).map(fold))];
}

function localizeOptions(type, options, locale) {
    return (options || []).map((option) => localizeOption(type, option.key, option, locale));
}

module.exports = { COPY, fold, localizeOption, localizeOptions, optionAliases, unbrandedOption };
