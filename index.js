require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;
const {
    POLL_INTERVAL,
    DATA_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./lib/config");
const settings = require("./lib/settings");
const {
    buildUsageCache,
    isAdmin,
    getUsageCount,
    enqueueJob,
    recoverStaleJobs,
    processGenerationQueue,
    processPrintQueue,
} = require("./lib/queue");
const { parseStyle, detectStyle } = require("./lib/styles");
const styleMenu = require("./lib/style-menu");
const { mountDashboard } = require("./lib/dashboard");
const { mountHome } = require("./lib/home");
const { mountPhotoGallery } = require("./lib/photogallery");
const { mountOutreach } = require("./lib/outreach");
const leads = require("./lib/leads");

const app = express();
const port = parseInt(process.env.PORT || "80", 10);

// Ensure directories exist
for (const dir of [DATA_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(bodyParser.urlencoded({ extended: false }));

// Serve generated images — resolves download dir dynamically per request
app.use("/images", (req, res, next) => {
    express.static(settings.getDownloadDir())(req, res, next);
});

// ── Twilio Webhook ───────────────────────────────────────────────────────────

let baseUrl = process.env.BASE_URL || "";

app.post("/sms", async (req, res) => {
    if (!baseUrl) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
        baseUrl = `${proto}://${req.headers.host}`;
        console.log(`🌐 Base URL detected: ${baseUrl}`);
    }
    const twiml = new MessagingResponse();
    const userPhone = req.body.From;
    const appPhone = req.body.To;
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    const body = req.body.Body || "";

    const activeStyles = settings.getActiveStyles();
    const activeStyleList = settings.getActiveStyleList();
    const leadMode = settings.get("leadCaptureMode");
    const eventName = settings.get("eventName");

    // Helper: confirm and enqueue a job with the chosen style
    async function confirmAndEnqueue(style, imageUrl, messageSid, useTwiml) {
        const styleName = activeStyles[style].name;
        console.log(`📩 Enqueuing portrait for ${userPhone} (style: ${styleName})`);

        const printingEnabled = settings.get("enablePrinting");
        const pickupMsg = printingEnabled
            ? " Head to the Twilio booth to pick it up in a few."
            : " We'll text it to you shortly.";
        const unit = printingEnabled ? "print" : "portrait";
        const units = printingEnabled ? "prints" : "portraits";

        if (isAdmin(userPhone)) {
            const isFirst = getUsageCount(userPhone) === 0;
            const promo = isFirst ? settings.getPromoIntro() : settings.getPromoReturning();
            const termsUrl = settings.get("termsUrl");
            const terms = isFirst && termsUrl ? `\n\nBy sending a photo, you agree to our terms: ${termsUrl}` : "";
            if (useTwiml) {
                twiml.message(`Your ${styleName} portrait is in the works!${pickupMsg}${terms}${promo}`);
            } else {
                const { sendSms } = require("./lib/helpers");
                await sendSms(userPhone, appPhone, `Your ${styleName} portrait is in the works!${pickupMsg}${terms}${promo}`);
            }
            enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl);
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const remaining = maxPrints - used;

            if (remaining <= 0) {
                if (useTwiml) {
                    twiml.message(`You've already used your ${maxPrints} free ${units} for ${eventName}. Thanks for stopping by!`);
                } else {
                    const { sendSms } = require("./lib/helpers");
                    await sendSms(userPhone, appPhone, `You've already used your ${maxPrints} free ${units} for ${eventName}. Thanks for stopping by!`);
                }
                return;
            }

            const isFirst = used === 0;
            const promo = isFirst ? settings.getPromoIntro() : settings.getPromoReturning();
            const termsUrl = settings.get("termsUrl");
            const terms = isFirst && termsUrl ? `\n\nBy sending a photo, you agree to our terms: ${termsUrl}` : "";
            const afterThis = remaining - 1;
            const countMsg = afterThis === 0
                ? ` This is your last free ${unit} -- make it count!`
                : ` You have ${afterThis} free ${unit}${afterThis === 1 ? "" : "s"} left.`;
            if (useTwiml) {
                twiml.message(`Your ${styleName} portrait is in the works!${pickupMsg}${countMsg}${terms}${promo}`);
            } else {
                const { sendSms } = require("./lib/helpers");
                await sendSms(userPhone, appPhone, `Your ${styleName} portrait is in the works!${pickupMsg}${countMsg}${terms}${promo}`);
            }
            enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl);
        }
    }

    // Helper: show style menu and hold the image
    function showMenuAndHold(imageUrl, messageSid) {
        styleMenu.setPending(userPhone, { imageUrl, messageSid, body, appPhone, baseUrl });
        twiml.message(styleMenu.buildMenu(activeStyles, activeStyleList));
    }

    // ── 1. Lead capture active survey ───────────────────────────────────────
    if (leadMode !== "disabled" && !isAdmin(userPhone) && leads.isActive(userPhone)) {
        const result = await leads.processResponse(userPhone, body);

        if (result.status === "completed" && result.pendingImage) {
            const pi = result.pendingImage;
            const style = pi.style || parseStyle(pi.body, activeStyles, settings.get("defaultStyle"));
            await confirmAndEnqueue(style, pi.imageUrl, pi.messageSid, false);
        }

        return res.type("text/xml").send(twiml.toString());
    }

    // ── 2. Style menu pending ───────────────────────────────────────────────
    if (styleMenu.hasPending(userPhone)) {
        if (numMedia >= 1) {
            // New selfie replaces old pending — clear and fall through
            styleMenu.clearPending(userPhone);
        } else {
            // Text reply — try to match a style
            const matched = styleMenu.matchReply(body, activeStyles, activeStyleList);
            if (!matched) {
                twiml.message(styleMenu.buildRetryMenu(activeStyles, activeStyleList));
                return res.type("text/xml").send(twiml.toString());
            }

            const pending = styleMenu.getPending(userPhone);
            styleMenu.clearPending(userPhone);

            // Check if lead capture "before" is needed
            if (leadMode === "before" && !isAdmin(userPhone) && !leads.isCompleted(userPhone, eventName)) {
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: pending.imageUrl,
                    messageSid: pending.messageSid,
                    body: pending.body,
                    style: matched,
                    baseUrl,
                });
                return res.type("text/xml").send(twiml.toString());
            }

            // Normal enqueue
            await confirmAndEnqueue(matched, pending.imageUrl, pending.messageSid, false);
            return res.type("text/xml").send(twiml.toString());
        }
    }

    // ── 3. Lead capture "before" intercept ──────────────────────────────────
    if (leadMode === "before" && !isAdmin(userPhone) && !leads.isCompleted(userPhone, eventName)) {
        if (numMedia > 1) {
            twiml.message("One at a time! Send a single selfie and we'll work our magic.");
        } else if (numMedia === 1) {
            const explicitStyle = detectStyle(body, activeStyles);
            if (explicitStyle) {
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: req.body.MediaUrl0,
                    messageSid: req.body.MessageSid,
                    body,
                    style: explicitStyle,
                    baseUrl,
                });
            } else {
                showMenuAndHold(req.body.MediaUrl0, req.body.MessageSid);
            }
        } else {
            await leads.startSurvey(userPhone, appPhone, eventName, "before", null);
        }
        return res.type("text/xml").send(twiml.toString());
    }

    // ── 4. Normal flow ──────────────────────────────────────────────────────
    if (numMedia > 1) {
        twiml.message("One at a time! Send a single selfie and we'll work our magic.");
    } else if (numMedia === 1) {
        const explicitStyle = detectStyle(body, activeStyles);
        if (explicitStyle) {
            await confirmAndEnqueue(explicitStyle, req.body.MediaUrl0, req.body.MessageSid, true);
        } else {
            showMenuAndHold(req.body.MediaUrl0, req.body.MessageSid);
        }
    } else {
        const printingEnabled = settings.get("enablePrinting");
        const unit = printingEnabled ? "print" : "portrait";
        const styleChoices = activeStyleList.map((k) => activeStyles[k].name).join(", ");

        // Check if this looks like a real question/conversation vs a simple greeting
        const conversational = body && body.trim().length > 2
            && !/^(hi|hey|hello|yo|sup|ok|yes|no|thanks|ty|thx|k|lol|hit send to start!?)$/i.test(body.trim());

        if (isAdmin(userPhone)) {
            if (conversational) {
                const { generateSmartReply } = require("./lib/helpers");
                const reply = await generateSmartReply(body, { eventName, styleChoices, remaining: null, unit });
                if (reply) {
                    twiml.message(reply);
                    return res.type("text/xml").send(twiml.toString());
                }
            }
            twiml.message(
                `Send us a selfie and we'll turn it into art! You'll get to pick your style after.`,
            );
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const remaining = maxPrints - used;
            if (remaining <= 0) {
                twiml.message(
                    `You've already used your ${maxPrints} free ${unit}s for ${eventName}. Thanks for stopping by!`,
                );
            } else {
                if (conversational) {
                    const { generateSmartReply } = require("./lib/helpers");
                    const reply = await generateSmartReply(body, { eventName, styleChoices, remaining, unit });
                    if (reply) {
                        twiml.message(reply);
                        return res.type("text/xml").send(twiml.toString());
                    }
                }
                twiml.message(
                    `Send us a selfie and we'll turn it into art! You'll get to pick your style after. You have ${remaining} free ${unit}${remaining === 1 ? "" : "s"} at ${eventName}.`,
                );
            }
        }
    }
    res.type("text/xml").send(twiml.toString());
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 App running on port ${port} | Event: ${settings.get("eventName")}`);
    settings.load();
    // Ensure download dir for current event exists
    const dlDir = settings.getDownloadDir();
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    buildUsageCache();
    leads.load();
    settings.onEventNameChange(() => buildUsageCache());
    recoverStaleJobs();
    mountHome(app);
    mountPhotoGallery(app);
    mountDashboard(app);
    mountOutreach(app);
    setInterval(processGenerationQueue, POLL_INTERVAL);
    setInterval(processPrintQueue, POLL_INTERVAL);
    console.log(`⏱️  Workers started (polling every ${POLL_INTERVAL}ms, max ${settings.get("maxConcurrentGeneration")} concurrent generations)`);

    // Auto-open home page in the default browser
    const host = `http://localhost${port === 80 ? "" : ":" + port}`;
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${openCmd} ${host}/home`, (err) => {
        if (err) console.log(`🏠 Home available at ${host}/home`);
    });
});
