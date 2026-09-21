const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { getModels } = require("../lib/config");
const { getEventSummary, resetEventSummaryCache } = require("../lib/event-summary");

beforeEach(() => resetEventSummaryCache());

test("event summaries use the configured Smart Reply model", async () => {
    let payload = null;
    const client = {
        responses: {
            create: async (request) => {
                payload = request;
                return { output_text: "A configured summary." };
            },
        },
    };

    const summary = await getEventSummary("Model Test Event", { client });

    assert.equal(summary, "A configured summary.");
    assert.equal(payload.model, getModels().smartReply);
});

test("event summary cache is isolated by model", async () => {
    let calls = 0;
    const client = {
        responses: {
            create: async (request) => {
                calls++;
                return { output_text: `Summary from ${request.model}` };
            },
        },
    };

    const first = await getEventSummary("Cache Test Event", { client, model: "gpt-test-a" });
    const cached = await getEventSummary("Cache Test Event", { client, model: "gpt-test-a" });
    const changed = await getEventSummary("Cache Test Event", { client, model: "gpt-test-b" });

    assert.equal(first, "Summary from gpt-test-a");
    assert.equal(cached, first);
    assert.equal(changed, "Summary from gpt-test-b");
    assert.equal(calls, 2);
});
