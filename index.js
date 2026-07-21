require("./lib/log-buffer").init();
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const express = require("express");
const bodyParser = require("body-parser");
const channels = require("./lib/channels");
const messaging = require("./lib/messaging");
const { getMessageBody, getNpsScore } = require("./lib/inbound-payload");
const richMenu = require("./lib/rich-menu");
const contentTemplates = require("./lib/content-templates");
const languageMenu = require("./lib/language-menu");
const i18n = require("./lib/i18n");
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
    sweepStaleGenerating,
    processGenerationQueue,
    processPrintQueue,
    recoverStaleRelayJobs,
    clearStaleRelayTargets,
    sweepMissingOutputJobs,
} = require("./lib/queue");
const { parseStyle, detectStyle } = require("./lib/styles");
const styleMenu = require("./lib/style-menu");
const brandMenu = require("./lib/brand-menu");
const backgroundMenu = require("./lib/background-menu");
const { getActiveBrands } = require("./lib/brands");
const { mountDashboard } = require("./lib/dashboard");
const { mountApiGenerate } = require("./lib/api-generate");
const { mountKiosk } = require("./lib/kiosk");
const { mountReview } = require("./lib/review");
const { mountExperiments } = require("./lib/experiments");
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
const { createTwilioWebhookValidator } = require("./lib/twilio-webhook");
const { channelWarnings } = require("./lib/config-warnings");
const { mountHealth, setReady, isReady } = require("./lib/health");
mountHealth(app);
mountAuth(app);
app.use((req, res, next) => {
    if (isReady() || req.path.startsWith("/healthz") || req.path.startsWith("/auth")) return next();
    return res.status(503).send("Application is starting");
});
app.use((req, res, next) => {
    if (isPublicRoute(req)) return next();
    requireAuth(req, res, next);
});

app.get("/", (req, res) => res.redirect("/home"));
// CSS changes often in this project (admin UI polish, pulse animations, etc.)
// so cache stylesheets briefly (5 minutes) while still letting fonts and
// images stay cached for a day. Otherwise admins see stale visuals until a
// manual hard-refresh on every CSS deploy.
app.use("/assets", express.static(path.join(__dirname, "assets"), {
    maxAge: "1d",
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(".css")) {
            res.setHeader("Cache-Control", "public, max-age=300"); // 5 min
        }
    },
}));

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

async function inboundHandler(req, res) {
  try {
    if (!baseUrl) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
        baseUrl = `${proto}://${req.headers.host}`;
        console.log(`🌐 Base URL detected: ${baseUrl}`);
    }

    // Skip duplicate webhook deliveries (Twilio retries)
    if (markSid(req.body.MessageSid)) {
        console.log(`⚠️  Duplicate webhook skipped: ${req.body.MessageSid}`);
        return res.status(204).end();
    }

    const inboundAdapter = channels.detectChannel(req.body);
    const userPhone = inboundAdapter.normalizeFrom(req.body.From);
    const appPhone = inboundAdapter.normalizeFrom(req.body.To);
    let numMedia = parseInt(req.body.NumMedia || "0", 10);
    let body = getMessageBody(req.body);

    const activeStyles = settings.getActiveStyles();
    const activeStyleList = settings.getActiveStyleList();
    const leadMode = settings.get("leadCaptureMode");
    const eventName = settings.get("eventName");

    // Track first contact for drop-off detection
    contacts.recordContact(userPhone, appPhone, eventName);
    contacts.recordInbound(userPhone, inboundAdapter.name);

    async function promptForLanguage() {
        if (inboundAdapter.name === "whatsapp") {
            const contentSid = await contentTemplates.getOrCreateLanguagePicker();
            if (contentSid) {
                const result = await messaging.send(userPhone, "languagePicker", {}, { adapter: inboundAdapter, contentSid });
                if (!result || !result.error) return;
            }
        }
        await messaging.send(userPhone, "_raw", {}, { _body: i18n.languagePrompt(inboundAdapter.name), adapter: inboundAdapter });
    }

    const languageMode = settings.get("languageMode") || "en";
    let heldLanguageSelfie = languageMenu.getPending(userPhone);
    if (heldLanguageSelfie && heldLanguageSelfie.eventName !== eventName) {
        languageMenu.clearPending(userPhone);
        heldLanguageSelfie = null;
    }
    if (languageMode !== "ask" && heldLanguageSelfie) {
        languageMenu.clearPending(userPhone);
        if (numMedia === 0 && heldLanguageSelfie.eventName === eventName && heldLanguageSelfie.imageUrl) {
            req.body.MediaUrl0 = heldLanguageSelfie.imageUrl;
            req.body.MessageSid = heldLanguageSelfie.messageSid;
            numMedia = 1;
            body = heldLanguageSelfie.body || "";
        }
    }

    function pendingForEvent(menu) {
        const pending = menu.getPending(userPhone);
        if (pending && pending.eventName !== eventName) {
            menu.clearPending(userPhone);
            return null;
        }
        return pending;
    }

    let pendingBackground = pendingForEvent(backgroundMenu);
    let pendingBrand = pendingForEvent(brandMenu);
    let pendingStyle = pendingForEvent(styleMenu);
    if (numMedia >= 1) {
        if (pendingBackground) backgroundMenu.clearPending(userPhone);
        if (pendingBrand) brandMenu.clearPending(userPhone);
        if (pendingStyle) styleMenu.clearPending(userPhone);
        pendingBackground = null;
        pendingBrand = null;
        pendingStyle = null;
    }

    const preferredLocale = contacts.getPreferredLocale(userPhone, eventName);
    const pendingRating = nps.getLatestPending(userPhone);
    if (pendingRating && !heldLanguageSelfie && !pendingBackground && !pendingBrand && !pendingStyle
        && !leads.isActive(userPhone) && numMedia === 0) {
        const score = getNpsScore(body);
        if (score !== null) {
            const ratingEvent = pendingRating.eventName || eventName;
            const ratingLocale = pendingRating.locale || i18n.resolveAttendeeLocale(
                settings.getForEvent("languageMode", ratingEvent),
                contacts.getPreferredLocale(userPhone, ratingEvent),
            ) || i18n.DEFAULT_LOCALE;
            nps.recordScore(userPhone, ratingEvent, score);
            await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(ratingLocale, "npsThanks", {}, ratingEvent), adapter: inboundAdapter });
            return res.status(204).end();
        }
    }

    const activeLocale = leads.getActiveLocale(userPhone)
        || (pendingBackground || {}).locale
        || (pendingBrand || {}).locale
        || (pendingStyle || {}).locale;
    let locale = i18n.resolveAttendeeLocale(
        languageMode,
        preferredLocale,
        activeLocale,
    );
    const canSelectLanguage = i18n.shouldApplyLanguageSelection(languageMode, body, {
        activeLocale,
        selectionPending: !!heldLanguageSelfie,
    });
    const selectedLocale = canSelectLanguage ? i18n.parseLanguageSelection(body) : null;
    const wantsLanguageMenu = languageMode === "ask" && !activeLocale
        && /^(language|idioma)$/i.test(String(body || "").trim());
    if (selectedLocale) {
        locale = selectedLocale;
        contacts.setPreferredLocale(userPhone, eventName, locale);
        const held = languageMenu.getPending(userPhone);
        if (held && held.eventName === eventName && held.imageUrl) {
            languageMenu.clearPending(userPhone);
            req.body.MediaUrl0 = held.imageUrl;
            req.body.MessageSid = held.messageSid;
            numMedia = 1;
            body = held.body || "";
        } else if (numMedia === 0) {
            if (held) languageMenu.clearPending(userPhone);
            await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(locale, "welcome", {}, eventName), adapter: inboundAdapter });
            return res.status(204).end();
        } else if (held) {
            languageMenu.clearPending(userPhone);
        }
    } else if (languageMode === "ask" && !activeLocale && (!locale || wantsLanguageMenu || heldLanguageSelfie)) {
        languageMenu.setPending(userPhone, {
            imageUrl: numMedia === 1 ? req.body.MediaUrl0 : (heldLanguageSelfie && heldLanguageSelfie.imageUrl),
            messageSid: numMedia === 1 ? req.body.MessageSid : (heldLanguageSelfie && heldLanguageSelfie.messageSid),
            body: numMedia === 1 ? body : ((heldLanguageSelfie && heldLanguageSelfie.body) || body),
            eventName,
        });
        await promptForLanguage();
        return res.status(204).end();
    }

    // Testing mode: admins experience the full regular-user flow (intro, promo,
    // status messages, lead capture) but with unlimited quota.
    const testingMode = eventName.toLowerCase() === "testing";
    const treatAsAdmin = isAdmin(userPhone) && !testingMode;

    async function sendMenu(menuKind, options, copy, fallbackText) {
        const result = await richMenu.sendMenu(userPhone, inboundAdapter, menuKind, options, copy);
        if (!result.rich) {
            await messaging.send(userPhone, "_raw", {}, { _body: fallbackText, adapter: inboundAdapter });
        }
    }

    function styleOptions() {
        return activeStyleList.map((key) => ({
            key,
            name: activeStyles[key].name || key,
            description: activeStyles[key].description || activeStyles[key].core || "Tap to choose",
        }));
    }

    function brandOptions(activeBrands, activeBrandList, includeNone) {
        const options = activeBrandList.slice(0, includeNone ? 9 : 10).map((key) => ({
            key,
            name: activeBrands[key].name || key,
            description: activeBrands[key].description || "Tap to choose",
        }));
        if (includeNone) options.push({
            key: "none",
            name: locale === "pt_BR" ? "Nenhum" : "None",
            description: locale === "pt_BR" ? "Sem tema de marca" : "No brand theme",
        });
        return options;
    }

    // Helper: confirm and enqueue a job with the chosen style (and optional background/brand)
    async function confirmAndEnqueue(style, imageUrl, messageSid, background, brand) {
        if (!activeStyles[style]) style = activeStyleList[0] || settings.get("defaultStyle");
        const styleName = activeStyles[style] ? activeStyles[style].name : style;
        const styleNameLower = typeof styleName === "string" ? styleName.toLowerCase() : styleName;
        const singleStyle = activeStyleList.length === 1;
        const confirmLabel = locale === "pt_BR"
            ? (singleStyle ? "Seu retrato" : `Seu retrato em estilo ${styleNameLower}`)
            : (singleStyle ? "Your portrait" : `Your ${styleNameLower} portrait`);
        const { maskPhone } = require("./lib/helpers");
        console.log(`📩 Enqueuing portrait for ${maskPhone(userPhone)} (style: ${styleName})`);

        const printingEnabled = settings.get("enablePrinting");
        const twilioBlurb = i18n.t(locale, "twilioBlurb", {}, eventName);
        const pickupText = printingEnabled
            ? i18n.t(locale, "pickupPrint", {}, eventName)
            : i18n.t(locale, "pickupDigital", {}, eventName);
        const pickupMsg = ` ${pickupText}${twilioBlurb ? `\n\n${twilioBlurb}` : ""}`;
        const unit = locale === "pt_BR" ? (printingEnabled ? "impressão" : "retrato") : (printingEnabled ? "print" : "portrait");
        const units = locale === "pt_BR" ? (printingEnabled ? "impressões" : "retratos") : (printingEnabled ? "prints" : "portraits");

        if (treatAsAdmin) {
            const msg = `${i18n.t(locale, "enqueued", { confirmLabel }, eventName)}${pickupMsg}`;
            await messaging.send(userPhone, "_raw", {}, { _body: msg, adapter: inboundAdapter });
            enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand, { channel: inboundAdapter.name, locale });
            require("./lib/still-working").arm(userPhone, appPhone, eventName, inboundAdapter, locale);
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const quotaUnlimited = settings.isUnlimitedQuota(maxPrints);
            const remaining = maxPrints - used;
            const unlimited = (isAdmin(userPhone) && testingMode) || quotaUnlimited;

            if (remaining <= 0 && !unlimited) {
                const quotaMsg = i18n.t(locale, "quotaExceeded", { maxPrints, units, eventName }, eventName);
                await messaging.send(userPhone, "_raw", {}, { _body: quotaMsg, adapter: inboundAdapter });
                return;
            }

            const afterThis = unlimited ? null : remaining - 1;
            const countMsg = afterThis === null || afterThis <= 0
                ? ""
                : ` ${i18n.t(locale, "remainingCount", { remaining: afterThis, unit: afterThis === 1 || locale === "pt_BR" ? unit : unit + "s" }, eventName)}`;
            const msg = `${i18n.t(locale, "enqueued", { confirmLabel }, eventName)}${pickupMsg}${countMsg}`;
            await messaging.send(userPhone, "_raw", {}, { _body: msg, adapter: inboundAdapter });
            enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand, { channel: inboundAdapter.name, locale });
            require("./lib/still-working").arm(userPhone, appPhone, eventName, inboundAdapter, locale);
        }
    }

    // Helper: show brand menu or proceed to background/enqueue
    async function showBrandMenuOrNext(style, imageUrl, messageSid) {
        const activeBrands = getActiveBrands();
        const activeBrandList = Object.keys(activeBrands);
        if (settings.get("enableBrandMenu") && activeBrandList.length > 0) {
            if (activeBrandList.length === 1) {
                // Auto-select if only one brand
                await showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, activeBrandList[0]);
                return;
            }
            brandMenu.setPending(userPhone, { imageUrl, messageSid, style, body, appPhone, baseUrl, includeNone: true, locale, eventName });
            const menuMsg = brandMenu.buildMenu(activeBrands, activeBrandList, { includeNone: true, locale, eventName });
            await sendMenu("brandMenu", brandOptions(activeBrands, activeBrandList, true), {
                body: i18n.t(locale, "brandMenuIntro", {}, eventName), button: locale === "pt_BR" ? "Escolher tema" : "Choose a theme",
            }, menuMsg);
            return;
        }
        await showBackgroundMenuOrEnqueue(style, imageUrl, messageSid);
    }

    // Helper: show style menu and hold the image (auto-selects if only one style)
    async function showMenuAndHold(imageUrl, messageSid) {
        if (activeStyleList.length === 1) {
            await showBrandMenuOrNext(activeStyleList[0], imageUrl, messageSid);
            return;
        }
        styleMenu.setPending(userPhone, { imageUrl, messageSid, body, appPhone, baseUrl, locale, eventName });
        await sendMenu("styleMenu", styleOptions(), {
            body: i18n.t(locale, "styleMenuIntro", {}, eventName), button: locale === "pt_BR" ? "Escolher estilo" : "Choose a style",
        }, styleMenu.buildMenu(activeStyles, activeStyleList, { locale, eventName }));
    }

    // Helper: show background menu or enqueue directly
    async function showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, brand) {
        const { selectBackgroundChoices } = require("./lib/prompt-assembler");

        // The event's admin-configured flat backgroundChoices list, if any.
        const configuredChoices = settings.get("backgroundChoices") || [];

        // Resolve style + brand config so the combo-driven menu can take over
        // when (and only when) the brand/style combo actually shapes the menu.
        const styleObj = activeStyles[style] || {};
        const activeBrands = getActiveBrands();
        const brandObj = brand ? activeBrands[brand] : null;

        // selectBackgroundChoices serves the configured list for non-combo
        // events and the combo-resolved menu otherwise. (Previously this used
        // `resolved.length > 0`, which is always true and permanently shadowed
        // the admin-configured list.)
        const choices = selectBackgroundChoices(styleObj, brandObj, configuredChoices);

        if (settings.get("enableBackgroundMenu") && choices.length > 0) {
            if (choices.length === 1) {
                await confirmAndEnqueue(style, imageUrl, messageSid, choices[0].key, brand);
                return;
            }
            backgroundMenu.setPending(userPhone, {
                imageUrl, messageSid, style, brand, body, appPhone, baseUrl,
                resolvedChoices: choices,
                locale,
                eventName,
            });
            const menuMsg = backgroundMenu.buildMenu(choices, { locale, eventName });
            await sendMenu("backgroundMenu", choices, {
                body: i18n.t(locale, "backgroundMenuIntro", {}, eventName), button: locale === "pt_BR" ? "Escolher fundo" : "Choose background",
            }, menuMsg);
            return;
        }
        await confirmAndEnqueue(style, imageUrl, messageSid, undefined, brand);
    }

    // ── 1. Lead capture active survey ───────────────────────────────────────
    if (leads.isActive(userPhone)) {
        const result = await leads.processResponse(userPhone, body);
        if (result.locale) locale = result.locale;

        if (result.status === "completed" && result.pendingImage) {
            const pi = result.pendingImage;
            const style = pi.style || parseStyle(pi.body, activeStyles, settings.get("defaultStyle"));
            if (pi.background) {
                await confirmAndEnqueue(style, pi.imageUrl, pi.messageSid, pi.background, pi.brand);
            } else if (pi.brandPicked) {
                // User already chose a brand (possibly "None" → null) before lead capture.
                // Don't re-ask; proceed to background.
                await showBackgroundMenuOrEnqueue(style, pi.imageUrl, pi.messageSid, pi.brand);
            } else if (pi.brand) {
                await showBackgroundMenuOrEnqueue(style, pi.imageUrl, pi.messageSid, pi.brand);
            } else {
                await showBrandMenuOrNext(style, pi.imageUrl, pi.messageSid);
            }
        }

        return res.status(204).end();
    }

    // ── 2. Background menu pending ──────────────────────────────────────────
    if (backgroundMenu.hasPending(userPhone)) {
        if (numMedia >= 1) {
            // New selfie replaces old pending — clear and fall through
            backgroundMenu.clearPending(userPhone);
            locale = i18n.resolveAttendeeLocale(languageMode, preferredLocale);
        } else {
            const bgPendingState = backgroundMenu.getPending(userPhone);
            const bgChoices = bgPendingState && bgPendingState.resolvedChoices
                ? bgPendingState.resolvedChoices
                : (settings.get("backgroundChoices") || []);
            const matched = backgroundMenu.matchReply(body, bgChoices);
            if (!matched) {
                await sendMenu("backgroundMenu", bgChoices, {
                    body: i18n.t(locale, "backgroundMenuRetry", {}, eventName), button: locale === "pt_BR" ? "Escolher fundo" : "Choose background",
                }, backgroundMenu.buildRetryMenu(bgChoices, { locale, eventName }));
                return res.status(204).end();
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
                }, locale);
                return res.status(204).end();
            }

            await confirmAndEnqueue(bgPending.style, bgPending.imageUrl, bgPending.messageSid, matched, bgPending.brand);
            return res.status(204).end();
        }
    }

    // ── 2b. Brand menu pending ─────────────────────────────────────────────
    if (brandMenu.hasPending(userPhone)) {
        if (numMedia >= 1) {
            // New selfie replaces old pending — clear and fall through
            brandMenu.clearPending(userPhone);
            locale = i18n.resolveAttendeeLocale(languageMode, preferredLocale);
        } else {
            const activeBrands = getActiveBrands();
            const activeBrandList = Object.keys(activeBrands);
            const brPending = brandMenu.getPending(userPhone);
            const includeNone = brPending && brPending.includeNone;
            const matched = brandMenu.matchReply(body, activeBrands, activeBrandList, { includeNone });
            if (!matched) {
                await sendMenu("brandMenu", brandOptions(activeBrands, activeBrandList, includeNone), {
                    body: i18n.t(locale, "brandMenuRetry", {}, eventName), button: locale === "pt_BR" ? "Escolher tema" : "Choose a theme",
                }, brandMenu.buildRetryMenu(activeBrands, activeBrandList, { includeNone, locale, eventName }));
                return res.status(204).end();
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
                    brandPicked: true,
                    baseUrl,
                }, locale);
                return res.status(204).end();
            }

            // Background menu or enqueue (with brand)
            await showBackgroundMenuOrEnqueue(brPending.style, brPending.imageUrl, brPending.messageSid, effectiveBrand);
            return res.status(204).end();
        }
    }

    // ── 3. Style menu pending ───────────────────────────────────────────────
    if (styleMenu.hasPending(userPhone)) {
        if (numMedia >= 1) {
            // New selfie replaces old pending — clear and fall through
            styleMenu.clearPending(userPhone);
            locale = i18n.resolveAttendeeLocale(languageMode, preferredLocale);
        } else {
            // Text reply — try to match a style
            const matched = styleMenu.matchReply(body, activeStyles, activeStyleList);
            if (!matched) {
                await sendMenu("styleMenu", styleOptions(), {
                    body: i18n.t(locale, "styleMenuRetry", {}, eventName), button: locale === "pt_BR" ? "Escolher estilo" : "Choose a style",
                }, styleMenu.buildRetryMenu(activeStyles, activeStyleList, { locale, eventName }));
                return res.status(204).end();
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
                }, locale);
                return res.status(204).end();
            }

            // Brand menu or background menu or enqueue
            await showBrandMenuOrNext(matched, pending.imageUrl, pending.messageSid);
            return res.status(204).end();
        }
    }

    // ── 4. Lead capture "before" intercept ──────────────────────────────────
    if (leadMode === "before" && !treatAsAdmin && !leads.isCompleted(userPhone, eventName) && !leads.isActive(userPhone)) {
        if (numMedia > 1) {
            await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(locale, "multiplePhotos", {}, eventName), adapter: inboundAdapter });
        } else if (numMedia === 1) {
            const explicitStyle = detectStyle(body, activeStyles);
            if (explicitStyle) {
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: req.body.MediaUrl0,
                    messageSid: req.body.MessageSid,
                    body,
                    style: explicitStyle,
                    baseUrl,
                }, locale);
            } else if (activeStyleList.length === 1) {
                // Auto-select the only style, but start lead survey instead of enqueuing
                await leads.startSurvey(userPhone, appPhone, eventName, "before", {
                    imageUrl: req.body.MediaUrl0,
                    messageSid: req.body.MessageSid,
                    body,
                    style: activeStyleList[0],
                    baseUrl,
                }, locale);
            } else {
                // Multiple styles — show menu; section 3 will check lead capture when they pick
                await showMenuAndHold(req.body.MediaUrl0, req.body.MessageSid);
            }
        } else {
            await leads.startSurvey(userPhone, appPhone, eventName, "before", null, locale);
        }
        return res.status(204).end();
    }

    // ── 5. Normal flow ──────────────────────────────────────────────────────
    if (numMedia > 1) {
        await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(locale, "multiplePhotos", {}, eventName), adapter: inboundAdapter });
    } else if (numMedia === 1) {
        // Check quota before showing style menu or enqueuing
        if (!treatAsAdmin) {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const quotaUnlimited = settings.isUnlimitedQuota(maxPrints);
            const unlimited = (isAdmin(userPhone) && testingMode) || quotaUnlimited;
            const printingEnabled = settings.get("enablePrinting");
            const units = locale === "pt_BR" ? (printingEnabled ? "impressões" : "retratos") : (printingEnabled ? "prints" : "portraits");
            if (used >= maxPrints && !unlimited) {
                await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(locale, "quotaExceeded", { maxPrints, units, eventName }, eventName), adapter: inboundAdapter });
                return res.status(204).end();
            }
        }

        const explicitStyle = detectStyle(body, activeStyles);
        if (explicitStyle) {
            await showBrandMenuOrNext(explicitStyle, req.body.MediaUrl0, req.body.MessageSid);
        } else {
            await showMenuAndHold(req.body.MediaUrl0, req.body.MessageSid);
        }
    } else {
        const printingEnabled = settings.get("enablePrinting");
        const unit = locale === "pt_BR" ? (printingEnabled ? "impressão" : "retrato") : (printingEnabled ? "print" : "portrait");
        const styleChoices = activeStyleList.map((k) => activeStyles[k].name).join(", ");

        // Check if this looks like a real question/conversation vs a simple greeting
        const conversational = body && body.trim().length > 2
            && !/^(hi|hey|hello|yo|sup|ok|yes|no|thanks|ty|thx|k|lol)$/i.test(body.trim())
            && !/^hit send to start!?/im.test(body.trim());

        if (treatAsAdmin) {
            if (conversational) {
                const { generateSmartReply } = require("./lib/helpers");
                const reply = await generateSmartReply(body, { eventName, styleChoices, remaining: null, unit, locale });
                if (reply) {
                    await messaging.send(userPhone, "_raw", {}, { _body: reply, adapter: inboundAdapter });
                    return res.status(204).end();
                }
            }
            await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(locale, "welcome", {}, eventName), adapter: inboundAdapter });
        } else {
            const used = getUsageCount(userPhone);
            const maxPrints = settings.get("maxPrints");
            const quotaUnlimited = settings.isUnlimitedQuota(maxPrints);
            const remaining = maxPrints - used;
            if (remaining <= 0 && !quotaUnlimited) {
                await messaging.send(userPhone, "_raw", {}, { _body: i18n.t(locale, "quotaExceeded", { maxPrints, units: locale === "pt_BR" ? unit : unit + "s", eventName }, eventName), adapter: inboundAdapter });
            } else {
                if (conversational) {
                    const { generateSmartReply } = require("./lib/helpers");
                    const reply = await generateSmartReply(body, {
                        eventName, styleChoices,
                        remaining: quotaUnlimited ? null : remaining, unit, locale,
                    });
                    if (reply) {
                        await messaging.send(userPhone, "_raw", {}, { _body: reply, adapter: inboundAdapter });
                        return res.status(204).end();
                    }
                }
                // Unlimited: no welcome/remaining counts. Otherwise first-time
                // gets welcomeCount, subsequent messages get remainingCount.
                var countNote = "";
                if (!quotaUnlimited) {
                    countNote = used === 0
                        ? ` ${i18n.t(locale, "welcomeCount", { maxPrints, unit: maxPrints === 1 || locale === "pt_BR" ? unit : unit + "s", eventName }, eventName)}`
                        : ` ${i18n.t(locale, "remainingCount", { remaining, unit: remaining === 1 || locale === "pt_BR" ? unit : unit + "s" }, eventName)}`;
                }
                await messaging.send(userPhone, "_raw", {}, { _body: `${i18n.t(locale, "welcome", {}, eventName)}${countNote}`, adapter: inboundAdapter });
            }
        }
    }
    return res.status(204).end();
  } catch (err) {
    console.error(`❌ Inbound webhook error: ${err.message}`);
    if (!res.headersSent) res.status(500).end();
  }
}

const validateTwilioWebhook = createTwilioWebhookValidator();
app.post("/inbound", validateTwilioWebhook, inboundHandler);
app.post("/sms", validateTwilioWebhook, inboundHandler);

// ── Start ────────────────────────────────────────────────────────────────────

// Load settings before accepting connections
settings.load();
const channelIssues = channelWarnings(settings.getAll());
for (const issue of channelIssues) console.error(`❌ ${issue.message}`);
if (channelIssues.some((issue) => issue.fatal)) {
    throw new Error("Invalid messaging sender configuration");
}

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
    mountApiGenerate(app);
    mountKiosk(app);
    await mountExperiments(app);
    setReady();
    let genPollRunning = false;
    setInterval(async () => {
        if (genPollRunning || settings.get("queuePaused")) return;
        genPollRunning = true;
        try {
            // Rescue jobs stuck in GENERATING_DIR before claiming new work —
            // otherwise a hung worker blocks a concurrency slot indefinitely.
            await sweepStaleGenerating();
            await processGenerationQueue();
        } finally { genPollRunning = false; }
    }, POLL_INTERVAL);
    let printPollRunning = false;
    setInterval(async () => {
        if (printPollRunning || settings.get("queuePaused")) return;
        printPollRunning = true;
        try {
            await recoverStaleRelayJobs();
            await clearStaleRelayTargets();
            await sweepMissingOutputJobs();
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
