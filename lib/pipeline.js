const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const fsp = fs.promises;
const { getOpenAI, formatTimestamp, getModels } = require("./config");
const { toFile } = require("openai");
const settings = require("./settings");
const { DEFAULT_STYLE } = require("./styles");
const { downloadImage, sendSms, moderateImage, detectPerson, analyzeScene, parseScene, compositeWithTemplate, prepareForPrint, withRetry } = require("./helpers");
const { checkPrinterReady, printImage } = require("./printer");
const paper = require("./paper");
const { trackApiCall } = require("./health");

// ── Reference image analysis (cached per style/brand/background) ────────────
// Sends reference images to a vision model with type-specific prompts.
// Returns a rich text description that the image generation model can follow.
// In-flight promise cache prevents duplicate API calls when concurrent jobs
// trigger analysis for the same resource.
const _analysisInFlight = new Map();

async function analyzeReferences(imageBuffers, type, cacheKey) {
    // Deduplicate: if another job is already analyzing the same resource, wait for it
    if (cacheKey && _analysisInFlight.has(cacheKey)) {
        console.log(`🔍 Analysis already in-flight for ${cacheKey}, waiting...`);
        return _analysisInFlight.get(cacheKey);
    }

    const promise = _runAnalysis(imageBuffers, type);
    if (cacheKey) {
        _analysisInFlight.set(cacheKey, promise);
        promise.finally(() => _analysisInFlight.delete(cacheKey));
    }
    return promise;
}

async function _runAnalysis(imageBuffers, type) {
    const prompts = {
        style: `Describe the art style of these reference images in ONE dense paragraph (max 150 words). Cover: rendering technique, line work, color palette (name specific colors), shading method, proportions/stylization level, texture, and mood. Be specific and technical — this will directly instruct an AI image generator to replicate the style. Do NOT use bullet points, headers, markdown, or multiple sections. Write only the style description, nothing else.`,
        brand: `Describe the clothing/outfit shown in these reference images in ONE dense paragraph (max 150 words). Cover: garment types, colors and placement, logos/graphics and their position, patterns, material appearance, fit/style, and accessories. Be specific and visual — this will directly instruct an AI to dress a person in this exact outfit. Do NOT use bullet points, headers, markdown, or multiple sections. Write only the outfit description, nothing else.`,
        background: `Describe the background/environment shown in these reference images in ONE dense paragraph (max 150 words). Cover: setting type, key visual elements, color scheme, lighting, depth/perspective, texture/style, and mood. Be specific and visual — this will directly instruct an AI to recreate this background. Do NOT use bullet points, headers, markdown, or multiple sections. Write only the background description, nothing else.`,
    };

    const imageContent = imageBuffers.map(buf => ({
        type: "input_image",
        image_url: `data:image/png;base64,${buf.toString("base64")}`,
        detail: "high",
    }));

    const start = Date.now();
    let response;
    try {
        response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().refAnalysis,
            input: [{
                role: "user",
                content: [
                    ...imageContent,
                    { type: "input_text", text: prompts[type] },
                ],
            }],
        }));
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        throw err;
    }
    trackApiCall("openai", true, Date.now() - start);
    return response.output_text.trim();
}

function jobPaths(job, { staged = false } = {}) {
    const { style, createdAt, filePrefix, eventName } = job;
    const activeStyles = settings.getActiveStyles();
    const styleKey = style && activeStyles[style] ? style : (settings.get("defaultStyle") || DEFAULT_STYLE);
    const prefix = filePrefix || formatTimestamp(createdAt || Date.now());
    const downloadDir = settings.getDownloadDir(eventName);
    const dir = staged ? path.join(downloadDir, ".staging") : downloadDir;
    if (staged && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const inputPath = path.join(dir, `${prefix}_input.jpg`);
    const outputPath = path.join(dir, `${prefix}_output.png`);
    const mmsPath = path.join(dir, `${prefix}_output_mms.jpg`);
    return { styleKey, prefix, inputPath, outputPath, mmsPath };
}

// Move staged files to the final downloads directory
async function moveStagedToFinal(job) {
    const staged = jobPaths(job, { staged: true });
    const final = jobPaths(job);
    for (const [src, dst] of [[staged.inputPath, final.inputPath], [staged.outputPath, final.outputPath], [staged.mmsPath, final.mmsPath]]) {
        if (fs.existsSync(src)) await fsp.rename(src, dst);
    }
}

// Delete staged files (on rejection)
async function cleanupStaged(job) {
    const staged = jobPaths(job, { staged: true });
    for (const f of [staged.inputPath, staged.outputPath, staged.mmsPath]) {
        try { await fsp.unlink(f); } catch {}
    }
}

// Steps 1-6: download, moderate, face detect, AI generate, composite, resize
async function generateImage(job) {
    const { imageUrl, userPhone, appPhone, eventName: ev } = job;
    const { styleKey, inputPath, outputPath, mmsPath } = jobPaths(job, { staged: true });
    const activeStyles = settings.getActiveStyles();
    const stylePrompt = activeStyles[styleKey].prompt;

    // Resolve brand references — from brand menu choice or event-level fallback
    let brandRefFiles;
    let brandPrompt;
    if (job.brand) {
        const customBrands = settings.getForEvent("customBrands", ev) || {};
        const brandDef = customBrands[job.brand];
        if (brandDef) {
            const bOverrides = settings.getForEvent("brandPromptOverrides", ev) || {};
            brandRefFiles = brandDef.files || [];
            brandPrompt = bOverrides[job.brand] || brandDef.wardrobe || brandDef.brandPrompt || settings.getForEvent("brandPrompt", ev);
        } else {
            // Brand was deleted after job was queued — fall back to event-level
            brandRefFiles = settings.getForEvent("brandReferenceFiles", ev) || [];
            brandPrompt = settings.getForEvent("brandPrompt", ev);
        }
    } else {
        brandRefFiles = settings.getForEvent("brandReferenceFiles", ev) || [];
        brandPrompt = settings.getForEvent("brandPrompt", ev);
    }

    // 1. Download input (skip if already downloaded from a previous attempt)
    if (!fs.existsSync(inputPath)) {
        console.log("⬇️  Downloading image...");
        await downloadImage(imageUrl, inputPath);
    }

    // 2. Content moderation
    console.log("🛡️  Running content moderation...");
    const imageBuffer = await fsp.readFile(inputPath);
    const base64Image = imageBuffer.toString("base64");
    const moderation = await moderateImage(base64Image);

    if (moderation.flagged) {
        console.log("🚫 Image flagged by moderation.", moderation.categories);
        await sendSms(
            userPhone,
            appPhone,
            settings.getMsg("moderationFail"),
        );
        await fsp.unlink(inputPath);
        const err = new Error("Image flagged by moderation.");
        err.permanent = true;
        err.failReason = "moderation";
        throw err;
    }

    // 3. Face detection + scene analysis (parallel — both are independent vision calls)
    // Cache scene analysis in the job so retries use the same prompt
    let sceneDescription;
    if (job.cachedScene !== undefined) {
        console.log("👤 Checking for face (reusing cached scene analysis)...");
        sceneDescription = job.cachedScene;
        const hasFace = await detectPerson(base64Image);
        if (!hasFace) {
            console.log("👤 No face detected in image.");
            await sendSms(userPhone, appPhone, settings.getMsg("noFace"));
            await fsp.unlink(inputPath);
            const err = new Error("No face detected in image.");
            err.permanent = true;
            err.failReason = "face_detection";
            throw err;
        }
    } else {
        console.log("👤 Checking for face + analyzing scene...");
        const [hasFace, freshScene] = await Promise.all([
            detectPerson(base64Image),
            analyzeScene(base64Image),
        ]);
        sceneDescription = freshScene;
        job.cachedScene = freshScene || "";

        if (!hasFace) {
            console.log("👤 No face detected in image.");
            await sendSms(userPhone, appPhone, settings.getMsg("noFace"));
            await fsp.unlink(inputPath);
            const err = new Error("No face detected in image.");
            err.permanent = true;
            err.failReason = "face_detection";
            throw err;
        }
    }

    // Parse scene analysis into structured data
    const scene = parseScene(sceneDescription);
    if (sceneDescription) {
        console.log(`👥 Scene: ${scene.subjects} subject(s), pets: ${scene.pets}, positions: ${scene.positions}`);
    }

    // Build scene instruction — always set, tells the model exactly what's in the photo
    let sceneLine = "";
    if (scene.subjects > 1 && scene.pets !== "none") {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects and a ${scene.pets}. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people and the ${scene.pets} — no more, no fewer.`;
    } else if (scene.subjects > 1) {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people — no more, no fewer.`;
    } else if (scene.pets !== "none") {
        sceneLine = `This photo has exactly 1 person and a ${scene.pets}. The ${scene.pets} is an animal, NOT a person — do not turn the ${scene.pets} into a human. The output must contain exactly 1 person and the ${scene.pets} — no other people.`;
    } else {
        sceneLine = "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.";
    }

    // Load brand reference images as buffers for Images API
    // brandRefFiles is already resolved above (from brand choice or event-level fallback)
    const brandRefBuffers = [];
    const BRAND_REFS_DIR = path.join(__dirname, "..", "brand-references");
    for (const filename of brandRefFiles) {
        const filePath = path.join(BRAND_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) {
            brandRefBuffers.push(await fsp.readFile(filePath));
        }
    }
    if (brandRefBuffers.length > 0) {
        console.log(`🎨 Including ${brandRefBuffers.length} brand reference image(s)${job.brand ? ` (brand: ${job.brand})` : " (event-level)"}`);
    }

    // Analyze brand references (cached — only runs once per brand)
    // customBrands is a global key, so safe to update regardless of event
    let brandAnalysis = "";
    if (brandRefBuffers.length > 0 && job.brand) {
        const customBrandsForAnalysis = settings.get("customBrands") || {};
        const brandObjForAnalysis = customBrandsForAnalysis[job.brand];
        if (brandObjForAnalysis) {
            brandAnalysis = brandObjForAnalysis.analysis || "";
            if (brandAnalysis.length > 500) { brandAnalysis = ""; }
            if (!brandAnalysis) {
                console.log("🔍 Analyzing brand reference images...");
                try {
                    brandAnalysis = await analyzeReferences(brandRefBuffers, "brand", `brand:${job.brand}`);
                } catch (err) {
                    console.error(`🔍 Brand analysis failed (proceeding without): ${err.message}`);
                }
                if (brandAnalysis) {
                    try {
                        brandObjForAnalysis.analysis = brandAnalysis;
                        settings.update({ customBrands: customBrandsForAnalysis });
                        console.log(`🔍 Brand analysis cached (${brandAnalysis.length} chars)`);
                    } catch (cacheErr) {
                        console.error(`🔍 Brand analysis caching failed (using analysis anyway): ${cacheErr.message}`);
                    }
                }
            }
        }
    }

    // Load style reference images as buffers (custom styles only)
    const styleObj = activeStyles[styleKey];
    const styleRefFiles = styleObj.files || [];
    const styleRefBuffers = [];
    for (const filename of styleRefFiles) {
        const filePath = path.join(settings.STYLE_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) {
            styleRefBuffers.push(await fsp.readFile(filePath));
        }
    }
    if (styleRefBuffers.length > 0) {
        console.log(`🖼️ Including ${styleRefBuffers.length} style reference image(s) for "${styleObj.name}"`);
    }

    // Analyze style references (cached — only runs once per style)
    // customStyles is per-event, so only cache if job event matches current event
    // Re-analyze if cached text is excessively long (stale from a previous verbose prompt)
    let styleAnalysis = styleObj.analysis || "";
    if (styleAnalysis.length > 500) { styleAnalysis = ""; }
    if (styleRefBuffers.length > 0 && !styleAnalysis) {
        console.log("🔍 Analyzing style reference images...");
        try {
            styleAnalysis = await analyzeReferences(styleRefBuffers, "style", `style:${ev}:${styleKey}`);
        } catch (err) {
            console.error(`🔍 Style analysis failed (proceeding without): ${err.message}`);
        }
        if (styleAnalysis && ev === settings.get("eventName")) {
            try {
                const customs = settings.get("customStyles") || {};
                if (customs[styleKey]) {
                    customs[styleKey].analysis = styleAnalysis;
                    settings.update({ customStyles: customs });
                }
                console.log(`🔍 Style analysis cached (${styleAnalysis.length} chars)`);
            } catch (cacheErr) {
                console.error(`🔍 Style analysis caching failed (using analysis anyway): ${cacheErr.message}`);
            }
        } else if (styleAnalysis) {
            console.log(`🔍 Style analysis complete but not cached (job event "${ev}" ≠ current event)`);
        }
    }

    // Build generation prompt — unified builder handles all combinations of style refs + brand refs
    const hasBrands = brandRefBuffers.length > 0;
    const hasStyleRefs = styleRefBuffers.length > 0;
    const isBuiltIn = !!styleObj.core;
    const preserve = settings.getForEvent("promptPreserve", ev);
    const preserveBrand = settings.getForEvent("promptPreserveBrand", ev);
    const brandInstruction = settings.getForEvent("promptBrandInstruction", ev);
    const composition = settings.getForEvent("promptComposition", ev);
    const parts = [];

    // ── Style direction ──
    if (hasStyleRefs && styleAnalysis) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: You MUST replicate this exact art style: ${styleAnalysis}\n\nThe input images named ${styleRefNames} are visual examples of this style. Study them and the description above. The output MUST look like it was created by the same artist using the same tools. Do NOT default to a generic style. ${stylePrompt}`);
    } else if (hasStyleRefs) {
        // Fallback: analysis unavailable, use filename-based approach
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: The input images named ${styleRefNames} show the exact art style to replicate. Study them carefully and match the rendering technique, line work, color palette, shading, proportions, and mood. Do NOT default to a generic style. ${stylePrompt}`);
    } else {
        parts.push(stylePrompt);
    }

    // ── Preserve & composition for custom styles ──
    // Built-in styles bake preserve + composition into their prompt via buildPrompt().
    // Custom styles are freeform text, so we append these explicitly.
    if (!isBuiltIn) {
        if (preserve) parts.push(preserve);
        if (composition) parts.push(composition);
    }

    // ── Scene instruction ──
    if (sceneLine) parts.push(sceneLine);

    // ── Brand / clothing direction (additive) ──
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
        // Fallback: no analysis available, use original brand prompt logic
        const refWord = brandRefBuffers.length > 1 ? "s" : "";
        if (scene.subjects > 1) {
            const petNote = scene.pets !== "none"
                ? ` Include the ${scene.pets} naturally without branded clothing.`
                : "";
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            const petNote = scene.pets !== "none"
                ? ` Include the ${scene.pets} naturally in the image.`
                : "";
            parts.push(`Clothing: Dress the subject in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else {
        if (brandPrompt) {
            parts.push(`Apply the following to ALL subjects in the image: ${brandPrompt}`);
        }
    }

    // ── Style + brand disambiguation ──
    if (hasStyleRefs && hasBrands) {
        parts.push("REMINDER: The art style described above takes ABSOLUTE priority. The brand/clothing references are ONLY for the outfit — do NOT let them influence the rendering style, line work, colors, or visual aesthetic.");
    }

    // ── Combo fragments (behavior-based container, brand color palette) ──
    // Additive: existing brand-wardrobe + style direction above remain intact.
    // These append themed-container description and optional brand palette override.
    const { buildComboFragments } = require("./prompt-assembler");
    const customBrandsForCombo = job.brand ? (settings.getForEvent("customBrands", ev) || {}) : {};
    const brandForCombo = job.brand ? customBrandsForCombo[job.brand] : null;
    const comboFragments = buildComboFragments({
        style: styleObj,
        brand: brandForCombo,
        background: null,
    });
    if (comboFragments.containerDescription) {
        parts.push(comboFragments.containerDescription);
    }

    let fullPrompt = parts.join("\n");

    // Background instruction — from user choice (job.background) or admin default
    const bgChoices = settings.getForEvent("backgroundChoices", ev) || [];
    let bgChoice = job.background && bgChoices.find(c => c.key === job.background);
    // Fallback: combo-resolved menu keys (brand scenes, synthesized original/plain-white)
    // don't live in settings.backgroundChoices — re-derive from the style + brand combo.
    if (job.background && !bgChoice) {
        const { resolveBackgroundMenu } = require("./prompt-assembler");
        const resolved = resolveBackgroundMenu(styleObj, brandForCombo);
        bgChoice = resolved.find(c => c.key === job.background) || null;
    }
    const bgRefFiles = bgChoice ? (bgChoice.files || []) : [];
    const bgMode = bgChoice ? (bgChoice.mode || "ai") : "ai";
    const bgRefBuffers = [];
    for (const filename of bgRefFiles) {
        const filePath = path.join(settings.BG_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) bgRefBuffers.push(await fsp.readFile(filePath));
    }
    if (bgRefBuffers.length > 0) {
        console.log(`🖼️ Including ${bgRefBuffers.length} background reference image(s) (mode: ${bgMode})`);
    }

    // Analyze background references (cached — only runs once per bg choice)
    // backgroundChoices is per-event, so only cache if job event matches current event
    let bgAnalysis = "";
    if (bgRefBuffers.length > 0 && bgMode === "ai" && bgChoice) {
        bgAnalysis = bgChoice.analysis || "";
        if (bgAnalysis.length > 500) { bgAnalysis = ""; }
        if (!bgAnalysis) {
            console.log("🔍 Analyzing background reference images...");
            try {
                bgAnalysis = await analyzeReferences(bgRefBuffers, "background", `bg:${ev}:${bgChoice.key}`);
            } catch (err) {
                console.error(`🔍 Background analysis failed (proceeding without): ${err.message}`);
            }
            if (bgAnalysis && ev === settings.get("eventName")) {
                try {
                    const allBgChoices = settings.get("backgroundChoices") || [];
                    const idx = allBgChoices.findIndex(c => c.key === bgChoice.key);
                    if (idx !== -1) {
                        allBgChoices[idx].analysis = bgAnalysis;
                        settings.update({ backgroundChoices: allBgChoices });
                    }
                    console.log(`🔍 Background analysis cached (${bgAnalysis.length} chars)`);
                } catch (cacheErr) {
                    console.error(`🔍 Background analysis caching failed (using analysis anyway): ${cacheErr.message}`);
                }
            } else if (bgAnalysis) {
                console.log(`🔍 Background analysis complete but not cached (job event "${ev}" ≠ current event)`);
            }
        }
    }

    if (bgMode === "ai" && bgRefBuffers.length > 0 && bgAnalysis) {
        const bgRefNames = bgRefBuffers.map((_, i) => `bg_ref_${i}.png`).join(", ");
        const extraPrompt = bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Recreate this exact background: ${bgAnalysis}\n\nThe input images named ${bgRefNames} show the background visually.${extraPrompt}`;
    } else if (bgMode === "ai" && bgRefBuffers.length > 0) {
        // Fallback: no analysis available
        const bgRefWord = bgRefBuffers.length > 1 ? "images" : "image";
        const extraPrompt = bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Match the background shown in the reference ${bgRefWord}.${extraPrompt}`;
    } else if (bgMode === "exact" && bgRefBuffers.length > 0) {
        fullPrompt += "\nBackground: Generate the subject on a plain solid-color background with no environment details. The background will be replaced in post-processing.";
    } else if (bgChoice && bgChoice.prompt) {
        // User explicitly chose a background from the menu — always apply it
        fullPrompt += "\n" + bgChoice.prompt;
    } else {
        // No explicit choice — apply default background prompt UNLESS the style already
        // has its own background instructions (e.g. "Background: dark studio setting")
        const styleHasBgInstruction = stylePrompt && /background\s*[:—–-]/im.test(stylePrompt);
        const backgroundLine = settings.getForEvent("promptBackground", ev);
        if (backgroundLine && !styleHasBgInstruction) fullPrompt += "\n" + backgroundLine;
    }

    // ── Color palette override (applies last, acts as global recolor filter) ──
    if (comboFragments.colorPalette) {
        fullPrompt += "\n" + comboFragments.colorPalette;
    }

    // Multi-subject handling (configurable per event)
    if (scene.subjects > 1) {
        const multiMode = settings.getForEvent("multiSubjectMode", ev) || "reject";

        if (multiMode === "reject") {
            console.log("🚫 Multi-subject rejected (mode: reject)");
            job.detectedSubjects = scene.subjects;
            await sendSms(userPhone, appPhone, settings.getMsg("multiSubjectReject"));
            await fsp.unlink(inputPath);
            const err = new Error("Multi-subject photo rejected by event config.");
            err.permanent = true;
            err.failReason = "multi_subject";
            throw err;
        }

        if (multiMode === "caricature") {
            console.log("🎭 Multi-subject: applying caricature mode");
            fullPrompt += "\n\nIMPORTANT: This has multiple people. Transform each person into a WILDLY EXAGGERATED CARICATURE — giant heads on tiny bodies, comically oversized eyes, enormous grins, bobblehead proportions. Push the abstraction as far as possible while keeping each person vaguely identifiable by their most obvious trait (hair color, glasses, beard, etc.). This should look like a theme-park caricature artist on overdrive — NOT a realistic portrait. Prioritize humor, energy, and bold graphic style over any attempt at photographic likeness. Do NOT try to make the faces look realistic.";
        }
    }

    // Append admin review feedback (from Reject + Re-analyze with instructions)
    // When feedback is present, it takes priority — skip the rigid FINAL REMINDER
    // so the reviewer's instructions aren't contradicted by automated scene counting.
    const hasReviewFeedback = !!job.reviewFeedback;
    if (hasReviewFeedback) {
        fullPrompt += "\n\nIMPORTANT — Override from reviewer (this takes priority over any earlier subject-count instructions): " + job.reviewFeedback;
        delete job.reviewFeedback;
    }

    // Final reinforcement — repeat subject count at the very end of the prompt
    // Skip when reviewer feedback is present, since it may intentionally override the count
    if (!hasReviewFeedback) {
        if (scene.subjects === 1 && scene.pets === "none") {
            fullPrompt += "\n\nFINAL REMINDER: Exactly 1 human in the output. No other people. Anything else visible (objects, posters, screens, reflections, background figures) must NOT become a person.";
        } else if (scene.subjects === 1 && scene.pets !== "none") {
            fullPrompt += `\n\nFINAL REMINDER: Exactly 1 human and 1 ${scene.pets} in the output. The ${scene.pets} is an animal — do NOT turn it into a person. No other people.`;
        } else if (scene.subjects > 1) {
            fullPrompt += `\n\nFINAL REMINDER: Exactly ${scene.subjects} humans in the output — no more, no fewer.`;
        }
    }

    // Save prompt to job so AI review can understand what was requested
    job.generationPrompt = fullPrompt;

    console.log(`📝 Prompt (direct to ${getModels().imageGen}):\n${fullPrompt}`);

    // 4. Generate image via Images API edit endpoint (prompt goes directly to image model)
    if (!fs.existsSync(outputPath)) {
        console.log(`🎨 Generating ${activeStyles[styleKey].name} image...`);
        const selfieBuffer = await fsp.readFile(inputPath);
        const imageFiles = await Promise.all([
            toFile(selfieBuffer, "selfie.jpg", { type: "image/jpeg" }),
            ...styleRefBuffers.map((buf, i) => toFile(buf, `style_ref_${i}.png`, { type: "image/png" })),
            ...brandRefBuffers.map((buf, i) => toFile(buf, `brand_ref_${i}.png`, { type: "image/png" })),
            ...(bgMode === "ai" ? bgRefBuffers : []).map((buf, i) => toFile(buf, `bg_ref_${i}.png`, { type: "image/png" })),
        ]);

        const genStart = Date.now();
        const imageModel = getModels().imageGen;
        const editParams = {
            model: imageModel,
            image: imageFiles,
            prompt: fullPrompt,
            size: "1024x1536",
            quality: "high",
            background: (bgMode === "exact" && bgRefBuffers.length > 0) ? "transparent" : "opaque",
        };
        // input_fidelity is only supported by gpt-image-1.5; gpt-image-2 rejects it.
        if (imageModel.startsWith("gpt-image-1")) {
            editParams.input_fidelity = "high";
        }
        let result;
        try {
            result = await withRetry(() => getOpenAI().images.edit(editParams));
            trackApiCall("openai", true, Date.now() - genStart);
        } catch (genErr) {
            trackApiCall("openai", false, Date.now() - genStart);
            throw genErr;
        }

        const imageData = result.data[0];
        if (!imageData || !imageData.b64_json) {
            console.log("🔍 Debug:", JSON.stringify(result, null, 2));
            throw new Error("No image generated in response.");
        }

        console.log("💾 Saving generated image...");
        await fsp.writeFile(outputPath, Buffer.from(imageData.b64_json, "base64"));

        // 4b. Exact background compositing — layer transparent portrait on uploaded background
        if (bgMode === "exact" && bgRefBuffers.length > 0) {
            try {
                console.log("🖼️  Compositing portrait onto exact background image...");
                const { width: pw, height: ph } = settings.getPrintDimensions();
                const resizedBg = await sharp(bgRefBuffers[0])
                    .resize(pw, ph, { fit: "cover" })
                    .png()
                    .toBuffer();
                const portraitBuf = await sharp(outputPath)
                    .resize(pw, ph, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .png()
                    .toBuffer();
                await sharp(resizedBg)
                    .composite([{ input: portraitBuf, gravity: "center" }])
                    .png()
                    .toFile(outputPath + ".tmp");
                fs.renameSync(outputPath + ".tmp", outputPath);
                console.log("🖼️  Exact background applied.");
            } catch (bgErr) {
                console.error(`🖼️  Exact background compositing failed (using portrait as-is): ${bgErr.message}`);
                try { fs.unlinkSync(outputPath + ".tmp"); } catch (_) {}
            }
        }

        // 5. Apply template frame (composites in-place onto the output file)
        console.log("🖼️  Applying template frame...");
        await compositeWithTemplate(outputPath);

        // 6. Resize to print dimensions (5x7 @ 300 DPI)
        console.log("📐 Preparing image for print...");
        await prepareForPrint(outputPath);
    }

    // 7. Create compressed version for MMS (skip if already exists from a previous attempt)
    if (!fs.existsSync(mmsPath)) {
        console.log("📱 Creating MMS image...");
        await sharp(outputPath)
            .resize(800, null, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(mmsPath);
    }
}

// Steps 7-8: check printer, print
async function printJob(job, printerName) {
    const { outputPath } = jobPaths(job);

    if (!printerName) {
        console.log("🖨️  Checking printer status...");
        printerName = await checkPrinterReady();
    }

    await printImage(outputPath, printerName);
    paper.decrement();
}

// ── AI Review ──────────────────────────────────────────────────────────────

function buildAiReviewPrompt(checks, hasBrandRefs, generationPrompt) {
    const criteria = [];
    let n = 1;
    if (checks.likeness !== false) criteria.push(`${n++}. Subject likeness — the person(s) in the portrait must be recognizable as the same person(s) from the original, accounting for the requested art style. Key features to check: face shape, skin tone, eye color, hair color/style.`);
    if (checks.subjectCount !== false) criteria.push(`${n++}. Subject count — the portrait must contain the same number of PRIMARY subjects as the original photo. Minor background figures, crowds, or partially visible people in the background do NOT count as added subjects. Only fail if a completely new prominent foreground person was added or a primary subject was removed.`);
    if (checks.gender !== false) criteria.push(`${n++}. Gender accuracy — each primary subject's apparent gender must be preserved. No gender swaps.`);
    if (checks.branding !== false && hasBrandRefs) criteria.push(`${n++}. Branding & logos — images 3+ are brand reference images. Clothing, logos, and text on clothing in the portrait should match those references (not the original selfie's clothing).`);
    if (checks.accessories !== false) criteria.push(`${n++}. Key accessories — glasses and distinctive facial hair from the original should be preserved (not removed entirely). Style changes, color shifts, and artistic reinterpretation of accessories are perfectly fine. Only fail if signature accessories like glasses were completely removed.`);
    if (checks.anatomy !== false) criteria.push(`${n++}. Anatomical quality — no SEVERE anomalies like extra limbs, merged faces, or badly distorted facial features. Minor hand/finger imperfections, slightly awkward object interactions, and small proportional oddities are acceptable — only fail if the anatomy is clearly broken and distracting at a glance.`);

    const promptContext = generationPrompt
        ? `\nThe portrait was generated using this prompt:\n---\n${generationPrompt}\n---\n\nThe prompt INTENTIONALLY requests style changes, clothing changes, and/or background changes. These are NOT errors — they are the goal. Your job is to catch genuine quality problems, not penalize intentional transformations.\n`
        : "";

    return `You are a quality-control reviewer for AI-generated portraits.

Image 1 is the original selfie (the input photo).
Image 2 is the AI-generated portrait (the output).
${hasBrandRefs ? "Images 3+ are brand reference images showing what clothing/logos should look like.\n" : ""}${promptContext}
IMPORTANT: The output image has a decorative border/frame overlay applied AFTER generation. Any text, logos, or branding visible in the border area (edges of the image) is part of the template frame — NOT generated by the AI. Ignore all content in the border/frame area when reviewing.

Evaluate the portrait against these criteria:
${criteria.join("\n")}

Be generous — this is stylized AI art meant to be fun, not photo restoration. The bar is "would the subject be happy to receive this?" Only FAIL for issues that are clearly unacceptable: wrong person, wrong gender, a primary subject added/removed, or severely broken anatomy that is immediately jarring. When in doubt, PASS.

Respond with EXACTLY one of:
- PASS (if acceptable or borderline quality)
- FAIL: followed by which criteria failed and a brief explanation`;
}

async function aiReviewImage(job) {
    const ev = job.eventName;
    const reviewChecks = settings.getForEvent("aiReviewChecks", ev) || {};

    // If every check is disabled, skip the API call entirely — auto-pass
    const hasAnyCheck = Object.values(reviewChecks).some(v => v !== false);
    if (!hasAnyCheck) return { passed: true, reason: "PASS (all checks disabled)" };

    const { inputPath, outputPath } = jobPaths(job, { staged: true });

    const inputB64 = (await fsp.readFile(inputPath)).toString("base64");
    const outputB64 = (await fsp.readFile(outputPath)).toString("base64");

    const images = [
        { type: "input_image", image_url: `data:image/jpeg;base64,${inputB64}`, detail: "high" },
        { type: "input_image", image_url: `data:image/png;base64,${outputB64}`, detail: "high" },
    ];

    // Include brand refs for branding check (same resolution logic as generateImage)
    let hasBrandRefs = false;
    if (reviewChecks.branding !== false) {
        let brandRefFiles;
        if (job.brand) {
            const customBrands = settings.getForEvent("customBrands", ev) || {};
            const brandDef = customBrands[job.brand];
            brandRefFiles = brandDef ? (brandDef.files || []) : (settings.getForEvent("brandReferenceFiles", ev) || []);
        } else {
            brandRefFiles = settings.getForEvent("brandReferenceFiles", ev) || [];
        }
        const BRAND_REFS_DIR = path.join(__dirname, "..", "brand-references");
        for (const filename of brandRefFiles) {
            const filePath = path.join(BRAND_REFS_DIR, filename);
            if (fs.existsSync(filePath)) {
                const buf = await fsp.readFile(filePath);
                images.push({ type: "input_image", image_url: `data:image/png;base64,${buf.toString("base64")}`, detail: "low" });
                hasBrandRefs = true;
            }
        }
    }

    const prompt = buildAiReviewPrompt(reviewChecks, hasBrandRefs, job.generationPrompt);

    const reviewStart = Date.now();
    let response;
    try {
        response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().orchestrator,
            input: [{ role: "user", content: [...images, { type: "input_text", text: prompt }] }],
        }));
        trackApiCall("openai", true, Date.now() - reviewStart);
    } catch (reviewErr) {
        trackApiCall("openai", false, Date.now() - reviewStart);
        throw reviewErr;
    }

    const text = response.output_text || "";
    const passed = text.trim().toUpperCase().startsWith("PASS");
    return { passed, reason: text.trim() };
}

module.exports = { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage };
