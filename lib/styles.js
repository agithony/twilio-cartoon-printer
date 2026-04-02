const DEFAULT_PRESERVE =
    "Preserve accurately for every subject: skin tone, eye color, hair color, hairstyle, facial hair, glasses, jewelry, clothing, and any visible accessories or distinguishing features.";

const DEFAULT_COMPOSITION =
    "Composition: Portrait framing from the chest up, with all subjects positioned naturally as they appear in the original photo.";

const STYLES = {
    cartoon: {
        name: "cartoon",
        core: "Pixar-style 3D animated portrait with exaggerated proportions, warm color grading, subsurface skin glow, and rich tactile textures.",
        brandCore: "Pixar-style 3D animated portrait with warm colors and rich textures.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a 3D animated character portrait in the style of Pixar and Disney Animation Studios (Coco, Up, Brave). Each subject should be a stylized cartoon version of the corresponding person (and any pets) in the photo.",
            preserve + " The cartoon should be immediately recognizable as each person in the original photo.",
            "Style: High-quality Pixar-style 3D render with warm, rich color grading. Slightly exaggerated proportions — larger head, big round expressive eyes with detailed iris reflections, soft rounded features with a touch of caricature. Smooth subsurface scattering on skin for that signature Pixar porcelain glow. Rich fabric and hair textures with individual strand detail. Every surface should have the polished, tactile quality of a Pixar film frame.",
            "Lighting: Warm cinematic Pixar-style lighting — soft key light with golden tones, gentle fill light, and a subtle cool rim light. Soft ambient occlusion in creases and under the chin.",
            composition + " Give them a warm, friendly expression.",
            "Background: Clean soft gradient background, light and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
    "pop-art": {
        name: "pop art",
        core: "Pop art portrait with bold halftone dots, high contrast, thick black outlines, and Ben-Day dot shading.",
        brandCore: "Pop art style with halftone dots and high contrast.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a bold pop art portrait in the style of Andy Warhol and Roy Lichtenstein. The artwork should be immediately recognizable as every person in the original photo.",
            preserve,
            "Style: Bold black outlines, flat vibrant colors with high saturation, and Ben-Day dots or halftone patterns for shading. Use a limited but striking color palette with strong contrast. The overall look should feel like a hand-pulled screen print or comic-book panel.",
            "Lighting: Flat, graphic lighting with strong shadows rendered as solid color blocks.",
            composition,
            "Background: Solid bright color block, clean and high-contrast, suitable for printing.",
        ].join("\n\n"),
    },
    watercolor: {
        name: "watercolor",
        core: "Watercolor painting with flowing brushstrokes, gentle color bleeds, paper texture, and wet-on-wet blending.",
        brandCore: "Soft watercolor painting with flowing brushstrokes and gentle blending.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a beautiful watercolor painting portrait. The painting should be immediately recognizable as every person in the original photo.",
            preserve,
            "Style: Soft, flowing watercolor washes with visible brush strokes and natural paint bleeding at edges. Use a luminous, translucent color palette with gentle gradients. Allow some areas of white paper to show through for a natural watercolor feel. The painting should look like a professional watercolor portrait by a skilled artist.",
            "Lighting: Soft, diffused natural lighting with gentle shadows built through layered washes.",
            composition,
            "Background: Light watercolor wash with soft color bleeds, minimal and airy, suitable for printing.",
        ].join("\n\n"),
    },
    anime: {
        name: "anime",
        core: "Anime illustration with large expressive eyes, detailed hair with shine highlights, smooth gradient shading, and clean line art.",
        brandCore: "Anime style with large expressive eyes and clean line art.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a Japanese anime-style character portrait. Each subject should be immediately recognizable as the corresponding person in the original photo.",
            preserve,
            "Style: Clean anime illustration with bold outlines, smooth cel-shaded coloring, and large expressive eyes. Use vibrant colors with clean flat shading and subtle highlights. The style should resemble a high-quality modern anime or manga illustration.",
            "Lighting: Bright, clean anime-style lighting with defined shadows and crisp highlights.",
            composition + " Give them an expressive, confident pose.",
            "Background: Soft gradient or subtle abstract pattern, clean and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
    sketch: {
        name: "sketch",
        core: "Pencil sketch with cross-hatching, varying line weights, graphite shading, and sketch paper texture.",
        brandCore: "Hand-drawn pencil sketch with cross-hatching and graphite shading.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a detailed pencil sketch portrait. The drawing should be immediately recognizable as every person in the original photo.",
            preserve + " Capture their likeness through precise linework and shading.",
            "Style: Realistic graphite pencil drawing on white paper with fine cross-hatching and careful tonal shading. Use a full range of values from light to dark for depth and dimension. Show visible pencil strokes and paper texture. The drawing should look like a professional hand-drawn portrait by a skilled artist.",
            "Lighting: Strong directional lighting that creates clear highlights and shadows to define the face and features.",
            composition,
            "Background: Clean white or very light paper texture, minimal and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
    "pixel-art": {
        name: "pixel art",
        core: "Pixel art portrait with visible square pixels, limited color dithering, and retro 16-bit game aesthetic.",
        brandCore: "Pixel art style with visible pixels and retro 16-bit aesthetic.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a pixel art portrait in a retro 16-bit video game style. Each subject should be immediately recognizable as the corresponding person in the original photo.",
            preserve,
            "Style: Crisp pixel art with a visible pixel grid, limited but vibrant color palette, and clean dithering for shading. The style should evoke classic 16-bit era video game character portraits -- detailed enough to capture the person's likeness while maintaining the charming pixelated aesthetic.",
            "Lighting: Simple, clean lighting appropriate for pixel art with defined highlight and shadow areas using distinct color steps.",
            composition,
            "Background: Solid color or simple pixel pattern, clean and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
};

const DEFAULT_STYLE = "cartoon";

const STYLE_LIST = Object.keys(STYLES);

function normalize(str) {
    return str.toLowerCase().replace(/[\s\-]+/g, "");
}

function parseStyle(body, activeStyles, defaultStyle) {
    const styles = activeStyles || STYLES;
    const keys = Object.keys(styles);
    const fallback = defaultStyle || DEFAULT_STYLE;
    const defaultKey = keys.includes(fallback) ? fallback : keys[0] || DEFAULT_STYLE;
    if (!body) return defaultKey;
    const normalized = normalize(body);
    // Exact match first (normalized)
    for (const key of keys) {
        if (normalized === normalize(key)) return key;
    }
    // Substring match (normalized)
    for (const key of keys) {
        if (normalized.includes(normalize(key))) return key;
    }
    return defaultKey;
}

function detectStyle(body, activeStyles) {
    if (!body) return null;
    const keys = Object.keys(activeStyles);
    const norm = normalize(body);
    for (const key of keys) {
        if (norm === normalize(key)) return key;
    }
    for (const key of keys) {
        if (norm.includes(normalize(key))) return key;
    }
    return null;
}

function getActiveStyles(disabledStyles, customStyles, stylePromptOverrides, preserveLine, compositionLine) {
    const preserve = preserveLine || DEFAULT_PRESERVE;
    const composition = compositionLine || DEFAULT_COMPOSITION;
    const active = {};
    for (const key of STYLE_LIST) {
        if (!disabledStyles || !disabledStyles.includes(key)) {
            const style = STYLES[key];
            const prompt = (stylePromptOverrides && stylePromptOverrides[key])
                ? stylePromptOverrides[key]
                : style.buildPrompt(preserve, composition);
            const core = (stylePromptOverrides && stylePromptOverrides[key + "_core"])
                ? stylePromptOverrides[key + "_core"]
                : style.core;
            const brandCore = (stylePromptOverrides && stylePromptOverrides[key + "_brandCore"])
                ? stylePromptOverrides[key + "_brandCore"]
                : style.brandCore;
            active[key] = { name: style.name, prompt, core, brandCore };
        }
    }
    if (customStyles) {
        for (const [key, style] of Object.entries(customStyles)) {
            if (!disabledStyles || !disabledStyles.includes(key)) {
                active[key] = style;
            }
        }
    }
    return active;
}

function getActiveStyleList(disabledStyles, customStyles, stylePromptOverrides) {
    return Object.keys(getActiveStyles(disabledStyles, customStyles, stylePromptOverrides));
}

module.exports = { STYLES, DEFAULT_STYLE, STYLE_LIST, DEFAULT_PRESERVE, DEFAULT_COMPOSITION, parseStyle, detectStyle, getActiveStyles, getActiveStyleList };
