# Style × Brand × Background Combos — Design

**Status:** Draft
**Date:** 2026-04-24
**Author:** Anthony Dellavecchia

## Goal

Give each event the ability to offer multiple art styles × brand wardrobes × background scenes in a composable way, via SMS. Every combo must produce a sensible image. Adding a new style, brand, or scene later is a config edit, not a code change. The immediate driver is an upcoming event with brand partnerships (LA Kings, Chelsea FC, PGA, Coachella, Twilio), but the feature is reusable for any future event.

## Non-goals

- Supporting brand-level "container" scenes (e.g., put the subject inside a giant phone booth). Deferred.
- Multi-scene pagination (brands with more than ~3 scenes). Deferred.
- Regional brand variants (LA Kings home vs away jersey). Deferred.
- Per-style forced palette. Deferred.

## Model

Three composable axes: **style**, **brand**, **background**. Each is picked independently over SMS. Backgrounds are assembled contextually from the style + brand choice.

### Styles

Nine styles for this event (some built-in, some custom):

| Style | Source | Behavior | Accepts palette? |
|---|---|---|---|
| Cartoon (Pixar-style) | built-in | normal | yes |
| Anime | built-in | normal | yes |
| Watercolor | built-in | normal | yes |
| Pixel Art | built-in | normal | yes |
| Magazine Cover (photorealistic) | custom | normal | yes |
| Comic Geometric | custom | normal | yes |
| Bronze Sculpture | custom | normal | **no** |
| Action Figure | custom | themed-container | yes |
| Sports Trading Card | custom | themed-container | yes |

**Style fields (new):**

- `behavior` — `"normal"` or `"themed-container"`. Default `"normal"`.
  - `normal` — scene appears behind the subject as the image background.
  - `themed-container` — subject sits inside a physical container (toy box, trading card). The chosen scene themes the container's interior/art, not a full image background.
- `acceptsColorPalette` — boolean. Default `true`. When `false`, the brand's color palette override is suppressed (e.g., bronze stays bronze).
- `containerDescription` — string, required when `behavior === "themed-container"`. Describes the container and how scene/brand theming flows into it.

### Brands

Five brands + a "None" option.

| Brand | Category | Color palette? |
|---|---|---|
| LA Kings | wardrobe-only | no |
| Chelsea FC | wardrobe-only | no |
| PGA Golfer | wardrobe-only | no |
| Coachella Performer | wardrobe-plus-scene | no |
| Twilio | wardrobe-plus-scene | **yes** (red/white) |

**Brand fields (new):**

- `category` — `"wardrobe-only"` or `"wardrobe-plus-scene"`. Default `"wardrobe-only"`.
- `wardrobe` — prompt fragment describing clothing/accessories.
- `scenes` — array of `{ key, name, prompt, files? }`. Wardrobe-only brands typically define 1 scene (shown alongside "Original" and "Plain white" in the menu). Wardrobe-plus-scene brands must define at least 2 scenes (menu auto-skips with only 1 option). Optional; empty is allowed but interacts with `allowOriginal` to determine menu contents.
- `allowOriginal` — boolean. Default `true`. When `false`, "Original scene" is hidden from the background menu.
- `colorPalette` — optional prompt fragment. When set, applied as a final recoloring instruction unless the chosen style has `acceptsColorPalette: false`.

### Backgrounds

Not a fixed menu. Assembled at runtime from:

1. Brand scenes (if any)
2. "Original scene" — added unless brand sets `allowOriginal: false`
3. "Plain white" — added unless style is `themed-container`

Auto-skip when the resolved menu has exactly one option.

## SMS Flow

Order: selfie → style menu → brand menu → background menu (conditional).

```
[Selfie received, moderation passes]
  → Style menu (9 options)
  → Brand menu (5 brands + None)
  → resolveBackgroundMenu(style, brand):
      - if result.length === 1: auto-apply, skip question
      - else: show menu, wait for reply
  → assemblePrompt(...)
  → queue for image generation
```

### Background-menu matrix

| Style behavior | Brand type | Menu contents | Ask? |
|---|---|---|---|
| normal | wardrobe-only | [brand scene, Original, Plain white] | yes (3 opts) |
| normal | wardrobe-plus-scene | [2 brand scenes] | yes (2 opts) |
| normal | None | [Original, Plain white] | yes (2 opts) |
| themed-container | wardrobe-only | [brand scene, Original] | yes (2 opts) |
| themed-container | wardrobe-plus-scene | [2 brand scenes] | yes (2 opts) |
| themed-container | None | [Original] | **auto-skip** |

### Session state

Per-phone pending record (extends existing pattern from `lib/background-menu.js`):

```
pending[phone] = {
  imageUrl,       // uploaded selfie URL
  messageSid,
  styleId,        // set after style pick
  brandId,        // set after brand pick (null if "None")
  backgroundId,   // set after bg pick (or auto-applied)
  appPhone, baseUrl,
  timestamp
}
```

30-min stale-entry cleanup inherits from existing menu code.

## Prompt Assembly

Pure function. Takes `{ style, brand, background }`, returns a single prompt string. Fixed paragraph ordering:

1. Transform directive + "do not add anyone" guard
2. Style prompt body (includes identity preservation + style rendering)
3. Brand wardrobe (if brand)
4. Brand-logo fidelity instruction (if brand has reference files)
5. Container description (if style is themed-container)
6. Background / scene
7. Color palette override (if brand has palette AND style accepts palette)

**Why this order:** identity is asserted before transformation; wardrobe before container (dress, then place); background before palette (scene exists, then gets recolored). Palette is last so it acts as a global filter over everything above.

### Worked combos

**Cartoon × no brand × Original scene** — 3 blocks: directive, cartoon prompt, original scene.

**Cartoon × LA Kings × Ice rink** — 5 blocks: directive, cartoon prompt, LA Kings wardrobe, logo-fidelity, ice rink scene.

**Action Figure × LA Kings × Ice rink** — 6 blocks: directive, action-figure prompt, wardrobe, logo-fidelity, container description, ice rink scene.

**Action Figure × Twilio × Rotary phone** (fully stacked) — 7 blocks: all of the above + Twilio palette override. Result: red/white action-figure toy box with Twilio-branded packaging, figure in Twilio gear, box interior depicts rotary phone scene, all recolored to Twilio red/white.

**Bronze Sculpture × Twilio × Rotary phone** — 5 blocks: directive, bronze prompt, Twilio wardrobe, logo-fidelity, rotary phone scene. Palette suppressed — bronze stays bronze; Twilio identity comes through via wardrobe + logos + scene.

## Implementation Plan

### Files added

- `lib/prompt-assembler.js` — new module. Exports `assemblePrompt({ style, brand, background })` and `resolveBackgroundMenu(style, brand)`. Pure functions. Reads `settings.get("promptUserDirective")`, `settings.get("promptBrandInstruction")`, `settings.get("promptBackground")`.

### Files modified

- `lib/styles.js` — extend built-in `STYLES` objects with `behavior: "normal"` and `acceptsColorPalette: true` on every entry. No behavior change for existing events (these are the defaults regardless).
- `lib/settings.js` — extend `validate()` for `customStyles` to accept optional `behavior`, `acceptsColorPalette`, `containerDescription`. Extend `validate()` for `customBrands` to accept optional `category`, `scenes` (array of scene objects), `allowOriginal`, `wardrobe`, `colorPalette`.
- `lib/outreach.js` — add brand-menu step (already wired, extend) and replace the final prompt-building call with `assemblePrompt(...)`. Before showing the background menu, call `resolveBackgroundMenu` and handle auto-skip.
- `lib/background-menu.js` — accept resolved choices from `resolveBackgroundMenu` instead of reading `settings.get("backgroundChoices")` directly for this event. Existing per-event override of `backgroundChoices` still works for other events.
- Admin UI (dashboard) — add fields to style form (behavior dropdown, acceptsColorPalette toggle, containerDescription textarea) and brand form (category dropdown, scenes repeater, allowOriginal toggle, wardrobe textarea, colorPalette textarea).

### Event profile for this event

No code changes — all configuration lives in the event's `settings.json`:

- `customStyles` — Comic Geometric, Action Figure, Bronze Sculpture, Trading Card, Magazine Cover (with new fields set)
- `customBrands` — LA Kings, Chelsea FC, PGA, Coachella, Twilio (with new fields set)
- `disabledStyles` — any built-in styles not used (Pop Art, Sketch likely)
- `enableBrandMenu: true`
- `enableBackgroundMenu: true`

### Backward compatibility

All new fields are optional with safe defaults:

- Missing `behavior` → `"normal"` (current behavior)
- Missing `acceptsColorPalette` → `true` (applies palette if set, a no-op if brand has none)
- Missing `category` → `"wardrobe-only"`
- Missing `scenes` → `[]`
- Missing `allowOriginal` → `true`
- Missing `colorPalette` → none (no palette override)

Past events load and run unchanged. Events that enabled `backgroundChoices` continue to use them via the existing per-event override path.

## Edge Cases

| Case | Resolution |
|---|---|
| Server restart mid-flow | In-memory pending lost; user re-prompted. Same as today. |
| 30-min silence | Existing cleanup interval wipes stale entries. |
| Admin disables a brand mid-event | Stale pending brandId → retry menu rebuilt with current list. |
| Brand has wardrobe text but no reference files | Logo-fidelity clause omitted (no logos to copy). |
| "Original scene" when selfie background is plain | Degrades to neutral background. Acceptable. |
| Bronze × Twilio | Palette suppressed by `acceptsColorPalette: false`. Bronze preserved. |
| Coachella × any style | 2 scenes only, no Original, no Plain white. |
| Zero-option resolved menu | Defensive fallback → "Original scene". |
| User picks "None" for brand | `brandId = null`; all brand-dependent prompt blocks skipped via guards. |

## Testing

**Unit tests (pure functions).** Construct style/brand/background objects and assert `assemblePrompt` output contains or excludes specific fragments across all 45 style × brand combos + null-brand variants. Test `resolveBackgroundMenu` against the matrix above.

**Settings validation tests.** Load legacy `customBrands` / `customStyles` (no new fields) and verify defaults apply cleanly.

**SMS flow integration.** Manual script covering: 3-menu happy path (Cartoon + LA Kings + Ice rink); 2-menu auto-skip (Action Figure + None); forced brand scene (Coachella + Anime); palette suppression (Bronze + Twilio); palette applied (Action Figure + Twilio).

**Visual smoke test.** Generate real images for high-risk combos before the event: Action Figure × Twilio × Rotary phone, Bronze Sculpture × Twilio × Wings, Trading Card × Coachella × Ferris wheel. Verify mental model matches output.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Palette override too aggressive, washes out wardrobe | Med | Med | Iterate on palette prompt text; anchor with reference images |
| Themed-container output varies inconsistently between runs | Med | Med | Add brand-specific `containerOverride` field later if needed |
| Twilio logos rendered incorrectly without reference files | High | Med | Admin checklist: require Twilio reference files before event |
| Coachella wardrobe + Bronze style feels off-genre | Low | Low | Acceptable — user chose it |
| Brand's color palette interacts badly with trading-card graphics | Med | Med | Scene-specific overrides can be added in config without code |

## Open Questions

- Do any future brand partners need additional scenes beyond the 1–2 we've defined? (Defer to as-needed.)
- Should the admin UI warn when a brand sets `category: "wardrobe-plus-scene"` but has fewer than 2 scenes? (Nice-to-have; not blocking.)
- Twilio Phone Booth brand — if re-introduced later, requires extending the model with brand-level container behavior. Separate design.
