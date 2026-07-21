const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const { getOpenAI, getTwilioClient, getModels } = require("./config");
const settings = require("./settings");
const { trackApiCall } = require("./health");

// Shared phone-masking helper for log lines. Keeps country code + last 4
// digits so a human can still tell phones apart across log lines, but
// hides the middle subscriber digits. "api:..." synthetic phones (kiosk /
// API entry points) render as "Kiosk". Same contract as the maskPhone()
// copies in lib/dashboard.js and lib/outreach.js — duplicated there for
// the admin-UI rendering path; this copy exists so non-UI modules (SMS,
// pipeline, lead capture, menu handlers) can mask without requiring the
// full dashboard module.
function maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    if (phone.startsWith("api:")) return "Kiosk";
    const tail = phone.slice(-4);
    let ccLen = 2; // +1
    if (phone.length > 12) ccLen = 4;
    const head = phone.slice(0, ccLen);
    return `${head}*****${tail}`;
}

async function withRetry(fn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRetryable = err.status === 429
                || err.status === 502 || err.status === 503 || err.status === 504
                || err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND";
            if (attempt === maxRetries || !isRetryable) throw err;
            const retryAfter = err.headers?.["retry-after"];
            const delay = (retryAfter ? Number(retryAfter) : 2 ** attempt) * 1000;
            console.log(`⏳ Retryable error (${err.status || err.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadImage(url, filepath) {
    if (!url) throw new Error("URL is undefined.");
    const config = { method: "GET", url: url, responseType: "stream", timeout: 30000 };

    if (url.includes("twilio.com")) {
        config.auth = {
            username: settings.get("twilioAccountSid"),
            password: settings.get("twilioAuthToken"),
        };
    }

    const response = await axios(config);

    // Reject early if Content-Length exceeds limit
    const contentLength = parseInt(response.headers["content-length"], 10);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
        response.data.destroy();
        throw new Error(`Image too large (${Math.round(contentLength / 1024 / 1024)}MB exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit)`);
    }

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        let bytesReceived = 0;
        let failed = false;
        function fail(err) {
            if (failed) return;
            failed = true;
            writer.destroy();
            response.data.destroy();
            fs.unlink(filepath, () => {});
            reject(err);
        }
        response.data.on("data", (chunk) => {
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_DOWNLOAD_BYTES) {
                fail(new Error(`Image download exceeded ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit`));
            }
        });
        response.data.pipe(writer);
        response.data.on("error", fail);
        writer.on("finish", resolve);
        writer.on("error", fail);
    });

    // Log image metadata so we can diagnose "Invalid image file or mode"
    // failures from OpenAI. Sharp decodes the header-level info (format,
    // colour space, channels, bit depth) without loading the full pixel
    // buffer. Best-effort only — never fail the download if Sharp can't
    // read it, since that itself is diagnostic information.
    try {
        const meta = await sharp(filepath).metadata();
        console.log(`📷 Input image: format=${meta.format} space=${meta.space} channels=${meta.channels} depth=${meta.depth} ${meta.width}x${meta.height} hasAlpha=${meta.hasAlpha} icc=${meta.icc ? "present" : "none"}`);
    } catch (metaErr) {
        console.log(`📷 Input image: sharp metadata read failed (${metaErr.message}) — bytes may be an unsupported format`);
    }
}


async function moderateImage(base64Image) {
    const start = Date.now();
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
        trackApiCall("openai", true, Date.now() - start);
        const result = response.results[0];
        return { flagged: result.flagged, categories: result.categories };
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`🛡️  Moderation API error (allowing through): ${err.message}`);
        return { flagged: false, categories: null };
    }
}

async function detectPerson(base64Image) {
    const start = Date.now();
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
                            text: settings.get("promptFaceDetection"),
                        },
                    ],
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        const text = response.output_text.trim().toUpperCase();
        return text.startsWith("YES");
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`👤 Person detection error (allowing through): ${err.message}`);
        return true;
    }
}

async function analyzeScene(base64Image) {
    const start = Date.now();
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
                            text: settings.get("promptSceneAnalysis"),
                        },
                    ],
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        return response.output_text.trim();
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`👥 Scene analysis error (skipping): ${err.message}`);
        return "";
    }
}

function parseScene(raw) {
    const defaults = { subjects: 1, pets: "none", positions: "centered" };
    if (!raw) return defaults;
    try {
        const subjectsMatch = raw.match(/Subjects:\s*(\d+)/i);
        const petsMatch = raw.match(/Pets:\s*(.+)/im);
        const positionsMatch = raw.match(/Positions:\s*(.+)/im);
        return {
            subjects: subjectsMatch ? parseInt(subjectsMatch[1], 10) : defaults.subjects,
            pets: petsMatch ? petsMatch[1].trim().toLowerCase() : defaults.pets,
            positions: positionsMatch ? positionsMatch[1].trim().toLowerCase() : defaults.positions,
        };
    } catch {
        return defaults;
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
    const start = Date.now();
    try {
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().smartReply,
            input: [
                {
                    role: "developer",
                    content: [{
                        type: "input_text",
                        text: settings.get("promptSmartReply")
                            .replace("{eventName}", context.eventName)
                            .replace("{styleChoices}", context.styleChoices)
                            .replace("{remainingLine}", context.remaining != null ? `They have ${context.remaining} free ${context.unit}${context.remaining === 1 ? "" : "s"} remaining.` : "")
                            + (context.locale === "pt_BR" ? "\nRespond in natural Brazilian Portuguese." : "\nRespond in English."),
                    }],
                },
                {
                    role: "user",
                    content: [{ type: "input_text", text: userMessage }],
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        return response.output_text.trim();
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`🤖 Smart reply failed (using static): ${err.message}`);
        return null;
    }
}

module.exports = {
    downloadImage,
    moderateImage,
    detectPerson,
    analyzeScene,
    parseScene,
    compositeWithTemplate,
    prepareForPrint,
    generateSmartReply,
    withRetry,
    maskPhone,
    getTwilioClient,
    trackApiCall,
};
