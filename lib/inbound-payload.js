function getMessageBody(body) {
    return body.ButtonPayload || body.Body || "";
}

function getNpsScore(value) {
    const text = String(value || "").trim();
    const quickReply = text.match(/^nps_([1-5])$/);
    if (quickReply) return Number(quickReply[1]);
    return /^[1-5]$/.test(text) ? Number(text) : null;
}

module.exports = { getMessageBody, getNpsScore };
