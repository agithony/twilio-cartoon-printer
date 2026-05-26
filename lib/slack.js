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
    _app = new App({ token, receiver: _receiver, tokenVerificationEnabled: false });
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
    if (!job.slackTs || !job.slackChannel) return;
    const label = {
        approve: "✓ Approved",
        reject: "✕ Rejected",
        reject_notify: "✕ Rejected + Notified",
        reanalyze: "↻ Re-analyzing",
        pick_variant: "✓ Variant approved",
        regen: "↻ Regenerating variant",
        reject_parent: "✕ All variants rejected",
        reject_parent_notify: "✕ All variants rejected + notified",
    }[action] || action;
    const actorLabel = actor === "web-ui" ? "via web UI" : `by <@${actor}>`;
    try {
        await _app.client.chatPostMessage({
            channel: job.slackChannel,
            thread_ts: job.slackTs,
            text: `${label} ${actorLabel}`,
        });
        await _app.client.chatUpdate({
            channel: job.slackChannel,
            ts: job.slackTs,
            text: `${label} ${actorLabel}`,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: `${label} ${actorLabel}` } }],
        });
    } catch (err) {
        console.error(`[Slack] notifyJobActioned failed: ${err.message}`);
    }
}

async function _readJobFromReview(filename) {
    const path = require("path");
    const fs = require("fs");
    const config = require("./config");
    const jobPath = path.join(config.REVIEW_DIR, filename);
    if (!fs.existsSync(jobPath)) {
        const err = new Error("Job not found in review queue");
        throw err;
    }
    return JSON.parse(fs.readFileSync(jobPath, "utf8"));
}

async function _postEphemeral(app, body, text) {
    try {
        await app.client.chatPostEphemeral({ channel: body.channel.id, user: body.user.id, text });
    } catch (e) {
        console.error(`[Slack] ephemeral post failed: ${e.message}`);
    }
}

function _registerActions(app) {
    const queue = require("./queue");

    // Single-variant: approve
    app.action("slack_approve", async ({ ack, body, action }) => {
        await ack();
        const filename = action.value;
        const userId = body.user.id;
        try {
            const job = await _readJobFromReview(filename);
            await queue.approveJob(filename);
            await notifyJobActioned({ ...job, slackTs: body.message.ts, slackChannel: body.channel.id }, "approve", userId);
        } catch (err) {
            if (err.message.includes("not found") || err.code === "ALREADY_DECIDED") await _postEphemeral(app, body, "This portrait has already been reviewed.");
            else console.error(`[Slack] slack_approve error: ${err.message}`);
        }
    });

    // Single-variant: reject (silent or notify)
    app.action("slack_reject", async ({ ack, body, action }) => {
        await ack();
        const { filename, notify } = JSON.parse(action.value);
        const userId = body.user.id;
        try {
            const job = await _readJobFromReview(filename);
            const msg = notify ? settings.getMsg("reviewReject") : null;
            await queue.rejectJob(filename, msg);
            await notifyJobActioned({ ...job, slackTs: body.message.ts, slackChannel: body.channel.id }, notify ? "reject_notify" : "reject", userId);
        } catch (err) {
            if (err.message.includes("not found") || err.code === "ALREADY_DECIDED") await _postEphemeral(app, body, "This portrait has already been reviewed.");
            else console.error(`[Slack] slack_reject error: ${err.message}`);
        }
    });

    // Single-variant: reject + notify (separate button, value is just filename string)
    app.action("slack_reject_notify", async ({ ack, body, action }) => {
        await ack();
        const filename = action.value;
        const userId = body.user.id;
        try {
            const job = await _readJobFromReview(filename);
            await queue.rejectJob(filename, settings.getMsg("reviewReject"));
            await notifyJobActioned({ ...job, slackTs: body.message.ts, slackChannel: body.channel.id }, "reject_notify", userId);
        } catch (err) {
            if (err.message.includes("not found") || err.code === "ALREADY_DECIDED") await _postEphemeral(app, body, "This portrait has already been reviewed.");
            else console.error(`[Slack] slack_reject_notify error: ${err.message}`);
        }
    });

    // Single-variant: re-analyze — opens a modal for optional feedback
    app.action("slack_reanalyze", async ({ ack, body, action, client }) => {
        await ack();
        await client.viewsOpen({
            trigger_id: body.trigger_id,
            view: {
                type: "modal",
                callback_id: "slack_reanalyze_submit",
                private_metadata: JSON.stringify({ filename: action.value, slackTs: body.message.ts, slackChannel: body.channel.id }),
                title: { type: "plain_text", text: "Re-analyze Portrait" },
                submit: { type: "plain_text", text: "Re-generate" },
                close: { type: "plain_text", text: "Cancel" },
                blocks: [{
                    type: "input", optional: true, block_id: "feedback_block",
                    element: { type: "plain_text_input", action_id: "feedback_input", placeholder: { type: "plain_text", text: 'e.g. "make the background blue"' } },
                    label: { type: "plain_text", text: "Optional: describe what to change" },
                }],
            },
        });
    });

    // Re-analyze modal submission
    app.view("slack_reanalyze_submit", async ({ ack, body, view }) => {
        await ack();
        const { filename, slackTs, slackChannel } = JSON.parse(view.private_metadata);
        const feedback = view.state.values?.feedback_block?.feedback_input?.value || "";
        const userId = body.user.id;
        try {
            const job = await _readJobFromReview(filename);
            await queue.rejectJob(filename, null, true, feedback);
            await notifyJobActioned({ ...job, slackTs, slackChannel }, "reanalyze", userId);
        } catch (err) {
            console.error(`[Slack] reanalyze submit error: ${err.message}`);
        }
    });

    // Multi-variant: pick (approve) a specific variant
    app.action("slack_pick_variant", async ({ ack, body, action }) => {
        await ack();
        const { parentJobId, variantId } = JSON.parse(action.value);
        const userId = body.user.id;
        try {
            await queue.pickVariant(parentJobId, variantId);
            await _app.client.chatUpdate({
                channel: body.channel.id, ts: body.message.ts,
                text: `✓ Variant approved by <@${userId}>`,
                blocks: [{ type: "section", text: { type: "mrkdwn", text: `✓ Variant approved by <@${userId}>` } }],
            });
        } catch (err) {
            if (err.code === "ALREADY_DECIDED") await _postEphemeral(app, body, "This portrait has already been reviewed.");
            else console.error(`[Slack] slack_pick_variant error: ${err.message}`);
        }
    });

    // Multi-variant: regenerate a specific variant
    app.action("slack_regen_variant", async ({ ack, body, action }) => {
        await ack();
        const { parentJobId, variantId } = JSON.parse(action.value);
        const userId = body.user.id;
        try {
            await queue.regenerateVariant(parentJobId, variantId);
            await _app.client.chatPostMessage({ channel: body.channel.id, thread_ts: body.message.ts, text: `↻ Variant regeneration started by <@${userId}>` });
        } catch (err) {
            if (err.code === "REGEN_LIMIT_REACHED" || err.code === "VARIANT_ALREADY_REGENERATING") await _postEphemeral(app, body, err.message);
            else console.error(`[Slack] slack_regen_variant error: ${err.message}`);
        }
    });

    // No-op for disabled regen button (regen limit reached)
    app.action("slack_regen_noop", async ({ ack }) => { await ack(); });

    // Multi-variant: reject all (silent)
    app.action("slack_reject_parent", async ({ ack, body, action }) => {
        await ack();
        const { parentJobId, notify } = JSON.parse(action.value);
        const userId = body.user.id;
        try {
            const msg = notify ? settings.getMsg("reviewReject") : null;
            await queue.rejectParent(parentJobId, msg);
            await _app.client.chatUpdate({
                channel: body.channel.id, ts: body.message.ts,
                text: `✕ All variants rejected by <@${userId}>`,
                blocks: [{ type: "section", text: { type: "mrkdwn", text: `✕ All variants rejected by <@${userId}>` } }],
            });
        } catch (err) {
            if (err.code === "ALREADY_DECIDED") await _postEphemeral(app, body, "This portrait has already been reviewed.");
            else console.error(`[Slack] slack_reject_parent error: ${err.message}`);
        }
    });

    // Multi-variant: reject all + notify
    app.action("slack_reject_parent_notify", async ({ ack, body, action }) => {
        await ack();
        const { parentJobId } = JSON.parse(action.value);
        const userId = body.user.id;
        try {
            await queue.rejectParent(parentJobId, settings.getMsg("reviewReject"));
            await _app.client.chatUpdate({
                channel: body.channel.id, ts: body.message.ts,
                text: `✕ All variants rejected + notified by <@${userId}>`,
                blocks: [{ type: "section", text: { type: "mrkdwn", text: `✕ All variants rejected + notified by <@${userId}>` } }],
            });
        } catch (err) {
            if (err.code === "ALREADY_DECIDED") await _postEphemeral(app, body, "This portrait has already been reviewed.");
            else console.error(`[Slack] slack_reject_parent_notify error: ${err.message}`);
        }
    });
}

function mountReceiver(expressApp) {
    if (!_receiver) return;
    expressApp.use(_receiver.router);
}

module.exports = { isConfigured, postPortraitFeed, postReviewRequest, notifyJobActioned, mountReceiver };
