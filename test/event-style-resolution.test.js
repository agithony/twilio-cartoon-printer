const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const settings = require("../lib/settings");
const { jobPaths } = require("../lib/pipeline");

const EVENT = "__event_style_resolution_test__";
const eventDir = path.join(settings.EVENTS_DIR, EVENT);

after(() => fs.rmSync(eventDir, { recursive: true, force: true }));

test("queued jobs resolve styles from their originating event", () => {
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify({
        customStyles: {
            "event-only": { name: "Event Only", prompt: "Event-specific style" },
        },
        defaultStyle: "event-only",
    }));

    const activeStyles = settings.getActiveStyles(EVENT);
    assert.equal(activeStyles["event-only"].prompt, "Event-specific style");
    assert.equal(jobPaths({ eventName: EVENT, style: "event-only", filePrefix: "test" }).styleKey, "event-only");
});
