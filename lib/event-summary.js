const { getOpenAI, getModels } = require("./config");

const summaryCache = new Map();

async function getEventSummary(eventName, options = {}) {
    const model = options.model || getModels().smartReply;
    const cacheKey = `${model}\0${eventName}`;
    if (summaryCache.has(cacheKey)) return summaryCache.get(cacheKey);

    const client = options.client || getOpenAI();
    const logger = options.logger || console;
    try {
        const response = await client.responses.create({
            model,
            input: [{ role: "user", content: [{ type: "input_text", text:
                `Write a 2-3 sentence summary of the event "${eventName}". What is it, who attends, and what's its focus? If you don't recognize the event, write a brief generic description for a tech conference or developer event booth activation. Do not use markdown formatting.`
            }] }],
        });
        const summary = response.output_text.trim();
        summaryCache.set(cacheKey, summary);
        return summary;
    } catch (err) {
        logger.error(`Event summary generation failed: ${err.message}`);
        return `Booth activation at ${eventName}.`;
    }
}

function resetEventSummaryCache() {
    summaryCache.clear();
}

module.exports = { getEventSummary, resetEventSummaryCache };
