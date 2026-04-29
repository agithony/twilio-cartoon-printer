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
    buildComboFragments,
    DEFAULT_ORIGINAL_PROMPT,
    DEFAULT_PLAIN_WHITE_PROMPT,
};
