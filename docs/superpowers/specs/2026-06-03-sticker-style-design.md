# Digital Sticker Style — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Author:** brainstormed with Claude

## Summary

Add a new built-in art style, **Sticker**, that produces a transparent-background,
die-cut "peel-and-stick" image instead of a normal rectangular photo. The sticker is
**digital-only** (never printed) and delivered as a transparent **PNG** so the alpha
channel survives.

The style is selected exactly like the existing styles (Cartoon, Pop Art, etc.). What
makes it a sticker is a single `sticker: true` flag on the style definition, which the
generation pipeline reads to change four downstream behaviors. Everything about *how a
style is chosen and flows through the system* is unchanged.

## Motivation

A co-worker's `ai-photobooth` project (luisleao/ai-photobooth) generates WhatsApp
stickers alongside its main card. We want a comparable sticker output, but:

- **digital only** — no printing, no printable sticker sheet;
- **as a style the user picks** — not a bonus generated alongside every photo;
- **with both** a new sticker *look* (glossy 3D caricature) **and** a transparent
  cutout with a die-cut white border.

The defining trait of a sticker is not the art style — it is the **transparent alpha
channel** plus a **delivery format that preserves transparency**. Those live in the
pipeline and delivery layers, not the style layer, which is why this is mostly small,
targeted pipeline work rather than "just a new style."

## Background: what the codebase already does

Verified against the current integration code:

- **Styles are data-carried, not just prompts.** `jobPaths`/`generateImage` resolve
  `styleObj = activeStyles[styleKey]` (`lib/pipeline.js:334`) and carry the whole object
  through generation. A flag added to the style definition automatically arrives at
  every downstream decision point — no new parameter threading required.
- **Transparent generation already exists.** For "exact background" mode the pipeline
  forces `gpt-image-1.5` and passes `background: "transparent"`
  (`lib/pipeline.js:508-519`), producing a real alpha-channel PNG. We extend this same
  path for stickers.
- **The transparency is then destroyed** in three places we must skip for stickers:
  - `compositeExactBackground()` pastes the cutout onto a background image
    (`lib/pipeline.js:612-628`, `lib/bg-composite.js`);
  - `compositeWithTemplate()` overlays a photo frame (`lib/pipeline.js:632`);
  - `prepareForPrint()` flattens alpha to a solid background (`lib/pipeline.js:636`).
- **MMS delivery flattens to JPEG.** `lib/pipeline.js:642-645` writes an 800px
  `*_output_mms.jpg`; `lib/queue.js:1181` points delivery at that JPEG. JPEG has no
  alpha, so the sticker must be delivered as PNG instead.
- **A digital-only path already exists.** When `enablePrinting` is false
  (`lib/queue.js:784`), jobs skip the print queue and deliver via MMS + share link
  (`lib/queue.js:816-823`). The share page serves the raw `*_output.png`.

## Design

### The flag

Add one new built-in style to the `STYLES` object in `lib/styles.js`:

```
sticker: {
    name: "Sticker",
    behavior: "normal",
    acceptsColorPalette: true,
    sticker: true,                       // <-- the switch
    core: "<one-line summary>",
    brandCore: "<brand-aware summary>",
    buildPrompt: (preserve, composition) => [ ... ].join("\n\n"),
}
```

`getActiveStyles()` (`lib/styles.js:134-178`) must be extended to propagate the
`sticker` boolean into the normalized active-style object for **both** built-in and
custom styles (so the flag survives the trip to `styleObj`). Default `false` when
absent — inert for every existing style.

### What the flag changes (4 behaviors)

**1. The look (prompt).** The Sticker `buildPrompt` produces a glossy, bold,
vinyl-sticker 3D-caricature aesthetic with strong likeness preservation, and explicitly
instructs: transparent background, subject only, **no AI-drawn white border / halo /
outline / stroke** (the border is added deterministically in post — see #3). Adapted
from the co-worker's prompt rules.

**2. Transparent generation.** Extend the model-forcing condition at
`lib/pipeline.js:508`. Today: `isExactBg = bgMode === "exact" && bgRefBuffers.length > 0`.
Introduce a `wantsTransparent = isExactBg || styleObj.sticker` notion that drives:
- `imageModel = "gpt-image-1.5"`,
- `editParams.background = "transparent"`,
- sticker output size `"1024x1024"` (square) instead of the portrait `"1024x1536"`.

The prompt-builder's `bgMode === "exact"` branch (`lib/prompt-builder.js:90-91`) already
emits a "fully transparent, subject as cut-out" instruction; the sticker prompt carries
its own transparent-background instruction, so no special-casing of the builder is
required beyond ensuring a sticker does not pick up a solid-background line.

**3. Post-processing.** When `styleObj.sticker`:
- **skip** `compositeExactBackground` (no background image — naturally skipped);
- **skip** `compositeWithTemplate` (`lib/pipeline.js:632`);
- **skip** `prepareForPrint` (`lib/pipeline.js:636` — this is what flattens alpha);
- **run** a new `compositeStickerBorder(outputPath)` that adds the die-cut white border.

**`compositeStickerBorder()` (new helper, `lib/sticker.js`)** — deterministic, no AI:
1. Read the transparent PNG; extract its alpha channel as a mask.
2. **Dilate** the mask outward by N px to form the border shape. `sharp` has no dilate
   primitive, so use blur-then-threshold: `.blur(sigma).threshold(t)` on the alpha,
   which grows the opaque region. N (border thickness) is a module constant.
3. Fill the dilated shape with solid white → the border layer.
4. Composite the **original subject** on top of the white border layer (`sharp.composite`,
   center gravity) — same compositing family as `lib/bg-composite.js:17-20`.
5. Optionally `.trim()` to crop transparent margins so the sticker is tightly framed.
6. Write back as PNG (alpha preserved).

**4. Delivery.** When `styleObj.sticker`:
- Skip the JPEG conversion at `lib/pipeline.js:642-645`. Deliver the existing
  `*_output.png` directly (it is the bordered sticker written by #3, ~1024px square —
  an acceptable PNG size for MMS). Do **not** introduce a separate downsized sticker
  file in v1; revisit only if MMS file-size limits prove a problem in practice.
- `sendDigitalDelivery` / `imageUrl` (`lib/queue.js:1181`) points at `*_output.png` for
  sticker jobs rather than `*_output_mms.jpg`.
- **Force `enablePrinting` off** for sticker jobs at the branch point
  (`lib/queue.js:784`) so a sticker never enters the print queue, regardless of event
  config.

### Delivery format trade-off (decided)

Delivery is **PNG**, not WebP. The co-worker uses 512×512 WebP because that is WhatsApp's
native sticker format, but this app delivers over **both SMS/MMS and WhatsApp**, and MMS
carriers do not reliably render WebP. PNG is the universal transparent format that works
as a regular image everywhere. Users receive a transparent PNG they can save and reuse —
not a tap-to-add-to-tray WhatsApp sticker. True WhatsApp sticker-type messages are a
possible later add-on (see Out of Scope).

### What does NOT change

Style selection and matching (`lib/style-menu.js`, `parseStyle`/`detectStyle`), the SMS
menu flow, brands/outfits, scene/subject logic, the six existing styles, and the normal
photo print path. The `sticker` flag is inert (`false`) for every non-sticker style.

## Components / files touched

| File | Change |
|---|---|
| `lib/styles.js` | Add `Sticker` built-in style + `sticker` flag; propagate flag in `getActiveStyles()` |
| `lib/sticker.js` (new) | `compositeStickerBorder()` — alpha-dilate → white die-cut → subject on top |
| `lib/pipeline.js` | Read `styleObj.sticker`; branch generation params (model/background/size), skip composite/template/print-flatten, run border helper, emit PNG instead of JPEG |
| `lib/queue.js` | Force printing off for sticker jobs; point delivery `imageUrl` at the PNG |

## Data flow

```
user picks "Sticker"  ->  styleKey="sticker"  ->  styleObj.sticker === true
   |
   v
prompt-builder: glossy caricature + "transparent, subject only, no drawn border"
   |
   v
pipeline generate: gpt-image-1.5, background:"transparent", size 1024x1024  -> alpha PNG
   |
   v
post-process (sticker branch): skip bg-composite / template / print-flatten
                               run compositeStickerBorder() -> white die-cut PNG
   |
   v
delivery: PNG (alpha preserved), printing forced OFF, share page serves PNG
```

## Error handling

- `compositeStickerBorder()` failure: log and fall back to delivering the clean
  borderless transparent PNG (mirrors the existing `compositeExactBackground`
  try/catch-and-continue at `lib/pipeline.js:625-627`). A sticker without a border is
  still a valid sticker; never fail the whole job over the border.
- If transparent generation somehow returns an opaque image, the border step still runs
  against whatever alpha exists; worst case is no visible border. No crash path.

## Testing

Follow existing `test/pipeline-*.test.js` patterns.

- **Unit — `compositeStickerBorder()`:** feed a known transparent PNG (subject on alpha),
  assert output still has an alpha channel, has a white opaque ring around the subject's
  alpha edge, and is larger than the subject bounds by ~N px.
- **Pipeline — sticker job:** assert a job with `style="sticker"` (a) requests
  `gpt-image-1.5` with `background:"transparent"` and square size, (b) does NOT call
  `compositeWithTemplate` / `prepareForPrint`, (c) produces a PNG with alpha (not a
  flattened JPEG), and (d) never enters the print queue (`enablePrinting` forced off).
- **Regression:** a normal style job is byte-for-byte unaffected (same model, same
  template/print path, same JPEG MMS output).

## Out of scope (YAGNI)

- Per-style border on/off toggle in admin UI (border is fixed for the Sticker style).
- WebP output / native WhatsApp sticker-type messages.
- Printable sticker sheets / grid composition.
- Sticker generated as a bonus alongside the normal photo.
- Making *any* existing style renderable as a sticker via a settings toggle (the flag
  mechanism would support this later; not built now).
