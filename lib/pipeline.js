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
const promptBuilder = require("./prompt-builder");
const { compositeExactBackground } = require("./bg-composite");

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
    const multiIdentityLine = " Each person has DISTINCT facial features, hair, and build — do NOT merge, swap, or blend their features. Each person must remain visually distinct from the others and recognizable as themselves.";
    if (scene.subjects > 1 && scene.pets !== "none") {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects and a ${scene.pets}. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people and the ${scene.pets} — no more, no fewer.${multiIdentityLine}`;
    } else if (scene.subjects > 1) {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people — no more, no fewer.${multiIdentityLine}`;
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

    // Resolve the background choice for this job (matches previous in-place logic)
    const bgChoices = settings.getForEvent("backgroundChoices", ev) || [];
    let bgChoice = job.background && bgChoices.find(c => c.key === job.background);
    if (job.background && !bgChoice) {
        const { resolveBackgroundMenu } = require("./prompt-assembler");
        const customBrandsForBg = settings.getForEvent("customBrands", ev) || {};
        const brandForBg = job.brand ? customBrandsForBg[job.brand] : null;
        const resolved = resolveBackgroundMenu(styleObj, brandForBg);
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

    // Cached vision analysis of the chosen background reference images
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

    // Delegate prompt assembly to the pure builder
    const customBrandsForCombo = job.brand ? (settings.getForEvent("customBrands", ev) || {}) : {};
    const brandForCombo = job.brand ? customBrandsForCombo[job.brand] : null;
    const preserve = settings.getForEvent("promptPreserve", ev);
    const preserveBrand = settings.getForEvent("promptPreserveBrand", ev);
    const brandInstruction = settings.getForEvent("promptBrandInstruction", ev);
    const composition = settings.getForEvent("promptComposition", ev);
    const fullPrompt = promptBuilder.build({
        styleKey, styleObj, stylePrompt,
        brandKey: job.brand || null,
        brandObj: brandForCombo,
        brandAnalysis, brandPrompt, brandRefBuffers,
        styleAnalysis, styleRefBuffers,
        bgChoice, bgMode, bgAnalysis, bgRefBuffers,
        scene, sceneLine,
        preserve,
        preserveBrand,
        brandInstruction,
        composition,
        backgroundLine: settings.getForEvent("promptBackground", ev),
        multiSubjectMode: settings.getForEvent("multiSubjectMode", ev) || "reject",
        reviewFeedback: job.reviewFeedback || null,
    });

    // Reject-mode early exit preserves original side effects (SMS, unlink, throw).
    // Caricature log-only side effect (build() handled the prompt addition).
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
        }
    }

    // Consume the review-feedback one-shot (matches original behavior)
    if (job.reviewFeedback) delete job.reviewFeedback;

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

        // 4b. Exact background compositing — chroma-key magenta fill, then
        // composite subject onto the uploaded background image.
        if (bgMode === "exact" && bgRefBuffers.length > 0) {
            try {
                console.log("🖼️  Chroma-keying magenta fill and compositing onto exact background image...");
                const { width: pw, height: ph } = settings.getPrintDimensions();
                const portraitBuf = await fsp.readFile(outputPath);
                const composited = await compositeExactBackground({
                    portraitBuf,
                    backgroundBuf: bgRefBuffers[0],
                    width: pw,
                    height: ph,
                });
                await fsp.writeFile(outputPath, composited);
                console.log("🖼️  Exact background applied.");
            } catch (bgErr) {
                console.error(`🖼️  Exact background compositing failed (using portrait as-is): ${bgErr.message}`);
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

// Test-only hook: exercises the prompt assembly block without running any I/O.
// Accepts fully-resolved inputs and returns the final prompt string the model
// would receive. Used by characterize tests to pin current behavior.
async function __assemblePromptForTest(resolved) {
    return require("./prompt-builder").build(resolved);
}

module.exports = { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage, analyzeReferences, __assemblePromptForTest };
