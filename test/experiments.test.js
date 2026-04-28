const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");

const {
    buildEntries, makeId,
    addPhoto, removePhoto, loadPhotos, ensureDirs, TEST_PHOTOS_DIR,
    experimentDir, saveManifest, loadManifest, runEntry, runExperiment,
} = require("../lib/experiments");

test("makeId: produces sortable, slug-safe IDs", () => {
    const id = makeId("Cartoon Length V2", new Date("2026-04-28T14:30:00Z"));
    assert.equal(id, "2026-04-28T14-30-00_cartoon-length-v2");
});

test("makeId: falls back to 'experiment' on empty name", () => {
    const id = makeId("", new Date("2026-04-28T14:30:00Z"));
    assert.equal(id, "2026-04-28T14-30-00_experiment");
});

test("buildEntries: full cross-product count", () => {
    const entries = buildEntries({
        photos: ["a.jpg", "b.jpg"],
        styles: ["cartoon"],
        brands: [null, "twilio"],
        backgrounds: [null, "original"],
        reps: 2,
        variants: [{ name: "live" }, { name: "trimmed" }],
    });
    // 2 × 1 × 2 × 2 × 2 × 2 = 32
    assert.equal(entries.length, 32);
});

test("buildEntries: outputPath encodes the combination uniquely", () => {
    const entries = buildEntries({
        photos: ["anthony.jpg"], styles: ["cartoon"], brands: ["twilio"],
        backgrounds: [null], reps: 1, variants: [{ name: "live" }],
    });
    assert.equal(entries[0].outputPath, "anthony_cartoon_twilio_none_live_1.png");

    const allEntries = buildEntries({
        photos: ["a.jpg", "b.jpg"],
        styles: ["cartoon"],
        brands: [null, "twilio"],
        backgrounds: [null, "original"],
        reps: 2,
        variants: [{ name: "live" }, { name: "trimmed" }],
    });
    assert.equal(new Set(allEntries.map(e => e.outputPath)).size, allEntries.length);
});

test("buildEntries: every entry starts as pending with no error", () => {
    const entries = buildEntries({
        photos: ["x.jpg"], styles: ["cartoon"], brands: [null], backgrounds: [null],
        reps: 1, variants: [{ name: "v" }],
    });
    assert.equal(entries[0].status, "pending");
    assert.equal(entries[0].error, null);
    assert.equal(entries[0].promptText, null);
});

// Photo helpers need a real filesystem — use the temp dir and override the
// module's EXPERIMENTS_DIR via a symlink trick isn't clean, so we just run
// against the real data/experiments/ and clean up afterwards.

test("addPhoto / loadPhotos / removePhoto roundtrip", async () => {
    await ensureDirs();
    const filename = `__unit_test_${crypto.randomUUID()}.jpg`;
    const buf = Buffer.from("not-a-real-jpg-but-bytes-suffice-for-the-test");
    try {
        const added = await addPhoto({ filename, displayName: "Unit Test", buffer: buf });
        assert.equal(added.filename, filename);
        assert.equal(added.sceneDescription, null);

        const photos = await loadPhotos();
        assert.ok(photos.photos.find((p) => p.filename === filename));
        assert.ok(fs.existsSync(path.join(TEST_PHOTOS_DIR, filename)));
    } finally {
        await removePhoto(filename).catch(() => {});
    }
});

test("addPhoto rejects duplicate filenames", async () => {
    await ensureDirs();
    const filename = `__unit_test_dup_${crypto.randomUUID()}.jpg`;
    const buf = Buffer.from("x");
    try {
        await addPhoto({ filename, displayName: "One", buffer: buf });
        await assert.rejects(() => addPhoto({ filename, displayName: "Two", buffer: buf }), /already exists/);
    } finally {
        await removePhoto(filename).catch(() => {});
    }
});

function makeManifest(overrides = {}) {
    return {
        id: `test-${crypto.randomUUID()}`,
        name: "runner-test",
        createdAt: new Date().toISOString(),
        status: "pending",
        config: { styles: ["cartoon"], brands: [null], backgrounds: [null], photos: ["a.jpg"], reps: 1, variants: [{ name: "v" }] },
        entries: [{
            photo: "a.jpg", style: "cartoon", brand: null, background: null,
            variant: "v", rep: 1, status: "pending",
            outputPath: "a_cartoon_none_none_v_1.png",
            promptText: null, generationMs: null, error: null,
            startedAt: null, completedAt: null,
        }],
        ...overrides,
    };
}

test("runEntry: success writes PNG and marks completed", async () => {
    const manifest = makeManifest();
    await fsp.mkdir(experimentDir(manifest.id), { recursive: true });
    const flushed = [];
    const deps = {
        flushManifest: async (m) => { flushed.push(JSON.stringify(m.entries[0].status)); },
        buildPromptForEntry: async () => "the-prompt",
        callImageEdit: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic bytes
        ensurePhotoSceneCache: async () => {},
    };
    try {
        await runEntry(manifest.entries[0], manifest, deps);
        assert.equal(manifest.entries[0].status, "completed");
        assert.equal(manifest.entries[0].promptText, "the-prompt");
        assert.ok(fs.existsSync(path.join(experimentDir(manifest.id), manifest.entries[0].outputPath)));
        // Two flushes: once at start (running), once at end (completed).
        assert.deepEqual(flushed, [`"running"`, `"completed"`]);
    } finally {
        await fsp.rm(experimentDir(manifest.id), { recursive: true, force: true });
    }
});

test("runEntry: first failure retries, second marks failed", async () => {
    const manifest = makeManifest();
    await fsp.mkdir(experimentDir(manifest.id), { recursive: true });
    let calls = 0;
    const deps = {
        flushManifest: async () => {},
        buildPromptForEntry: async () => "p",
        callImageEdit: async () => { calls++; throw new Error("boom"); },
        ensurePhotoSceneCache: async () => {},
    };
    try {
        await runEntry(manifest.entries[0], manifest, deps);
        assert.equal(calls, 2); // one initial + one retry
        assert.equal(manifest.entries[0].status, "failed");
        assert.equal(manifest.entries[0].error, "boom");
    } finally {
        await fsp.rm(experimentDir(manifest.id), { recursive: true, force: true });
    }
});

test("runExperiment: completes all entries and computes cost", async () => {
    const manifest = makeManifest({
        entries: [
            { photo: "a.jpg", style: "cartoon", brand: null, background: null, variant: "v", rep: 1, status: "pending", outputPath: "a1.png", promptText: null, generationMs: null, error: null, startedAt: null, completedAt: null },
            { photo: "a.jpg", style: "cartoon", brand: null, background: null, variant: "v", rep: 2, status: "pending", outputPath: "a2.png", promptText: null, generationMs: null, error: null, startedAt: null, completedAt: null },
        ],
    });
    await saveManifest(manifest);
    const deps = {
        flushManifest: saveManifest,
        buildPromptForEntry: async () => "p",
        callImageEdit: async () => Buffer.from([0x89]),
        ensurePhotoSceneCache: async () => {},
    };
    try {
        await runExperiment(manifest, deps);
        assert.equal(manifest.status, "completed");
        assert.equal(manifest.entries.every((e) => e.status === "completed"), true);
        assert.ok(manifest.totalCostUsd > 0);
    } finally {
        await fsp.rm(experimentDir(manifest.id), { recursive: true, force: true });
    }
});
