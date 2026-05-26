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
    const path = require("path");
    const config = require("./config");
    const fs = require("fs");
    const stagedPath = path.join(config.getDownloadDir(job.eventName), ".staging", `${job.filePrefix}_output_mms.jpg`);
    const finalPath = path.join(config.getDownloadDir(job.eventName), `${job.filePrefix}_output_mms.jpg`);
    const mmsPath = fs.existsSync(stagedPath) ? stagedPath : finalPath;
    const phone = _maskPhone(job.userPhone);
    const styleName = job.style || "Unknown style";
    const eventName = job.eventName || "";
    const isMultiVariant = Boolean(job.parentJobId);
    try {
        const blocks = isMultiVariant
            ? _buildMultiVariantBlocks([job])
            : _buildSingleVariantBlocks(job, phone, styleName, eventName);
        const result = await _app.client.chatPostMessage({
            channel,
            text: `Review needed: ${styleName} — ${phone} — ${eventName}`,
            blocks,
        });
        job.slackTs = result.ts;
        job.slackChannel = result.channel;
    } catch (err) {
        console.error(`[Slack] postReviewRequest failed: ${err.message}`);
    }
}

function _buildSingleVariantBlocks(job, phone, styleName, eventName) {
    return [
        { type: "section", text: { type: "mrkdwn", text: `🔍 *Review needed* — *${styleName}* — ${phone} — ${eventName}` } },
        {
            type: "actions",
            elements: [
                { type: "button", text: { type: "plain_text", text: "✓ Approve" }, style: "primary", action_id: "slack_approve", value: job.filename },
                { type: "button", text: { type: "plain_text", text: "✕ Reject" }, style: "danger", action_id: "slack_reject", value: JSON.stringify({ filename: job.filename, notify: false }) },
                { type: "button", text: { type: "plain_text", text: "✕ Reject + Notify" }, action_id: "slack_reject_notify", value: job.filename },
                { type: "button", text: { type: "plain_text", text: "↻ Re-analyze" }, action_id: "slack_reanalyze", value: job.filename },
            ],
        },
    ];
}

function _buildMultiVariantBlocks(variants) {
    const blocks = [];
    for (const v of variants) {
        const regenCount = v.regenCount || 0;
        const regenLimit = v.regenerationLimit || 2;
        const regenExhausted = regenCount >= regenLimit;
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `Variant ${v.variantIndex || 1}  (${regenCount}/${regenLimit} regens used)` } });
        blocks.push({
            type: "actions",
            elements: [
                { type: "button", text: { type: "plain_text", text: "✓ Approve" }, style: "primary", action_id: "slack_pick_variant", value: JSON.stringify({ parentJobId: v.parentJobId, variantId: v.variantId || v.filePrefix }) },
                regenExhausted
                    ? { type: "button", text: { type: "plain_text", text: "Regen limit reached" }, action_id: "slack_regen_noop", value: "noop" }
                    : { type: "button", text: { type: "plain_text", text: "↻ Regen" }, action_id: "slack_regen_variant", value: JSON.stringify({ parentJobId: v.parentJobId, variantId: v.variantId || v.filePrefix }) },
            ],
        });
        blocks.push({ type: "divider" });
    }
    const parentJobId = variants[0].parentJobId;
    blocks.push({
        type: "actions",
        elements: [
            { type: "button", text: { type: "plain_text", text: "✕ Reject All" }, style: "danger", action_id: "slack_reject_parent", value: JSON.stringify({ parentJobId, notify: false }) },
            { type: "button", text: { type: "plain_text", text: "✕ Reject All + Notify" }, action_id: "slack_reject_parent_notify", value: JSON.stringify({ parentJobId, notify: true }) },
        ],
    });
    return blocks;
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
