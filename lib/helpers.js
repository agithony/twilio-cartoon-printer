const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const { getOpenAI, getTwilioClient, getModels } = require("./config");
const settings = require("./settings");

async function withRetry(fn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxRetries || err.status !== 429) throw err;
            const retryAfter = err.headers?.["retry-after"];
            const delay = (retryAfter ? Number(retryAfter) : 2 ** attempt) * 1000;
            console.log(`⏳ Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

async function downloadImage(url, filepath) {
    if (!url) throw new Error("URL is undefined.");
    const config = { method: "GET", url: url, responseType: "stream" };

    if (url.includes("twilio.com")) {
        config.auth = {
            username: settings.get("twilioAccountSid"),
            password: settings.get("twilioAuthToken"),
        };
    }

    const response = await axios(config);
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
    });
}

async function sendSms(to, from, body, mediaUrl) {
    try {
        const opts = { to, from, body };
        if (mediaUrl) opts.mediaUrl = [mediaUrl];
        await getTwilioClient().messages.create(opts);
    } catch (err) {
        console.error(`📱 Failed to send message to ${to}: ${err.message}`);
    }
}

async function moderateImage(base64Image) {
    try {
        const response = await withRetry(() => getOpenAI().moderations.create({
            model: "omni-moderation-latest",
            input: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${base64Image}`,
                    },
                },
            ],
        }));
        const result = response.results[0];
        return { flagged: result.flagged, categories: result.categories };
    } catch (err) {
        console.error(`🛡️  Moderation API error (allowing through): ${err.message}`);
        return { flagged: false, categories: null };
    }
}

async function detectPerson(base64Image) {
    try {
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().visionLight,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "low",
                        },
                        {
                            type: "input_text",
                            text: "Does this image clearly show a person's face? A face must be visible -- photos of only hands, feet, backs, or other body parts without a face do NOT count. Reply with only YES or NO.",
                        },
                    ],
                },
            ],
        }));
        const text = response.output_text.trim().toUpperCase();
        return text.startsWith("YES");
    } catch (err) {
        console.error(`👤 Person detection error (allowing through): ${err.message}`);
        return true;
    }
}

async function analyzeScene(base64Image) {
    try {
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().visionLight,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "low",
                        },
                        {
                            type: "input_text",
                            text: "Briefly describe the subjects in this photo: how many people, their relative positions (left/center/right), and any pets or animals present. Be concise — 1-2 sentences max.",
                        },
                    ],
                },
            ],
        }));
        return response.output_text.trim();
    } catch (err) {
        console.error(`👥 Scene analysis error (skipping): ${err.message}`);
        return "";
    }
}

async function detectSafeZone(templateBuffer) {
    const { data, info } = await sharp(templateBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const THRESHOLD = 128; // alpha below this = transparent

    let top = height, bottom = 0, left = width, right = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alpha = data[(y * width + x) * channels + (channels - 1)];
            if (alpha < THRESHOLD) {
                if (y < top) top = y;
                if (y > bottom) bottom = y;
                if (x < left) left = x;
                if (x > right) right = x;
            }
        }
    }

    if (bottom <= top || right <= left) return null; // no transparent area found

    return {
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1,
    };
}

async function compositeWithTemplate(imagePath) {
    const templatePath = settings.getTemplatePath();
    if (!templatePath || !fs.existsSync(templatePath)) {
        console.log("🖼️  No template configured, skipping frame overlay.");
        return;
    }

    const { width: PRINT_WIDTH, height: PRINT_HEIGHT } = settings.getPrintDimensions();
    const borderEnabled = settings.get("enableFrameBorder") !== false;
    const INSET_RATIO = borderEnabled ? 0.03 : 0; // 3% padding when border enabled, 0 when off

    // Resize template to print dimensions
    const resizedTemplate = await sharp(templatePath)
        .resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "cover" })
        .toBuffer();

    // Detect the transparent window in the template
    const zone = await detectSafeZone(resizedTemplate);

    if (!zone) {
        // No transparent area — fall back to simple overlay
        const resizedImage = await sharp(imagePath)
            .resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "cover" })
            .toBuffer();
        await sharp(resizedImage)
            .composite([{ input: resizedTemplate, gravity: "center" }])
            .png()
            .toFile(imagePath);
        console.log("🖼️  Frame overlay applied (no safe zone detected, using full area).");
        return;
    }

    // Add inset padding
    const padX = Math.round(zone.width * INSET_RATIO);
    const padY = Math.round(zone.height * INSET_RATIO);
    const targetW = zone.width - padX * 2;
    const targetH = zone.height - padY * 2;
    const targetX = zone.left + padX;
    const targetY = zone.top + padY;

    // Portrait fitted within the safe zone (no clipping of subject)
    const fgPortrait = await sharp(imagePath)
        .resize(targetW, targetH, { fit: "cover" })
        .toBuffer();

    // Blank canvas → fitted portrait → template frame
    const hex = settings.get("frameBorderColor") || "#000000";
    const bgR = parseInt(hex.slice(1, 3), 16) || 0;
    const bgG = parseInt(hex.slice(3, 5), 16) || 0;
    const bgB = parseInt(hex.slice(5, 7), 16) || 0;
    await sharp({
        create: { width: PRINT_WIDTH, height: PRINT_HEIGHT, channels: 3, background: { r: bgR, g: bgG, b: bgB } },
    })
        .composite([
            { input: fgPortrait, left: targetX, top: targetY },
            { input: resizedTemplate, left: 0, top: 0 },
        ])
        .png()
        .toFile(imagePath);

    console.log("🖼️  Frame overlay applied (safe zone: %dx%d at +%d+%d).",
        targetW, targetH, targetX, targetY);
}

async function prepareForPrint(imagePath) {
    const { width: PRINT_WIDTH, height: PRINT_HEIGHT, dpi: PRINT_DPI } = settings.getPrintDimensions();

    await sharp(imagePath)
        .resize(PRINT_WIDTH, PRINT_HEIGHT, {
            fit: "cover",
        })
        .withMetadata({ density: PRINT_DPI })
        .png()
        .toFile(imagePath + ".tmp");

    fs.renameSync(imagePath + ".tmp", imagePath);
    console.log(`📐 Image resized to ${PRINT_WIDTH}x${PRINT_HEIGHT} @ ${PRINT_DPI} DPI`);
}

async function generateSmartReply(userMessage, context) {
    try {
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().smartReply,
            input: [
                {
                    role: "developer",
                    content: [{
                        type: "input_text",
                        text: `You are an AI-powered photobooth assistant at an event called "${context.eventName}". Powered by Twilio and OpenAI.
Your job is to respond to the user's message naturally and helpfully, then direct them to send a selfie so you can transform it into art.
Available art styles: ${context.styleChoices}.
${context.remaining != null ? `They have ${context.remaining} free ${context.unit}${context.remaining === 1 ? "" : "s"} remaining.` : ""}
Keep your response concise (2-4 sentences max). Always end by encouraging them to send a selfie. Be friendly and conversational. Do not use emojis.`,
                    }],
                },
                {
                    role: "user",
                    content: [{ type: "input_text", text: userMessage }],
                },
            ],
        }));
        return response.output_text.trim();
    } catch (err) {
        console.error(`🤖 Smart reply failed (using static): ${err.message}`);
        return null;
    }
}

module.exports = {
    downloadImage,
    sendSms,
    moderateImage,
    detectPerson,
    analyzeScene,
    compositeWithTemplate,
    prepareForPrint,
    generateSmartReply,
    withRetry,
};
