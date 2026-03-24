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

function jobPaths(job) {
    const { style, createdAt, filePrefix } = job;
    const activeStyles = settings.getActiveStyles();
    const styleKey = style && activeStyles[style] ? style : (settings.get("defaultStyle") || DEFAULT_STYLE);
    const prefix = filePrefix || formatTimestamp(createdAt || Date.now());
    const downloadDir = settings.getDownloadDir();
    const inputPath = path.join(downloadDir, `${prefix}_input.jpg`);
    const outputPath = path.join(downloadDir, `${prefix}_output.png`);
    const mmsPath = path.join(downloadDir, `${prefix}_output_mms.jpg`);
    return { styleKey, prefix, inputPath, outputPath, mmsPath };
}

// Steps 1-6: download, moderate, face detect, AI generate, composite, resize
async function generateImage(job) {
    const { imageUrl, userPhone, appPhone } = job;
    const { styleKey, inputPath, outputPath, mmsPath } = jobPaths(job);
    const activeStyles = settings.getActiveStyles();
    const stylePrompt = activeStyles[styleKey].prompt;
    const brandPrompt = settings.get("brandPrompt");

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
    console.log("👤 Checking for face + analyzing scene...");
    const [hasFace, sceneDescription] = await Promise.all([
        detectPerson(base64Image),
        analyzeScene(base64Image),
    ]);

    if (!hasFace) {
        console.log("👤 No face detected in image.");
        await sendSms(
            userPhone,
            appPhone,
            settings.getMsg("noFace"),
        );
        await fsp.unlink(inputPath);
        const err = new Error("No face detected in image.");
        err.permanent = true;
        err.failReason = "face_detection";
        throw err;
    }

    // Parse scene analysis into structured data
    const scene = parseScene(sceneDescription);
    if (sceneDescription) {
        console.log(`👥 Scene: ${scene.subjects} subject(s), pets: ${scene.pets}, positions: ${scene.positions}`);
    }

    // Build scene instruction (only when multi-subject or pets)
    let sceneLine = "";
    if (scene.subjects > 1 && scene.pets !== "none") {
        sceneLine = `This photo has ${scene.subjects} people and a ${scene.pets}. Include ALL of them positioned as shown.`;
    } else if (scene.subjects > 1) {
        sceneLine = `This photo has ${scene.subjects} people. Include ALL of them positioned as shown.`;
    } else if (scene.pets !== "none") {
        sceneLine = `This photo has a person and a ${scene.pets}. Include both in the image.`;
    }

    // Load brand reference images as buffers for Images API
    const brandRefFiles = settings.get("brandReferenceFiles") || [];
    const brandRefBuffers = [];
    const BRAND_REFS_DIR = path.join(__dirname, "..", "brand-references");
    for (const filename of brandRefFiles) {
        const filePath = path.join(BRAND_REFS_DIR, filename);
        if (fs.existsSync(filePath)) {
            brandRefBuffers.push(await fsp.readFile(filePath));
        }
    }
    if (brandRefBuffers.length > 0) {
        console.log(`🎨 Including ${brandRefBuffers.length} brand reference image(s)`);
    }

    // Build generation prompt — single prompt sent directly to image model (no orchestrator)
    const hasBrands = brandRefBuffers.length > 0;
    const styleObj = activeStyles[styleKey];
    const isBuiltIn = !!styleObj.core;
    const preserveBrand = settings.get("promptPreserveBrand");
    const brandInstruction = settings.get("promptBrandInstruction");
    const composition = settings.get("promptComposition");
    let fullPrompt;

    if (hasBrands) {
        // Brand refs present — simple, direct prompt; multi-subject gets explicit "dress everyone"
        const refWord = brandRefBuffers.length > 1 ? "s" : "";
        let parts;
        if (scene.subjects > 1) {
            const petNote = scene.pets !== "none"
                ? ` Include the ${scene.pets} naturally without branded clothing.`
                : "";
            parts = [
                `Generate a ${styleObj.name} version of this photo. There are ${scene.subjects} people — dress EVERY person in the outfit/gear from the reference photo${refWord}. Do NOT change the logo or any branding in any way.${petNote}`,
                `Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`,
            ];
        } else {
            const petNote = scene.pets !== "none"
                ? ` Include the ${scene.pets} naturally in the image.`
                : "";
            parts = [
                `Generate a ${styleObj.name} version of me wearing the outfit/gear from the reference photo${refWord}. Do NOT change the logo or any branding in any way.${petNote}`,
                preserveBrand,
            ];
        }
        if (sceneLine) parts.push(sceneLine);
        if (brandPrompt) parts.push(brandPrompt);
        fullPrompt = parts.join("\n");
    } else {
        // No brand refs — full style prompt
        fullPrompt = stylePrompt;
        if (sceneLine) {
            fullPrompt = `${sceneLine}\n\n${fullPrompt}`;
        }
        if (brandPrompt) {
            fullPrompt += `\n\nApply the following to ALL subjects in the image: ${brandPrompt}`;
        }
    }

    // Background instruction — from user choice (job.background) or admin default
    const bgChoices = settings.get("backgroundChoices") || [];
    const bgChoice = job.background && bgChoices.find(c => c.key === job.background);
    const backgroundLine = bgChoice ? bgChoice.prompt : settings.get("promptBackground");
    if (backgroundLine) fullPrompt += "\n" + backgroundLine;

    console.log(`📝 Prompt (direct to ${getModels().imageGen}):\n${fullPrompt}`);

    // 4. Generate image via Images API edit endpoint (prompt goes directly to image model)
    if (!fs.existsSync(outputPath)) {
        console.log(`🎨 Generating ${activeStyles[styleKey].name} image...`);
        const selfieBuffer = await fsp.readFile(inputPath);
        const imageFiles = await Promise.all([
            toFile(selfieBuffer, "selfie.jpg", { type: "image/jpeg" }),
            ...brandRefBuffers.map((buf, i) => toFile(buf, `brand_${i}.png`, { type: "image/png" })),
        ]);

        const result = await withRetry(() => getOpenAI().images.edit({
            model: getModels().imageGen,
            image: imageFiles,
            prompt: fullPrompt,
            size: "1024x1536",
            quality: "high",
            input_fidelity: "high",
            background: "opaque",
        }));

        const imageData = result.data[0];
        if (!imageData || !imageData.b64_json) {
            console.log("🔍 Debug:", JSON.stringify(result, null, 2));
            throw new Error("No image generated in response.");
        }

        console.log("💾 Saving generated image...");
        await fsp.writeFile(outputPath, Buffer.from(imageData.b64_json, "base64"));

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

module.exports = { generateImage, printJob, jobPaths };
