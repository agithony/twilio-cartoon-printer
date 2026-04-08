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
            brandPrompt = bOverrides[job.brand] || brandDef.brandPrompt || settings.getForEvent("brandPrompt", ev);
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
    if (hasStyleRefs) {
        const styleRefWord = styleRefBuffers.length > 1 ? "images" : "image";
        parts.push(`CRITICAL — Art style: You MUST replicate the exact visual style shown in the style reference ${styleRefWord}. Study ${styleRefWord === "image" ? "it" : "them"} carefully and match: the rendering technique (vector, painted, sketch, 3D, etc.), line weight and edge treatment, color palette and saturation levels, shading style (flat, cel-shaded, gradient, textured), proportions and level of stylization, and overall mood/aesthetic. The output should look like it was created by the same artist using the same tools. Do NOT default to a generic cartoon or illustration style — the reference ${styleRefWord} ${styleRefWord === "image" ? "is" : "are"} your ground truth. ${stylePrompt}`);
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
    if (hasBrands) {
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

    let fullPrompt = parts.join("\n");

    // Background instruction — from user choice (job.background) or admin default
    const bgChoices = settings.getForEvent("backgroundChoices", ev) || [];
    const bgChoice = job.background && bgChoices.find(c => c.key === job.background);
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

    if (bgMode === "ai" && bgRefBuffers.length > 0) {
        const bgRefWord = bgRefBuffers.length > 1 ? "images" : "image";
        const extraPrompt = bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Match the background shown in the reference ${bgRefWord}.${extraPrompt}`;
    } else if (bgMode === "exact" && bgRefBuffers.length > 0) {
        fullPrompt += "\nBackground: Generate the subject on a plain solid-color background with no environment details. The background will be replaced in post-processing.";
    } else {
        const backgroundLine = bgChoice ? bgChoice.prompt : settings.getForEvent("promptBackground", ev);
        if (backgroundLine) fullPrompt += "\n" + backgroundLine;
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
        let result;
        try {
            result = await withRetry(() => getOpenAI().images.edit({
                model: getModels().imageGen,
                image: imageFiles,
                prompt: fullPrompt,
                size: "1024x1536",
                quality: "high",
                input_fidelity: "high",
                background: (bgMode === "exact" && bgRefBuffers.length > 0) ? "transparent" : "opaque",
            }));
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
