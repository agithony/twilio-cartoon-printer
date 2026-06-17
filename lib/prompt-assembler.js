// Pure helpers for resolving the background menu and building prompt fragments
// from a style + brand + background combination. No I/O, no side effects.
// See docs/superpowers/specs/2026-04-24-style-brand-background-combos-design.md

const DEFAULT_ORIGINAL_PROMPT = "Background: Recreate the background environment from the original photo in the same art style.";
const DEFAULT_PLAIN_WHITE_PROMPT = "Background: Pure solid white background, clean and minimal.";

function resolveBackgroundMenu(style, brand) {
    const options = [];

    const brandScenes = brand && Array.isArray(brand.scenes) ? brand.scenes : [];
    for (const s of brandScenes) {
        if (s && s.key && s.name) {
            options.push({
                key: s.key,
                name: s.name,
                prompt: s.prompt || "",
                files: Array.isArray(s.files) ? s.files : [],
                mode: s.mode === "exact" ? "exact" : "ai",
                analysis: s.analysis || "",
            });
        }
    }

    const allowOriginal = !brand || brand.allowOriginal !== false;
    const isWardrobePlusScene = brand && brand.category === "wardrobe-plus-scene";
    if (allowOriginal && !isWardrobePlusScene) {
        options.push({
            key: "original",
            name: "Original scene",
            prompt: DEFAULT_ORIGINAL_PROMPT,
            files: [],
        });
    }

    const isContainer = style && style.behavior === "themed-container";
    if (!isContainer && !isWardrobePlusScene) {
        options.push({
            key: "plain-white",
            name: "Solid White",
            prompt: DEFAULT_PLAIN_WHITE_PROMPT,
            files: [],
        });
    }

    return options;
}

// Decide which background options the SMS menu should offer.
//
// Two systems coexist (see combos design spec): a flat admin-configured
// `backgroundChoices` list, and the combo-driven menu synthesized from
// style + brand. `resolveBackgroundMenu` ALWAYS synthesizes at least
// [original, plain-white], so it can never be used as the "is the combo
// system active?" signal — doing so permanently shadows the admin list.
//
// The combo system only genuinely shapes the menu when the brand contributes
// scenes or the style is a themed-container (which suppresses plain-white).
// In every other case, prefer the admin-configured flat list, and fall back
// to the synthetic defaults only when no list is configured.
function comboShapesMenu(style, brand) {
    const brandHasScenes = !!(brand && Array.isArray(brand.scenes) && brand.scenes.length > 0);
    const brandHidesOriginal = !!(brand && brand.allowOriginal === false);
    const isContainer = !!(style && style.behavior === "themed-container");
    const isWardrobePlusScene = !!(brand && brand.category === "wardrobe-plus-scene");
    return brandHasScenes || brandHidesOriginal || isContainer || isWardrobePlusScene;
}

function selectBackgroundChoices(style, brand, configuredChoices) {
    const flat = Array.isArray(configuredChoices) ? configuredChoices : [];
    if (comboShapesMenu(style, brand)) {
        return resolveBackgroundMenu(style, brand);
    }
    if (flat.length > 0) {
        return flat;
    }
    return resolveBackgroundMenu(style, brand);
}

function buildComboFragments({ style, brand, background }) {
    const result = { containerDescription: null, colorPalette: null };

    if (style && style.behavior === "themed-container"
        && typeof style.containerDescription === "string"
        && style.containerDescription.trim()) {
        result.containerDescription = style.containerDescription.trim();
    }

    const styleAcceptsPalette = !style || style.acceptsColorPalette !== false;
    if (brand && typeof brand.colorPalette === "string" && brand.colorPalette.trim() && styleAcceptsPalette) {
        result.colorPalette = brand.colorPalette.trim();
    }

    return result;
}

module.exports = {
    resolveBackgroundMenu,
    selectBackgroundChoices,
    buildComboFragments,
    DEFAULT_ORIGINAL_PROMPT,
    DEFAULT_PLAIN_WHITE_PROMPT,
};
