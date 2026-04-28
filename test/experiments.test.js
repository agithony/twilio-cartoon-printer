const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
    buildEntries, makeId,
    addPhoto, removePhoto, loadPhotos, ensureDirs, TEST_PHOTOS_DIR,
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
