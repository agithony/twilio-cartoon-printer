const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const { openai, twilioClient, TEMPLATE_PATH } = require("./config");

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
        console.log(`📱 ${mediaUrl ? "MMS" : "SMS"} sent to ${to}`);
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

async function compositeWithTemplate(imagePath) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
        console.log("🖼️  Template not found, skipping frame overlay.");
        return;
    }

    const templateMeta = await sharp(TEMPLATE_PATH).metadata();

    const resizedImage = await sharp(imagePath)
        .resize(templateMeta.width, templateMeta.height, {
            fit: "cover",
        })
        .toBuffer();

    await sharp(resizedImage)
        .composite([
            {
                input: TEMPLATE_PATH,
                gravity: "center",
            },
        ])
        .png()
        .toFile(imagePath);

    console.log("🖼️  Frame overlay applied.");
}

// 5x7 at 300 DPI = 1500x2100 pixels
const PRINT_WIDTH = 1500;
const PRINT_HEIGHT = 2100;
const PRINT_DPI = 300;

async function prepareForPrint(imagePath) {
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
