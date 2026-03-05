const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const { openai, twilioClient } = require("./config");
const settings = require("./settings");

async function downloadImage(url, filepath) {
    if (!url) throw new Error("URL is undefined.");
    const config = { method: "GET", url: url, responseType: "stream" };

    if (url.includes("twilio.com")) {
        config.auth = {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN,
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
        await twilioClient.messages.create(opts);
    } catch (err) {
        console.error(`📱 Failed to send message to ${to}: ${err.message}`);
    }
}

async function moderateImage(base64Image) {
    try {
        const response = await openai.moderations.create({
            model: "omni-moderation-latest",
            input: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${base64Image}`,
                    },
                },
            ],
        });
        const result = response.results[0];
        return { flagged: result.flagged, categories: result.categories };
    } catch (err) {
        console.error(`🛡️  Moderation API error (allowing through): ${err.message}`);
        return { flagged: false, categories: null };
    }
}

async function detectPerson(base64Image) {
    try {
        const response = await openai.responses.create({
            model: "gpt-5.2",
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
        });
        const text = response.output_text.trim().toUpperCase();
        return text.startsWith("YES");
    } catch (err) {
        console.error(`👤 Person detection error (allowing through): ${err.message}`);
        return true;
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
    const INSET_RATIO = 0.03; // 3% padding inside the safe zone

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
    await sharp({
        create: { width: PRINT_WIDTH, height: PRINT_HEIGHT, channels: 3, background: { r: 0, g: 0, b: 0 } },
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

module.exports = {
    downloadImage,
    sendSms,
    moderateImage,
    detectPerson,
    compositeWithTemplate,
    prepareForPrint,
};
