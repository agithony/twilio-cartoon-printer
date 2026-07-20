const twilio = require("twilio");
const settings = require("./settings");

function buildRequestUrl(req, configuredBaseUrl = process.env.BASE_URL) {
    if (configuredBaseUrl) {
        return configuredBaseUrl.replace(/\/$/, "") + req.originalUrl;
    }
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    return `${proto}://${host}${req.originalUrl}`;
}

function createTwilioWebhookValidator(options = {}) {
    const getAuthToken = options.getAuthToken || (() => settings.get("twilioAuthToken"));
    const validateRequest = options.validateRequest || twilio.validateRequest;
    const configuredBaseUrl = options.baseUrl;

    return function validateTwilioWebhook(req, res, next) {
        if (process.env.SKIP_TWILIO_SIGNATURE_VALIDATION === "true") return next();

        const authToken = getAuthToken();
        if (!authToken) return res.status(503).send("Twilio webhook validation is not configured");

        const signature = req.get("x-twilio-signature");
        const requestUrl = buildRequestUrl(req, configuredBaseUrl);
        if (!signature || !validateRequest(authToken, signature, requestUrl, req.body || {})) {
            return res.status(403).send("Invalid Twilio signature");
        }
        return next();
    };
}

module.exports = { buildRequestUrl, createTwilioWebhookValidator };
