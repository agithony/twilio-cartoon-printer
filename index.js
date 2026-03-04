require("dotenv").config();
const fs = require("fs");
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
const { parseStyle } = require("./lib/styles");
const { mountDashboard } = require("./lib/dashboard");
const { mountHome } = require("./lib/home");
const { mountPhotoGallery } = require("./lib/photogallery");

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
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    const activeStyles = settings.getActiveStyles();
    const activeStyleList = settings.getActiveStyleList();
    const styleChoices = activeStyleList.map((k) => activeStyles[k].name).join(", ");

    if (numMedia > 1) {
        twiml.message(
            "One at a time! Send a single selfie and we'll work our magic.",
        );
    } else if (numMedia === 1) {
        const style = parseStyle(req.body.Body, activeStyles);
        const styleName = activeStyles[style].name;
        console.log(`📩 Image received from ${userPhone} (style: ${styleName})`);

        if (isAdmin(userPhone)) {
            const isFirst = getUsageCount(userPhone) === 0;
            const promo = isFirst ? settings.getPromoIntro() : settings.getPromoReturning();
            const termsUrl = settings.get("termsUrl");
            const terms = isFirst && termsUrl ? `\n\nBy sending a photo, you agree to our terms: ${termsUrl}` : "";
            twiml.message(
                `Your ${styleName} portrait is in the works! Head to the Twilio booth to pick it up in a few.${terms}${promo}`,
            );
            enqueueJob(
                req.body.MediaUrl0,
                req.body.MessageSid,
                userPhone,
                req.body.To,
                style,
                baseUrl,
            );
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const remaining = maxPrints - used;
            const eventName = settings.get("eventName");

            if (remaining <= 0) {
                twiml.message(
                    `You've already used your ${maxPrints} free prints for ${eventName}. Thanks for stopping by the Twilio booth!`,
                );
            } else {
                const isFirst = used === 0;
                const promo = isFirst ? settings.getPromoIntro() : settings.getPromoReturning();
                const termsUrl = settings.get("termsUrl");
                const terms = isFirst && termsUrl ? `\n\nBy sending a photo, you agree to our terms: ${termsUrl}` : "";
                const afterThis = remaining - 1;
                const countMsg = afterThis === 0
                    ? ` This is your last free print -- make it count!`
                    : ` You have ${afterThis} free print${afterThis === 1 ? "" : "s"} left.`;
                twiml.message(
                    `Your ${styleName} portrait is in the works! Head to the Twilio booth to pick it up in a few.${countMsg}${terms}${promo}`,
                );
                enqueueJob(
                    req.body.MediaUrl0,
                    req.body.MessageSid,
                    userPhone,
                    req.body.To,
                    style,
                    baseUrl,
                );
            }
        }
    } else {
        if (isAdmin(userPhone)) {
            twiml.message(
                `Send us a selfie and we'll turn it into art! Pick a style by typing its name with your photo: ${styleChoices}.`,
            );
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const remaining = maxPrints - used;
            const eventName = settings.get("eventName");
            if (remaining <= 0) {
                twiml.message(
                    `You've already used your ${maxPrints} free prints for ${eventName}. Thanks for stopping by the Twilio booth!`,
                );
            } else {
                twiml.message(
                    `Send us a selfie and we'll turn it into art! Pick a style by typing its name with your photo: ${styleChoices}. You have ${remaining} free print${remaining === 1 ? "" : "s"} at ${eventName}.`,
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
    settings.onEventNameChange(() => buildUsageCache());
    recoverStaleJobs();
    mountHome(app);
    mountPhotoGallery(app);
    mountDashboard(app);
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
