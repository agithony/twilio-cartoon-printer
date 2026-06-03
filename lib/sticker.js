// Add a die-cut white border to a transparent-alpha subject PNG.
// No AI, no settings, no network — pure sharp compositing.
//
// sharp has no morphological dilate, so we grow the opaque region by
// blurring the alpha channel and re-thresholding it: soft-grow then
// hard-cut. The grown mask becomes a solid white silhouette (the border),
// and the original subject is composited on top.
//
// Note on sharp 0.34.5 behavior: threshold() is a no-op on a *raw*
// single-channel buffer (it passes values through unchanged and expands
// to 3 channels). To binarize reliably we round-trip the blurred mask
// through PNG before thresholding, then collapse back to a clean
// single-channel ("b-w") buffer for joinChannel.

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
    //    silhouette. Blur sigma ≈ borderPx/2 grows the edge by roughly borderPx.
    const sigma = Math.max(1, borderPx / 2);
    const blurredMaskPng = await sharp(alphaRaw, { raw: { width, height, channels: 1 } })
        .blur(sigma)
        .png()
        .toBuffer();
    const grownMask = await sharp(blurredMaskPng)
        .threshold(20) // keep any pixel the blur meaningfully touched -> dilation
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
