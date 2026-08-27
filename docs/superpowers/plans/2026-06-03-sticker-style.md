# Digital Sticker Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new built-in "Sticker" art style that produces a transparent-background, die-cut PNG (digital-only, never printed).

**Architecture:** A single `sticker: true` flag on the style definition flows through the existing `styleObj` carried into the pipeline. The flag drives four behaviors: a glossy-caricature transparent prompt, forced `gpt-image-1.5` + `background:"transparent"` square generation, skipping the three alpha-flattening post-steps in favor of a deterministic `sharp` die-cut white border, and PNG delivery with printing forced off. No new parameter threading — every consumer reads the flag off the style object that is already passed around.

**Tech Stack:** Node.js (CommonJS), `node --test` + `node:assert/strict`, `sharp` for image compositing, OpenAI Images `edit` endpoint.

**Spec:** `docs/superpowers/specs/2026-06-03-sticker-style-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/sticker.js` | NEW. `compositeStickerBorder()` — alpha-dilate → white die-cut → subject on top. Pure image I/O, no settings/network. | Create |
| `test/sticker.test.js` | NEW. Unit tests for `compositeStickerBorder()`. | Create |
| `lib/styles.js` | Add `Sticker` built-in style + propagate `sticker` flag through `getActiveStyles()`. | Modify |
| `test/styles-sticker.test.js` | NEW. Tests the flag is exposed on the active style object. | Create |
| `lib/pipeline.js` | Read `styleObj.sticker`; branch generation (model/background/size), post-processing (skip 3 steps, run border), and output (PNG not JPEG). | Modify |
| `test/pipeline-sticker.test.js` | NEW. Asserts sticker generation params + post-processing branch. | Create |
| `lib/queue.js` | Force `enablePrinting` off and point delivery `imageUrl` at the PNG for sticker jobs. | Modify |

**Design note on `compositeStickerBorder` dilation:** `sharp` has no morphological dilate. We grow the opaque region by operating on the alpha channel: `extractChannel("alpha") → blur(sigma) → threshold(t)` turns a soft-grown alpha into a hard-grown mask. That mask becomes a white silhouette (the border), and the original subject composites on top. This mirrors the existing `sharp.composite` style in `lib/bg-composite.js` and `lib/helpers.js:compositeWithTemplate`.

---

## Task 1: `compositeStickerBorder()` — die-cut white border helper

This is the only genuinely new image-processing code. Build and test it in isolation before wiring anything into the pipeline.

**Files:**
- Create: `lib/sticker.js`
- Test: `test/sticker.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/sticker.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sticker.test.js`
Expected: FAIL — `Cannot find module '../lib/sticker'` (or `compositeStickerBorder is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `lib/sticker.js`:

```javascript
// Add a die-cut white border to a transparent-alpha subject PNG.
// No AI, no settings, no network — pure sharp compositing.
//
// sharp has no morphological dilate, so we grow the opaque region by
// blurring the alpha channel and re-thresholding it: soft-grow then
// hard-cut. The grown mask becomes a solid white silhouette (the border),
// and the original subject is composited on top.

const sharp = require("sharp");

async function compositeStickerBorder(inputBuf, { borderPx = 12, trim = true } = {}) {
    const base = sharp(inputBuf).ensureAlpha();
    const { width, height } = await base.metadata();

    // 1. Extract the subject's alpha as a single-channel mask.
    const alpha = await sharp(inputBuf).ensureAlpha().extractChannel("alpha").toBuffer();

    // 2. Grow the mask outward ~borderPx: blur spreads the edge, threshold
    //    turns the soft halo back into a hard (now larger) silhouette.
    const grownMask = await sharp(alpha, { raw: undefined })
        .blur(Math.max(1, borderPx / 2))
        .threshold(40) // keep any pixel the blur touched -> dilation
        .toBuffer();

    // 3. White silhouette: a white canvas masked to the grown shape.
    const whiteBorder = await sharp({
        create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
        .joinChannel(grownMask) // apply grown mask as alpha
        .png()
        .toBuffer();

    // 4. Composite the original subject on top of the white border.
    let out = sharp(whiteBorder).composite([{ input: inputBuf, gravity: "center" }]).png();

    // 5. Optionally crop the surrounding transparency tight to the sticker.
    if (trim) out = sharp(await out.toBuffer()).trim().png();

    return out.toBuffer();
}

module.exports = { compositeStickerBorder };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sticker.test.js`
Expected: PASS (3 tests). If the `threshold` value lets too much/little through on your sharp version, adjust the `40` threshold or `borderPx/2` blur sigma until the ring assertion passes — the test is the contract.

- [ ] **Step 5: Commit**

```bash
git add lib/sticker.js test/sticker.test.js
git commit -m "feat: add compositeStickerBorder die-cut border helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add the `Sticker` built-in style and propagate the `sticker` flag

**Files:**
- Modify: `lib/styles.js` (add style to `STYLES` object after `pixel-art`, ~line 92; propagate flag in `getActiveStyles` at lines 150-158 and 164-173)
- Test: `test/styles-sticker.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/styles-sticker.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { STYLES, getActiveStyles, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

test("a built-in Sticker style exists with sticker:true", () => {
    assert.ok(STYLES.sticker, "STYLES.sticker should exist");
    assert.equal(STYLES.sticker.sticker, true);
    assert.equal(STYLES.sticker.name, "Sticker");
});

test("Sticker prompt instructs transparent background and forbids AI-drawn border", () => {
    const prompt = STYLES.sticker.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION);
    assert.match(prompt, /transparent/i);
    assert.match(prompt, /no.*(border|outline|stroke|halo)/i);
});

test("Sticker prompt carries its own 'Background:' line so the default bg line is suppressed", () => {
    // prompt-builder.js:95 suppresses the event's default background line when the
    // style prompt already contains a `background:` instruction. The sticker MUST
    // own its background instruction (transparent) — otherwise a solid default bg
    // line would be appended and fight the transparency. This regex must match the
    // one in prompt-builder.js (/background\s*[:—–-]/im).
    const prompt = STYLES.sticker.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION);
    assert.match(prompt, /background\s*[:—–-]/im);
});

test("getActiveStyles exposes sticker flag on the active style object", () => {
    const active = getActiveStyles(null, null, null, DEFAULT_PRESERVE, DEFAULT_COMPOSITION);
    assert.equal(active.sticker.sticker, true);
    // non-sticker styles report a falsy flag, never undefined-shaped
    assert.equal(active.cartoon.sticker, false);
});

test("custom styles can opt into sticker via the flag", () => {
    const active = getActiveStyles(
        null,
        { myCustom: { name: "Mine", prompt: "p", sticker: true } },
        null, DEFAULT_PRESERVE, DEFAULT_COMPOSITION
    );
    assert.equal(active.myCustom.sticker, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/styles-sticker.test.js`
Expected: FAIL — `STYLES.sticker should exist` (sticker style not defined yet).

- [ ] **Step 3a: Add the Sticker style to the `STYLES` object**

In `lib/styles.js`, immediately after the `"pixel-art": { ... },` block (closes at line 92) and before the closing `};` of `STYLES` (line 93), insert:

```javascript
    sticker: {
        name: "Sticker",
        behavior: "normal",
        acceptsColorPalette: true,
        sticker: true,
        core: "Glossy die-cut vinyl sticker: bold 3D caricature with clean cel shading on a fully transparent background.",
        brandCore: "Glossy 3D caricature sticker with bold clean shading.",
        buildPrompt: (preserve, composition) => [
            "Transform this photo into a glossy die-cut vinyl STICKER character — a bold, fun 3D caricature in the style of premium messaging-app stickers and Pixar-esque toy figures. Do not add anyone not in the original photo.",
            preserve,
            "Style: Bold, clean, slightly exaggerated 3D caricature with smooth cel-style shading, vivid saturated colors, soft glossy highlights, and crisp confident edges. Push personality and charm — a touch larger head and expressive features — while keeping the face immediately recognizable as the same person.",
            "Background: The background MUST be 100% transparent — a real alpha channel, not white, not a checkerboard pattern, not a colored fill. Render ONLY the subject as a clean cut-out. Do NOT draw any border, outline, stroke, halo, glow, drop shadow, or sticker edge around the subject — the die-cut border is added later in post-processing. The transition from subject to background must go straight to full transparency.",
            "Composition: Frame from roughly the chest up, centered, with empty transparent margin around the subject. Give them a warm, lively expression.",
        ].join("\n\n"),
    },
```

- [ ] **Step 3b: Propagate the flag for built-in styles**

In `getActiveStyles`, the built-in branch builds `active[key] = { ... }` (lines 150-158). Add the flag. Change:

```javascript
            active[key] = {
                name: style.name,
                behavior: style.behavior || "normal",
                acceptsColorPalette: style.acceptsColorPalette !== false,
                containerDescription: style.containerDescription || null,
                prompt,
                core,
                brandCore,
            };
```

to:

```javascript
            active[key] = {
                name: style.name,
                behavior: style.behavior || "normal",
                acceptsColorPalette: style.acceptsColorPalette !== false,
                containerDescription: style.containerDescription || null,
                sticker: style.sticker === true,
                prompt,
                core,
                brandCore,
            };
```

- [ ] **Step 3c: Propagate the flag for custom styles**

In the same function, the custom-styles branch builds `active[key] = { ... }` (lines 164-173). Change:

```javascript
                active[key] = {
                    name: style.name,
                    behavior: style.behavior || "normal",
                    acceptsColorPalette: style.acceptsColorPalette !== false,
                    containerDescription: style.containerDescription || null,
                    prompt: style.prompt,
                    files: style.files || [],
                    analysis: style.analysis || "",
                    core: style.core || "",
                };
```

to:

```javascript
                active[key] = {
                    name: style.name,
                    behavior: style.behavior || "normal",
                    acceptsColorPalette: style.acceptsColorPalette !== false,
                    containerDescription: style.containerDescription || null,
                    sticker: style.sticker === true,
                    prompt: style.prompt,
                    files: style.files || [],
                    analysis: style.analysis || "",
                    core: style.core || "",
                };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/styles-sticker.test.js`
Expected: PASS (4 tests).

Also run the existing style/prompt suites to confirm no regression:
Run: `node --test test/prompt-builder.test.js test/prompt-assembler.test.js`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/styles.js test/styles-sticker.test.js
git commit -m "feat: add built-in Sticker style with sticker flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pipeline generation params — transparent square for stickers

`generateImage` can't be unit-tested directly (needs live OpenAI/Twilio), so — following the existing `__assemblePromptForTest` pattern — extract the param decision into a **pure, exported helper** and test that. Then wire it into the inline generation block.

**Files:**
- Modify: `lib/pipeline.js` (add helper near other module-scope functions ~line 122; use it at lines 508-519; export at line 907)
- Test: `test/pipeline-sticker.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/pipeline-sticker.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __resolveGenParamsForTest } = require("../lib/pipeline");

const configuredModel = "gpt-image-2-2026-04-21";

test("sticker style forces transparent gpt-image-1.5 at square size", () => {
    const p = __resolveGenParamsForTest({
        styleObj: { sticker: true }, bgMode: "ai", bgRefCount: 0, configuredModel,
    });
    assert.equal(p.model, "gpt-image-1.5");
    assert.equal(p.background, "transparent");
    assert.equal(p.size, "1024x1024");
});

test("exact-background mode still works as before (transparent portrait)", () => {
    const p = __resolveGenParamsForTest({
        styleObj: { sticker: false }, bgMode: "exact", bgRefCount: 1, configuredModel,
    });
    assert.equal(p.model, "gpt-image-1.5");
    assert.equal(p.background, "transparent");
    assert.equal(p.size, "1024x1536");
});

test("normal style is unaffected: configured model, no transparent, portrait", () => {
    const p = __resolveGenParamsForTest({
        styleObj: { sticker: false }, bgMode: "ai", bgRefCount: 0, configuredModel,
    });
    assert.equal(p.model, configuredModel);
    assert.equal(p.background, undefined);
    assert.equal(p.size, "1024x1536");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline-sticker.test.js`
Expected: FAIL — `__resolveGenParamsForTest is not a function`.

- [ ] **Step 3a: Add the pure helper**

In `lib/pipeline.js`, after `jobPaths` (closes ~line 136), add:

```javascript
// Decide image-generation params from style + background mode. Pure so it can
// be unit-tested without a live OpenAI call (see test/pipeline-sticker.test.js).
// Two ways to get a transparent-alpha output: exact-background scenes (existing)
// and the Sticker style (new). Both require gpt-image-1.5 on the edit endpoint.
function resolveGenParams({ styleObj, bgMode, bgRefCount, configuredModel }) {
    const isExactBg = bgMode === "exact" && bgRefCount > 0;
    const isSticker = !!(styleObj && styleObj.sticker);
    const wantsTransparent = isExactBg || isSticker;
    const params = {
        model: wantsTransparent ? "gpt-image-1.5" : configuredModel,
        size: isSticker ? "1024x1024" : "1024x1536",
        quality: "high",
    };
    if (wantsTransparent) params.background = "transparent";
    return params;
}
```

- [ ] **Step 3b: Use the helper in the generation block**

In `generateImage`, replace the existing model/param block at lines 508-519:

```javascript
        const isExactBg = bgMode === "exact" && bgRefBuffers.length > 0;
        const imageModel = isExactBg ? "gpt-image-1.5" : getModels().imageGen;
        const editParams = {
            model: imageModel,
            image: await buildImageFiles(selfieBuffer, "selfie.jpg"),
            prompt: fullPrompt,
            size: "1024x1536",
            quality: "high",
        };
        if (isExactBg) {
            editParams.background = "transparent";
        }
```

with:

```javascript
        const isSticker = !!(styleObj && styleObj.sticker);
        const genParams = resolveGenParams({
            styleObj,
            bgMode,
            bgRefCount: bgRefBuffers.length,
            configuredModel: getModels().imageGen,
        });
        const imageModel = genParams.model;
        const editParams = {
            model: imageModel,
            image: await buildImageFiles(selfieBuffer, "selfie.jpg"),
            prompt: fullPrompt,
            size: genParams.size,
            quality: genParams.quality,
        };
        if (genParams.background) {
            editParams.background = genParams.background;
        }
```

(The downstream `if (imageModel.startsWith("gpt-image-1")) { editParams.input_fidelity = "high"; }` at lines 521-523 is unchanged and now also applies to stickers — correct, since stickers run on gpt-image-1.5.)

- [ ] **Step 3c: Export the helper for tests**

At `module.exports` (line 907), add `__resolveGenParamsForTest`:

```javascript
module.exports = { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage, aiPickBestVariant, analyzeReferences, __assemblePromptForTest, __resolveGenParamsForTest: resolveGenParams };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pipeline-sticker.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.js test/pipeline-sticker.test.js
git commit -m "feat: force transparent square generation for sticker style

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Pipeline post-processing — skip flatteners, add border, emit PNG

When `isSticker`, skip the three steps that destroy alpha (`compositeExactBackground`, `compositeWithTemplate`, `prepareForPrint`), run `compositeStickerBorder` instead, and skip the JPEG MMS conversion so the alpha survives.

**Files:**
- Modify: `lib/pipeline.js` (require sticker module ~line 15; post-processing block lines 610-646)

- [ ] **Step 1: Add the require**

Near the existing `const { compositeExactBackground } = require("./bg-composite");` (line 15), add:

```javascript
const { compositeStickerBorder } = require("./sticker");
```

- [ ] **Step 2: Branch the post-processing block**

`isSticker` is already defined in Task 3 (Step 3b) just before `editParams`, so it is in scope here. Replace the post-processing region (lines 610-637, from the `// 4b. Exact background compositing` comment through the closing brace of the `if (!fs.existsSync(outputPath))` block):

```javascript
        // 4b. Exact background compositing — chroma-key magenta fill, then
        // composite subject onto the uploaded background image.
        if (bgMode === "exact" && bgRefBuffers.length > 0) {
            try {
                console.log("🖼️  Chroma-keying magenta fill and compositing onto exact background image...");
                const { width: pw, height: ph } = settings.getPrintDimensions();
                const portraitBuf = await fsp.readFile(outputPath);
                const composited = await compositeExactBackground({
                    portraitBuf,
                    backgroundBuf: bgRefBuffers[0],
                    width: pw,
                    height: ph,
                });
                await fsp.writeFile(outputPath, composited);
                console.log("🖼️  Exact background applied.");
            } catch (bgErr) {
                console.error(`🖼️  Exact background compositing failed (using portrait as-is): ${bgErr.message}`);
            }
        }

        // 5. Apply template frame (composites in-place onto the output file)
        console.log("🖼️  Applying template frame...");
        await compositeWithTemplate(outputPath);

        // 6. Resize to print dimensions (5x7 @ 300 DPI)
        console.log("📐 Preparing image for print...");
        await prepareForPrint(outputPath);
    }
```

with:

```javascript
        if (isSticker) {
            // Sticker mode: the generated PNG is already a transparent cut-out.
            // Skip background compositing, the photo frame, and print resizing —
            // all three would flatten the alpha. Instead add a die-cut white
            // border deterministically. Border failure is non-fatal: a clean
            // borderless cut-out is still a valid sticker.
            try {
                console.log("🏷️  Applying die-cut sticker border...");
                const subjectBuf = await fsp.readFile(outputPath);
                const bordered = await compositeStickerBorder(subjectBuf, { borderPx: 14, trim: true });
                await fsp.writeFile(outputPath, bordered);
                console.log("🏷️  Sticker border applied.");
            } catch (stickerErr) {
                console.error(`🏷️  Sticker border failed (delivering clean cut-out): ${stickerErr.message}`);
            }
        } else {
            // 4b. Exact background compositing — chroma-key magenta fill, then
            // composite subject onto the uploaded background image.
            if (bgMode === "exact" && bgRefBuffers.length > 0) {
                try {
                    console.log("🖼️  Chroma-keying magenta fill and compositing onto exact background image...");
                    const { width: pw, height: ph } = settings.getPrintDimensions();
                    const portraitBuf = await fsp.readFile(outputPath);
                    const composited = await compositeExactBackground({
                        portraitBuf,
                        backgroundBuf: bgRefBuffers[0],
                        width: pw,
                        height: ph,
                    });
                    await fsp.writeFile(outputPath, composited);
                    console.log("🖼️  Exact background applied.");
                } catch (bgErr) {
                    console.error(`🖼️  Exact background compositing failed (using portrait as-is): ${bgErr.message}`);
                }
            }

            // 5. Apply template frame (composites in-place onto the output file)
            console.log("🖼️  Applying template frame...");
            await compositeWithTemplate(outputPath);

            // 6. Resize to print dimensions (5x7 @ 300 DPI)
            console.log("📐 Preparing image for print...");
            await prepareForPrint(outputPath);
        }
    }
```

- [ ] **Step 3: Skip the JPEG MMS conversion for stickers**

The MMS block at lines 639-646 converts the PNG to opaque JPEG. For stickers, skip it so delivery uses the transparent `_output.png`. Replace:

```javascript
    // 7. Create compressed version for MMS (skip if already exists from a previous attempt)
    if (!fs.existsSync(mmsPath)) {
        console.log("📱 Creating MMS image...");
        await sharp(outputPath)
            .resize(800, null, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(mmsPath);
    }
```

with:

```javascript
    // 7. Create compressed JPEG for MMS. Skipped for stickers: JPEG has no
    //    alpha, so flattening here would destroy the transparency. Sticker
    //    jobs deliver _output.png directly (see lib/queue.js delivery).
    const stickerJob = !!(activeStyles[styleKey] && activeStyles[styleKey].sticker);
    if (!stickerJob && !fs.existsSync(mmsPath)) {
        console.log("📱 Creating MMS image...");
        await sharp(outputPath)
            .resize(800, null, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(mmsPath);
    }
```

(`activeStyles` and `styleKey` are both in scope at this point in `generateImage`; this re-derives the flag because `isSticker` lives inside the earlier `if (!fs.existsSync(outputPath))` block.)

- [ ] **Step 4: Verify nothing regressed**

Run: `node --test test/pipeline-sticker.test.js test/styles-sticker.test.js test/sticker.test.js`
Expected: PASS (all). These cover the seams; the inline branch is verified by reading + the queue test in Task 5.

Run: `node -e "require('./lib/pipeline')"`
Expected: no output, exit 0 (module loads — catches the new `require` typo or syntax error).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.js
git commit -m "feat: sticker post-processing skips flatteners, adds border, keeps PNG

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Delivery — force printing off and deliver the PNG for stickers

**Files:**
- Modify: `lib/queue.js` (delivery `imageUrl` at line 1181; printing branch at line 784)
- Test: `test/queue-sticker.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/queue-sticker.test.js`. The print/delivery decisions are currently inline in `queue.js`, so extract them as pure exported helpers (mirrors the `__resolveGenParamsForTest` approach):

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __stickerDeliveryUrl, __shouldPrintJob } = require("../lib/queue");

test("sticker job delivery URL points at the transparent PNG", () => {
    const url = __stickerDeliveryUrl({ baseUrl: "https://x.test", filePrefix: "p1", style: "sticker" }, true);
    assert.equal(url, "https://x.test/images/p1_output.png");
});

test("non-sticker job delivery URL points at the MMS JPEG", () => {
    const url = __stickerDeliveryUrl({ baseUrl: "https://x.test", filePrefix: "p1", style: "cartoon" }, false);
    assert.equal(url, "https://x.test/images/p1_output_mms.jpg");
});

test("printing is forced off for sticker jobs regardless of event config", () => {
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: true, isSticker: true }), false);
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: true, isSticker: false }), true);
    assert.equal(__shouldPrintJob({ eventPrintingEnabled: false, isSticker: false }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/queue-sticker.test.js`
Expected: FAIL — `__stickerDeliveryUrl is not a function`.

- [ ] **Step 3a: Add the pure helpers**

In `lib/queue.js`, near the top-level helpers (after the requires block), add:

```javascript
// Pure delivery/print decisions for sticker jobs (unit-tested in
// test/queue-sticker.test.js). Stickers deliver a transparent PNG (alpha
// would die in the MMS JPEG) and never print (printers can't do alpha, and
// the feature is digital-only by design).
function stickerDeliveryUrl(job, isSticker) {
    if (!job.baseUrl) return null;
    const file = isSticker ? `${job.filePrefix}_output.png` : `${job.filePrefix}_output_mms.jpg`;
    return `${job.baseUrl}/images/${file}`;
}

function shouldPrintJob({ eventPrintingEnabled, isSticker }) {
    return !!eventPrintingEnabled && !isSticker;
}
```

- [ ] **Step 3b: Use the delivery helper**

In `sendDigitalDelivery`, replace line 1181:

```javascript
    const imageUrl = job.baseUrl ? `${job.baseUrl}/images/${job.filePrefix}_output_mms.jpg` : null;
```

with:

```javascript
    const isStickerJob = !!(activeStyles[jobStyle] && activeStyles[jobStyle].sticker);
    const imageUrl = stickerDeliveryUrl(job, isStickerJob);
```

(`activeStyles` and `jobStyle` are already resolved earlier in `sendDigitalDelivery` at lines 1147-1150.)

- [ ] **Step 3c: Use the print helper**

At the printing branch (line 784):

```javascript
        if (settings.getForEvent("enablePrinting", job.eventName)) {
```

replace with:

```javascript
        const jobIsSticker = !!(settings.getActiveStyles()[job.style] && settings.getActiveStyles()[job.style].sticker);
        if (shouldPrintJob({ eventPrintingEnabled: settings.getForEvent("enablePrinting", job.eventName), isSticker: jobIsSticker })) {
```

- [ ] **Step 3d: Export the helpers**

Add both to `lib/queue.js`'s `module.exports`:

```javascript
    __stickerDeliveryUrl: stickerDeliveryUrl,
    __shouldPrintJob: shouldPrintJob,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/queue-sticker.test.js`
Expected: PASS (3 tests).

Run: `node -e "require('./lib/queue')"`
Expected: exit 0 (module loads).

- [ ] **Step 5: Commit**

```bash
git add lib/queue.js test/queue-sticker.test.js
git commit -m "feat: sticker jobs deliver PNG and never print

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `node --test`
Expected: PASS, including the four new files (`sticker`, `styles-sticker`, `pipeline-sticker`, `queue-sticker`) and all pre-existing tests unchanged.

- [ ] **Manual smoke (optional, requires live keys)**

In an event whose style menu includes "Sticker": text in a selfie, pick Sticker, confirm the reply is a transparent PNG with a white die-cut border, that no print job is queued, and that picking Cartoon in the same event still prints/behaves exactly as before.
