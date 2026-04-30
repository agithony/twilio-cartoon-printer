// Chroma-key + composite for Exact Background scenes.
// The image model is asked to paint the area around the subject in pure
// magenta (#FF00FF). This module removes those magenta pixels and layers
// the resulting subject cutout over the uploaded background image.
//
// gpt-image-2 rejects `background: "transparent"` on images.edit, so chroma
// keying replaces the old transparent-alpha strategy.

const sharp = require("sharp");

// Squared Euclidean distance threshold from pure magenta (255, 0, 255).
// 100 → only pixels visually close to magenta get keyed. Clothing/skin at
// this distance from #FF00FF are extremely rare; if they happen, the
// affected pixel becomes transparent and the uploaded background shows
// through there — an acceptable failure mode that only affects that tile.
const MAGENTA_KEY_THRESHOLD_SQ = 100 * 100;

async function chromaKeyMagenta(buf) {
    const { data, info } = await sharp(buf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const dr = 255 - r;
        const dg = g;
        const db = 255 - b;
        if (dr * dr + dg * dg + db * db < MAGENTA_KEY_THRESHOLD_SQ) {
            data[i + 3] = 0;
        }
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer();
}

async function compositeExactBackground({ portraitBuf, backgroundBuf, width, height }) {
    const keyedPortrait = await chromaKeyMagenta(portraitBuf);
    const resizedBg = await sharp(backgroundBuf)
        .resize(width, height, { fit: "cover" })
        .png()
        .toBuffer();
    const normalizedPortrait = await sharp(keyedPortrait)
        .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    return sharp(resizedBg)
        .composite([{ input: normalizedPortrait, gravity: "center" }])
        .png()
        .toBuffer();
}

module.exports = { compositeExactBackground, chromaKeyMagenta, MAGENTA_KEY_THRESHOLD_SQ };
