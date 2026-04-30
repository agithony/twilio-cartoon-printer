// lib/prompt-builder.js
// Pure prompt-assembly function extracted from pipeline.js.
// No I/O, no settings reads, no caching.
// See docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md

const { STYLES } = require("./styles");
const { buildComboFragments } = require("./prompt-assembler");

function build(input) {
    const {
        styleKey, styleObj, stylePrompt,
        brandObj, brandAnalysis, brandPrompt, brandRefBuffers = [],
        styleAnalysis, styleRefBuffers = [],
        bgChoice, bgMode = "ai", bgAnalysis, bgRefBuffers = [],
        scene, sceneLine,
        preserve, preserveBrand, brandInstruction, composition, backgroundLine,
        multiSubjectMode, reviewFeedback,
    } = input;

    const isBuiltIn = !!STYLES[styleKey];
    const hasBrands = brandRefBuffers.length > 0;
    const hasStyleRefs = styleRefBuffers.length > 0;
    const parts = [];

    if (hasStyleRefs && styleAnalysis) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: You MUST replicate this exact art style: ${styleAnalysis}\n\nThe input images named ${styleRefNames} are visual examples of this style. Study them and the description above. The output MUST look like it was created by the same artist using the same tools. Do NOT default to a generic style. ${stylePrompt}`);
    } else if (hasStyleRefs) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: The input images named ${styleRefNames} show the exact art style to replicate. Study them carefully and match the rendering technique, line work, color palette, shading, proportions, and mood. Do NOT default to a generic style. ${stylePrompt}`);
    } else {
        parts.push(stylePrompt);
    }

    if (!isBuiltIn) {
        if (preserve) parts.push(preserve);
        if (composition) parts.push(composition);
    }

    if (sceneLine) parts.push(sceneLine);

    if (hasBrands && brandAnalysis) {
        const brandRefNames = brandRefBuffers.map((_, i) => `brand_ref_${i}.png`).join(", ");
        const petNote = scene.pets !== "none"
            ? (scene.subjects > 1 ? ` Include the ${scene.pets} naturally without branded clothing.` : ` Include the ${scene.pets} naturally in the image.`)
            : "";
        if (scene.subjects > 1) {
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in this exact outfit: ${brandAnalysis}\n\nThe input images named ${brandRefNames} show the outfit visually.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            parts.push(`Clothing: Dress the subject in this exact outfit: ${brandAnalysis}\n\nThe input images named ${brandRefNames} show the outfit visually.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else if (hasBrands) {
        const refWord = brandRefBuffers.length > 1 ? "s" : "";
        if (scene.subjects > 1) {
            const petNote = scene.pets !== "none" ? ` Include the ${scene.pets} naturally without branded clothing.` : "";
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            const petNote = scene.pets !== "none" ? ` Include the ${scene.pets} naturally in the image.` : "";
            parts.push(`Clothing: Dress the subject in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else {
        if (brandPrompt) parts.push(`Apply the following to ALL subjects in the image: ${brandPrompt}`);
    }

    if (hasBrands) {
        parts.push("REMINDER: The art style described above takes ABSOLUTE priority. The brand/clothing references are ONLY for the outfit — do NOT let them influence the rendering style, line work, colors, or visual aesthetic.");
    }

    const comboFragments = buildComboFragments({ style: styleObj, brand: brandObj, background: null });
    if (comboFragments.containerDescription) parts.push(comboFragments.containerDescription);

    let fullPrompt = parts.join("\n");

    if (bgMode === "ai" && bgRefBuffers.length > 0 && bgAnalysis) {
        const bgRefNames = bgRefBuffers.map((_, i) => `bg_ref_${i}.png`).join(", ");
        const extraPrompt = bgChoice && bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Recreate this exact background: ${bgAnalysis}\n\nThe input images named ${bgRefNames} show the background visually.${extraPrompt}`;
    } else if (bgMode === "ai" && bgRefBuffers.length > 0) {
        const bgRefWord = bgRefBuffers.length > 1 ? "images" : "image";
        const extraPrompt = bgChoice && bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Match the background shown in the reference ${bgRefWord}.${extraPrompt}`;
    } else if (bgMode === "exact" && bgRefBuffers.length > 0) {
        fullPrompt += "\nBackground: Fill the entire area around the subject with a flat, solid, pure magenta color — hex #FF00FF, RGB (255, 0, 255). The magenta must go edge-to-edge in every direction around the subject with no shading, gradient, texture, environment, floor, shadow, or vignette. Do not use any other shade of pink, purple, or violet — only pure #FF00FF. This magenta is a chroma-key fill that will be removed in post-processing and replaced with the actual background image, so it must be uniform and uninterrupted. Do not include magenta anywhere on the subject's body, clothing, hair, or accessories — magenta only appears in the background.";
    } else if (bgChoice && bgChoice.prompt) {
        fullPrompt += "\n" + bgChoice.prompt;
    } else {
        const styleHasBgInstruction = stylePrompt && /background\s*[:—–-]/im.test(stylePrompt);
        if (backgroundLine && !styleHasBgInstruction) fullPrompt += "\n" + backgroundLine;
    }

    if (comboFragments.colorPalette) fullPrompt += "\n" + comboFragments.colorPalette;

    if (scene.subjects > 1 && multiSubjectMode === "caricature") {
        fullPrompt += "\n\nIMPORTANT: This has multiple people. Transform each person into a WILDLY EXAGGERATED CARICATURE — giant heads on tiny bodies, comically oversized eyes, enormous grins, bobblehead proportions. Push the abstraction as far as possible while keeping each person vaguely identifiable by their most obvious trait (hair color, glasses, beard, etc.). This should look like a theme-park caricature artist on overdrive — NOT a realistic portrait. Prioritize humor, energy, and bold graphic style over any attempt at photographic likeness. Do NOT try to make the faces look realistic.";
    }

    const hasReviewFeedback = !!reviewFeedback;
    if (hasReviewFeedback) {
        fullPrompt += "\n\nIMPORTANT — Override from reviewer (this takes priority over any earlier subject-count instructions): " + reviewFeedback;
    }

    // Emit style lock whenever any brand content is present (refs OR wardrobe text).
    // Brand-style text like "professional Chelsea FC player ... photorealistic detail"
    // fights with stylized rendering (Pixar, sketch, etc.) and the model tends to
    // average the two — yielding "realistic Pixar." The lock pins the art style.
    const hasBrandContent = hasBrands || !!brandPrompt;
    if (!hasReviewFeedback && hasBrandContent) {
        const styleLock = styleObj.brandCore || styleObj.core || `${styleObj.name || "the selected"} art style`;
        fullPrompt += `\n\nFINAL STYLE LOCK: Render the entire output in this exact art style: ${styleLock} The clothing and background descriptions above describe subject matter, not rendering technique — they must not override the chosen art style.`;
    }

    if (!hasReviewFeedback) {
        if (scene.subjects === 1 && scene.pets === "none") {
            fullPrompt += "\n\nFINAL REMINDER: Exactly 1 human in the output. No other people. Anything else visible (objects, posters, screens, reflections, background figures) must NOT become a person.";
        } else if (scene.subjects === 1 && scene.pets !== "none") {
            fullPrompt += `\n\nFINAL REMINDER: Exactly 1 human and 1 ${scene.pets} in the output. The ${scene.pets} is an animal — do NOT turn it into a person. No other people.`;
        } else if (scene.subjects > 1) {
            fullPrompt += `\n\nFINAL REMINDER: Exactly ${scene.subjects} humans in the output — no more, no fewer.`;
        }
    }

    return fullPrompt;
}

module.exports = { build };
