# Prompt Experiment Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone `/eval` admin tool that runs gpt-image-2 experiments across style/brand/background combinations and multiple prompt variants, compares results side-by-side, and persists history.

**Architecture:** Phase 1 extracts `pipeline.js`'s prompt assembly (~lines 293-529) into a pure `lib/prompt-builder.js` function, gated by byte-identical characterize tests. Phase 2 adds `lib/experiments.js` (runner + routes + storage in `data/experiments/`) mounted at `/eval` via the existing Express pattern. Two isolated commits for independent revertability.

**Tech Stack:** Node.js 20 (CommonJS), Express 5, `node:test`, OpenAI SDK 6, Sharp 0.34, server-rendered HTML with `--th-*` CSS variables — no frontend framework.

**Spec:** `docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md`

---

## File Structure

**Phase 1 — Refactor (2 new files, 1 modified):**
- `lib/prompt-builder.js` — NEW. Pure function `build(input)` returning the prompt string. No I/O, no settings reads.
- `test/prompt-builder-characterize.test.js` — NEW. Byte-identical snapshots of current pipeline prompt output for 8 scenarios. Gate for the refactor.
- `lib/pipeline.js` — MODIFIED. The `parts` assembly block, combo-fragments injection, multi-subject caricature append, review feedback override, FINAL STYLE LOCK, FINAL REMINDER all move to `prompt-builder.build()`. Pipeline now resolves inputs and calls it.
- `test/prompt-builder.test.js` — NEW. Direct unit tests of the pure function (added after refactor is proven safe).

**Phase 2 — Tracker feature (3 new files, 2 modified):**
- `lib/experiments.js` — NEW. Manifest CRUD, runner orchestration, photo management, Express routes, HTML pages. Single file keeps related concerns together, mirroring `dashboard.js`.
- `test/experiments.test.js` — NEW. Runner orchestration tests with OpenAI mocked.
- `data/experiments/` — NEW DIRECTORY (gitignored). Created at runtime.
- `index.js` — MODIFIED. Add `mountExperiments(app)` call inside the `server.listen` callback, alongside `mountDashboard` etc.
- `.gitignore` — MODIFIED. Add `data/experiments/`.

---

## Task List Overview

**Phase 1: prompt-builder extraction (gated)**
- Task 1: Create `prompt-builder.js` stub + export
- Task 2: Write characterize test harness
- Task 3: Snapshot scenarios 1-4 (solo, wardrobe-only, wardrobe-plus-scene, themed-container)
- Task 4: Snapshot scenarios 5-8 (palette-rejecting, multi-subject, subject+pet, reviewer override)
- Task 5: Port assembly logic into `prompt-builder.build()`
- Task 6: Swap `pipeline.js` to call `prompt-builder.build()`; characterize must stay green
- Task 7: Add direct unit tests for `prompt-builder`
- Task 8: Commit Phase 1

**Phase 2: experiment tracker**
- Task 9: Gitignore + directory scaffolding
- Task 10: Manifest schema + CRUD helpers (pure, in `experiments.js`)
- Task 11: Photo management (`photos.json` + scene cache)
- Task 12: Runner orchestration (sequential then concurrent, retry, restart-recovery)
- Task 13: Express routes (list, create, get, patch, delete) + static PNG serving
- Task 14: Photo routes (list, upload, delete)
- Task 15: HTML: landing page (`/eval`)
- Task 16: HTML: new-run form (`/eval/new`)
- Task 17: HTML: run detail page (`/eval/run/:id`) with polling + winners + notes
- Task 18: HTML: photo manager modal
- Task 19: Wire `mountExperiments(app)` into `index.js`
- Task 20: Commit Phase 2

---

## Phase 1 — prompt-builder extraction

### Task 1: Create prompt-builder.js stub

**Files:**
- Create: `lib/prompt-builder.js`

- [ ] **Step 1: Create the file with signature and a placeholder body**

```javascript
// lib/prompt-builder.js
// Pure prompt-assembly function extracted from pipeline.js.
// No I/O, no settings reads, no caching.
// See docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md

function build(input) {
    throw new Error("prompt-builder.build() not implemented yet");
}

module.exports = { build };
```

- [ ] **Step 2: Verify Node can load it**

Run: `node -e "require('./lib/prompt-builder')"`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add lib/prompt-builder.js
git commit -m "feat(prompt-builder): stub module"
```

---

### Task 2: Write characterize test harness

Characterize tests pin the exact current output of `pipeline.js`'s prompt assembly. They invoke the real assembly code path by importing a small helper we add to `pipeline.js`, with all I/O and settings stubbed. If any snapshot byte changes across the refactor, the refactor is wrong.

**Files:**
- Modify: `lib/pipeline.js` (add `__assemblePromptForTest` export near bottom)
- Create: `test/prompt-builder-characterize.test.js`

- [ ] **Step 1: Add a tiny export hook at the bottom of `pipeline.js`**

After the existing `module.exports` line (currently line 729), change it to also export a thin test helper. Replace:

```javascript
module.exports = { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage };
```

with:

```javascript
// Test-only hook: exercises the prompt assembly block without running any I/O.
// Accepts fully-resolved inputs and returns the final prompt string the model
// would receive. Used by characterize tests to pin current behavior.
async function __assemblePromptForTest(resolved) {
    // Implementation added in Step 2.
    throw new Error("__assemblePromptForTest not wired up yet");
}

module.exports = { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage, __assemblePromptForTest };
```

- [ ] **Step 2: Implement `__assemblePromptForTest` by copy-paste of the assembly block**

The goal is to mechanically copy the assembly code from `generateImage` (currently lines 293-529) into `__assemblePromptForTest`, substituting resolved inputs for the settings/I/O lookups. Paste this body into the stub from Step 1:

```javascript
async function __assemblePromptForTest(resolved) {
    const {
        styleKey, styleObj, stylePrompt,
        brandKey, brandObj, brandAnalysis, brandPrompt, brandRefBuffers,
        styleAnalysis, styleRefBuffers,
        bgChoice, bgMode, bgAnalysis, bgRefBuffers,
        scene, sceneLine,
        preserve, preserveBrand, brandInstruction, composition, backgroundLine,
        multiSubjectMode, reviewFeedback,
    } = resolved;

    const { STYLES } = require("./styles");
    const { buildComboFragments } = require("./prompt-assembler");
    const isBuiltIn = !!STYLES[styleKey];
    const hasBrands = brandRefBuffers.length > 0;
    const hasStyleRefs = styleRefBuffers.length > 0;
    const parts = [];

    if (hasStyleRefs && styleAnalysis) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: You MUST replicate this exact art style: ${styleAnalysis}\n\nThe input images named ${styleRefNames} are visual examples of this style. Study them and the description above. The output MUST look like it was created by the same artist using the same tools. Do NOT default to a generic style. ${stylePrompt}`);
    } else if (hasStyleRefs) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: The input images named ${styleRefNames} show the exact art style to replicate. Study them carefully and match the rendering technique, line work, color palette, shading, proportions, and mood. Do NOT default to a generic style. ${stylePrompt}`);
    } else {
        parts.push(stylePrompt);
    }

    if (!isBuiltIn) {
        if (preserve) parts.push(preserve);
        if (composition) parts.push(composition);
    }

    if (sceneLine) parts.push(sceneLine);

    if (hasBrands && brandAnalysis) {
        const brandRefNames = brandRefBuffers.map((_, i) => `brand_ref_${i}.png`).join(", ");
        const petNote = scene.pets !== "none"
            ? (scene.subjects > 1 ? ` Include the ${scene.pets} naturally without branded clothing.` : ` Include the ${scene.pets} naturally in the image.`)
            : "";
        if (scene.subjects > 1) {
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in this exact outfit: ${brandAnalysis}\n\nThe input images named ${brandRefNames} show the outfit visually.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            parts.push(`Clothing: Dress the subject in this exact outfit: ${brandAnalysis}\n\nThe input images named ${brandRefNames} show the outfit visually.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else if (hasBrands) {
        const refWord = brandRefBuffers.length > 1 ? "s" : "";
        if (scene.subjects > 1) {
            const petNote = scene.pets !== "none" ? ` Include the ${scene.pets} naturally without branded clothing.` : "";
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            const petNote = scene.pets !== "none" ? ` Include the ${scene.pets} naturally in the image.` : "";
            parts.push(`Clothing: Dress the subject in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else {
        if (brandPrompt) parts.push(`Apply the following to ALL subjects in the image: ${brandPrompt}`);
    }

    if (hasBrands) {
        parts.push("REMINDER: The art style described above takes ABSOLUTE priority. The brand/clothing references are ONLY for the outfit — do NOT let them influence the rendering style, line work, colors, or visual aesthetic.");
    }

    const comboFragments = buildComboFragments({ style: styleObj, brand: brandObj, background: null });
    if (comboFragments.containerDescription) parts.push(comboFragments.containerDescription);

    let fullPrompt = parts.join("\n");

    if (bgMode === "ai" && bgRefBuffers.length > 0 && bgAnalysis) {
        const bgRefNames = bgRefBuffers.map((_, i) => `bg_ref_${i}.png`).join(", ");
        const extraPrompt = bgChoice && bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Recreate this exact background: ${bgAnalysis}\n\nThe input images named ${bgRefNames} show the background visually.${extraPrompt}`;
    } else if (bgMode === "ai" && bgRefBuffers.length > 0) {
        const bgRefWord = bgRefBuffers.length > 1 ? "images" : "image";
        const extraPrompt = bgChoice && bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Match the background shown in the reference ${bgRefWord}.${extraPrompt}`;
    } else if (bgMode === "exact" && bgRefBuffers.length > 0) {
        fullPrompt += "\nBackground: Generate the subject on a plain solid-color background with no environment details. The background will be replaced in post-processing.";
    } else if (bgChoice && bgChoice.prompt) {
        fullPrompt += "\n" + bgChoice.prompt;
    } else {
        const styleHasBgInstruction = stylePrompt && /background\s*[:—–-]/im.test(stylePrompt);
        if (backgroundLine && !styleHasBgInstruction) fullPrompt += "\n" + backgroundLine;
    }

    if (comboFragments.colorPalette) fullPrompt += "\n" + comboFragments.colorPalette;

    if (scene.subjects > 1 && multiSubjectMode === "caricature") {
        fullPrompt += "\n\nIMPORTANT: This has multiple people. Transform each person into a WILDLY EXAGGERATED CARICATURE — giant heads on tiny bodies, comically oversized eyes, enormous grins, bobblehead proportions. Push the abstraction as far as possible while keeping each person vaguely identifiable by their most obvious trait (hair color, glasses, beard, etc.). This should look like a theme-park caricature artist on overdrive — NOT a realistic portrait. Prioritize humor, energy, and bold graphic style over any attempt at photographic likeness. Do NOT try to make the faces look realistic.";
    }

    const hasReviewFeedback = !!reviewFeedback;
    if (hasReviewFeedback) {
        fullPrompt += "\n\nIMPORTANT — Override from reviewer (this takes priority over any earlier subject-count instructions): " + reviewFeedback;
    }

    if (!hasReviewFeedback && hasBrands) {
        const styleLock = styleObj.brandCore || styleObj.core || `${styleObj.name || "the selected"} art style`;
        fullPrompt += `\n\nFINAL STYLE LOCK: Render the entire output in this exact art style: ${styleLock} The clothing and background descriptions above describe subject matter, not rendering technique — they must not override the chosen art style.`;
    }

    if (!hasReviewFeedback) {
        if (scene.subjects === 1 && scene.pets === "none") {
            fullPrompt += "\n\nFINAL REMINDER: Exactly 1 human in the output. No other people. Anything else visible (objects, posters, screens, reflections, background figures) must NOT become a person.";
        } else if (scene.subjects === 1 && scene.pets !== "none") {
            fullPrompt += `\n\nFINAL REMINDER: Exactly 1 human and 1 ${scene.pets} in the output. The ${scene.pets} is an animal — do NOT turn it into a person. No other people.`;
        } else if (scene.subjects > 1) {
            fullPrompt += `\n\nFINAL REMINDER: Exactly ${scene.subjects} humans in the output — no more, no fewer.`;
        }
    }

    return fullPrompt;
}
```

- [ ] **Step 3: Commit the test hook (no behavior change yet)**

```bash
git add lib/pipeline.js
git commit -m "test(pipeline): add __assemblePromptForTest hook for characterize suite"
```

---

### Task 3: Characterize scenarios 1-4 (baselines without brand + with wardrobe-only/plus-scene + themed-container)

**Files:**
- Create: `test/prompt-builder-characterize.test.js`

- [ ] **Step 1: Write the test file with four scenarios using `t.assert.snapshot`**

Node's built-in test runner ships snapshot support since Node 22. We pass `--test-update-snapshots` the first time to record the baseline, then leave them checked in as the regression gate. File contents:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __assemblePromptForTest } = require("../lib/pipeline");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

// ─── Test fixtures (stable, no randomness) ──────────────────────────────────
const cartoonStyleObj = {
    name: "cartoon",
    behavior: "normal",
    acceptsColorPalette: true,
    containerDescription: null,
    core: STYLES.cartoon.core,
    brandCore: STYLES.cartoon.brandCore,
    prompt: STYLES.cartoon.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
};

const sketchStyleObj = {
    name: "sketch",
    behavior: "normal",
    acceptsColorPalette: false,
    containerDescription: null,
    core: STYLES.sketch.core,
    brandCore: STYLES.sketch.brandCore,
    prompt: STYLES.sketch.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
};

const actionFigureStyleObj = {
    name: "action figure",
    behavior: "themed-container",
    acceptsColorPalette: true,
    containerDescription: "Subject rendered as a collectible action figure sealed in a themed toy box with clear blister packaging.",
    core: "Collectible action figure toy sealed in branded packaging.",
    brandCore: "Action figure toy packaging.",
    prompt: "Transform this photo into a detailed action figure portrait inside a themed toy package.",
};

const wardrobeOnlyBrand = {
    category: "wardrobe-only",
    wardrobe: "Twilio-branded apparel",
    allowOriginal: true,
};

const wardrobePlusSceneBrand = {
    category: "wardrobe-plus-scene",
    wardrobe: "Signal conference apparel with branded lanyard",
    colorPalette: "Recolor everything to Twilio red and white.",
    allowOriginal: false,
};

const soloScene = { subjects: 1, pets: "none", positions: "centered" };
const soloSceneLine = "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.";

const baseEvent = {
    preserve: DEFAULT_PRESERVE,
    preserveBrand: "Preserve accurately: skin tone, eye color, hair color and style, facial hair, glasses, facial structure.",
    brandInstruction: "Logos and text: Copy the exact logos, crests, numbers, and text from the reference images. Do NOT invent, add, or modify any text or symbols.",
    composition: DEFAULT_COMPOSITION,
    backgroundLine: "Background: Recreate the background from the original photo in the same art style. Keep it natural and consistent with the scene.",
    multiSubjectMode: "reject",
};

function baseInput(overrides) {
    return {
        styleKey: "cartoon",
        styleObj: cartoonStyleObj,
        stylePrompt: cartoonStyleObj.prompt,
        brandKey: null,
        brandObj: null,
        brandAnalysis: "",
        brandPrompt: "",
        brandRefBuffers: [],
        styleAnalysis: "",
        styleRefBuffers: [],
        bgChoice: null,
        bgMode: "ai",
        bgAnalysis: "",
        bgRefBuffers: [],
        scene: soloScene,
        sceneLine: soloSceneLine,
        ...baseEvent,
        reviewFeedback: null,
        ...overrides,
    };
}

// ─── Scenarios 1-4 ──────────────────────────────────────────────────────────

test("characterize: solo cartoon, no brand, default background", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput());
    t.assert.snapshot(prompt);
});

test("characterize: solo cartoon + wardrobe-only brand", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        brandKey: "laKings",
        brandObj: wardrobeOnlyBrand,
        brandPrompt: "Wear an LA Kings hockey jersey.",
        brandAnalysis: "A black hockey jersey with silver LA Kings crest on the chest.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
    }));
    t.assert.snapshot(prompt);
});

test("characterize: solo cartoon + wardrobe-plus-scene brand (palette applies)", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        brandKey: "twilio",
        brandObj: wardrobePlusSceneBrand,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "A red Signal conference jacket with white lanyard.",
        brandRefBuffers: [Buffer.from("fake-ref-1"), Buffer.from("fake-ref-2")],
    }));
    t.assert.snapshot(prompt);
});

test("characterize: themed-container style (action figure) with brand", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        styleKey: "action-figure",
        styleObj: actionFigureStyleObj,
        stylePrompt: actionFigureStyleObj.prompt,
        brandKey: "twilio",
        brandObj: wardrobePlusSceneBrand,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "A red Signal conference jacket with white lanyard.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
    }));
    t.assert.snapshot(prompt);
});
```

- [ ] **Step 2: Generate the baseline snapshot file**

Run: `node --test --test-update-snapshots test/prompt-builder-characterize.test.js`
Expected: 4 tests pass, creates `test/prompt-builder-characterize.test.js.snapshot` (checked in).

- [ ] **Step 3: Re-run without updating to confirm stability**

Run: `node --test test/prompt-builder-characterize.test.js`
Expected: 4 tests pass.

- [ ] **Step 4: Commit the baseline**

```bash
git add test/prompt-builder-characterize.test.js test/prompt-builder-characterize.test.js.snapshot
git commit -m "test(prompt-builder): characterize scenarios 1-4"
```

---

### Task 4: Characterize scenarios 5-8 (palette-rejecting, multi-subject, subject+pet, reviewer override)

**Files:**
- Modify: `test/prompt-builder-characterize.test.js`

- [ ] **Step 1: Append the remaining four scenarios to the test file**

Append the following tests after the Task 3 scenarios (end of file):

```javascript
// ─── Scenarios 5-8 ──────────────────────────────────────────────────────────

test("characterize: sketch (rejects color palette) + palette-bearing brand", async (t) => {
    // Twilio brand has a colorPalette, but sketch has acceptsColorPalette:false,
    // so the palette must be suppressed. This pins that behavior.
    const prompt = await __assemblePromptForTest(baseInput({
        styleKey: "sketch",
        styleObj: sketchStyleObj,
        stylePrompt: sketchStyleObj.prompt,
        brandKey: "twilio",
        brandObj: wardrobePlusSceneBrand,
        brandPrompt: "Wear Signal conference apparel.",
        brandAnalysis: "A red Signal conference jacket with white lanyard.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
    }));
    t.assert.snapshot(prompt);
});

test("characterize: multi-subject (2 people) cartoon, no brand, caricature mode", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        scene: { subjects: 2, pets: "none", positions: "side-by-side" },
        sceneLine: "This photo has exactly 2 HUMAN subjects. Include ALL of them positioned as shown. The output must contain exactly 2 people — no more, no fewer.",
        multiSubjectMode: "caricature",
    }));
    t.assert.snapshot(prompt);
});

test("characterize: solo cartoon + pet (dog), no brand", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        scene: { subjects: 1, pets: "dog", positions: "centered" },
        sceneLine: "This photo has exactly 1 person and a dog. The dog is an animal, NOT a person — do not turn the dog into a human. The output must contain exactly 1 person and the dog — no other people.",
    }));
    t.assert.snapshot(prompt);
});

test("characterize: reviewer feedback override (skips final lock + reminder)", async (t) => {
    const prompt = await __assemblePromptForTest(baseInput({
        brandKey: "laKings",
        brandObj: wardrobeOnlyBrand,
        brandPrompt: "Wear an LA Kings hockey jersey.",
        brandAnalysis: "A black hockey jersey with silver LA Kings crest on the chest.",
        brandRefBuffers: [Buffer.from("fake-ref-1")],
        reviewFeedback: "The subject is wearing a blue shirt in the original, not an LA Kings jersey. Please do not alter their original clothing.",
    }));
    t.assert.snapshot(prompt);
});
```

- [ ] **Step 2: Generate baseline snapshots for the new scenarios**

Run: `node --test --test-update-snapshots test/prompt-builder-characterize.test.js`
Expected: 8 tests pass, snapshot file updated with 4 additional entries.

- [ ] **Step 3: Re-run without update flag**

Run: `node --test test/prompt-builder-characterize.test.js`
Expected: 8 tests pass.

- [ ] **Step 4: Run the full suite to confirm nothing else regressed**

Run: `npm test`
Expected: All existing tests pass plus the 8 characterize tests.

- [ ] **Step 5: Commit**

```bash
git add test/prompt-builder-characterize.test.js test/prompt-builder-characterize.test.js.snapshot
git commit -m "test(prompt-builder): characterize scenarios 5-8"
```

---

### Task 5: Port the assembly logic into `prompt-builder.build()`

The implementation of `prompt-builder.build()` is a literal move of `__assemblePromptForTest`'s body — same inputs, same output. We keep both functions temporarily so snapshots can compare pre/post.

**Files:**
- Modify: `lib/prompt-builder.js`

- [ ] **Step 1: Replace the `build` stub with the real implementation**

Replace the current body of `lib/prompt-builder.js` with:

```javascript
// lib/prompt-builder.js
// Pure prompt-assembly function extracted from pipeline.js.
// No I/O, no settings reads, no caching.
// See docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md

const { STYLES } = require("./styles");
const { buildComboFragments } = require("./prompt-assembler");

function build(input) {
    const {
        styleKey, styleObj, stylePrompt,
        brandObj, brandAnalysis, brandPrompt, brandRefBuffers = [],
        styleAnalysis, styleRefBuffers = [],
        bgChoice, bgMode = "ai", bgAnalysis, bgRefBuffers = [],
        scene, sceneLine,
        preserve, preserveBrand, brandInstruction, composition, backgroundLine,
        multiSubjectMode, reviewFeedback,
    } = input;

    const isBuiltIn = !!STYLES[styleKey];
    const hasBrands = brandRefBuffers.length > 0;
    const hasStyleRefs = styleRefBuffers.length > 0;
    const parts = [];

    if (hasStyleRefs && styleAnalysis) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: You MUST replicate this exact art style: ${styleAnalysis}\n\nThe input images named ${styleRefNames} are visual examples of this style. Study them and the description above. The output MUST look like it was created by the same artist using the same tools. Do NOT default to a generic style. ${stylePrompt}`);
    } else if (hasStyleRefs) {
        const styleRefNames = styleRefBuffers.map((_, i) => `style_ref_${i}.png`).join(", ");
        parts.push(`CRITICAL — Art style: The input images named ${styleRefNames} show the exact art style to replicate. Study them carefully and match the rendering technique, line work, color palette, shading, proportions, and mood. Do NOT default to a generic style. ${stylePrompt}`);
    } else {
        parts.push(stylePrompt);
    }

    if (!isBuiltIn) {
        if (preserve) parts.push(preserve);
        if (composition) parts.push(composition);
    }

    if (sceneLine) parts.push(sceneLine);

    if (hasBrands && brandAnalysis) {
        const brandRefNames = brandRefBuffers.map((_, i) => `brand_ref_${i}.png`).join(", ");
        const petNote = scene.pets !== "none"
            ? (scene.subjects > 1 ? ` Include the ${scene.pets} naturally without branded clothing.` : ` Include the ${scene.pets} naturally in the image.`)
            : "";
        if (scene.subjects > 1) {
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in this exact outfit: ${brandAnalysis}\n\nThe input images named ${brandRefNames} show the outfit visually.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            parts.push(`Clothing: Dress the subject in this exact outfit: ${brandAnalysis}\n\nThe input images named ${brandRefNames} show the outfit visually.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else if (hasBrands) {
        const refWord = brandRefBuffers.length > 1 ? "s" : "";
        if (scene.subjects > 1) {
            const petNote = scene.pets !== "none" ? ` Include the ${scene.pets} naturally without branded clothing.` : "";
            parts.push(`Clothing: There are ${scene.subjects} people — dress EVERY person in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(`Preserve accurately for every subject: ${preserveBrand.replace(/^Preserve accurately:\s*/i, "")}`);
        } else {
            const petNote = scene.pets !== "none" ? ` Include the ${scene.pets} naturally in the image.` : "";
            parts.push(`Clothing: Dress the subject in the outfit/gear from the brand reference photo${refWord}.${petNote}`);
            parts.push(preserveBrand);
        }
        if (brandInstruction) parts.push(brandInstruction);
        if (brandPrompt) parts.push(brandPrompt);
    } else {
        if (brandPrompt) parts.push(`Apply the following to ALL subjects in the image: ${brandPrompt}`);
    }

    if (hasBrands) {
        parts.push("REMINDER: The art style described above takes ABSOLUTE priority. The brand/clothing references are ONLY for the outfit — do NOT let them influence the rendering style, line work, colors, or visual aesthetic.");
    }

    const comboFragments = buildComboFragments({ style: styleObj, brand: brandObj, background: null });
    if (comboFragments.containerDescription) parts.push(comboFragments.containerDescription);

    let fullPrompt = parts.join("\n");

    if (bgMode === "ai" && bgRefBuffers.length > 0 && bgAnalysis) {
        const bgRefNames = bgRefBuffers.map((_, i) => `bg_ref_${i}.png`).join(", ");
        const extraPrompt = bgChoice && bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Recreate this exact background: ${bgAnalysis}\n\nThe input images named ${bgRefNames} show the background visually.${extraPrompt}`;
    } else if (bgMode === "ai" && bgRefBuffers.length > 0) {
        const bgRefWord = bgRefBuffers.length > 1 ? "images" : "image";
        const extraPrompt = bgChoice && bgChoice.prompt ? ` ${bgChoice.prompt}` : "";
        fullPrompt += `\nBackground: Match the background shown in the reference ${bgRefWord}.${extraPrompt}`;
    } else if (bgMode === "exact" && bgRefBuffers.length > 0) {
        fullPrompt += "\nBackground: Generate the subject on a plain solid-color background with no environment details. The background will be replaced in post-processing.";
    } else if (bgChoice && bgChoice.prompt) {
        fullPrompt += "\n" + bgChoice.prompt;
    } else {
        const styleHasBgInstruction = stylePrompt && /background\s*[:—–-]/im.test(stylePrompt);
        if (backgroundLine && !styleHasBgInstruction) fullPrompt += "\n" + backgroundLine;
    }

    if (comboFragments.colorPalette) fullPrompt += "\n" + comboFragments.colorPalette;

    if (scene.subjects > 1 && multiSubjectMode === "caricature") {
        fullPrompt += "\n\nIMPORTANT: This has multiple people. Transform each person into a WILDLY EXAGGERATED CARICATURE — giant heads on tiny bodies, comically oversized eyes, enormous grins, bobblehead proportions. Push the abstraction as far as possible while keeping each person vaguely identifiable by their most obvious trait (hair color, glasses, beard, etc.). This should look like a theme-park caricature artist on overdrive — NOT a realistic portrait. Prioritize humor, energy, and bold graphic style over any attempt at photographic likeness. Do NOT try to make the faces look realistic.";
    }

    const hasReviewFeedback = !!reviewFeedback;
    if (hasReviewFeedback) {
        fullPrompt += "\n\nIMPORTANT — Override from reviewer (this takes priority over any earlier subject-count instructions): " + reviewFeedback;
    }

    if (!hasReviewFeedback && hasBrands) {
        const styleLock = styleObj.brandCore || styleObj.core || `${styleObj.name || "the selected"} art style`;
        fullPrompt += `\n\nFINAL STYLE LOCK: Render the entire output in this exact art style: ${styleLock} The clothing and background descriptions above describe subject matter, not rendering technique — they must not override the chosen art style.`;
    }

    if (!hasReviewFeedback) {
        if (scene.subjects === 1 && scene.pets === "none") {
            fullPrompt += "\n\nFINAL REMINDER: Exactly 1 human in the output. No other people. Anything else visible (objects, posters, screens, reflections, background figures) must NOT become a person.";
        } else if (scene.subjects === 1 && scene.pets !== "none") {
            fullPrompt += `\n\nFINAL REMINDER: Exactly 1 human and 1 ${scene.pets} in the output. The ${scene.pets} is an animal — do NOT turn it into a person. No other people.`;
        } else if (scene.subjects > 1) {
            fullPrompt += `\n\nFINAL REMINDER: Exactly ${scene.subjects} humans in the output — no more, no fewer.`;
        }
    }

    return fullPrompt;
}

module.exports = { build };
```

- [ ] **Step 2: Add a parity test that the extracted function matches the in-pipeline helper**

Create `test/prompt-builder-parity.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __assemblePromptForTest } = require("../lib/pipeline");
const promptBuilder = require("../lib/prompt-builder");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

test("parity: prompt-builder.build matches __assemblePromptForTest on cartoon solo", async () => {
    const cartoon = {
        name: "cartoon", behavior: "normal", acceptsColorPalette: true,
        containerDescription: null,
        core: STYLES.cartoon.core, brandCore: STYLES.cartoon.brandCore,
        prompt: STYLES.cartoon.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
    };
    const input = {
        styleKey: "cartoon", styleObj: cartoon, stylePrompt: cartoon.prompt,
        brandObj: null, brandAnalysis: "", brandPrompt: "", brandRefBuffers: [],
        styleAnalysis: "", styleRefBuffers: [],
        bgChoice: null, bgMode: "ai", bgAnalysis: "", bgRefBuffers: [],
        scene: { subjects: 1, pets: "none", positions: "centered" },
        sceneLine: "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.",
        preserve: DEFAULT_PRESERVE, preserveBrand: "Preserve accurately: skin tone.",
        brandInstruction: "Logos.", composition: DEFAULT_COMPOSITION,
        backgroundLine: "Background: Recreate the background from the original photo in the same art style.",
        multiSubjectMode: "reject", reviewFeedback: null,
    };
    const fromPipeline = await __assemblePromptForTest(input);
    const fromBuilder = promptBuilder.build(input);
    assert.equal(fromBuilder, fromPipeline);
});
```

- [ ] **Step 3: Run parity test**

Run: `node --test test/prompt-builder-parity.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/prompt-builder.js test/prompt-builder-parity.test.js
git commit -m "feat(prompt-builder): implement build() as pure function"
```

---

### Task 6: Swap `pipeline.js` to call `promptBuilder.build()`

This is the refactor itself. We replace the inline assembly block (currently lines 293-529 in `generateImage`) with a call to `promptBuilder.build(...)` using the already-resolved values. The characterize tests from Tasks 3-4 are the gate: they MUST stay byte-identical.

**Files:**
- Modify: `lib/pipeline.js`

- [ ] **Step 1: Add the require at the top of `pipeline.js`**

At `lib/pipeline.js:12` (after the `trackApiCall` require), add:

```javascript
const promptBuilder = require("./prompt-builder");
```

- [ ] **Step 2: Delete the inline assembly in `generateImage`**

In `lib/pipeline.js`, delete the block from the comment `// Build generation prompt — unified builder handles all combinations of style refs + brand refs` (currently line 293) through the end of the final REMINDER block (currently line 529, ends with the closing `}` of the `if (!hasReviewFeedback)` block that appends FINAL REMINDER).

Do NOT delete lines 531-534 (`job.generationPrompt = fullPrompt;` and the console.log). Those stay because the prompt string is still needed.

- [ ] **Step 3: Insert the `promptBuilder.build()` call in place of the deleted block**

At the same location, insert:

```javascript
    // Resolve the background choice for this job (matches previous in-place logic)
    const bgChoices = settings.getForEvent("backgroundChoices", ev) || [];
    let bgChoice = job.background && bgChoices.find(c => c.key === job.background);
    if (job.background && !bgChoice) {
        const { resolveBackgroundMenu } = require("./prompt-assembler");
        const customBrandsForBg = settings.getForEvent("customBrands", ev) || {};
        const brandForBg = job.brand ? customBrandsForBg[job.brand] : null;
        const resolved = resolveBackgroundMenu(styleObj, brandForBg);
        bgChoice = resolved.find(c => c.key === job.background) || null;
    }
    const bgRefFiles = bgChoice ? (bgChoice.files || []) : [];
    const bgMode = bgChoice ? (bgChoice.mode || "ai") : "ai";
    const bgRefBuffers = [];
    for (const filename of bgRefFiles) {
        const filePath = path.join(settings.BG_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) bgRefBuffers.push(await fsp.readFile(filePath));
    }
    if (bgRefBuffers.length > 0) {
        console.log(`🖼️ Including ${bgRefBuffers.length} background reference image(s) (mode: ${bgMode})`);
    }

    // Cached vision analysis of the chosen background reference images
    let bgAnalysis = "";
    if (bgRefBuffers.length > 0 && bgMode === "ai" && bgChoice) {
        bgAnalysis = bgChoice.analysis || "";
        if (bgAnalysis.length > 500) { bgAnalysis = ""; }
        if (!bgAnalysis) {
            console.log("🔍 Analyzing background reference images...");
            try {
                bgAnalysis = await analyzeReferences(bgRefBuffers, "background", `bg:${ev}:${bgChoice.key}`);
            } catch (err) {
                console.error(`🔍 Background analysis failed (proceeding without): ${err.message}`);
            }
            if (bgAnalysis && ev === settings.get("eventName")) {
                try {
                    const allBgChoices = settings.get("backgroundChoices") || [];
                    const idx = allBgChoices.findIndex(c => c.key === bgChoice.key);
                    if (idx !== -1) {
                        allBgChoices[idx].analysis = bgAnalysis;
                        settings.update({ backgroundChoices: allBgChoices });
                    }
                    console.log(`🔍 Background analysis cached (${bgAnalysis.length} chars)`);
                } catch (cacheErr) {
                    console.error(`🔍 Background analysis caching failed (using analysis anyway): ${cacheErr.message}`);
                }
            } else if (bgAnalysis) {
                console.log(`🔍 Background analysis complete but not cached (job event "${ev}" ≠ current event)`);
            }
        }
    }

    // Delegate prompt assembly to the pure builder
    const customBrandsForCombo = job.brand ? (settings.getForEvent("customBrands", ev) || {}) : {};
    const brandForCombo = job.brand ? customBrandsForCombo[job.brand] : null;
    const fullPrompt = promptBuilder.build({
        styleKey, styleObj, stylePrompt,
        brandKey: job.brand || null,
        brandObj: brandForCombo,
        brandAnalysis, brandPrompt, brandRefBuffers,
        styleAnalysis, styleRefBuffers,
        bgChoice, bgMode, bgAnalysis, bgRefBuffers,
        scene, sceneLine,
        preserve,
        preserveBrand,
        brandInstruction,
        composition,
        backgroundLine: settings.getForEvent("promptBackground", ev),
        multiSubjectMode: settings.getForEvent("multiSubjectMode", ev) || "reject",
        reviewFeedback: job.reviewFeedback || null,
    });

    // Reject-mode early exit preserves original side effects (SMS, unlink, throw)
    if (scene.subjects > 1) {
        const multiMode = settings.getForEvent("multiSubjectMode", ev) || "reject";
        if (multiMode === "reject") {
            console.log("🚫 Multi-subject rejected (mode: reject)");
            job.detectedSubjects = scene.subjects;
            await sendSms(userPhone, appPhone, settings.getMsg("multiSubjectReject"));
            await fsp.unlink(inputPath);
            const err = new Error("Multi-subject photo rejected by event config.");
            err.permanent = true;
            err.failReason = "multi_subject";
            throw err;
        }
    }

    // Consume the review-feedback one-shot (matches original behavior)
    if (job.reviewFeedback) delete job.reviewFeedback;
```

Note: the background-loading block is preserved because the runtime also needs `bgRefBuffers` to attach reference images to the `images.edit` call further down the function. We reorder so resolution happens before the prompt build, not in a separate step.

- [ ] **Step 4: Update `__assemblePromptForTest` to delegate too**

Replace the body of `__assemblePromptForTest` (the helper added in Task 2) with a single line so it proves the extraction is complete:

```javascript
async function __assemblePromptForTest(resolved) {
    return require("./prompt-builder").build(resolved);
}
```

- [ ] **Step 5: Run the characterize tests — this is the gate**

Run: `node --test test/prompt-builder-characterize.test.js`
Expected: All 8 scenarios PASS with byte-identical output. If any scenario fails, STOP — the refactor is wrong. Compare output diffs and reconcile before proceeding.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: Every existing test (including `pipeline-combo-integration.test.js`, `pipeline-wardrobe.test.js`) passes.

- [ ] **Step 7: Manual smoke read**

Open `lib/pipeline.js` and scan the diff. The `generateImage` function should be noticeably shorter, with the massive `parts` block and trailing reminders gone. All surviving logic should be: resolution of inputs (settings reads, reference loading, vision analysis) + `promptBuilder.build(...)` + `openai.images.edit(...)` + compositing + MMS.

- [ ] **Step 8: Commit**

```bash
git add lib/pipeline.js
git commit -m "refactor(pipeline): delegate prompt assembly to prompt-builder"
```

---

### Task 7: Direct unit tests on `prompt-builder`

Now that the refactor is proven safe, add a few unit tests that target `prompt-builder.build` directly — these are easier to reason about than the big characterize snapshots, and they're what future contributors will actually read.

**Files:**
- Create: `test/prompt-builder.test.js`

- [ ] **Step 1: Write focused unit tests**

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("../lib/prompt-builder");
const { STYLES, DEFAULT_PRESERVE, DEFAULT_COMPOSITION } = require("../lib/styles");

function makeStyle(key) {
    const s = STYLES[key];
    return {
        name: s.name, behavior: "normal", acceptsColorPalette: s.acceptsColorPalette !== false,
        containerDescription: null, core: s.core, brandCore: s.brandCore,
        prompt: s.buildPrompt(DEFAULT_PRESERVE, DEFAULT_COMPOSITION),
    };
}
function makeInput(over) {
    const cartoon = makeStyle("cartoon");
    return {
        styleKey: "cartoon", styleObj: cartoon, stylePrompt: cartoon.prompt,
        brandObj: null, brandAnalysis: "", brandPrompt: "", brandRefBuffers: [],
        styleAnalysis: "", styleRefBuffers: [],
        bgChoice: null, bgMode: "ai", bgAnalysis: "", bgRefBuffers: [],
        scene: { subjects: 1, pets: "none", positions: "centered" },
        sceneLine: "scene_line",
        preserve: "PRESERVE", preserveBrand: "PRESERVE_BRAND",
        brandInstruction: "BRAND_INSTR", composition: "COMP",
        backgroundLine: "DEFAULT_BG", multiSubjectMode: "reject",
        reviewFeedback: null,
        ...over,
    };
}

test("solo, no brand: default background line is appended", () => {
    const out = build(makeInput());
    assert.match(out, /DEFAULT_BG/);
});

test("reviewer feedback overrides and suppresses FINAL STYLE LOCK + REMINDER", () => {
    const out = build(makeInput({
        brandRefBuffers: [Buffer.from("x")],
        reviewFeedback: "Keep original clothing.",
    }));
    assert.match(out, /Override from reviewer/);
    assert.doesNotMatch(out, /FINAL STYLE LOCK/);
    assert.doesNotMatch(out, /FINAL REMINDER/);
});

test("palette-rejecting style suppresses brand colorPalette", () => {
    const sketch = makeStyle("sketch"); // sketch.acceptsColorPalette === false
    const out = build(makeInput({
        styleKey: "sketch", styleObj: sketch, stylePrompt: sketch.prompt,
        brandObj: { category: "wardrobe-plus-scene", colorPalette: "ALL RED" },
        brandPrompt: "brand_prompt",
        brandRefBuffers: [Buffer.from("x")],
        brandAnalysis: "red jersey",
    }));
    assert.doesNotMatch(out, /ALL RED/);
});

test("multi-subject with caricature mode appends the caricature block", () => {
    const out = build(makeInput({
        scene: { subjects: 2, pets: "none", positions: "side-by-side" },
        sceneLine: "two people",
        multiSubjectMode: "caricature",
    }));
    assert.match(out, /WILDLY EXAGGERATED CARICATURE/);
    assert.match(out, /FINAL REMINDER: Exactly 2 humans/);
});

test("subject + pet: final reminder mentions the pet as an animal", () => {
    const out = build(makeInput({
        scene: { subjects: 1, pets: "dog", positions: "centered" },
        sceneLine: "one person and a dog",
    }));
    assert.match(out, /Exactly 1 human and 1 dog/);
    assert.match(out, /dog is an animal — do NOT turn it into a person/);
});

test("style prompt containing 'Background:' suppresses default background line", () => {
    const fakeStyle = {
        name: "fake", behavior: "normal", acceptsColorPalette: true,
        containerDescription: null, core: "FAKE_CORE", brandCore: "FAKE_BC",
        prompt: "Do something. Background: dark studio.",
    };
    const out = build(makeInput({
        styleKey: "fake", styleObj: fakeStyle, stylePrompt: fakeStyle.prompt,
    }));
    assert.doesNotMatch(out, /DEFAULT_BG/);
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/prompt-builder.test.js`
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/prompt-builder.test.js
git commit -m "test(prompt-builder): unit tests for pure function"
```

---

### Task 8: Phase 1 wrap-up

- [ ] **Step 1: Run the full test suite one last time**

Run: `npm test`
Expected: All tests pass including characterize, parity, unit, and every pre-existing suite.

- [ ] **Step 2: Verify the refactor is self-contained on the branch**

Run: `git log --oneline -10`
Expected: A clean series of commits (stub → hook → characterize 1-4 → characterize 5-8 → implement build → refactor pipeline → unit tests).

Phase 1 is complete. At this point the spec's "Ship in two commits" clause is met for the refactor portion — this is a safe place to stop and deploy for a day if desired before starting Phase 2. The plan continues directly, but the two halves are independently revertible.

---

## Phase 2 — Experiment tracker

### Task 9: Gitignore + directory scaffolding

**Files:**
- Modify: `.gitignore`
- Create: `data/experiments/.gitkeep` (empty — but the directory itself is gitignored so this is actually unnecessary; see step 2)

- [ ] **Step 1: Add the ignore rule**

Add this line to `.gitignore` (alphabetical position after `data/events/`):

```
data/experiments/
```

- [ ] **Step 2: Verify the gitignore**

Run: `mkdir -p data/experiments && touch data/experiments/test-file && git status --porcelain data/experiments/`
Expected: No output (fully ignored). Clean up: `rm data/experiments/test-file`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore data/experiments/"
```

---

### Task 10: `lib/experiments.js` skeleton + manifest CRUD

The experiments module will grow across Tasks 10-19. Start with pure helpers (schema + CRUD), no Express yet. This keeps each task independently testable.

**Files:**
- Create: `lib/experiments.js`
- Create: `test/experiments.test.js`

- [ ] **Step 1: Scaffold the module with constants and pure helpers**

```javascript
// lib/experiments.js
// Prompt experiment tracker — standalone runner, storage, and Express mount.
// See docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md
//
// This module is intentionally self-contained: all experiment state lives under
// data/experiments/ and nothing in the production pipeline reads from it. A
// failure here must never affect live SMS generation.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const EXPERIMENTS_DIR = path.join(__dirname, "..", "data", "experiments");
const TEST_PHOTOS_DIR = path.join(EXPERIMENTS_DIR, "test-photos");
const PHOTOS_JSON = path.join(EXPERIMENTS_DIR, "photos.json");

const MAX_CONCURRENT = 3;
const MAX_RETRIES = 1;
const MAX_ENTRIES_PER_EXPERIMENT = 500;
const MAX_VARIANTS_PER_EXPERIMENT = 10;
const COST_PER_IMAGE_USD = 0.19;

async function ensureDirs() {
    await fsp.mkdir(EXPERIMENTS_DIR, { recursive: true });
    await fsp.mkdir(TEST_PHOTOS_DIR, { recursive: true });
}

function experimentDir(id) {
    return path.join(EXPERIMENTS_DIR, id);
}

function manifestPath(id) {
    return path.join(experimentDir(id), "manifest.json");
}

async function loadManifest(id) {
    const raw = await fsp.readFile(manifestPath(id), "utf8");
    return JSON.parse(raw);
}

async function saveManifest(manifest) {
    manifest.updatedAt = new Date().toISOString();
    const filePath = manifestPath(manifest.id);
    const tmp = filePath + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
    await fsp.rename(tmp, filePath);
}

async function listManifests() {
    try {
        const entries = await fsp.readdir(EXPERIMENTS_DIR, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory() && e.name !== "test-photos");
        const manifests = [];
        for (const d of dirs) {
            try { manifests.push(await loadManifest(d.name)); }
            catch (err) { console.warn(`⚠️  Skipping malformed experiment ${d.name}: ${err.message}`); }
        }
        manifests.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        return manifests;
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
}

function buildEntries(config) {
    // Expand config into one entry per (photo × style × brand × background × variant × rep)
    const entries = [];
    for (const photo of config.photos) {
        for (const style of config.styles) {
            for (const brand of config.brands) {
                for (const background of config.backgrounds) {
                    for (const variant of config.variants) {
                        for (let rep = 1; rep <= config.reps; rep++) {
                            const brandSeg = brand || "none";
                            const bgSeg = background || "none";
                            entries.push({
                                photo, style, brand, background,
                                variant: variant.name, rep,
                                status: "pending",
                                outputPath: `${path.parse(photo).name}_${style}_${brandSeg}_${bgSeg}_${variant.name}_${rep}.png`,
                                promptText: null,
                                generationMs: null,
                                error: null,
                                startedAt: null,
                                completedAt: null,
                            });
                        }
                    }
                }
            }
        }
    }
    return entries;
}

function makeId(name, now = new Date()) {
    // Slug-safe timestamp + slug-safe name. Keeps directories filesystem-sortable.
    const ts = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const slug = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "experiment";
    return `${ts}_${slug}`;
}

module.exports = {
    // constants
    EXPERIMENTS_DIR, TEST_PHOTOS_DIR, PHOTOS_JSON,
    MAX_CONCURRENT, MAX_RETRIES, MAX_ENTRIES_PER_EXPERIMENT, MAX_VARIANTS_PER_EXPERIMENT, COST_PER_IMAGE_USD,
    // helpers
    ensureDirs, experimentDir, manifestPath,
    loadManifest, saveManifest, listManifests,
    buildEntries, makeId,
};
```

- [ ] **Step 2: Write tests for pure helpers**

Create `test/experiments.test.js`:

```javascript
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

// Redirect EXPERIMENTS_DIR to a temp dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "exp-test-"));
process.env.EXPERIMENTS_DIR_OVERRIDE = TMP; // (module will read this — see note below)

// NOTE: the module currently resolves EXPERIMENTS_DIR from __dirname, not env.
// For now, we test buildEntries() and makeId() which are path-independent.

const { buildEntries, makeId, MAX_ENTRIES_PER_EXPERIMENT } = require("../lib/experiments");

after(async () => { await fsp.rm(TMP, { recursive: true, force: true }); });

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
```

- [ ] **Step 3: Run tests**

Run: `node --test test/experiments.test.js`
Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): manifest schema + CRUD helpers"
```

---

### Task 11: Photo management (upload + scene cache)

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add photo helpers to `lib/experiments.js`**

Append after the CRUD helpers (and before the `module.exports`):

```javascript
// ── Photo management ────────────────────────────────────────────────────────

async function loadPhotos() {
    try {
        const raw = await fsp.readFile(PHOTOS_JSON, "utf8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") return { photos: [] };
        throw err;
    }
}

async function savePhotos(data) {
    await fsp.writeFile(PHOTOS_JSON, JSON.stringify(data, null, 2), "utf8");
}

async function addPhoto({ filename, displayName, buffer }) {
    await ensureDirs();
    const safeName = path.basename(filename);
    await fsp.writeFile(path.join(TEST_PHOTOS_DIR, safeName), buffer);

    const photos = await loadPhotos();
    if (photos.photos.find((p) => p.filename === safeName)) {
        throw new Error(`Photo ${safeName} already exists`);
    }

    // Scene analysis happens in the route handler (needs helpers.analyzeScene);
    // addPhoto just persists the file + manifest entry with null scene fields.
    photos.photos.push({
        filename: safeName,
        displayName: displayName || safeName,
        uploadedAt: new Date().toISOString(),
        sceneDescription: null,
        parsedScene: null,
    });
    await savePhotos(photos);
    return photos.photos[photos.photos.length - 1];
}

async function updatePhotoScene(filename, sceneDescription, parsedScene) {
    const photos = await loadPhotos();
    const entry = photos.photos.find((p) => p.filename === filename);
    if (!entry) throw new Error(`Photo ${filename} not found`);
    entry.sceneDescription = sceneDescription || null;
    entry.parsedScene = parsedScene || null;
    await savePhotos(photos);
    return entry;
}

async function removePhoto(filename) {
    const photos = await loadPhotos();
    const idx = photos.photos.findIndex((p) => p.filename === filename);
    if (idx === -1) throw new Error(`Photo ${filename} not found`);
    photos.photos.splice(idx, 1);
    await savePhotos(photos);
    try { await fsp.unlink(path.join(TEST_PHOTOS_DIR, filename)); } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
}

async function isPhotoInUseByRunning(filename) {
    const manifests = await listManifests();
    return manifests.some((m) => m.status === "running" && (m.config.photos || []).includes(filename));
}
```

Update `module.exports` to add the new names:

```javascript
module.exports = {
    EXPERIMENTS_DIR, TEST_PHOTOS_DIR, PHOTOS_JSON,
    MAX_CONCURRENT, MAX_RETRIES, MAX_ENTRIES_PER_EXPERIMENT, MAX_VARIANTS_PER_EXPERIMENT, COST_PER_IMAGE_USD,
    ensureDirs, experimentDir, manifestPath,
    loadManifest, saveManifest, listManifests,
    buildEntries, makeId,
    loadPhotos, savePhotos, addPhoto, updatePhotoScene, removePhoto, isPhotoInUseByRunning,
};
```

- [ ] **Step 2: Add photo tests**

Append to `test/experiments.test.js`:

```javascript
// Photo helpers need a real filesystem — use the temp dir and override the
// module's EXPERIMENTS_DIR via a symlink trick isn't clean, so we just run
// against the real data/experiments/ and clean up afterwards.
const { addPhoto, removePhoto, loadPhotos, ensureDirs, TEST_PHOTOS_DIR } = require("../lib/experiments");

test("addPhoto / loadPhotos / removePhoto roundtrip", async () => {
    await ensureDirs();
    const filename = `__unit_test_${Date.now()}.jpg`;
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
    const filename = `__unit_test_dup_${Date.now()}.jpg`;
    const buf = Buffer.from("x");
    try {
        await addPhoto({ filename, displayName: "One", buffer: buf });
        await assert.rejects(() => addPhoto({ filename, displayName: "Two", buffer: buf }), /already exists/);
    } finally {
        await removePhoto(filename).catch(() => {});
    }
});
```

- [ ] **Step 3: Run tests**

Run: `node --test test/experiments.test.js`
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): photo upload + scene cache helpers"
```

---

### Task 12: Runner orchestration

The runner iterates entries with a bounded concurrency pool, retries once on failure, and flushes the manifest to disk after each state change so the polling UI sees progress and a crash leaves recoverable partial state.

**Files:**
- Modify: `lib/experiments.js`
- Modify: `test/experiments.test.js`

- [ ] **Step 1: Add runner + entry execution to `lib/experiments.js`**

Append (before `module.exports`):

```javascript
// ── Runner ──────────────────────────────────────────────────────────────────

// runEntry is parameterized on `deps` so tests can mock OpenAI + builder.
// In production, mountExperiments wires the real dependencies in.
async function runEntry(entry, manifest, deps) {
    entry.status = "running";
    entry.startedAt = new Date().toISOString();
    entry._retried = entry._retried || false;
    await deps.flushManifest(manifest);

    const t0 = Date.now();
    try {
        const promptText = await deps.buildPromptForEntry(entry, manifest);
        entry.promptText = promptText;
        const pngBuf = await deps.callImageEdit({ entry, manifest, promptText });
        await fsp.writeFile(path.join(experimentDir(manifest.id), entry.outputPath), pngBuf);
        entry.status = "completed";
        entry.generationMs = Date.now() - t0;
    } catch (err) {
        if (!entry._retried) {
            entry._retried = true;
            console.log(`🔁 Retrying entry ${entry.outputPath} after error: ${err.message}`);
            return runEntry(entry, manifest, deps);
        }
        entry.status = "failed";
        entry.error = err.message;
    }
    entry.completedAt = new Date().toISOString();
    await deps.flushManifest(manifest);
}

async function runExperiment(manifest, deps) {
    await fsp.mkdir(experimentDir(manifest.id), { recursive: true });
    manifest.status = "running";
    await deps.flushManifest(manifest);

    // Ensure each photo has a cached scene description
    for (const photo of manifest.config.photos) {
        await deps.ensurePhotoSceneCache(photo);
    }

    const inFlight = new Set();
    for (const entry of manifest.entries) {
        while (inFlight.size >= MAX_CONCURRENT) {
            await Promise.race(inFlight);
        }
        const p = runEntry(entry, manifest, deps).finally(() => inFlight.delete(p));
        inFlight.add(p);
    }
    await Promise.all(inFlight);

    manifest.status = "completed";
    manifest.totalCostUsd = manifest.entries.filter((e) => e.status === "completed").length * COST_PER_IMAGE_USD;
    await deps.flushManifest(manifest);
}

// Recover any manifest left in "running" state from a prior crash.
// Called at server startup.
async function recoverStaleExperiments() {
    const manifests = await listManifests();
    for (const m of manifests) {
        if (m.status !== "running") continue;
        for (const entry of m.entries) {
            if (entry.status === "running" || entry.status === "pending") {
                entry.status = "failed";
                entry.error = "server restarted";
                entry.completedAt = new Date().toISOString();
            }
        }
        m.status = "failed";
        await saveManifest(m);
        console.log(`🧹 Recovered stale experiment ${m.id}`);
    }
}
```

Add `runEntry`, `runExperiment`, `recoverStaleExperiments` to `module.exports`.

- [ ] **Step 2: Add runner tests (fully mocked — no OpenAI calls)**

Append to `test/experiments.test.js`:

```javascript
const { runEntry, runExperiment, experimentDir, saveManifest, loadManifest } = require("../lib/experiments");

function makeManifest(overrides = {}) {
    return {
        id: `test-${Date.now()}`,
        name: "runner-test",
        createdAt: new Date().toISOString(),
        status: "pending",
        config: { styles: ["cartoon"], brands: [null], backgrounds: [null], photos: ["a.jpg"], reps: 1, variants: [{ name: "v" }] },
        entries: [{
            photo: "a.jpg", style: "cartoon", brand: null, background: null,
            variant: "v", rep: 1, status: "pending",
            outputPath: "a_cartoon_none_none_v_1.png",
            promptText: null, generationMs: null, error: null,
            startedAt: null, completedAt: null,
        }],
        ...overrides,
    };
}

test("runEntry: success writes PNG and marks completed", async () => {
    const manifest = makeManifest();
    await fsp.mkdir(experimentDir(manifest.id), { recursive: true });
    const flushed = [];
    const deps = {
        flushManifest: async (m) => { flushed.push(JSON.stringify(m.entries[0].status)); },
        buildPromptForEntry: async () => "the-prompt",
        callImageEdit: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic bytes
        ensurePhotoSceneCache: async () => {},
    };
    try {
        await runEntry(manifest.entries[0], manifest, deps);
        assert.equal(manifest.entries[0].status, "completed");
        assert.equal(manifest.entries[0].promptText, "the-prompt");
        assert.ok(fs.existsSync(path.join(experimentDir(manifest.id), manifest.entries[0].outputPath)));
    } finally {
        await fsp.rm(experimentDir(manifest.id), { recursive: true, force: true });
    }
});

test("runEntry: first failure retries, second marks failed", async () => {
    const manifest = makeManifest();
    await fsp.mkdir(experimentDir(manifest.id), { recursive: true });
    let calls = 0;
    const deps = {
        flushManifest: async () => {},
        buildPromptForEntry: async () => "p",
        callImageEdit: async () => { calls++; throw new Error("boom"); },
        ensurePhotoSceneCache: async () => {},
    };
    try {
        await runEntry(manifest.entries[0], manifest, deps);
        assert.equal(calls, 2); // one initial + one retry
        assert.equal(manifest.entries[0].status, "failed");
        assert.equal(manifest.entries[0].error, "boom");
    } finally {
        await fsp.rm(experimentDir(manifest.id), { recursive: true, force: true });
    }
});

test("runExperiment: completes all entries and computes cost", async () => {
    const manifest = makeManifest({
        entries: [
            { photo: "a.jpg", style: "cartoon", brand: null, background: null, variant: "v", rep: 1, status: "pending", outputPath: "a1.png", promptText: null, generationMs: null, error: null, startedAt: null, completedAt: null },
            { photo: "a.jpg", style: "cartoon", brand: null, background: null, variant: "v", rep: 2, status: "pending", outputPath: "a2.png", promptText: null, generationMs: null, error: null, startedAt: null, completedAt: null },
        ],
    });
    await saveManifest(manifest);
    const deps = {
        flushManifest: saveManifest,
        buildPromptForEntry: async () => "p",
        callImageEdit: async () => Buffer.from([0x89]),
        ensurePhotoSceneCache: async () => {},
    };
    try {
        await runExperiment(manifest, deps);
        assert.equal(manifest.status, "completed");
        assert.equal(manifest.entries.every((e) => e.status === "completed"), true);
        assert.ok(manifest.totalCostUsd > 0);
    } finally {
        await fsp.rm(experimentDir(manifest.id), { recursive: true, force: true });
    }
});
```

- [ ] **Step 3: Run tests**

Run: `node --test test/experiments.test.js`
Expected: 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): runner with bounded concurrency + retry"
```

---

### Task 13: Experiment routes (run list, create, get, patch, delete)

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add route layer at the bottom of `lib/experiments.js`**

Add these requires at the top of the file (after the existing `path` require):

```javascript
const express = require("express");
const crypto = require("crypto");
const { getOpenAI, getModels } = require("./config");
const { toFile } = require("openai");
const { analyzeScene, parseScene, withRetry } = require("./helpers");
const settings = require("./settings");
const promptBuilder = require("./prompt-builder");
const { getActiveBrands } = require("./brands");
```

Append before `module.exports`:

```javascript
// ── Route layer ─────────────────────────────────────────────────────────────

// Build a prompt-builder input from a single entry + manifest. This mirrors the
// production pipeline's resolution step but sources style/brand/background
// either from live settings or from the variant's override map.
function resolveEntryInputs(entry, manifest, photoScene) {
    const variant = manifest.config.variants.find((v) => v.name === entry.variant);
    const activeStyles = settings.getActiveStyles();
    const activeBrands = getActiveBrands();

    let styleObj, stylePrompt;
    if (variant && variant.type === "custom" && variant.overrides && variant.overrides[entry.style]) {
        const o = variant.overrides[entry.style];
        const base = activeStyles[entry.style] || {};
        styleObj = { ...base, prompt: o.prompt || base.prompt, core: o.core || base.core, brandCore: o.brandCore || base.brandCore };
        stylePrompt = styleObj.prompt;
    } else {
        styleObj = activeStyles[entry.style];
        stylePrompt = styleObj ? styleObj.prompt : "";
    }

    const brandObj = entry.brand ? activeBrands[entry.brand] || null : null;
    const bgChoice = null; // backgrounds resolved at the variant level via brand/style context; v1 uses label only
    const scene = photoScene && photoScene.parsedScene ? photoScene.parsedScene : { subjects: 1, pets: "none", positions: "centered" };
    let sceneLine;
    if (scene.subjects > 1 && scene.pets !== "none") {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects and a ${scene.pets}. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people and the ${scene.pets} — no more, no fewer.`;
    } else if (scene.subjects > 1) {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people — no more, no fewer.`;
    } else if (scene.pets !== "none") {
        sceneLine = `This photo has exactly 1 person and a ${scene.pets}. The ${scene.pets} is an animal, NOT a person — do not turn the ${scene.pets} into a human. The output must contain exactly 1 person and the ${scene.pets} — no other people.`;
    } else {
        sceneLine = "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.";
    }

    return {
        styleKey: entry.style, styleObj, stylePrompt,
        brandKey: entry.brand, brandObj,
        brandAnalysis: "", brandPrompt: "", brandRefBuffers: [],
        styleAnalysis: "", styleRefBuffers: [],
        bgChoice, bgMode: "ai", bgAnalysis: "", bgRefBuffers: [],
        scene, sceneLine,
        preserve: settings.get("promptPreserve"),
        preserveBrand: settings.get("promptPreserveBrand"),
        brandInstruction: settings.get("promptBrandInstruction"),
        composition: settings.get("promptComposition"),
        backgroundLine: settings.get("promptBackground"),
        multiSubjectMode: settings.get("multiSubjectMode") || "reject",
        reviewFeedback: null,
    };
}

async function defaultBuildPromptForEntry(entry, manifest) {
    const photos = await loadPhotos();
    const photoScene = photos.photos.find((p) => p.filename === entry.photo) || null;
    const input = resolveEntryInputs(entry, manifest, photoScene);
    return promptBuilder.build(input);
}

async function defaultCallImageEdit({ entry, promptText }) {
    const selfiePath = path.join(TEST_PHOTOS_DIR, entry.photo);
    const selfieBuffer = await fsp.readFile(selfiePath);
    const imageFiles = [await toFile(selfieBuffer, "selfie.jpg", { type: "image/jpeg" })];
    const imageModel = getModels().imageGen;
    const result = await withRetry(() => getOpenAI().images.edit({
        model: imageModel,
        image: imageFiles,
        prompt: promptText,
        size: "1024x1536",
        quality: "high",
    }));
    const data = result.data && result.data[0];
    if (!data || !data.b64_json) throw new Error("No image returned");
    return Buffer.from(data.b64_json, "base64");
}

async function defaultEnsurePhotoSceneCache(filename) {
    const photos = await loadPhotos();
    const entry = photos.photos.find((p) => p.filename === filename);
    if (!entry) throw new Error(`Photo ${filename} not found`);
    if (entry.sceneDescription) return;
    const photoPath = path.join(TEST_PHOTOS_DIR, filename);
    const buf = await fsp.readFile(photoPath);
    const b64 = buf.toString("base64");
    const sceneText = await analyzeScene(b64);
    const parsed = parseScene(sceneText);
    await updatePhotoScene(filename, sceneText, parsed);
}

function buildRouter() {
    const router = express.Router();

    router.get("/api/runs", async (req, res) => {
        try { res.json({ runs: await listManifests() }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post("/api/runs", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const { name, styles, brands, backgrounds, photos, reps, variants } = req.body || {};
            if (!name || !Array.isArray(styles) || !Array.isArray(brands) || !Array.isArray(backgrounds) || !Array.isArray(photos) || !Array.isArray(variants)) {
                return res.status(400).json({ error: "Missing required fields" });
            }
            if (variants.length > MAX_VARIANTS_PER_EXPERIMENT) {
                return res.status(400).json({ error: `Too many variants (max ${MAX_VARIANTS_PER_EXPERIMENT})` });
            }
            const config = { styles, brands, backgrounds, photos, reps: reps || 1, variants };
            const entries = buildEntries(config);
            if (entries.length > MAX_ENTRIES_PER_EXPERIMENT) {
                return res.status(400).json({ error: `Too many entries (${entries.length} > max ${MAX_ENTRIES_PER_EXPERIMENT})` });
            }
            const id = makeId(name);
            const manifest = {
                id, name, createdAt: new Date().toISOString(), status: "pending",
                config, entries, winners: {}, notes: "", totalCostUsd: 0,
            };
            await fsp.mkdir(experimentDir(id), { recursive: true });
            await saveManifest(manifest);

            // Kick off asynchronously; don't await
            const deps = {
                flushManifest: saveManifest,
                buildPromptForEntry: defaultBuildPromptForEntry,
                callImageEdit: defaultCallImageEdit,
                ensurePhotoSceneCache: defaultEnsurePhotoSceneCache,
            };
            runExperiment(manifest, deps).catch((err) => {
                console.error(`❌ Experiment ${id} crashed: ${err.message}`);
                manifest.status = "failed";
                saveManifest(manifest).catch(() => {});
            });
            res.json({ id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get("/api/runs/:id", async (req, res) => {
        try { res.json(await loadManifest(req.params.id)); }
        catch (err) { res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.message }); }
    });

    router.patch("/api/runs/:id", express.json(), async (req, res) => {
        try {
            const manifest = await loadManifest(req.params.id);
            if (req.body.winners) manifest.winners = { ...(manifest.winners || {}), ...req.body.winners };
            if (typeof req.body.notes === "string") manifest.notes = req.body.notes;
            await saveManifest(manifest);
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete("/api/runs/:id", async (req, res) => {
        try {
            await fsp.rm(experimentDir(req.params.id), { recursive: true, force: true });
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    return router;
}
```

Add `buildRouter`, `resolveEntryInputs`, `defaultBuildPromptForEntry`, `defaultCallImageEdit`, `defaultEnsurePhotoSceneCache` to `module.exports`.

- [ ] **Step 2: Test the router with supertest-like raw express**

Append to `test/experiments.test.js`:

```javascript
const express = require("express");
const http = require("http");
const { buildRouter } = require("../lib/experiments");

function request(app, { method, path: p, body }) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const req = http.request({ port, method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
                let chunks = "";
                res.on("data", (c) => chunks += c);
                res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }); });
            });
            req.on("error", (err) => { server.close(); reject(err); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

test("GET /api/runs returns an array", async () => {
    const app = express();
    app.use(buildRouter());
    const { status, body } = await request(app, { method: "GET", path: "/api/runs" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.runs));
});

test("POST /api/runs rejects missing fields", async () => {
    const app = express();
    app.use(buildRouter());
    const { status } = await request(app, { method: "POST", path: "/api/runs", body: { name: "x" } });
    assert.equal(status, 400);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test test/experiments.test.js`
Expected: 12 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): experiment CRUD routes"
```

---

### Task 14: Photo + static-image routes

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add photo and image routes to `buildRouter()`**

Inside `buildRouter()`, before `return router;`, add:

```javascript
    router.get("/api/photos", async (req, res) => {
        try { res.json(await loadPhotos()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Raw JPEG upload — body is the image bytes, filename in query string.
    // Keeps the route dependency-free (no multer). Max 8MB.
    router.post("/api/photos", express.raw({ type: "image/jpeg", limit: "8mb" }), async (req, res) => {
        try {
            const filename = req.query.filename ? String(req.query.filename).replace(/[^A-Za-z0-9._-]/g, "") : null;
            const displayName = req.query.displayName ? String(req.query.displayName) : filename;
            if (!filename || !/\.jpe?g$/i.test(filename)) {
                return res.status(400).json({ error: "filename must end in .jpg or .jpeg" });
            }
            if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
                return res.status(400).json({ error: "body must be raw image/jpeg bytes" });
            }
            // Quick signature check (JPEG SOI)
            if (!(req.body[0] === 0xff && req.body[1] === 0xd8)) {
                return res.status(400).json({ error: "body does not look like a JPEG" });
            }
            const added = await addPhoto({ filename, displayName, buffer: req.body });
            // Scene analysis happens inline and may fail — keep the photo either way
            try {
                const b64 = req.body.toString("base64");
                const sceneText = await analyzeScene(b64);
                const parsed = parseScene(sceneText);
                await updatePhotoScene(filename, sceneText, parsed);
                added.sceneDescription = sceneText;
                added.parsedScene = parsed;
            } catch (err) {
                console.warn(`📸 Scene analysis failed for ${filename}: ${err.message}`);
            }
            res.json(added);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete("/api/photos/:name", async (req, res) => {
        try {
            if (await isPhotoInUseByRunning(req.params.name)) {
                return res.status(409).json({ error: "Photo is in use by a running experiment" });
            }
            await removePhoto(req.params.name);
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Static PNG serving. Scope tightly — only expose experiment dirs.
    router.get("/images/:id/:file", (req, res) => {
        const safeId = String(req.params.id).replace(/[^A-Za-z0-9._:-]/g, "");
        const safeFile = String(req.params.file).replace(/[^A-Za-z0-9._-]/g, "");
        if (!safeFile.endsWith(".png")) return res.status(400).end();
        const fp = path.join(experimentDir(safeId), safeFile);
        if (!fp.startsWith(EXPERIMENTS_DIR)) return res.status(400).end();
        res.sendFile(fp, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    });
```

- [ ] **Step 2: Test the photo routes**

Append to `test/experiments.test.js`:

```javascript
test("GET /api/photos returns current photo manifest", async () => {
    const app = express();
    app.use(buildRouter());
    const { status, body } = await request(app, { method: "GET", path: "/api/photos" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.photos));
});

test("POST /api/photos rejects non-JPEG filename", async () => {
    const app = express();
    app.use(buildRouter());
    const { status } = await request(app, { method: "POST", path: "/api/photos?filename=foo.png", body: { x: 1 } });
    // Either 400 (filename rejected) or 415 (express.raw won't accept application/json)
    assert.ok(status === 400 || status === 415);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test test/experiments.test.js`
Expected: 14 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): photo upload + static image routes"
```

---

### Task 15: Landing page `/eval`

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add a page helper and the GET `/` route**

Near the other requires, add:

```javascript
const { userBarSnippet, magicHatSnippet } = require("./auth");
```

Append a page helper before `buildRouter()`:

```javascript
function pageShell({ title, body }) {
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--th-bg); color: var(--th-text); font-family: 'Twilio Sans Text', system-ui, sans-serif; padding: 24px; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 28px; margin-bottom: 16px; }
  h2 { font-size: 18px; margin: 24px 0 8px; color: var(--th-text-muted); }
  .card { background: var(--th-surface); border: 1px solid var(--th-border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .btn { display: inline-block; background: var(--th-primary); color: white; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 14px; }
  .btn-secondary { background: var(--th-surface); color: var(--th-text); border: 1px solid var(--th-border); }
  .muted { color: var(--th-text-muted); font-size: 13px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill-running { background: #fef3c7; color: #92400e; }
  .pill-completed { background: #d1fae5; color: #065f46; }
  .pill-failed { background: #fee2e2; color: #991b1b; }
  input, select, textarea { background: var(--th-surface); color: var(--th-text); border: 1px solid var(--th-border); padding: 8px; border-radius: 6px; font-family: inherit; font-size: 14px; }
  a { color: var(--th-link); }
</style>
</head>
<body>
${magicHatSnippet()}
${userBarSnippet()}
<div class="wrap">
${body}
</div>
</body>
</html>`;
}
```

Inside `buildRouter()`, before the API routes, add:

```javascript
    router.get("/", async (req, res) => {
        const manifests = await listManifests();
        const running = manifests.filter((m) => m.status === "running");
        const recent = manifests.filter((m) => m.status !== "running").slice(0, 25);

        const card = (m) => {
            const done = m.entries.filter((e) => e.status === "completed").length;
            const failed = m.entries.filter((e) => e.status === "failed").length;
            const total = m.entries.length;
            const pill = `<span class="pill pill-${m.status}">${m.status}</span>`;
            const cost = m.totalCostUsd ? `$${m.totalCostUsd.toFixed(2)}` : "";
            return `<div class="card"><div class="row">
              <div>
                <a href="/eval/run/${encodeURIComponent(m.id)}"><strong>${escapeHtml(m.name)}</strong></a> ${pill}
                <div class="muted">${new Date(m.createdAt).toLocaleString()} · ${done}/${total} done${failed ? ` · ${failed} failed` : ""}${cost ? ` · ${cost}` : ""}</div>
              </div>
            </div></div>`;
        };

        const body = `
          <div class="row"><h1>Prompt Experiments</h1>
            <div>
              <a class="btn btn-secondary" href="/eval/photos">Photos</a>
              <a class="btn" href="/eval/new">+ New experiment</a>
            </div>
          </div>
          ${running.length ? `<h2>Running</h2>${running.map(card).join("")}` : ""}
          <h2>Recent</h2>
          ${recent.length ? recent.map(card).join("") : `<p class="muted">No experiments yet. Click "+ New experiment" to start.</p>`}
          <script>
            // Poll while any card is running
            if (${running.length}) setTimeout(() => location.reload(), 3000);
          </script>
        `;
        res.type("html").send(pageShell({ title: "Experiments", body }));
    });

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
```

- [ ] **Step 2: Smoke test the page renders**

Append to `test/experiments.test.js`:

```javascript
test("GET / returns the experiments landing page HTML", async () => {
    const app = express();
    app.use(buildRouter());
    const { status, body } = await new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            http.get({ port, path: "/" }, (res) => {
                let chunks = ""; res.on("data", (c) => chunks += c);
                res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: chunks }); });
            }).on("error", reject);
        });
    });
    assert.equal(status, 200);
    assert.match(body, /Prompt Experiments/);
    assert.match(body, /New experiment/);
});
```

- [ ] **Step 3: Run test**

Run: `node --test test/experiments.test.js`
Expected: 15 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): landing page at /eval"
```

---

### Task 16: New-run form `/eval/new`

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add the GET `/new` route**

Inside `buildRouter()` alongside the other page routes, add:

```javascript
    router.get("/new", async (req, res) => {
        const activeStyles = settings.getActiveStyles();
        const activeBrands = getActiveBrands();
        const photos = (await loadPhotos()).photos;

        const styleOptions = Object.entries(activeStyles).map(([k, s]) =>
            `<label><input type="checkbox" name="styles" value="${k}"> ${escapeHtml(s.name)}</label>`).join("<br>");
        const brandOptions = [`<label><input type="checkbox" name="brands" value=""> (no brand)</label>`]
            .concat(Object.entries(activeBrands).map(([k, b]) =>
                `<label><input type="checkbox" name="brands" value="${k}"> ${escapeHtml(b.name || k)}</label>`)).join("<br>");
        const bgOptions = [
            `<label><input type="checkbox" name="backgrounds" value=""> (style default)</label>`,
            `<label><input type="checkbox" name="backgrounds" value="original"> Original scene</label>`,
            `<label><input type="checkbox" name="backgrounds" value="plain-white"> Plain white</label>`,
        ].join("<br>");
        const photoOptions = photos.map((p) =>
            `<label><input type="checkbox" name="photos" value="${escapeHtml(p.filename)}"> ${escapeHtml(p.displayName || p.filename)}</label>`).join("<br>") ||
            `<p class="muted">No photos uploaded. <a href="/eval/photos">Upload one</a> first.</p>`;

        const body = `
          <h1>New experiment</h1>
          <form id="f" class="card" style="display:grid; gap:16px;">
            <label>Name<br><input name="name" required style="width:100%"></label>
            <div><strong>Styles</strong><br>${styleOptions}</div>
            <div><strong>Brands</strong><br>${brandOptions}</div>
            <div><strong>Backgrounds</strong><br>${bgOptions}</div>
            <div><strong>Photos</strong><br>${photoOptions}</div>
            <label>Reps per combination<br><input type="number" name="reps" value="3" min="1" max="10"></label>
            <div id="variants"><strong>Variants</strong><br>
              <label><input type="checkbox" name="includeLive" checked> Include "live" variant (snapshots current settings)</label>
            </div>
            <button class="btn" type="submit">Run experiment</button>
            <div id="err" class="muted" style="color:#dc2626;"></div>
          </form>
          <script>
          document.getElementById("f").addEventListener("submit", async (e) => {
              e.preventDefault();
              const f = e.target;
              const data = {
                  name: f.name.value,
                  styles: [...f.querySelectorAll("[name=styles]:checked")].map(x => x.value),
                  brands: [...f.querySelectorAll("[name=brands]:checked")].map(x => x.value || null),
                  backgrounds: [...f.querySelectorAll("[name=backgrounds]:checked")].map(x => x.value || null),
                  photos: [...f.querySelectorAll("[name=photos]:checked")].map(x => x.value),
                  reps: parseInt(f.reps.value, 10),
                  variants: f.includeLive.checked ? [{ name: "live", type: "live" }] : [],
              };
              if (!data.variants.length) { document.getElementById("err").textContent = "Pick at least one variant"; return; }
              const r = await fetch("/eval/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
              const j = await r.json();
              if (r.ok) location.href = "/eval/run/" + encodeURIComponent(j.id);
              else document.getElementById("err").textContent = j.error || "Request failed";
          });
          </script>
        `;
        res.type("html").send(pageShell({ title: "New experiment", body }));
    });
```

- [ ] **Step 2: Smoke test**

Append to `test/experiments.test.js`:

```javascript
test("GET /new renders the form", async () => {
    const app = express();
    app.use(buildRouter());
    const { status, body } = await new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: "/new" }, (res) => {
                let chunks = ""; res.on("data", (c) => chunks += c);
                res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: chunks }); });
            }).on("error", reject);
        });
    });
    assert.equal(status, 200);
    assert.match(body, /New experiment/);
    assert.match(body, /Run experiment/);
});
```

- [ ] **Step 3: Run test**

Run: `node --test test/experiments.test.js`
Expected: 16 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): new-run form at /eval/new"
```

---

### Task 17: Run detail page `/eval/run/:id` (grid + winners + notes)

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add the GET `/run/:id` route**

Inside `buildRouter()`:

```javascript
    router.get("/run/:id", async (req, res) => {
        let manifest;
        try { manifest = await loadManifest(req.params.id); }
        catch { return res.status(404).send("Not found"); }

        // Group entries by combination key: style|brand|background
        const groups = new Map();
        for (const e of manifest.entries) {
            const key = `${e.style}|${e.brand || "null"}|${e.background || "null"}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        }
        const variantNames = manifest.config.variants.map((v) => v.name);
        const photos = manifest.config.photos;

        const renderCombo = (key, entries) => {
            const [s, b, bg] = key.split("|");
            const title = `${s} × ${b === "null" ? "(no brand)" : b} × ${bg === "null" ? "(default bg)" : bg}`;
            const winnerOpts = ["<option value=''>—</option>"]
                .concat(variantNames.map((v) => `<option value="${escapeHtml(v)}" ${manifest.winners && manifest.winners[key] && manifest.winners[key].variant === v ? "selected" : ""}>${escapeHtml(v)}</option>`));
            const currentNotes = (manifest.winners && manifest.winners[key] && manifest.winners[key].notes) || "";
            const photoBlocks = photos.map((p) => {
                const rows = variantNames.map((vn) => {
                    const cells = entries.filter((e) => e.photo === p && e.variant === vn)
                        .sort((a, b) => a.rep - b.rep)
                        .map((e) => {
                            if (e.status === "completed") {
                                return `<a href="/eval/images/${encodeURIComponent(manifest.id)}/${encodeURIComponent(e.outputPath)}" target="_blank"><img src="/eval/images/${encodeURIComponent(manifest.id)}/${encodeURIComponent(e.outputPath)}" width="180" style="border-radius:6px;" title="${escapeHtml(e.promptText || "")}"></a>`;
                            }
                            if (e.status === "failed") return `<div style="width:180px;height:240px;background:#fee2e2;color:#991b1b;border-radius:6px;display:flex;align-items:center;justify-content:center;padding:8px;font-size:12px;text-align:center;">${escapeHtml(e.error || "failed")}</div>`;
                            return `<div style="width:180px;height:240px;background:var(--th-surface);border:1px dashed var(--th-border);border-radius:6px;display:flex;align-items:center;justify-content:center;">⏳ ${e.status}</div>`;
                        }).join("");
                    return `<div style="display:flex;gap:8px;align-items:center;"><strong style="width:80px;">${escapeHtml(vn)}</strong>${cells}</div>`;
                }).join("");
                return `<div style="margin:12px 0;"><div class="muted">${escapeHtml(p)}</div>${rows}</div>`;
            }).join("");
            return `<div class="card" data-combo="${escapeHtml(key)}">
              <div class="row"><strong>${escapeHtml(title)}</strong>
                <label>Winner: <select data-combo-key="${escapeHtml(key)}">${winnerOpts.join("")}</select></label>
              </div>
              <textarea data-combo-notes="${escapeHtml(key)}" placeholder="Notes for this combination" style="width:100%;margin-top:8px;min-height:60px;">${escapeHtml(currentNotes)}</textarea>
              ${photoBlocks}
            </div>`;
        };

        const combos = [...groups.entries()].map(([k, es]) => renderCombo(k, es)).join("");
        const running = manifest.status === "running";
        const body = `
          <div class="row"><h1>${escapeHtml(manifest.name)} <span class="pill pill-${manifest.status}">${manifest.status}</span></h1>
            <a class="btn btn-secondary" href="/eval">← Back</a>
          </div>
          <p class="muted">${new Date(manifest.createdAt).toLocaleString()} · ${manifest.entries.length} entries${manifest.totalCostUsd ? ` · $${manifest.totalCostUsd.toFixed(2)}` : ""}</p>
          <textarea id="runNotes" placeholder="Experiment-wide notes (markdown ok)" style="width:100%;min-height:80px;margin-bottom:16px;">${escapeHtml(manifest.notes || "")}</textarea>
          ${combos}
          <script>
          const runId = ${JSON.stringify(manifest.id)};
          ${running ? `setTimeout(() => location.reload(), 3000);` : ""}
          function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
          const save = debounce(async () => {
              const winners = {};
              document.querySelectorAll("[data-combo-key]").forEach((s) => {
                  const k = s.dataset.comboKey;
                  const v = s.value;
                  const notesEl = document.querySelector('[data-combo-notes="' + CSS.escape(k) + '"]');
                  if (v || (notesEl && notesEl.value)) winners[k] = { variant: v, notes: notesEl ? notesEl.value : "" };
              });
              await fetch("/eval/api/runs/" + encodeURIComponent(runId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ winners, notes: document.getElementById("runNotes").value }) });
          }, 500);
          document.querySelectorAll("[data-combo-key], [data-combo-notes], #runNotes").forEach((el) => el.addEventListener("input", save));
          document.querySelectorAll("[data-combo-key]").forEach((el) => el.addEventListener("change", save));
          </script>
        `;
        res.type("html").send(pageShell({ title: manifest.name, body }));
    });
```

- [ ] **Step 2: Smoke test**

Append to `test/experiments.test.js`:

```javascript
test("GET /run/:id returns 404 for unknown id", async () => {
    const app = express();
    app.use(buildRouter());
    const { status } = await new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: "/run/does-not-exist" }, (res) => {
                res.on("data", () => {}); res.on("end", () => { server.close(); resolve({ status: res.statusCode }); });
            }).on("error", reject);
        });
    });
    assert.equal(status, 404);
});
```

- [ ] **Step 3: Run test**

Run: `node --test test/experiments.test.js`
Expected: 17 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): run detail page with winners + notes"
```

---

### Task 18: Photo manager page `/eval/photos`

**Files:**
- Modify: `lib/experiments.js`

- [ ] **Step 1: Add the GET `/photos` route**

Inside `buildRouter()`:

```javascript
    router.get("/photos", async (req, res) => {
        const photos = (await loadPhotos()).photos;
        const list = photos.map((p) => `
          <div class="card"><div class="row">
            <div>
              <strong>${escapeHtml(p.displayName || p.filename)}</strong>
              <div class="muted">${escapeHtml(p.filename)} · ${new Date(p.uploadedAt).toLocaleDateString()}</div>
              ${p.sceneDescription ? `<div class="muted" style="margin-top:6px;">${escapeHtml(p.sceneDescription.slice(0, 200))}${p.sceneDescription.length > 200 ? "…" : ""}</div>` : `<div class="muted">(scene not analyzed)</div>`}
            </div>
            <button class="btn btn-secondary" data-del="${escapeHtml(p.filename)}">Delete</button>
          </div></div>`).join("");
        const body = `
          <div class="row"><h1>Test photos</h1><a class="btn btn-secondary" href="/eval">← Back</a></div>
          <div class="card">
            <input type="file" id="file" accept="image/jpeg">
            <input type="text" id="displayName" placeholder="Display name (optional)">
            <button class="btn" id="upload">Upload</button>
            <div id="msg" class="muted" style="margin-top:8px;"></div>
          </div>
          ${list || '<p class="muted">No photos yet.</p>'}
          <script>
          document.getElementById("upload").addEventListener("click", async () => {
              const f = document.getElementById("file").files[0];
              const dn = document.getElementById("displayName").value;
              if (!f) { document.getElementById("msg").textContent = "Pick a JPEG first"; return; }
              const qs = "?filename=" + encodeURIComponent(f.name) + (dn ? "&displayName=" + encodeURIComponent(dn) : "");
              document.getElementById("msg").textContent = "Uploading (scene analysis may take a few seconds)…";
              const r = await fetch("/eval/api/photos" + qs, { method: "POST", headers: { "content-type": "image/jpeg" }, body: f });
              if (r.ok) location.reload();
              else { const j = await r.json(); document.getElementById("msg").textContent = j.error || "Upload failed"; }
          });
          document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
              if (!confirm("Delete " + b.dataset.del + "?")) return;
              const r = await fetch("/eval/api/photos/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
              if (r.ok) location.reload();
              else alert((await r.json()).error || "Delete failed");
          }));
          </script>
        `;
        res.type("html").send(pageShell({ title: "Test photos", body }));
    });
```

- [ ] **Step 2: Smoke test**

```javascript
test("GET /photos renders the photo manager", async () => {
    const app = express();
    app.use(buildRouter());
    const { status, body } = await new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: "/photos" }, (res) => {
                let chunks = ""; res.on("data", (c) => chunks += c);
                res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: chunks }); });
            }).on("error", reject);
        });
    });
    assert.equal(status, 200);
    assert.match(body, /Test photos/);
});
```

- [ ] **Step 3: Run test**

Run: `node --test test/experiments.test.js`
Expected: 18 tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/experiments.js test/experiments.test.js
git commit -m "feat(experiments): photo manager at /eval/photos"
```

---

### Task 19: Wire `mountExperiments` into `index.js`

**Files:**
- Modify: `lib/experiments.js`
- Modify: `index.js`

- [ ] **Step 1: Add `mountExperiments` to `lib/experiments.js`**

At the bottom of `lib/experiments.js`, before `module.exports`:

```javascript
async function mountExperiments(app) {
    await ensureDirs();
    await recoverStaleExperiments();
    app.use("/eval", buildRouter());
    console.log("🧪 Experiment tracker mounted at /eval");
}
```

Add `mountExperiments` to `module.exports`.

- [ ] **Step 2: Call it from `index.js`**

In `index.js` near the other `mount*` requires (around line 37-46), add:

```javascript
const { mountExperiments } = require("./lib/experiments");
```

Inside the `server.listen` callback (around line 544-550) where other mounts happen, add:

```javascript
    await mountExperiments(app);
```

immediately after `mountReview(app);`.

- [ ] **Step 3: Start the server manually and verify**

Run: `npm start`
In another terminal:

```bash
curl -sI http://localhost:3000/eval | head -1
```

Expected: `HTTP/1.1 302 Found` (redirect to `/auth/login`) because the route is behind the auth middleware. That's correct — the tracker is gated.

Kill the server.

- [ ] **Step 4: Full test run**

Run: `npm test`
Expected: All tests pass (characterize, prompt-builder unit, parity, experiments, and all pre-existing suites).

- [ ] **Step 5: Commit**

```bash
git add lib/experiments.js index.js
git commit -m "feat(experiments): mount /eval behind OAuth"
```

---

### Task 20: Phase 2 wrap-up

- [ ] **Step 1: Manual end-to-end smoke (browser)**

1. Log into `/auth/login` if not already authed.
2. Navigate to `/eval`. Landing page renders with empty recent list.
3. Navigate to `/eval/photos`. Upload a small JPEG selfie. Verify scene description appears after upload.
4. Navigate to `/eval/new`. Fill in name, pick one style, no brand, no background, pick the uploaded photo, reps=1. Submit.
5. Redirect to `/eval/run/:id`. Verify status shows `running`, grid shows a pending tile, page auto-refreshes every 3s.
6. Wait for generation to complete (~30-60s). Verify tile turns into an image.
7. Click the image — opens the PNG at full resolution.
8. Set a winner in the combo dropdown, add notes — reload the page and confirm persistence.

- [ ] **Step 2: Confirm Phase 1 invariants still hold**

Run: `node --test test/prompt-builder-characterize.test.js`
Expected: 8 PASS. No production drift introduced by Phase 2.

- [ ] **Step 3: Final full-suite run**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Review the diff**

Run: `git log --oneline main..HEAD` (or equivalent range covering this work).
Expected: A clean linear history of well-named commits spanning Tasks 1-19.

Phase 2 is complete. The tracker is live at `/eval`, behind existing OAuth, with no production path affected.

---

## Self-Review Notes

**Spec coverage check:**
- Goal → Tasks 9-19 build `/eval`. ✓
- Architecture → Phase 1 extracts prompt-builder, Phase 2 adds experiments.js + data/experiments/. ✓
- Manifest schema → Task 10 (CRUD) + Task 13 (create populates it). ✓
- Refactor safety (characterize tests) → Tasks 2-6. ✓
- Runner with MAX_CONCURRENT=3, MAX_RETRIES=1 → Task 12. ✓
- Restart-recovery → Task 12 (`recoverStaleExperiments`) + Task 19 (mount-time call). ✓
- Photo management → Tasks 11, 14, 18. ✓
- Routes (list/create/get/patch/delete/photos/images) → Tasks 13, 14. ✓
- UI (landing, new, detail, photos) → Tasks 15-18. ✓
- Cost accounting → Task 12 computes `totalCostUsd` post-run. ✓
- 2-commit rollout → Phase 1 commits produce a logical refactor ship, Phase 2 commits produce the feature ship. Engineers may squash per phase at push time if desired.

**Out-of-scope for v1 (from spec) — intentionally NOT in the plan:**
- Pre-run cost/count estimation (the form just caps at 500)
- Automated winner scoring
- Resume failed experiments
- Prompt diffing / CSV export / cross-run comparison
- Patches-style variants (only full-override + live in v1)

**Known simplifications in v1 (call out during review):**
- Custom variants are wired through in the manifest schema (`type: "custom"`, `overrides` map) but the `/eval/new` form in Task 16 only surfaces the "live" variant. Adding per-style override textareas to the form is a straightforward UI extension for a follow-up.
- Background label in the grid is purely text — v1 does not load brand-specific scene references or bg analysis for experiments. If the user wants brand background references in experiments, that's a follow-up.
- `defaultCallImageEdit` does not attach brand/style/bg reference buffers for experiments. This keeps cost predictable during early testing; add reference-buffer loading in a follow-up once the workflow is proven.

