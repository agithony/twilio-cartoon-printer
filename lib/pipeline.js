const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { openai, formatTimestamp, DOWNLOAD_DIR } = require("./config");
const { STYLES, DEFAULT_STYLE } = require("./styles");
const { downloadImage, sendSms, moderateImage, detectPerson, compositeWithTemplate, prepareForPrint } = require("./helpers");
const { checkPrinterReady, printImage } = require("./printer");

function jobPaths(job) {
    const { style, createdAt, filePrefix } = job;
    const styleKey = style && STYLES[style] ? style : DEFAULT_STYLE;
    const prefix = filePrefix || formatTimestamp(createdAt || Date.now());
    const inputPath = path.join(DOWNLOAD_DIR, `${prefix}_input.jpg`);
    const outputPath = path.join(DOWNLOAD_DIR, `${prefix}_output.png`);
    const mmsPath = path.join(DOWNLOAD_DIR, `${prefix}_output_mms.jpg`);
    return { styleKey, prefix, inputPath, outputPath, mmsPath };
}

// Steps 1-6: download, moderate, face detect, AI generate, composite, resize
async function generateImage(job) {
    const { imageUrl, userPhone, appPhone } = job;
    const { styleKey, inputPath, outputPath, mmsPath } = jobPaths(job);
    const stylePrompt = STYLES[styleKey].prompt;

    // 1. Download input (skip if already downloaded from a previous attempt)
    if (!fs.existsSync(inputPath)) {
        console.log("⬇️  Downloading image...");
        await downloadImage(imageUrl, inputPath);
    }

    // 2. Content moderation
    console.log("🛡️  Running content moderation...");
    const imageBuffer = fs.readFileSync(inputPath);
    const base64Image = imageBuffer.toString("base64");
    const moderation = await moderateImage(base64Image);

    if (moderation.flagged) {
        console.log("🚫 Image flagged by moderation.", moderation.categories);
        await sendSms(
            userPhone,
            appPhone,
            "That photo didn't work -- try sending a different selfie. Don't worry, it didn't use up a print!",
        );
        fs.unlinkSync(inputPath);
        const err = new Error("Image flagged by moderation.");
        err.permanent = true;
        throw err;
    }

    // 3. Face detection
    console.log("👤 Checking for face in image...");
    const hasFace = await detectPerson(base64Image);
    if (!hasFace) {
        console.log("👤 No face detected in image.");
        await sendSms(
            userPhone,
            appPhone,
            "We need to see your face for the portrait! Send a selfie with your face visible. Don't worry, that one didn't count.",
        );
        fs.unlinkSync(inputPath);
        const err = new Error("No face detected in image.");
        err.permanent = true;
        throw err;
    }

    // 4. Generate image via Responses API with image_generation tool
    if (!fs.existsSync(outputPath)) {
        console.log(`🎨 Generating ${STYLES[styleKey].name} image...`);
        const response = await openai.responses.create({
            model: "gpt-5.2",
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "high",
                        },
                        {
                            type: "input_text",
                            text: stylePrompt,
                        },
                    ],
                },
            ],
            tools: [
                {
                    type: "image_generation",
                    model: "gpt-image-1.5",
                    quality: "high",
                    size: "1024x1536",
                },
            ],
        });

        const imageCall = response.output.find(
            (item) => item.type === "image_generation_call",
        );

        if (!imageCall || !imageCall.result) {
            console.log("🔍 Debug:", JSON.stringify(response.output, null, 2));
            throw new Error("No image generated in response.");
        }

        console.log("💾 Saving generated image...");
        fs.writeFileSync(outputPath, Buffer.from(imageCall.result, "base64"));

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
async function printJob(job) {
    const { outputPath } = jobPaths(job);

    console.log("🖨️  Checking printer status...");
    const printerName = await checkPrinterReady();

    await printImage(outputPath, printerName);
}

module.exports = { generateImage, printJob, jobPaths };
