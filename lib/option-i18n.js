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
    background: {
        gradient: { pt_BR: { name: "Degradê suave", description: "Fundo limpo com um degradê suave" } },
        "solid-white": { pt_BR: { name: "Branco sólido", description: "Fundo branco, limpo e minimalista" } },
        "plain-white": { pt_BR: { name: "Branco sólido", description: "Fundo branco, limpo e minimalista" } },
        "solid-black": { pt_BR: { name: "Preto sólido", description: "Fundo preto, marcante e minimalista" } },
        original: { pt_BR: { name: "Cena original", description: "Mantém o ambiente da foto original" } },
    },
};

const GENERIC_DESCRIPTION = {
    en: { style: "Tap to choose this style", brand: "Tap to choose this theme", background: "Tap to choose this background" },
    pt_BR: { style: "Toque para escolher este estilo", brand: "Toque para escolher este tema", background: "Toque para escolher este fundo" },
};

function fold(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "");
}

function localizeOption(type, key, option = {}, locale = "en") {
    const resolved = normalizeLocale(locale) || "en";
    const custom = option.labels && option.labels[resolved] || {};
    const builtIn = COPY[type] && COPY[type][key] && COPY[type][key][resolved] || {};
    const name = custom.name || builtIn.name || option.name || key;
    const description = custom.description || builtIn.description || option.description
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

module.exports = { COPY, fold, localizeOption, localizeOptions, optionAliases };
