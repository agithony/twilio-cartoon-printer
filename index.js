require("./lib/log-buffer").init();
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
    REVIEW_DIR,
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
    recoverStaleRelayJobs,
    clearStaleRelayTargets,
} = require("./lib/queue");
const { parseStyle, detectStyle } = require("./lib/styles");
const styleMenu = require("./lib/style-menu");
const brandMenu = require("./lib/brand-menu");
const backgroundMenu = require("./lib/background-menu");
const { getActiveBrands } = require("./lib/brands");
const { mountDashboard } = require("./lib/dashboard");
const { mountReview } = require("./lib/review");
const { mountHome } = require("./lib/home");
const { mountPhotoGallery } = require("./lib/photogallery");
const { mountOutreach } = require("./lib/outreach");
const { mountShare } = require("./lib/share");
const { mountPrintRelay } = require("./lib/print-relay");
const leads = require("./lib/leads");
const nps = require("./lib/nps");
const contacts = require("./lib/contacts");

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

// Storage diagnostics
const dataMount = process.env.DATA_MOUNT || "";
if (dataMount) {
    const mountExists = fs.existsSync(dataMount);
    const dataSymlink = fs.lstatSync(path.join(__dirname, "data")).isSymbolicLink() ? "symlink" : "local";
    console.log(`💾 Storage: DATA_MOUNT=${dataMount} (${mountExists ? "mounted" : "NOT FOUND"}), data/ is ${dataSymlink}`);
} else {
    console.log("💾 Storage: No DATA_MOUNT set — using local/ephemeral storage");
}

// Ensure directories exist
const BRAND_REFS_DIR = path.join(__dirname, "brand-references");
for (const dir of [DATA_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR, DONE_DIR, FAILED_DIR, BRAND_REFS_DIR, settings.EVENTS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(bodyParser.urlencoded({ extended: false }));
app.use(require("compression")());

// ── Google OAuth (must be before all other routes) ──────────────────────────
const { mountAuth, requireAuth, isPublicRoute } = require("./lib/auth");
const { mountHealth } = require("./lib/health");
mountHealth(app);
mountAuth(app);
app.use((req, res, next) => {
    if (isPublicRoute(req)) return next();
    requireAuth(req, res, next);
});

app.get("/", (req, res) => res.redirect("/home"));
app.use("/assets", express.static(path.join(__dirname, "assets"), { maxAge: "1d" }));

// Staging images (for review previews in dashboard)
app.use("/images/staging", (req, res, next) => {
    express.static(path.join(settings.getDownloadDir(), ".staging"))(req, res, next);
});
// Serve approved images — resolves download dir dynamically per request
app.use("/images", (req, res, next) => {
    express.static(settings.getDownloadDir())(req, res, next);
});

// ── Twilio Webhook ───────────────────────────────────────────────────────────

let baseUrl = process.env.BASE_URL || "";

// Deduplicate Twilio webhook retries (same MessageSid delivered again if
// the first response was slow).  Keep the last 500 SIDs in a rotating set.
const _processedSids = new Set();
const _sidQueue = [];
function markSid(sid) {
    if (!sid) return false; // no SID → allow
    if (_processedSids.has(sid)) return true; // duplicate
    _processedSids.add(sid);
    _sidQueue.push(sid);
    if (_sidQueue.length > 2000) _processedSids.delete(_sidQueue.shift());
    return false;
}

app.post("/sms", async (req, res) => {
  try {
    if (!baseUrl) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
        baseUrl = `${proto}://${req.headers.host}`;
        console.log(`🌐 Base URL detected: ${baseUrl}`);
    }

    // Skip duplicate webhook deliveries (Twilio retries)
    if (markSid(req.body.MessageSid)) {
        console.log(`⚠️  Duplicate webhook skipped: ${req.body.MessageSid}`);
        return res.type("text/xml").send(new MessagingResponse().toString());
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

    // Track first contact for drop-off detection
    contacts.recordContact(userPhone, appPhone, eventName);

    // Testing mode: admins experience the full regular-user flow (intro, promo,
    // status messages, lead capture) but with unlimited quota.
    const testingMode = eventName.toLowerCase() === "testing";
    const treatAsAdmin = isAdmin(userPhone) && !testingMode;

    // Helper: confirm and enqueue a job with the chosen style (and optional background/brand)
    async function confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, background, brand) {
        if (!activeStyles[style]) style = activeStyleList[0] || settings.get("defaultStyle");
        const styleName = activeStyles[style] ? activeStyles[style].name : style;
        const singleStyle = activeStyleList.length === 1;
        const confirmLabel = singleStyle ? "Your portrait" : `Your ${styleName} portrait`;
        console.log(`📩 Enqueuing portrait for ${userPhone} (style: ${styleName})`);

        const printingEnabled = settings.get("enablePrinting");
        const twilioBlurb = settings.getMsg("twilioBlurb");
        const pickupText = printingEnabled
            ? settings.getMsg("pickupPrint")
            : settings.getMsg("pickupDigital");
        const pickupMsg = ` ${pickupText}${twilioBlurb ? `\n\n${twilioBlurb}` : ""}`;
        const unit = printingEnabled ? "print" : "portrait";
        const units = printingEnabled ? "prints" : "portraits";

        if (treatAsAdmin) {
            const msg = `${settings.getMsg("enqueued", { confirmLabel })}${pickupMsg}`;
            if (useTwiml) {
                twiml.message(msg);
            } else {
                const { sendSms } = require("./lib/helpers");
                await sendSms(userPhone, appPhone, msg);
            }
            enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand);
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const remaining = maxPrints - used;
            const unlimited = isAdmin(userPhone) && testingMode;

            if (remaining <= 0 && !unlimited) {
                const quotaMsg = settings.getMsg("quotaExceeded", { maxPrints, units, eventName });
                if (useTwiml) {
                    twiml.message(quotaMsg);
                } else {
                    const { sendSms } = require("./lib/helpers");
                    await sendSms(userPhone, appPhone, quotaMsg);
                }
                return;
            }

            const afterThis = unlimited ? null : remaining - 1;
            const countMsg = afterThis === null || afterThis <= 0
                ? ""
                : ` ${settings.getMsg("remainingCount", { remaining: afterThis, unit: afterThis === 1 ? unit : unit + "s" })}`;
            const msg = `${settings.getMsg("enqueued", { confirmLabel })}${pickupMsg}${countMsg}`;
            if (useTwiml) {
                twiml.message(msg);
            } else {
                const { sendSms } = require("./lib/helpers");
                await sendSms(userPhone, appPhone, msg);
            }
            enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand);
        }
    }

    // Helper: show brand menu or proceed to background/enqueue
    async function showBrandMenuOrNext(style, imageUrl, messageSid, useTwiml) {
        const activeBrands = getActiveBrands();
        const activeBrandList = Object.keys(activeBrands);
        if (settings.get("enableBrandMenu") && activeBrandList.length > 0) {
            if (activeBrandList.length === 1) {
                // Auto-select if only one brand
                await showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, useTwiml, activeBrandList[0]);
                return;
            }
            brandMenu.setPending(userPhone, { imageUrl, messageSid, style, body, appPhone, baseUrl, includeNone: true });
            const menuMsg = brandMenu.buildMenu(activeBrands, activeBrandList, { includeNone: true });
            if (useTwiml) {
                twiml.message(menuMsg);
            } else {
                const { sendSms } = require("./lib/helpers");
                await sendSms(userPhone, appPhone, menuMsg);
            }
            return;
        }
        await showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, useTwiml);
    }

    // Helper: show style menu and hold the image (auto-selects if only one style)
    async function showMenuAndHold(imageUrl, messageSid) {
        if (activeStyleList.length === 1) {
            await showBrandMenuOrNext(activeStyleList[0], imageUrl, messageSid, true);
            return;
        }
        styleMenu.setPending(userPhone, { imageUrl, messageSid, body, appPhone, baseUrl });
        twiml.message(styleMenu.buildMenu(activeStyles, activeStyleList));
    }

    // Helper: show background menu or enqueue directly
    async function showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, useTwiml, brand) {
        const { resolveBackgroundMenu } = require("./lib/prompt-assembler");

        // Legacy mode: the event configured a flat backgroundChoices list.
        // Keep serving it verbatim for existing events.
        const legacyChoices = settings.get("backgroundChoices") || [];

        // Resolve from style + brand config (new combo-driven menu).
        const styleObj = activeStyles[style] || {};
        const activeBrands = getActiveBrands();
        const brandObj = brand ? activeBrands[brand] : null;
        const resolved = resolveBackgroundMenu(styleObj, brandObj);

        // Prefer the resolved menu when non-empty; fall back to legacy otherwise.
        const useResolved = resolved.length > 0;
        const choices = useResolved ? resolved : legacyChoices;

        if (settings.get("enableBackgroundMenu") && choices.length > 0) {
            if (choices.length === 1) {
                await confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, choices[0].key, brand);
                return;
            }
            backgroundMenu.setPending(userPhone, {
                imageUrl, messageSid, style, brand, body, appPhone, baseUrl,
                resolvedChoices: choices,
            });
            const menuMsg = backgroundMenu.buildMenu(choices);
            if (useTwiml) {
                twiml.message(menuMsg);
            } else {
                const { sendSms } = require("./lib/helpers");
                await sendSms(userPhone, appPhone, menuMsg);
            }
            return;
        }
        await confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, undefined, brand);
    }

    // ── 0. NPS response ────────────────────────────────────────────────────
    if (nps.hasPending(userPhone) && numMedia === 0) {
        const trimmed = (body || "").trim();
        const score = parseInt(trimmed, 10);
        if (score >= 1 && score <= 5) {
            nps.recordScore(userPhone, eventName, score);
            twiml.message(settings.getMsg("npsThanks"));
            return res.type("text/xml").send(twiml.toString());
        }
    }

    // ── 1. Lead capture active survey ───────────────────────────────────────
    if (leadMode !== "disabled" && !treatAsAdmin && leads.isActive(userPhone)) {
        const result = await leads.processResponse(userPhone, body);

        if (result.status === "completed" && result.pendingImage) {
            const pi = result.pendingImage;
            const style = pi.style || parseStyle(pi.body, activeStyles, settings.get("defaultStyle"));
            if (pi.background) {
                await confirmAndEnqueue(style, pi.imageUrl, pi.messageSid, false, pi.background, pi.brand);
            } else if (pi.brand) {
                await showBackgroundMenuOrEnqueue(style, pi.imageUrl, pi.messageSid, false, pi.brand);
            } else {
                await showBrandMenuOrNext(style, pi.imageUrl, pi.messageSid, false);
            }
        }

        return res.type("text/xml").send(twiml.toString());
    }

    // ── 2. Background menu pending ──────────────────────────────────────────
    if (backgroundMenu.hasPending(userPhone)) {
        if (numMedia >= 1) {
            // New selfie replaces old pending — clear and fall through
            backgroundMenu.clearPending(userPhone);
        } else {
            const bgPendingState = backgroundMenu.getPending(userPhone);
            const bgChoices = bgPendingState && bgPendingState.resolvedChoices
                ? bgPendingState.resolvedChoices
                : (settings.get("backgroundChoices") || []);
            const matched = backgroundMenu.matchReply(body, bgChoices);
            if (!matched) {
                twiml.message(backgroundMenu.buildRetryMenu(bgChoices));
                return res.type("text/xml").send(twiml.toString());
            }

            const bgPending = backgroundMenu.getPending(userPhone);
            backgroundMenu.clearPending(userPhone);

            // Check if lead capture "before" is needed
            if (leadMode === "before" && !treatAsAdmin && !leads.isCompleted(userPhone, eventName)) {
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: bgPending.imageUrl,
                    messageSid: bgPending.messageSid,
                    body: bgPending.body || "",
                    style: bgPending.style,
                    background: matched,
                    brand: bgPending.brand || null,
                    baseUrl,
                });
                return res.type("text/xml").send(twiml.toString());
            }

            await confirmAndEnqueue(bgPending.style, bgPending.imageUrl, bgPending.messageSid, false, matched, bgPending.brand);
            return res.type("text/xml").send(twiml.toString());
        }
    }

    // ── 2b. Brand menu pending ─────────────────────────────────────────────
    if (brandMenu.hasPending(userPhone)) {
        if (numMedia >= 1) {
            // New selfie replaces old pending — clear and fall through
            brandMenu.clearPending(userPhone);
        } else {
            const activeBrands = getActiveBrands();
            const activeBrandList = Object.keys(activeBrands);
            const brPending = brandMenu.getPending(userPhone);
            const includeNone = brPending && brPending.includeNone;
            const matched = brandMenu.matchReply(body, activeBrands, activeBrandList, { includeNone });
            if (!matched) {
                twiml.message(brandMenu.buildRetryMenu(activeBrands, activeBrandList, { includeNone }));
                return res.type("text/xml").send(twiml.toString());
            }

            brandMenu.clearPending(userPhone);
            const effectiveBrand = matched === "__none__" ? null : matched;

            // Check if lead capture "before" is needed
            if (leadMode === "before" && !treatAsAdmin && !leads.isCompleted(userPhone, eventName)) {
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: brPending.imageUrl,
                    messageSid: brPending.messageSid,
                    body: brPending.body || "",
                    style: brPending.style,
                    brand: effectiveBrand,
                    baseUrl,
                });
                return res.type("text/xml").send(twiml.toString());
            }

            // Background menu or enqueue (with brand)
            await showBackgroundMenuOrEnqueue(brPending.style, brPending.imageUrl, brPending.messageSid, false, effectiveBrand);
            return res.type("text/xml").send(twiml.toString());
        }
    }

    // ── 3. Style menu pending ───────────────────────────────────────────────
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
            if (leadMode === "before" && !treatAsAdmin && !leads.isCompleted(userPhone, eventName)) {
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: pending.imageUrl,
                    messageSid: pending.messageSid,
                    body: pending.body,
                    style: matched,
                    baseUrl,
                });
                return res.type("text/xml").send(twiml.toString());
            }

            // Brand menu or background menu or enqueue
            await showBrandMenuOrNext(matched, pending.imageUrl, pending.messageSid, false);
            return res.type("text/xml").send(twiml.toString());
        }
    }

    // ── 4. Lead capture "before" intercept ──────────────────────────────────
    if (leadMode === "before" && !treatAsAdmin && !leads.isCompleted(userPhone, eventName) && !leads.isActive(userPhone)) {
        if (numMedia > 1) {
            twiml.message(settings.getMsg("multiplePhotos"));
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
            } else if (activeStyleList.length === 1) {
                // Auto-select the only style, but start lead survey instead of enqueuing
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: req.body.MediaUrl0,
                    messageSid: req.body.MessageSid,
                    body,
                    style: activeStyleList[0],
                    baseUrl,
                });
            } else {
                // Multiple styles — show menu; section 3 will check lead capture when they pick
                styleMenu.setPending(userPhone, { imageUrl: req.body.MediaUrl0, messageSid: req.body.MessageSid, body, appPhone, baseUrl });
                twiml.message(styleMenu.buildMenu(activeStyles, activeStyleList));
            }
        } else {
            await leads.startSurvey(userPhone, appPhone, eventName, "before", null);
        }
        return res.type("text/xml").send(twiml.toString());
    }

    // ── 5. Normal flow ──────────────────────────────────────────────────────
    if (numMedia > 1) {
        twiml.message(settings.getMsg("multiplePhotos"));
    } else if (numMedia === 1) {
        // Check quota before showing style menu or enqueuing
        if (!treatAsAdmin) {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const unlimited = isAdmin(userPhone) && testingMode;
            const printingEnabled = settings.get("enablePrinting");
            const units = printingEnabled ? "prints" : "portraits";
            if (used >= maxPrints && !unlimited) {
                twiml.message(settings.getMsg("quotaExceeded", { maxPrints, units, eventName }));
                return res.type("text/xml").send(twiml.toString());
            }
        }

        const explicitStyle = detectStyle(body, activeStyles);
        if (explicitStyle) {
            await showBrandMenuOrNext(explicitStyle, req.body.MediaUrl0, req.body.MessageSid, true);
        } else {
            await showMenuAndHold(req.body.MediaUrl0, req.body.MessageSid);
        }
    } else {
        const printingEnabled = settings.get("enablePrinting");
        const unit = printingEnabled ? "print" : "portrait";
        const styleChoices = activeStyleList.map((k) => activeStyles[k].name).join(", ");

        // Check if this looks like a real question/conversation vs a simple greeting
        const conversational = body && body.trim().length > 2
            && !/^(hi|hey|hello|yo|sup|ok|yes|no|thanks|ty|thx|k|lol)$/i.test(body.trim())
            && !/^hit send to start!?/im.test(body.trim());

        if (treatAsAdmin) {
            if (conversational) {
                const { generateSmartReply } = require("./lib/helpers");
                const reply = await generateSmartReply(body, { eventName, styleChoices, remaining: null, unit });
                if (reply) {
                    twiml.message(reply);
                    return res.type("text/xml").send(twiml.toString());
                }
            }
            twiml.message(settings.getMsg("welcome"));
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const remaining = maxPrints - used;
            if (remaining <= 0) {
                twiml.message(settings.getMsg("quotaExceeded", { maxPrints, units: unit + "s", eventName }));
            } else {
                if (conversational) {
                    const { generateSmartReply } = require("./lib/helpers");
                    const reply = await generateSmartReply(body, { eventName, styleChoices, remaining, unit });
                    if (reply) {
                        twiml.message(reply);
                        return res.type("text/xml").send(twiml.toString());
                    }
                }
                const countNote = used === 0
                    ? ` ${settings.getMsg("welcomeCount", { maxPrints, unit: maxPrints === 1 ? unit : unit + "s", eventName })}`
                    : ` ${settings.getMsg("remainingCount", { remaining, unit: remaining === 1 ? unit : unit + "s" })}`;
                twiml.message(`${settings.getMsg("welcome")}${countNote}`);
            }
        }
    }
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error(`❌ SMS webhook error: ${err.message}`);
    if (!res.headersSent) {
        const twiml = new MessagingResponse();
        res.type("text/xml").send(twiml.toString());
    }
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

// Load settings before accepting connections
settings.load();

const server = app.listen(port, "0.0.0.0", async () => {
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    console.log(`🚀 App running on port ${port} | Event: ${settings.get("eventName")}`);
    // Ensure download dir for current event exists
    const dlDir = settings.getDownloadDir();
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    await buildUsageCache();
    leads.load();
    nps.load();
    contacts.load();
    settings.onEventNameChange(() => buildUsageCache());
    await recoverStaleJobs();
    mountHome(app);
    mountPhotoGallery(app);
    mountDashboard(app);
    mountOutreach(app);
    mountShare(app);
    mountPrintRelay(app);
    mountReview(app);
    let genPollRunning = false;
    setInterval(async () => {
        if (genPollRunning || settings.get("queuePaused")) return;
        genPollRunning = true;
        try { await processGenerationQueue(); }
        finally { genPollRunning = false; }
    }, POLL_INTERVAL);
    let printPollRunning = false;
    setInterval(async () => {
        if (printPollRunning || settings.get("queuePaused")) return;
        printPollRunning = true;
        try {
            await recoverStaleRelayJobs();
            await clearStaleRelayTargets();
            await processPrintQueue();
        }
        finally { printPollRunning = false; }
    }, POLL_INTERVAL);
    console.log(`⏱️  Workers started (polling every ${POLL_INTERVAL}ms, max ${settings.get("maxConcurrentGeneration")} concurrent generations)`);

    // Auto-open home page in the default browser (skip in production/Docker)
    const host = `http://localhost:${port}`;
    if (process.env.NODE_ENV !== "production") {
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${openCmd} ${host}`, (err) => {
            if (err) console.log(`🏠 Home available at ${host}`);
        });
    } else {
        console.log(`🏠 Home available at ${host}`);
    }
});
