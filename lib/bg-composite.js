// Composite an alpha-transparent portrait onto an uploaded background image.
// Used by Exact Background scenes. The caller guarantees portraitBuf was
// generated with real alpha transparency (via gpt-image-1.5 + background:
// "transparent" on the OpenAI edit endpoint — gpt-image-2 does not support it).

const sharp = require("sharp");

async function compositeExactBackground({ portraitBuf, backgroundBuf, width, height }) {
    const resizedBg = await sharp(backgroundBuf)
        .resize(width, height, { fit: "cover" })
        .png()
        .toBuffer();
    const normalizedPortrait = await sharp(portraitBuf)
        .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    return sharp(resizedBg)
        .composite([{ input: normalizedPortrait, gravity: "center" }])
        .png()
        .toBuffer();
}

module.exports = { compositeExactBackground };
