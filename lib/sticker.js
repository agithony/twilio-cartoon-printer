// Add a die-cut white border to a transparent-alpha subject PNG.
// No AI, no settings, no network — pure sharp compositing.
//
// sharp has no morphological dilate, so we grow the opaque region by
// blurring the alpha channel and re-thresholding it: soft-grow then
// hard-cut. The grown mask becomes a solid white silhouette (the border),
// and the original subject is composited on top.
//
// Note on sharp 0.34.5 behavior: threshold() on a *raw* single-channel
// buffer DOES binarize correctly (0/255), but it expands the result to 3
// channels — which joinChannel(..., {channels: 1}) would then misread as
// raw single-channel data (reading garbage / wrong stride). So we round-trip
// the blurred mask through PNG before thresholding, then collapse it back to
// a clean single channel via toColourspace("b-w") before joinChannel. Do not
// "simplify away" the PNG round-trip: it is what keeps the mask 1-channel.

const sharp = require("sharp");

async function compositeStickerBorder(inputBuf, { borderPx = 12, trim = true } = {}) {
    const { width, height } = await sharp(inputBuf).metadata();

    // 1. Extract the subject's alpha as a single-channel raw mask.
    const alphaRaw = await sharp(inputBuf)
        .ensureAlpha()
        .extractChannel("alpha")
        .raw()
        .toBuffer();

    // 2. Grow the mask outward ~borderPx: blur spreads the edge into a soft
    //    halo, then threshold snaps that halo back into a hard (now larger)
    //    silhouette. The actual outward grow is set by BOTH the blur sigma and
    //    the threshold below: a lower threshold keeps more of the faint blur
    //    tail, widening the grow. Empirically (sharp 0.34.5, threshold 20) the
    //    grow ≈ sigma / 0.8, so sigma = borderPx * 0.8 makes the white border
    //    grow ≈ borderPx pixels. If you change threshold(20), re-measure: the
    //    two are coupled and this multiplier will no longer hold.
    const sigma = Math.max(1, borderPx * 0.8);
    const blurredMaskPng = await sharp(alphaRaw, { raw: { width, height, channels: 1 } })
        .blur(sigma)
        .png()
        .toBuffer();
    const grownMask = await sharp(blurredMaskPng)
        .threshold(20) // keep any pixel the blur meaningfully touched -> dilation (coupled to sigma above)
        .toColourspace("b-w") // collapse to a clean single-channel mask
        .raw()
        .toBuffer();

    // 3. White silhouette: a white canvas masked to the grown shape.
    const whiteBorder = await sharp({
        create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
        .joinChannel(grownMask, { raw: { width, height, channels: 1 } })
        .png()
        .toBuffer();

    // 4. Composite the original subject on top of the white border.
    let out = sharp(whiteBorder).composite([{ input: inputBuf, gravity: "center" }]).png();

    // 5. Optionally crop the surrounding transparency tight to the sticker.
    if (trim) out = sharp(await out.toBuffer()).trim().png();

    return out.toBuffer();
}

module.exports = { compositeStickerBorder };
