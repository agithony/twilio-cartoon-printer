const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { compositeStickerBorder } = require("../lib/sticker");

// Build a 200x200 transparent PNG with an opaque red 80x80 square centered.
// This stands in for an AI-generated transparent cutout.
async function makeSubjectPng() {
    const square = await sharp({
        create: { width: 80, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    return sharp({
        create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
        .composite([{ input: square, gravity: "center" }])
        .png()
        .toBuffer();
}

test("compositeStickerBorder returns a PNG that still has an alpha channel", async () => {
    const input = await makeSubjectPng();
    const out = await compositeStickerBorder(input, { borderPx: 8 });
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.hasAlpha, true);
});

test("compositeStickerBorder adds white pixels in the ring just outside the subject edge", async () => {
    const input = await makeSubjectPng();
    const out = await compositeStickerBorder(input, { borderPx: 8, trim: false });
    // The 80x80 red square sits at x/y 60..140 in a 200x200 canvas.
    // A pixel ~4px outside that edge (e.g. x=56,y=100) was fully transparent
    // in the input; after bordering it must be opaque white.
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => {
        const i = (y * info.width + x) * info.channels;
        return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    };
    const ring = px(56, 100); // just left of the red square
    assert.ok(ring.a > 200, `expected opaque border pixel, got alpha=${ring.a}`);
    assert.ok(ring.r > 220 && ring.g > 220 && ring.b > 220, `expected white border, got rgb=${ring.r},${ring.g},${ring.b}`);
});

test("compositeStickerBorder keeps the original subject color on top of the border", async () => {
    const input = await makeSubjectPng();
    const out = await compositeStickerBorder(input, { borderPx: 8, trim: false });
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (100 * info.width + 100) * info.channels; // dead center = subject
    assert.ok(data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60, "center should remain red subject");
});
