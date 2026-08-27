const settings = require("./settings");
const {
    authenticateAdminSession,
    credentialMatches,
    parseCookie,
    verifyReviewToken,
} = require("./auth");

function getReviewCredentials() {
    const reviewPin = settings.get("reviewPin");
    return {
        reviewPin: typeof reviewPin === "string" ? reviewPin : "",
    };
}

function authenticateReviewPin(candidate) {
    const entered = typeof candidate === "string" ? candidate.trim() : "";
    const credentials = getReviewCredentials();
    return credentialMatches(entered, credentials.reviewPin)
        ? { method: "reviewPin", credential: credentials.reviewPin }
        : null;
}

function authenticateReviewRequest(req) {
    const user = authenticateAdminSession(req);
    if (user) return { method: "adminSession", user };

    const token = parseCookie(req, "review_token");
    const reviewSession = verifyReviewToken(token, getReviewCredentials());
    return reviewSession ? { method: "reviewToken", reviewSession } : null;
}

function requireStagedMediaAuth(req, res, next) {
    res.setHeader("Cache-Control", "private, no-store");
    if (authenticateReviewRequest(req)) return next();
    return res.status(401).send("Unauthorized");
}

module.exports = {
    authenticateReviewPin,
    authenticateReviewRequest,
    getReviewCredentials,
    requireStagedMediaAuth,
};
