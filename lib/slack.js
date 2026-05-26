"use strict";
const { App, ExpressReceiver } = require("@slack/bolt");
const settings = require("./settings");

const token = process.env.SLACK_BOT_TOKEN || "";
const signingSecret = process.env.SLACK_SIGNING_SECRET || "";

let _app = null;
let _receiver = null;

function isConfigured() {
    return Boolean(token && signingSecret);
}

function _getChannel() {
    return settings.get("slackChannel") || "";
}

if (isConfigured()) {
    _receiver = new ExpressReceiver({ signingSecret, path: "/slack/events" });
    _app = new App({ token, receiver: _receiver });
    _registerActions(_app);
}

async function postPortraitFeed(job) {
    if (!isConfigured()) return;
    if (settings.get("slackFeedMode") === "off") return;
    if (settings.get("reviewMode") === "human") return;
    const channel = _getChannel();
    if (!channel) return;
    // Full implementation added in a later task
}

async function postReviewRequest(job) {
    if (!isConfigured()) return;
    const channel = _getChannel();
    if (!channel) return;
    // Full implementation added in a later task
}

async function notifyJobActioned(job, action, actor) {
    if (!isConfigured()) return;
    if (!job.slackTs) return;
    // Full implementation added in a later task
}

function _registerActions(app) {
    // Action handlers registered in a later task
    // Uses lazy require("./queue") here (not top-level) to avoid circular dependency
}

function mountReceiver(expressApp) {
    if (!_receiver) return;
    expressApp.use(_receiver.router);
}

module.exports = { isConfigured, postPortraitFeed, postReviewRequest, notifyJobActioned, mountReceiver };
