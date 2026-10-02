const { canonicalBrief } = require("./submit");

const BRIEF_FIELDS = ["visualStyle", "clothingOrSubject", "setting", "mood", "importantDetails", "preserve"];
const INSTRUCTION_ATTACK = /ignore\s+(all\s+)?(previous\s+)?(instructions|rules)|system\s+prompt|developer\s+message|reveal\s+(secrets|api\s*key)/i;
const UNSUPPORTED_EDIT = /\b(animat(?:e|ion)|video|movie|audio|voiceover|soundtrack|deepfake|face\s*swap)\b/i;

async function moderateText(text) {
    const { getOpenAI } = require("../config");
    const response = await getOpenAI().moderations.create({ model: "omni-moderation-latest", input: text });
    return response.results?.[0];
}

async function validateVoiceBrief(brief, request, { store, moderate = moderateText,
    now = Date.now, isCurrent = () => true } = {}) {
    if (!store || !request?.id) throw new Error("Voice policy requires a stored request");
    const current = await store.get(request.id);
    if (!current) return { approved: false, code: "source_unavailable", brief: null };
    async function decide(code, approvedBrief = null) {
        if (!isCurrent()) return { approved: false, code: "stale", brief: null };
        const approved = code === "approved";
        const policyOutcome = { approved, code, at: now() };
        const updated = await store.patch(current.id, { policyOutcome, approvedBrief }, { ifStatus: "claimed" });
        return updated ? { approved, code, brief: approved ? approvedBrief : null }
            : { approved: false, code: "source_unavailable", brief: null };
    }
    if (!current || current.status !== "claimed" || Number(current.expiresAt) <= now()
        || !current.stagedInputPath || !Number.isInteger(current.scene?.subjects)
        || current.scene.subjects < 1 || current.preflightApproved === false) {
        return decide("source_unavailable");
    }
    if (current.eventSettings?.multiSubjectMode === "reject" && current.scene.subjects > 1) {
        return decide("subject_rule");
    }
    let normalized;
    try {
        if (!brief || typeof brief !== "object" || Array.isArray(brief)
            || Object.keys(brief).some((key) => !BRIEF_FIELDS.includes(key))) {
            throw new Error("invalid brief");
        }
        normalized = canonicalBrief(brief);
    } catch {
        return decide("invalid_brief");
    }
    const text = BRIEF_FIELDS.map((key) => normalized[key]).join("\n");
    if (INSTRUCTION_ATTACK.test(text)) return decide("invalid_brief");
    if (UNSUPPORTED_EDIT.test(text)) return decide("unsupported_edit");
    try {
        const result = await moderate(text);
        if (typeof result?.flagged !== "boolean") return decide("service_error");
        if (result.flagged) return decide("blocked_content");
    } catch {
        return decide("service_error");
    }
    return decide("approved", normalized);
}

module.exports = { validateVoiceBrief, moderateText, BRIEF_FIELDS };
