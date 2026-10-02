function readinessIssues(config, baseUrl) {
    const issues = [];
    if (!/^\+[1-9]\d{7,14}$/.test(config.twilioVoiceNumber || "")) {
        issues.push("Voice number must be E.164");
    }

    let publicHttps = false;
    try {
        const url = new URL(baseUrl);
        publicHttps = url.protocol === "https:"
            && !!url.hostname
            && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    } catch { /* malformed or missing URL */ }
    if (!publicHttps) issues.push("Public HTTPS BASE_URL is required");

    if (!config.twilioAccountSid || !config.twilioAuthToken) {
        issues.push("Twilio credentials are required");
    }
    if (!config.openaiApiKey) issues.push("OpenAI API key is required");
    if (config.leadCaptureMode === "before") {
        issues.push("Voice cannot run with before lead capture");
    }

    if (config.twilioWhatsappNumber || config.twilioWhatsappMessagingServiceSid) {
        for (const locale of ["en", "pt_BR"]) {
            for (const key of ["voiceInvitation", "voiceDelivery", "voiceFailure"]) {
                if (!config.contentTemplates?.[locale]?.[key]) {
                    issues.push(`${locale} ${key} WhatsApp template is required`);
                }
            }
            if (config.contentTemplates?.[locale]?.voiceInvitation
                && config.contentTemplates[locale].voiceInvitationPhone !== config.twilioVoiceNumber) {
                issues.push(`${locale} voiceInvitation template phone must match Voice number`);
            }
        }
    }
    return issues;
}

module.exports = { readinessIssues };
