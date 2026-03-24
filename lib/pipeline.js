const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const fsp = fs.promises;
const { getOpenAI, formatTimestamp, getModels } = require("./config");
const settings = require("./settings");
const { DEFAULT_STYLE } = require("./styles");
const { downloadImage, sendSms, moderateImage, detectPerson, analyzeScene, compositeWithTemplate, prepareForPrint, withRetry } = require("./helpers");
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

    if (sceneDescription) {
        console.log(`👥 Scene: ${sceneDescription}`);
    }

    // Build full prompt with scene context
    let fullPrompt = stylePrompt;
    if (sceneDescription) {
        fullPrompt = `IMPORTANT: This photo contains ${sceneDescription}. You MUST include ALL people and any pets/animals visible in the original photo — do not omit anyone.\n\n${fullPrompt}`;
    }
    if (brandPrompt) {
        fullPrompt += `\n\nApply the following to ALL subjects in the image: ${brandPrompt}`;
    }

    // Load brand reference images
    const brandRefFiles = settings.get("brandReferenceFiles") || [];
    const brandRefImages = [];
    const BRAND_REFS_DIR = path.join(__dirname, "..", "brand-references");
    for (const filename of brandRefFiles) {
        const filePath = path.join(BRAND_REFS_DIR, filename);
        if (fs.existsSync(filePath)) {
            const buf = await fsp.readFile(filePath);
            const ext = path.extname(filename).toLowerCase();
            const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
            brandRefImages.push({
                type: "input_image",
                image_url: `data:${mime};base64,${buf.toString("base64")}`,
                detail: "high",
            });
        }
    }
    if (brandRefImages.length > 0) {
        fullPrompt += `\n\nCRITICAL BRAND COMPLIANCE: Additional reference images are provided showing official brand guidelines, logos, colors, typography, or design specifications. You MUST reproduce these brand elements EXACTLY as shown — not an approximation or interpretation, but an exact copy. Study every pixel-level detail: exact logo shapes, exact letter forms, exact color hex values, exact stitching patterns, exact stripe placement, exact proportions. Do NOT invent, substitute, or improvise any brand element. If the reference shows a specific logo, reproduce that EXACT logo — not a similar one. If it shows specific text, use those EXACT words and fonts. Brand accuracy is the top priority after preserving the subject's likeness. The FIRST image is the selfie to transform; the remaining ${brandRefImages.length} image(s) are brand reference materials that must be replicated with absolute precision.`;
        console.log(`🎨 Including ${brandRefImages.length} brand reference image(s)`);
    }

    // 4. Generate image via Responses API with image_generation tool
    if (!fs.existsSync(outputPath)) {
        console.log(`🎨 Generating ${activeStyles[styleKey].name} image...`);
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().orchestrator,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "high",
                        },
                        ...brandRefImages,
                        {
                            type: "input_text",
                            text: fullPrompt,
                        },
                    ],
                },
            ],
            tools: [
                {
                    type: "image_generation",
                    model: getModels().imageGen,
                    quality: "high",
                    size: "1024x1536",
                },
            ],
        }));

        const imageCall = response.output.find(
            (item) => item.type === "image_generation_call",
        );

        if (!imageCall || !imageCall.result) {
            console.log("🔍 Debug:", JSON.stringify(response.output, null, 2));
            throw new Error("No image generated in response.");
        }

        console.log("💾 Saving generated image...");
        await fsp.writeFile(outputPath, Buffer.from(imageCall.result, "base64"));

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
