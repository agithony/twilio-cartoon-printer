require("dotenv").config();
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;
const {
    POLL_INTERVAL,
    MAX_CONCURRENT_GENERATION,
    MAX_PRINTS,
    EVENT_NAME,
    TERMS_URL,
    PROMO_INTRO,
    PROMO_RETURNING,
    DATA_DIR,
    DOWNLOAD_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./lib/config");
const {
    buildUsageCache,
    isAdmin,
    getUsageCount,
    enqueueJob,
    recoverStaleJobs,
    processGenerationQueue,
    processPrintQueue,
} = require("./lib/queue");
const { STYLES, STYLE_LIST, parseStyle } = require("./lib/styles");
const { mountDashboard } = require("./lib/dashboard");

const app = express();
const port = 80;

// Ensure directories exist
for (const dir of [DATA_DIR, DOWNLOAD_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(bodyParser.urlencoded({ extended: false }));

// Serve generated images so Twilio can fetch them for MMS
app.use("/images", express.static(DOWNLOAD_DIR));

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

    const styleChoices = STYLE_LIST.map((k) => STYLES[k].name).join(", ");

    if (numMedia > 1) {
        twiml.message(
            "One at a time! Send a single selfie and we'll work our magic.",
        );
    } else if (numMedia === 1) {
        const style = parseStyle(req.body.Body);
        const styleName = STYLES[style].name;
        console.log(`📩 Image received from ${userPhone} (style: ${styleName})`);

        if (isAdmin(userPhone)) {
            const isFirst = getUsageCount(userPhone) === 0;
            const promo = isFirst ? PROMO_INTRO : PROMO_RETURNING;
            const terms = isFirst && TERMS_URL ? `\n\nBy sending a photo, you agree to our terms: ${TERMS_URL}` : "";
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
            const remaining = MAX_PRINTS - used;

            if (remaining <= 0) {
                twiml.message(
                    `You've already used your ${MAX_PRINTS} free prints for ${EVENT_NAME}. Thanks for stopping by the Twilio booth!`,
                );
            } else {
                const isFirst = used === 0;
                const promo = isFirst ? PROMO_INTRO : PROMO_RETURNING;
                const terms = isFirst && TERMS_URL ? `\n\nBy sending a photo, you agree to our terms: ${TERMS_URL}` : "";
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
            const remaining = MAX_PRINTS - used;
            if (remaining <= 0) {
                twiml.message(
                    `You've already used your ${MAX_PRINTS} free prints for ${EVENT_NAME}. Thanks for stopping by the Twilio booth!`,
                );
            } else {
                twiml.message(
                    `Send us a selfie and we'll turn it into art! Pick a style by typing its name with your photo: ${styleChoices}. You have ${remaining} free print${remaining === 1 ? "" : "s"} at ${EVENT_NAME}.`,
                );
            }
        }
    }
    res.type("text/xml").send(twiml.toString());
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 App running on port ${port} | Event: ${EVENT_NAME}`);
    buildUsageCache();
    recoverStaleJobs();
    mountDashboard(app);
    setInterval(processGenerationQueue, POLL_INTERVAL);
    setInterval(processPrintQueue, POLL_INTERVAL);
    console.log(`⏱️  Workers started (polling every ${POLL_INTERVAL}ms, max ${MAX_CONCURRENT_GENERATION} concurrent generations)`);
});
