const PRESERVE_LINE =
    "Preserve accurately: skin tone, eye color, hair color, hairstyle, facial hair, glasses, jewelry, clothing, and any visible accessories or distinguishing features.";

const COMPOSITION_LINE =
    "Composition: Portrait framing from the chest up, with the character centered and looking toward the camera.";

const STYLES = {
    cartoon: {
        name: "cartoon",
        prompt: [
            "Transform this photo into a 3D cartoon caricature in the style of a modern animated film. The character should be a stylized cartoon version of the exact person in the photo.",
            PRESERVE_LINE + " The cartoon should be immediately recognizable as this specific person.",
            "Style: Soft, smooth 3D render with slightly exaggerated proportions -- a larger head relative to the body, big expressive eyes, and soft rounded facial features. Use warm, vibrant colors with rich saturation. Apply soft subsurface scattering on skin for a polished, high-quality look.",
            "Lighting: Cinematic three-point lighting with a warm key light, soft fill, and subtle rim light to separate the character from the background.",
            COMPOSITION_LINE.replace("character", "character") + " Give them a warm, friendly expression.",
            "Background: Clean soft gradient background, light and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
    "pop-art": {
        name: "pop art",
        prompt: [
            "Transform this photo into a bold pop art portrait in the style of Andy Warhol and Roy Lichtenstein. The artwork should be immediately recognizable as this specific person.",
            PRESERVE_LINE,
            "Style: Bold black outlines, flat vibrant colors with high saturation, and Ben-Day dots or halftone patterns for shading. Use a limited but striking color palette with strong contrast. The overall look should feel like a hand-pulled screen print or comic-book panel.",
            "Lighting: Flat, graphic lighting with strong shadows rendered as solid color blocks.",
            COMPOSITION_LINE,
            "Background: Solid bright color block, clean and high-contrast, suitable for printing.",
        ].join("\n\n"),
    },
    watercolor: {
        name: "watercolor",
        prompt: [
            "Transform this photo into a beautiful watercolor painting portrait. The painting should be immediately recognizable as this specific person.",
            PRESERVE_LINE,
            "Style: Soft, flowing watercolor washes with visible brush strokes and natural paint bleeding at edges. Use a luminous, translucent color palette with gentle gradients. Allow some areas of white paper to show through for a natural watercolor feel. The painting should look like a professional watercolor portrait by a skilled artist.",
            "Lighting: Soft, diffused natural lighting with gentle shadows built through layered washes.",
            COMPOSITION_LINE,
            "Background: Light watercolor wash with soft color bleeds, minimal and airy, suitable for printing.",
        ].join("\n\n"),
    },
    anime: {
        name: "anime",
        prompt: [
            "Transform this photo into a Japanese anime-style character portrait. The character should be immediately recognizable as this specific person.",
            PRESERVE_LINE,
            "Style: Clean anime illustration with bold outlines, smooth cel-shaded coloring, and large expressive eyes. Use vibrant colors with clean flat shading and subtle highlights. The style should resemble a high-quality modern anime or manga illustration.",
            "Lighting: Bright, clean anime-style lighting with defined shadows and crisp highlights.",
            COMPOSITION_LINE + " Give them an expressive, confident pose.",
            "Background: Soft gradient or subtle abstract pattern, clean and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
    sketch: {
        name: "sketch",
        prompt: [
            "Transform this photo into a detailed pencil sketch portrait. The drawing should be immediately recognizable as this specific person.",
            PRESERVE_LINE.replace("skin tone, eye color, ", "") + " Capture their likeness through precise linework and shading.",
            "Style: Realistic graphite pencil drawing on white paper with fine cross-hatching and careful tonal shading. Use a full range of values from light to dark for depth and dimension. Show visible pencil strokes and paper texture. The drawing should look like a professional hand-drawn portrait by a skilled artist.",
            "Lighting: Strong directional lighting that creates clear highlights and shadows to define the face and features.",
            COMPOSITION_LINE,
            "Background: Clean white or very light paper texture, minimal and uncluttered, suitable for printing.",
        ].join("\n\n"),
    },
    "pixel-art": {
        name: "pixel art",
        prompt: [
            "Transform this photo into a pixel art portrait in a retro 16-bit video game style. The character should be immediately recognizable as this specific person.",
            PRESERVE_LINE,
            "Style: Crisp pixel art with a visible pixel grid, limited but vibrant color palette, and clean dithering for shading. The style should evoke classic 16-bit era video game character portraits -- detailed enough to capture the person's likeness while maintaining the charming pixelated aesthetic.",
            "Lighting: Simple, clean lighting appropriate for pixel art with defined highlight and shadow areas using distinct color steps.",
            COMPOSITION_LINE,
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

function getActiveStyles(disabledStyles, customStyles, stylePromptOverrides) {
    const active = {};
    for (const key of STYLE_LIST) {
        if (!disabledStyles || !disabledStyles.includes(key)) {
            if (stylePromptOverrides && stylePromptOverrides[key]) {
                active[key] = { ...STYLES[key], prompt: stylePromptOverrides[key] };
            } else {
                active[key] = STYLES[key];
            }
        }
    }
    if (customStyles) {
        for (const [key, style] of Object.entries(customStyles)) {
            active[key] = style;
        }
    }
    return active;
}

function getActiveStyleList(disabledStyles, customStyles, stylePromptOverrides) {
    return Object.keys(getActiveStyles(disabledStyles, customStyles, stylePromptOverrides));
}

module.exports = { STYLES, DEFAULT_STYLE, STYLE_LIST, parseStyle, detectStyle, getActiveStyles, getActiveStyleList };
