const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-template-test-"));
process.env.CONTENT_TEMPLATE_CACHE_FILE = path.join(tmpDir, "cache.json");

let creates = 0;
let releaseCreate;
const clientStub = {
    content: {
        v1: {
            contents: {
                create: async () => ({ sid: `HX${++creates}` }),
            },
        },
    },
};
const settingsStub = { get() { return "ACtest"; } };
const helpersStub = { getTwilioClient: () => clientStub };
require.cache[require.resolve("../lib/settings")] = { exports: settingsStub };
require.cache[require.resolve("../lib/helpers")] = { exports: helpersStub };
delete require.cache[require.resolve("../lib/content-templates")];
const templates = require("../lib/content-templates");

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("list picker enforces field limits and descriptions", () => {
    const picker = templates.buildListPicker([
        { key: "x".repeat(250), name: "n".repeat(30), description: "d".repeat(80) },
        { key: "second", name: "Second" },
    ], "Choose", "Open menu");
    assert.equal(picker.items[0].item.length, 24);
    assert.equal(picker.items[0].id.length, 200);
    assert.equal(picker.items[0].description.length, 72);
    assert.equal(picker.items[1].description, "Tap to choose");
});

test("identical menus reuse a cached Content SID", async () => {
    const options = [{ key: "cartoon", name: "Cartoon" }];
    assert.equal(await templates.getOrCreateListPicker("style", options, "Choose", "Open"), "HX1");
    assert.equal(await templates.getOrCreateListPicker("style", options, "Choose", "Open"), "HX1");
    assert.equal(creates, 1);
});

test("concurrent identical menus share one API request", async () => {
    clientStub.content.v1.contents.create = () => new Promise((resolve) => { releaseCreate = resolve; });
    const options = [{ key: "beach", name: "Beach" }];
    const first = templates.getOrCreateListPicker("background", options, "Choose", "Open");
    const second = templates.getOrCreateListPicker("background", options, "Choose", "Open");
    releaseCreate({ sid: "HXshared" });
    assert.deepEqual(await Promise.all([first, second]), ["HXshared", "HXshared"]);
});
