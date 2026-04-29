# Prompt Experiment Tracker — Design

**Status:** Design approved 2026-04-28, ready for implementation planning.

## Goal

A web-based prompt experiment tracker at `/eval` that lets the admin queue image-generation experiments across style/brand/background combinations and multiple prompt variants, compare results side-by-side, mark winners per combination, and keep a persistent history of past runs.

## Motivation

Prompt engineering for `gpt-image-2` is empirical — OpenAI's documented guidance is thin, and what works for a style in isolation can drift when a brand wardrobe block or background instruction is added. Today this is evaluated ad-hoc: edit `styles.js`, send a selfie via SMS, eyeball the output, iterate. This loses history, cannot compare variants fairly, and encourages tuning based on a single generation.

The tracker makes prompt evaluation reproducible, parallelizable across many combinations, and persistently comparable across time.

## Non-Goals

- Automated image quality scoring. Visual judgment is the user's job.
- Replacing the production pipeline. This is a standalone evaluation tool that shares assembly logic but runs fully isolated.
- Live-event use. Not intended for running during real SMS events — built for internal iteration on a developer laptop or the dashboard server.
- Pre-run cost estimation, prompt diffing, export, cross-run comparison, or patches-style variants. Explicitly deferred to future versions.

## Architecture

### New and changed files

```
lib/
  prompt-builder.js      NEW — pure function: (resolved inputs) → full prompt string.
                         Extracted from pipeline.js lines ~293-529.
  experiments.js         NEW — experiment runner, storage, and Express routes.
  pipeline.js            MODIFIED — delegates prompt assembly to prompt-builder.js.

test/
  prompt-builder-characterize.test.js  NEW — byte-identical snapshots of current
                                              pipeline prompt output.
  prompt-builder.test.js               NEW — unit tests for the pure function.
  experiments.test.js                  NEW — runner orchestration with OpenAI mocked.

data/experiments/        NEW DIRECTORY — gitignored
  photos.json                       manifest of test photos + cached scene analysis
  test-photos/
    <name>.jpg
    <name>.json                     per-photo scene cache
  <timestamp>_<name>/               one directory per experiment run
    manifest.json
    <entry>.png ...

index.js                 MODIFIED — add mountExperiments(app).
.gitignore               MODIFIED — add data/experiments/.
```

### Data flow — single experiment run

1. User clicks **Run experiment** in the UI.
2. `POST /eval/api/runs` validates the config, writes an initial `manifest.json` with `status: "running"`, and kicks the runner asynchronously. Returns the new experiment ID.
3. Runner iterates over every `combination × variant × photo × rep`:
   1. Ensures the photo has a cached scene description (generates once if missing).
   2. Resolves the style/brand/background for the combination — using live settings or variant overrides.
   3. Calls `promptBuilder.build(...)` → prompt string.
   4. Calls `openai.images.edit(...)` with the selfie + reference images.
   5. Writes the PNG to the experiment directory and updates the manifest entry.
   6. On error, retries once; a second failure marks the entry `failed`.
4. Three entries run in parallel at any time (hardcoded `MAX_CONCURRENT = 3`).
5. Runner updates `status: "completed"` and writes final totals when all entries settle.
6. Browser polls `GET /eval/api/runs/:id` every 3 seconds while running; images appear in the grid as they complete.

### Module responsibilities

| Module | Responsibility | Key Dependencies |
|---|---|---|
| `prompt-builder.js` | Assemble the final prompt string given fully-resolved inputs. Pure — no I/O, no settings reads, no caching. | `styles.js`, `prompt-assembler.js` |
| `experiments.js` | Manifest CRUD, runner orchestration, Express routes, photo management. | `prompt-builder.js`, `config.js`, `openai`, `helpers.js` |
| `pipeline.js` | Production path: moderation, face detection, scene analysis, reference-image loading, calls `prompt-builder.build()`, image generation, compositing, printing. | `prompt-builder.js` (new), everything it already uses. |

## prompt-builder.js — Extracted Pure Function

### Signature

```javascript
// lib/prompt-builder.js
/**
 * Build the final prompt string sent to gpt-image-2.
 * Pure function: no I/O, no settings reads, no caching.
 *
 * @param {Object} input
 * @param {string} input.styleKey
 * @param {Object} input.style                  — resolved style object (from getActiveStyles)
 * @param {string} [input.brandKey]
 * @param {Object} [input.brand]                — resolved brand object from customBrands
 * @param {string} [input.brandAnalysis]        — cached vision description of brand refs
 * @param {Array<Buffer>} input.brandRefBuffers — presence check only
 * @param {string} [input.styleAnalysis]
 * @param {Array<Buffer>} input.styleRefBuffers
 * @param {Object} [input.background]           — resolved bg {key, name, mode, prompt, files}
 * @param {string} [input.bgAnalysis]
 * @param {Array<Buffer>} input.bgRefBuffers
 * @param {Object} input.scene                  — parsed scene {subjects, pets, positions}
 * @param {Object} input.eventSettings          — preserve, preserveBrand, brandInstruction,
 *                                                 composition, promptBackground, multiSubjectMode
 * @param {string} [input.reviewFeedback]       — admin override text, takes priority
 * @returns {string}                             — the full prompt string
 */
function build(input) { ... }

module.exports = { build };
```

### Extraction scope

**Moves out of `pipeline.js` → into `prompt-builder.js`:**
- The `parts` array assembly block (lines ~306-394)
- Combo fragment injection (containerDescription, colorPalette)
- Background instruction logic including the regex-based "style already mentions background" detection at line 465
- Multi-subject caricature injection (lines 490-494)
- Review-feedback override (lines 500-503)
- FINAL STYLE LOCK block (lines 514-517)
- FINAL REMINDER block (lines 521-529)

**Stays in `pipeline.js`:**
- Moderation, face detection, scene analysis (the `analyzeScene` call and `parseScene` parsing)
- Brand / style / background reference-image file loading
- Reference-image vision analysis (`analyzeReferences`) and its caching
- `openai.images.edit()` invocation, image model config, edit params
- Template compositing, resizing
- SMS and printing

### Refactor safety strategy

This is the highest-risk change in the project. Safety plan:

1. **Characterize first.** Before any extraction, write `prompt-builder-characterize.test.js` that drives the current `pipeline.js` assembly path (via a test harness that stubs out I/O) and snapshots the exact output string for ~8 scenarios:
   - Solo style, no brand, no background
   - Solo style with brand (wardrobe-only category)
   - Solo style with brand (wardrobe-plus-scene category)
   - Style with themed-container behavior (magazine-cover-like)
   - Style that rejects color palette (sketch-like)
   - Multi-subject (2 people)
   - Subject + pet
   - Reviewer-feedback override present
2. **Run snapshots against current code.** All pass.
3. **Extract** into `prompt-builder.js`. Change `pipeline.js` to call it.
4. **Re-run snapshots.** They MUST pass byte-identical. If any snapshot diverges — even whitespace — the refactor is wrong and we investigate before proceeding.
5. **Add direct unit tests** in `prompt-builder.test.js` after the extraction has proven safe.

Byte-identical output is the acceptance criterion for the refactor. Nothing ships if snapshots diverge.

## experiments.js — Runner, Storage, Routes

### Manifest schema

Every experiment directory contains a `manifest.json`:

```json
{
  "id": "2026-04-28T14-30-00_cartoon-length-v2",
  "name": "cartoon-length-v2",
  "createdAt": "2026-04-28T14:30:00.123Z",
  "status": "running" | "completed" | "failed",
  "updatedAt": "2026-04-28T14:45:12.456Z",

  "config": {
    "styles": ["cartoon"],
    "brands": [null, "twilio"],
    "backgrounds": [null, "original"],
    "photos": ["anthony.jpg", "sample-2.jpg"],
    "reps": 3,
    "variants": [
      {
        "name": "current",
        "type": "live",
        "resolved": { "<styleKey>": { "prompt": "...", "core": "...", "brandCore": "..." } }
      },
      {
        "name": "trimmed",
        "type": "custom",
        "overrides": { "cartoon": { "prompt": "...", "core": "...", "brandCore": "..." } }
      }
    ]
  },

  "entries": [
    {
      "photo": "anthony.jpg",
      "style": "cartoon",
      "brand": null,
      "background": null,
      "variant": "current",
      "rep": 1,
      "status": "pending" | "running" | "completed" | "failed",
      "outputPath": "anthony_cartoon_none_none_current_1.png",
      "promptText": "<full prompt as sent>",
      "generationMs": 34210,
      "error": null,
      "startedAt": "...",
      "completedAt": "..."
    }
  ],

  "winners": {
    "cartoon|null|null": { "variant": "trimmed", "notes": "..." },
    "cartoon|twilio|null": { "variant": "current", "notes": "..." }
  },
  "notes": "<markdown notes for the whole experiment>",
  "totalCostUsd": 3.42
}
```

Winner keys are the combination triplet `style|brand|background` (nulls represented as the literal string "null" in the key).

### Runner orchestration

```javascript
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 1;

async function runExperiment(manifestPath) {
    const manifest = await loadManifest(manifestPath);
    manifest.status = "running";
    await saveManifest(manifestPath, manifest);

    for (const photo of manifest.config.photos) {
        await ensurePhotoSceneCache(photo);
    }

    const inFlight = new Set();
    for (const entry of manifest.entries) {
        while (inFlight.size >= MAX_CONCURRENT) await Promise.race(inFlight);
        const p = runEntry(entry, manifest).finally(() => inFlight.delete(p));
        inFlight.add(p);
    }
    await Promise.all(inFlight);

    manifest.status = "completed";
    manifest.totalCostUsd = sumCosts(manifest.entries);
    await saveManifest(manifestPath, manifest);
}

async function runEntry(entry, manifest) {
    entry.status = "running";
    entry.startedAt = new Date().toISOString();
    await flushManifest(manifest);

    try {
        entry.promptText = await assemblePromptForEntry(entry, manifest);
        const pngBuf = await callImageEdit(entry.promptText, entry, manifest);
        // entry.outputPath is a filename; resolve against the experiment directory
        await fsp.writeFile(path.join(experimentDir, entry.outputPath), pngBuf);
        entry.status = "completed";
    } catch (err) {
        if (!entry._retried) {
            entry._retried = true;
            return runEntry(entry, manifest);
        }
        entry.status = "failed";
        entry.error = err.message;
    }
    entry.completedAt = new Date().toISOString();
    await flushManifest(manifest);
}
```

Manifest flushing writes the full JSON to disk after every status change so the polling UI sees progress in real time and a mid-run crash leaves recoverable partial state.

### Photo management

`data/experiments/photos.json`:

```json
{
  "photos": [
    {
      "filename": "anthony.jpg",
      "displayName": "Anthony",
      "uploadedAt": "2026-04-27T10:00:00Z",
      "sceneDescription": "<raw text from analyzeScene()>",
      "parsedScene": { "subjects": 1, "pets": "none", "positions": "..." }
    }
  ]
}
```

Upload flow:
1. Validate JPG (file-type check server-side).
2. Write to `data/experiments/test-photos/<filename>`.
3. Call `helpers.analyzeScene()` on the image (~$0.02 per photo, one-time).
4. Call `helpers.parseScene()` to extract structured data.
5. Write both raw description and parsed scene to `photos.json`.
6. Return success — UI shows the scene text so the user knows what the runner will use.

If scene analysis fails, save the photo anyway with `sceneDescription: null`. Runner falls back to the default single-subject scene line.

### Routes

All routes sit behind the existing Google OAuth middleware in `index.js`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/eval` | Landing page — list of runs + "New" button |
| GET | `/eval/new` | New-run form (full page) |
| GET | `/eval/run/:id` | Run detail page with side-by-side grid |
| GET | `/eval/api/runs` | List all experiments (JSON, for polling) |
| POST | `/eval/api/runs` | Create a new run, kick off runner |
| GET | `/eval/api/runs/:id` | Full manifest JSON (polled for progress) |
| PATCH | `/eval/api/runs/:id` | Update `winners` and `notes` |
| DELETE | `/eval/api/runs/:id` | Delete entire experiment directory |
| GET | `/eval/api/photos` | List uploaded photos |
| POST | `/eval/api/photos` | Upload a new photo (runs scene analysis) |
| DELETE | `/eval/api/photos/:name` | Remove a photo |
| GET | `/experiment-images/:id/:file` | Static serving of PNGs from experiment dirs |

### Cost accounting

Per-image cost is a fixed constant (`~$0.19` for gpt-image-2 at 1024x1536 high quality). Stored in `lib/experiments.js` as `COST_PER_IMAGE_USD`. Manifest's `totalCostUsd` is computed as `completed_entries × COST_PER_IMAGE_USD` after the run finishes.

No pre-run cost estimation in v1. Cost is shown post-run on the detail page.

## Admin UI

Server-rendered HTML with inline CSS, following the existing `dashboard.js` / `home.js` pattern. No framework. Minimal JavaScript — fetch polling for progress, click handlers, debounced auto-save for winners and notes.

### Shared theming

- Theme-aware via existing `--th-*` CSS variables
- Import `/assets/twilio-brand.css` for fonts
- Include `userBarSnippet()` and `magicHatSnippet()` on every page — matches existing admin UI chrome

### Landing page (`/eval`)

- Running experiments at the top, auto-refreshing every 3 seconds
- "Recent" section below, listing completed and failed runs chronologically
- Each card shows name, created date, entry count, cost, winner summary, optional short notes excerpt
- Buttons: `[+ New experiment]` (navigates to `/eval/new`), `[Photos]` (opens photo-manager modal)

### Run detail page (`/eval/run/:id`)

Organized by **combination** per Q5. Each combination is a collapsible block with:
- Header: "Combination: cartoon × no-brand × style-default-bg"
- Winner dropdown (one of the variant names or "unmarked")
- Notes textarea — debounced auto-save
- For each photo in the run: a grid with rows = variants, columns = reps
- Image thumbnails ~180px; click to open full-res modal

Modal shows full-resolution image, the exact prompt text sent to `images.edit`, a copy-to-clipboard button, and the variant configuration used. Failed entries show a red placeholder with the error message instead of an image. Running entries show a spinner tile.

### New run form (`/eval/new`)

Full-page form, not a modal. Fields:

1. **Name** — text input, required, unique
2. **Styles** — multi-select checkboxes of all active styles
3. **Brands** — multi-select (`(no brand)` + all active brands)
4. **Backgrounds** — multi-select (`(style default)` + specific bg keys from active backgrounds)
5. **Reference photos** — multi-select from uploaded photos
6. **Reps** — number input, default 3
7. **Variants** — add one or more:
   - `[+ Add variant from live settings]` → creates a "live" variant that snapshots current settings at run time
   - `[+ Add variant with custom overrides]` → creates a variant with a name + per-style override textareas (pre-filled with current live values for the styles in the matrix)

Submit kicks off `POST /eval/api/runs`, redirects to the detail page. Form rejects > 500 total entries or > 10 variants.

### Photo manager modal

Accessed from the `[Photos]` button on the landing page:
- Drag-and-drop or file-picker upload
- List of uploaded photos, each showing filename, scene text, upload date
- Delete button per photo (blocked if referenced by a running experiment)

Upload is synchronous — shows a loading state while scene analysis runs, then adds to the list.

## Testing

Three test layers with clear ownership:

| Layer | What | Where |
|---|---|---|
| Characterize | `pipeline.js`'s current prompt output on 8 scenarios, byte-identical snapshots before and after the refactor | `test/prompt-builder-characterize.test.js` |
| Unit | `prompt-builder.build()` covering combo matrix, reviewer override, multi-subject, palette suppression, themed-container, reference-image fallback paths | `test/prompt-builder.test.js` |
| Integration | `experiments.runExperiment()` with OpenAI mocked — orchestration, retry logic, manifest writes, failure propagation | `test/experiments.test.js` |

**Not tested:**
- Real OpenAI calls (mocked everywhere)
- HTML rendering (no Playwright)
- UI interactions (manual verification on real runs)

Full existing test suite must pass at every commit. The characterize test is the gate for the refactor — byte-identical or no ship.

## Error Handling

| Failure | Behavior |
|---|---|
| `images.edit` error | Retry once via runner. Second failure marks entry `failed` with error message |
| Rate limit (429) | Same retry path |
| OpenAI timeout (5 min) | Same retry path |
| Server crash mid-run | On server startup, `mountExperiments(app)` scans `data/experiments/` for any manifest with `status: "running"`, marks it `failed` with reason "server restarted", and marks any `pending` or `running` entries `failed`. No auto-resume in v1 |
| Invalid JPG upload | Server-side file-type check; 400 response |
| Scene analysis fails on upload | Save the photo with `sceneDescription: null`. Runner falls back to default single-subject scene line |
| User deletes photo referenced by a running experiment | Block delete. Allow delete once all references are in completed runs |
| User closes browser during a run | Runner continues server-side; refresh to see progress |
| Parallel experiment starts from two tabs | Each gets its own experiment dir; both run in parallel, each with its own `MAX_CONCURRENT = 3` cap |
| Disk full | Runner catches `ENOSPC`, marks entry failed with "disk full" |

### Runner safety guards

- **Max 500 total entries per experiment.** Form rejects above this.
- **Max 10 variants per experiment.** Form UI limit.
- **Cleanup on failed creation.** If manifest write fails partway, clean up partial directory.

## Rollout

Ship in two commits for isolated risk:

1. **Commit 1: Refactor `prompt-builder.js` extraction.** Includes characterize tests proving byte-identical output. Deploy, observe production for a day, confirm no prompt regressions in live events.
2. **Commit 2: Experiment tracker feature.** New module, routes, UI, `data/experiments/` setup. Net-new code — lower risk.

Rollback: each commit is independently revertible. If anything looks off in live generations after commit 1, `git revert` restores the original.

## Out of Scope for v1

Explicit deferrals:

- Pre-run cost/count estimation
- Automated winner scoring (AI vision grading)
- "Resume failed experiments" / gap-fill re-runs
- Prompt diffing between variants
- Export manifest as CSV
- Cross-run comparison
- Patches-style variants (only full-override in v1)
- Batch rename / tag / search
- Post-processing (template frames, resizing) — raw gpt-image-2 output only
