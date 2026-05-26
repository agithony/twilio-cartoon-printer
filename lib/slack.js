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

function _maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    if (phone.startsWith("api:")) return "Kiosk";
    const tail = phone.slice(-4);
    const ccLen = phone.length > 12 ? 4 : 2;
    return `${phone.slice(0, ccLen)}*****${tail}`;
}

async function _uploadImage(imagePath) {
    const fs = require("fs");
    const path = require("path");
    const filename = path.basename(imagePath);
    const result = await _app.client.filesGetUploadURLExternal({
        filename,
        length: fs.statSync(imagePath).size,
    });
    const { upload_url, file_id } = result;
    const fileData = fs.readFileSync(imagePath);
    await require("axios").post(upload_url, fileData, {
        headers: { "Content-Type": "application/octet-stream" },
    });
    await _app.client.filesCompleteUploadExternal({
        files: [{ id: file_id, title: filename }],
    });
    return file_id;
}

async function postPortraitFeed(job) {
    if (!isConfigured()) return;
    if (settings.get("slackFeedMode") === "off") return;
    if (settings.get("reviewMode") === "human") return;
    const channel = _getChannel();
    if (!channel) return;
    const path = require("path");
    const config = require("./config");
    const mmsPath = path.join(config.getDownloadDir(job.eventName), `${job.filePrefix}_output_mms.jpg`);
    const shareUrl = job.shareUrl || "";
    const phone = _maskPhone(job.userPhone);
    const styleName = job.style || "Unknown style";
    const eventName = job.eventName || "";
    try {
        const fileId = await _uploadImage(mmsPath);
        await _app.client.chatPostMessage({
            channel,
            text: `Portrait: ${styleName} — ${phone} — ${eventName}`,
            blocks: [
                { type: "image", image_url: `https://files.slack.com/files-pri/${fileId}`, alt_text: "Portrait" },
                {
                    type: "section",
                    text: { type: "mrkdwn", text: `*${styleName}* — ${phone} — ${eventName}${shareUrl ? `\n→ Share: ${shareUrl}` : ""}` },
                },
            ],
        });
    } catch (err) {
        console.error(`[Slack] postPortraitFeed failed: ${err.message}`);
    }
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
