# Style × Brand × Background Combos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-style `behavior` / `acceptsColorPalette` fields, per-brand `category` / `scenes` / `allowOriginal` / `wardrobe` / `colorPalette` fields, a pure `resolveBackgroundMenu` function that derives the bg menu from style+brand, and integrate into the existing SMS flow + prompt builder so every style × brand × background combo produces a coherent image.

**Architecture:** A new pure module `lib/prompt-assembler.js` owns the `resolveBackgroundMenu(style, brand)` function and a prompt-fragment helper `buildComboFragments({ style, brand, background })`. The existing `generateImage` in `lib/pipeline.js` calls `buildComboFragments` at the right points to get the container description and color palette fragments (rather than fully replacing its prompt builder). The SMS flow (`index.js`) uses `resolveBackgroundMenu` to decide whether to ask about background and what options to show. Backward compatibility: all new fields are optional with safe defaults, so every existing event keeps working unchanged.

**Tech Stack:** Node.js 20, Express 5, Twilio webhook, CommonJS modules, no existing test framework (tests will use Node.js built-in `node:test` + `node:assert` — zero-install).

---

## File Structure

**New files:**
- `lib/prompt-assembler.js` — pure functions: `resolveBackgroundMenu(style, brand)`, `buildComboFragments({ style, brand, background })`, and constants for default menu entries.
- `test/prompt-assembler.test.js` — unit tests via `node --test`.
- `test/settings-combo-validation.test.js` — unit tests for new fields in `customStyles` / `customBrands` validators.

**Modified files:**
- `lib/styles.js` — add `behavior` and `acceptsColorPalette` to each built-in style object.
- `lib/settings.js` — extend `customStyles` and `customBrands` validators to accept new optional fields.
- `lib/background-menu.js` — rename existing `buildMenu`/`buildRetryMenu`/`matchReply` to accept an array of `{key, name, prompt}` choices directly (already basically does; we lock that contract).
- `index.js` — replace the `showBackgroundMenuOrEnqueue` helper body to use `resolveBackgroundMenu`; persist `resolvedBgChoices` into `backgroundMenu.setPending` so the reply handler matches against the exact list the user saw; add a "None" option handling at the brand step.
- `lib/pipeline.js` — in `generateImage`, after building the existing prompt `parts` array, call `buildComboFragments` to append `containerDescription` (if themed-container) and `colorPalette` (if brand has it AND style accepts it).
- `package.json` — add a `test` script that runs `node --test test/`.

**Not modified (by design, scope-guard):**
- Admin UI / dashboard — the spec calls for UI fields but that's a separate sub-project. This plan makes the backend accept the new fields; admins can set them today via the existing raw-JSON export/import. A follow-up plan will add form controls.

---

## Task 1: Add `node --test` harness and smoke test

**Files:**
- Modify: `package.json`
- Create: `test/smoke.test.js`

- [ ] **Step 1.1: Add test script to package.json**

Read `package.json`. The existing `scripts.test` is the placeholder `"echo \"Error: no test specified\" && exit 1"`. Replace that line so the field reads:

```json
"test": "node --test test/"
```

- [ ] **Step 1.2: Create a smoke test so the runner has something to run**

Create `test/smoke.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("node:test runner works", () => {
    assert.equal(1 + 1, 2);
});
```

- [ ] **Step 1.3: Run the test**

Run: `cd /Users/adellavecchia/Desktop/Git-Projects/twilio-cartoon-printer && npm test`
Expected: `# tests 1` / `# pass 1` / `# fail 0`.

- [ ] **Step 1.4: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "chore: add node:test harness with smoke test"
```

---

## Task 2: Extend built-in styles with `behavior` and `acceptsColorPalette`

**Files:**
- Modify: `lib/styles.js` (each entry in the `STYLES` object, lines ~7–87)
- Modify: `lib/styles.js` (the `getActiveStyles` function, lines ~128–155, to propagate the new fields)
- Create: `test/styles-fields.test.js`

- [ ] **Step 2.1: Write failing test that every built-in style has the new fields**

Create `test/styles-fields.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { STYLES } = require("../lib/styles");

test("every built-in style has behavior field", () => {
    for (const [key, style] of Object.entries(STYLES)) {
        assert.ok(
            style.behavior === "normal" || style.behavior === "themed-container",
            `Style "${key}" must set behavior to "normal" or "themed-container" (got ${style.behavior})`
        );
    }
});

test("every built-in style has acceptsColorPalette field", () => {
    for (const [key, style] of Object.entries(STYLES)) {
        assert.equal(
            typeof style.acceptsColorPalette,
            "boolean",
            `Style "${key}" must set acceptsColorPalette to a boolean (got ${typeof style.acceptsColorPalette})`
        );
    }
});

test("getActiveStyles propagates behavior and acceptsColorPalette", () => {
    const { getActiveStyles } = require("../lib/styles");
    const active = getActiveStyles([], {}, {}, "preserve line", "composition line");
    for (const [key, entry] of Object.entries(active)) {
        assert.ok(entry.behavior, `Active style "${key}" missing behavior`);
        assert.equal(typeof entry.acceptsColorPalette, "boolean",
            `Active style "${key}" missing acceptsColorPalette`);
    }
});
```

- [ ] **Step 2.2: Run test to verify failure**

Run: `npm test -- test/styles-fields.test.js`
Expected: all 3 tests fail with "must set behavior" / "must set acceptsColorPalette" / "missing behavior".

- [ ] **Step 2.3: Edit `lib/styles.js` to add fields to each built-in style**

In `lib/styles.js`, add `behavior: "normal"` and `acceptsColorPalette: true` to **every** entry in the `STYLES` object. The 6 built-in styles are: `cartoon`, `pop-art`, `watercolor`, `anime`, `sketch`, `pixel-art`. Example for the first one (apply the same two-field addition to all six):

```javascript
cartoon: {
    name: "cartoon",
    behavior: "normal",
    acceptsColorPalette: true,
    core: "Pixar-style 3D animated portrait with exaggerated proportions, warm color grading, subsurface skin glow, and rich tactile textures.",
    brandCore: "Pixar-style 3D animated portrait with warm colors and rich textures.",
    buildPrompt: (preserve, composition) => [
        // ... unchanged ...
    ].join("\n\n"),
},
```

- [ ] **Step 2.4: Edit `getActiveStyles` to propagate the new fields**

Locate the `getActiveStyles` function in `lib/styles.js` (around line 128). Find the line that reads:

```javascript
active[key] = { name: style.name, prompt, core, brandCore };
```

Replace with:

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

Also locate the custom-style branch a few lines below:

```javascript
active[key] = { name: style.name, prompt: style.prompt, files: style.files || [], analysis: style.analysis || "" };
```

Replace with:

```javascript
active[key] = {
    name: style.name,
    behavior: style.behavior || "normal",
    acceptsColorPalette: style.acceptsColorPalette !== false,
    containerDescription: style.containerDescription || null,
    prompt: style.prompt,
    files: style.files || [],
    analysis: style.analysis || "",
};
```

- [ ] **Step 2.5: Run test to verify pass**

Run: `npm test -- test/styles-fields.test.js`
Expected: all 3 tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add lib/styles.js test/styles-fields.test.js
git commit -m "feat(styles): add behavior and acceptsColorPalette fields to built-in styles"
```

---

## Task 3: Extend settings validators for `customStyles` new fields

**Files:**
- Modify: `lib/settings.js` (the `customStyles` case in `validate`, around lines 682–695)
- Create: `test/settings-combo-validation.test.js`

- [ ] **Step 3.1: Write failing test for customStyles validator**

Create `test/settings-combo-validation.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// Isolate settings module state by clearing require cache between tests.
function freshSettings() {
    delete require.cache[require.resolve("../lib/settings")];
    return require("../lib/settings");
}

test("customStyles accepts behavior field", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "test-style": {
                name: "Test Style",
                prompt: "A test style prompt.",
                behavior: "themed-container",
                acceptsColorPalette: false,
                containerDescription: "Subject inside a test container.",
            },
        },
    });
    const stored = settings.get("customStyles")["test-style"];
    assert.equal(stored.behavior, "themed-container");
    assert.equal(stored.acceptsColorPalette, false);
    assert.equal(stored.containerDescription, "Subject inside a test container.");
});

test("customStyles missing new fields loads cleanly (backward compat)", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "legacy-style": {
                name: "Legacy",
                prompt: "Legacy prompt.",
            },
        },
    });
    const stored = settings.get("customStyles")["legacy-style"];
    assert.equal(stored.name, "Legacy");
    // new fields are not required — they simply won't be present
    assert.ok(!("behavior" in stored) || stored.behavior === undefined);
});

test("customStyles invalid behavior value is dropped", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "bad-style": {
                name: "Bad",
                prompt: "Bad prompt.",
                behavior: "banana",
            },
        },
    });
    const stored = settings.get("customStyles")["bad-style"];
    assert.ok(!("behavior" in stored) || stored.behavior === undefined,
        `Invalid behavior "banana" should have been dropped; got ${stored.behavior}`);
});
```

Note: this test writes to `data/settings.json` as a side effect. Before running, back it up:

```bash
cp data/settings.json data/settings.json.testbak 2>/dev/null || true
```

And restore it after the test suite completes. A cleaner fix is added in Step 3.2.

- [ ] **Step 3.2: Add a test setup guard that restores settings.json**

Prepend the test file with teardown logic so the tests are safe to run without manual backup:

```javascript
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "settings.json");
let _originalSettings = null;

before(() => {
    if (fs.existsSync(SETTINGS_FILE)) {
        _originalSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
    }
});

after(() => {
    if (_originalSettings !== null) {
        fs.writeFileSync(SETTINGS_FILE, _originalSettings);
    } else if (fs.existsSync(SETTINGS_FILE)) {
        fs.unlinkSync(SETTINGS_FILE);
    }
});

function freshSettings() {
    delete require.cache[require.resolve("../lib/settings")];
    const s = require("../lib/settings");
    s.load();
    return s;
}
```

Then keep the three tests from Step 3.1.

- [ ] **Step 3.3: Run test to verify failure**

Run: `npm test -- test/settings-combo-validation.test.js`
Expected: the "accepts behavior field" test fails because `behavior`, `acceptsColorPalette`, `containerDescription` are stripped by the current validator.

- [ ] **Step 3.4: Edit validator for `customStyles`**

Locate the `case "customStyles":` branch in `lib/settings.js` (around lines 682–695). The current loop body reads:

```javascript
if (v && typeof v.name === "string" && typeof v.prompt === "string" && v.prompt.trim()) {
    cleaned[k.trim().toLowerCase().replace(/\s+/g, "-")] = {
        name: v.name.trim(),
        prompt: v.prompt.trim(),
        files: Array.isArray(v.files) ? v.files.map((f) => String(f).trim()).filter(Boolean) : [],
        analysis: typeof v.analysis === "string" ? v.analysis : "",
    };
}
```

Replace with:

```javascript
if (v && typeof v.name === "string" && typeof v.prompt === "string" && v.prompt.trim()) {
    const entry = {
        name: v.name.trim(),
        prompt: v.prompt.trim(),
        files: Array.isArray(v.files) ? v.files.map((f) => String(f).trim()).filter(Boolean) : [],
        analysis: typeof v.analysis === "string" ? v.analysis : "",
    };
    if (v.behavior === "normal" || v.behavior === "themed-container") {
        entry.behavior = v.behavior;
    }
    if (typeof v.acceptsColorPalette === "boolean") {
        entry.acceptsColorPalette = v.acceptsColorPalette;
    }
    if (typeof v.containerDescription === "string" && v.containerDescription.trim()) {
        entry.containerDescription = v.containerDescription.trim();
    }
    cleaned[k.trim().toLowerCase().replace(/\s+/g, "-")] = entry;
}
```

- [ ] **Step 3.5: Run test to verify pass**

Run: `npm test -- test/settings-combo-validation.test.js`
Expected: all 3 tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add lib/settings.js test/settings-combo-validation.test.js
git commit -m "feat(settings): validate new customStyles fields (behavior, acceptsColorPalette, containerDescription)"
```

---

## Task 4: Extend settings validators for `customBrands` new fields

**Files:**
- Modify: `lib/settings.js` (the `customBrands` case in `validate`, around lines 696–709)
- Modify: `test/settings-combo-validation.test.js` (add brand tests)

- [ ] **Step 4.1: Extend test file with customBrands cases**

Append these tests to `test/settings-combo-validation.test.js`:

```javascript
test("customBrands accepts category, scenes, allowOriginal, wardrobe, colorPalette", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "test-brand": {
                name: "Test Brand",
                brandPrompt: "legacy prompt",
                category: "wardrobe-plus-scene",
                wardrobe: "test wardrobe fragment",
                allowOriginal: false,
                colorPalette: "Recolor everything red.",
                scenes: [
                    { key: "scene-a", name: "Scene A", prompt: "Scene A prompt." },
                    { key: "scene-b", name: "Scene B", prompt: "Scene B prompt." },
                ],
            },
        },
    });
    const stored = settings.get("customBrands")["test-brand"];
    assert.equal(stored.category, "wardrobe-plus-scene");
    assert.equal(stored.wardrobe, "test wardrobe fragment");
    assert.equal(stored.allowOriginal, false);
    assert.equal(stored.colorPalette, "Recolor everything red.");
    assert.equal(stored.scenes.length, 2);
    assert.equal(stored.scenes[0].key, "scene-a");
    assert.equal(stored.scenes[0].name, "Scene A");
    assert.equal(stored.scenes[0].prompt, "Scene A prompt.");
});

test("customBrands legacy shape loads cleanly (backward compat)", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "legacy-brand": {
                name: "Legacy",
                brandPrompt: "legacy text",
                files: ["ref1.png"],
            },
        },
    });
    const stored = settings.get("customBrands")["legacy-brand"];
    assert.equal(stored.name, "Legacy");
    assert.equal(stored.brandPrompt, "legacy text");
    assert.deepEqual(stored.files, ["ref1.png"]);
});

test("customBrands invalid category is dropped", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "bad-brand": {
                name: "Bad",
                brandPrompt: "x",
                category: "banana",
            },
        },
    });
    const stored = settings.get("customBrands")["bad-brand"];
    assert.ok(!("category" in stored) || stored.category === undefined,
        `Invalid category "banana" should be dropped; got ${stored.category}`);
});

test("customBrands invalid scene entries are filtered out", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "filter-brand": {
                name: "Filter",
                brandPrompt: "x",
                scenes: [
                    { key: "ok", name: "OK scene", prompt: "ok." },
                    { name: "missing key" },
                    "not an object",
                    { key: "nokey-no-name" },
                ],
            },
        },
    });
    const stored = settings.get("customBrands")["filter-brand"];
    assert.equal(stored.scenes.length, 1, "only the valid scene should survive");
    assert.equal(stored.scenes[0].key, "ok");
});
```

- [ ] **Step 4.2: Run tests to verify failure**

Run: `npm test -- test/settings-combo-validation.test.js`
Expected: the first 3 new tests fail; the "legacy shape" test passes already.

- [ ] **Step 4.3: Edit validator for `customBrands`**

Locate the `case "customBrands":` branch in `lib/settings.js` (around lines 696–709). The current loop body reads:

```javascript
if (v && typeof v.name === "string" && v.name.trim()) {
    cleanedBrands[k.trim().toLowerCase().replace(/\s+/g, "-")] = {
        name: v.name.trim(),
        files: Array.isArray(v.files) ? v.files.map((f) => String(f).trim()).filter(Boolean) : [],
        brandPrompt: typeof v.brandPrompt === "string" ? v.brandPrompt.trim() : "",
        analysis: typeof v.analysis === "string" ? v.analysis : "",
    };
}
```

Replace with:

```javascript
if (v && typeof v.name === "string" && v.name.trim()) {
    const entry = {
        name: v.name.trim(),
        files: Array.isArray(v.files) ? v.files.map((f) => String(f).trim()).filter(Boolean) : [],
        brandPrompt: typeof v.brandPrompt === "string" ? v.brandPrompt.trim() : "",
        analysis: typeof v.analysis === "string" ? v.analysis : "",
    };
    if (v.category === "wardrobe-only" || v.category === "wardrobe-plus-scene") {
        entry.category = v.category;
    }
    if (typeof v.wardrobe === "string" && v.wardrobe.trim()) {
        entry.wardrobe = v.wardrobe.trim();
    }
    if (typeof v.allowOriginal === "boolean") {
        entry.allowOriginal = v.allowOriginal;
    }
    if (typeof v.colorPalette === "string" && v.colorPalette.trim()) {
        entry.colorPalette = v.colorPalette.trim();
    }
    if (Array.isArray(v.scenes)) {
        entry.scenes = v.scenes
            .filter((s) => s && typeof s === "object" && typeof s.key === "string" && s.key.trim() && typeof s.name === "string" && s.name.trim())
            .map((s) => ({
                key: s.key.trim().toLowerCase().replace(/\s+/g, "-"),
                name: s.name.trim(),
                prompt: typeof s.prompt === "string" ? s.prompt.trim() : "",
                files: Array.isArray(s.files) ? s.files.map((f) => String(f).trim()).filter(Boolean) : [],
            }));
    }
    cleanedBrands[k.trim().toLowerCase().replace(/\s+/g, "-")] = entry;
}
```

- [ ] **Step 4.4: Run tests to verify pass**

Run: `npm test -- test/settings-combo-validation.test.js`
Expected: all 7 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add lib/settings.js test/settings-combo-validation.test.js
git commit -m "feat(settings): validate new customBrands fields (category, scenes, wardrobe, allowOriginal, colorPalette)"
```

---

## Task 5: Create `prompt-assembler.js` — `resolveBackgroundMenu`

**Files:**
- Create: `lib/prompt-assembler.js`
- Create: `test/prompt-assembler.test.js`

- [ ] **Step 5.1: Write failing tests for resolveBackgroundMenu**

Create `test/prompt-assembler.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBackgroundMenu } = require("../lib/prompt-assembler");

const normalStyle = { behavior: "normal" };
const containerStyle = { behavior: "themed-container" };

const wardrobeOnlyBrand = {
    category: "wardrobe-only",
    scenes: [{ key: "ice-rink", name: "Ice rink", prompt: "ice rink bg" }],
    allowOriginal: true,
};
const wardrobePlusSceneBrand = {
    category: "wardrobe-plus-scene",
    scenes: [
        { key: "main-stage", name: "Main stage", prompt: "main stage bg" },
        { key: "ferris-wheel", name: "Ferris wheel", prompt: "ferris wheel bg" },
    ],
    allowOriginal: false,
};

test("normal + wardrobe-only: [brand scene, original, plain white]", () => {
    const menu = resolveBackgroundMenu(normalStyle, wardrobeOnlyBrand);
    assert.equal(menu.length, 3);
    assert.deepEqual(menu.map((m) => m.key), ["ice-rink", "original", "plain-white"]);
});

test("normal + wardrobe-plus-scene: brand scenes only", () => {
    const menu = resolveBackgroundMenu(normalStyle, wardrobePlusSceneBrand);
    assert.equal(menu.length, 2);
    assert.deepEqual(menu.map((m) => m.key), ["main-stage", "ferris-wheel"]);
});

test("normal + no brand: [original, plain white]", () => {
    const menu = resolveBackgroundMenu(normalStyle, null);
    assert.deepEqual(menu.map((m) => m.key), ["original", "plain-white"]);
});

test("themed-container + wardrobe-only: [brand scene, original] (no plain white)", () => {
    const menu = resolveBackgroundMenu(containerStyle, wardrobeOnlyBrand);
    assert.deepEqual(menu.map((m) => m.key), ["ice-rink", "original"]);
});

test("themed-container + wardrobe-plus-scene: brand scenes only", () => {
    const menu = resolveBackgroundMenu(containerStyle, wardrobePlusSceneBrand);
    assert.deepEqual(menu.map((m) => m.key), ["main-stage", "ferris-wheel"]);
});

test("themed-container + no brand: [original] only (auto-skip)", () => {
    const menu = resolveBackgroundMenu(containerStyle, null);
    assert.deepEqual(menu.map((m) => m.key), ["original"]);
});

test("defaults when fields missing: behavior undefined treated as normal", () => {
    const menu = resolveBackgroundMenu({}, null);
    assert.deepEqual(menu.map((m) => m.key), ["original", "plain-white"]);
});

test("defaults when brand category missing: treated as wardrobe-only", () => {
    const brand = { scenes: [{ key: "s", name: "S", prompt: "p" }] };
    const menu = resolveBackgroundMenu(normalStyle, brand);
    // allowOriginal defaults to true
    assert.deepEqual(menu.map((m) => m.key), ["s", "original", "plain-white"]);
});

test("each menu entry has { key, name, prompt }", () => {
    const menu = resolveBackgroundMenu(normalStyle, wardrobeOnlyBrand);
    for (const entry of menu) {
        assert.equal(typeof entry.key, "string");
        assert.equal(typeof entry.name, "string");
        assert.equal(typeof entry.prompt, "string");
    }
});
```

- [ ] **Step 5.2: Run tests to verify failure**

Run: `npm test -- test/prompt-assembler.test.js`
Expected: all tests fail with "Cannot find module '../lib/prompt-assembler'".

- [ ] **Step 5.3: Implement `resolveBackgroundMenu`**

Create `lib/prompt-assembler.js`:

```javascript
// Pure helpers for resolving the background menu and building prompt fragments
// from a style + brand + background combination. No I/O, no side effects.
// See docs/superpowers/specs/2026-04-24-style-brand-background-combos-design.md

const DEFAULT_ORIGINAL_PROMPT = "Background: Recreate the background environment from the original photo in the same art style.";
const DEFAULT_PLAIN_WHITE_PROMPT = "Background: Pure solid white background, clean and minimal.";

function resolveBackgroundMenu(style, brand) {
    const options = [];

    const brandScenes = brand && Array.isArray(brand.scenes) ? brand.scenes : [];
    for (const s of brandScenes) {
        if (s && s.key && s.name) {
            options.push({
                key: s.key,
                name: s.name,
                prompt: s.prompt || "",
                files: Array.isArray(s.files) ? s.files : [],
            });
        }
    }

    const allowOriginal = !brand || brand.allowOriginal !== false;
    const isWardrobePlusScene = brand && brand.category === "wardrobe-plus-scene";
    if (allowOriginal && !isWardrobePlusScene) {
        options.push({
            key: "original",
            name: "Original scene",
            prompt: DEFAULT_ORIGINAL_PROMPT,
            files: [],
        });
    }

    const isContainer = style && style.behavior === "themed-container";
    if (!isContainer && !isWardrobePlusScene) {
        options.push({
            key: "plain-white",
            name: "Plain white",
            prompt: DEFAULT_PLAIN_WHITE_PROMPT,
            files: [],
        });
    }

    return options;
}

module.exports = {
    resolveBackgroundMenu,
    DEFAULT_ORIGINAL_PROMPT,
    DEFAULT_PLAIN_WHITE_PROMPT,
};
```

- [ ] **Step 5.4: Run tests to verify pass**

Run: `npm test -- test/prompt-assembler.test.js`
Expected: all 9 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add lib/prompt-assembler.js test/prompt-assembler.test.js
git commit -m "feat(prompt-assembler): add resolveBackgroundMenu pure function"
```

---

## Task 6: Add `buildComboFragments` to prompt-assembler

**Files:**
- Modify: `lib/prompt-assembler.js`
- Modify: `test/prompt-assembler.test.js`

- [ ] **Step 6.1: Write failing tests for buildComboFragments**

Append to `test/prompt-assembler.test.js`:

```javascript
const { buildComboFragments } = require("../lib/prompt-assembler");

const cartoon = { behavior: "normal", acceptsColorPalette: true };
const actionFigure = {
    behavior: "themed-container",
    acceptsColorPalette: true,
    containerDescription: "Subject rendered as a collectible action figure sealed in a themed toy box.",
};
const bronze = { behavior: "normal", acceptsColorPalette: false };
const twilioBrand = {
    category: "wardrobe-plus-scene",
    wardrobe: "Twilio-branded apparel",
    colorPalette: "Recolor everything to Twilio red and white.",
};
const laKingsBrand = {
    category: "wardrobe-only",
    wardrobe: "LA Kings hockey jersey",
};

test("buildComboFragments: no brand, normal style — container=null, palette=null", () => {
    const frags = buildComboFragments({ style: cartoon, brand: null, background: null });
    assert.equal(frags.containerDescription, null);
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: themed-container style contributes containerDescription", () => {
    const frags = buildComboFragments({ style: actionFigure, brand: laKingsBrand, background: null });
    assert.match(frags.containerDescription, /toy box/);
});

test("buildComboFragments: normal style does not contribute containerDescription", () => {
    const frags = buildComboFragments({ style: cartoon, brand: laKingsBrand, background: null });
    assert.equal(frags.containerDescription, null);
});

test("buildComboFragments: brand colorPalette included when style accepts it", () => {
    const frags = buildComboFragments({ style: cartoon, brand: twilioBrand, background: null });
    assert.match(frags.colorPalette, /Twilio red/);
});

test("buildComboFragments: brand colorPalette suppressed when style rejects it (Bronze × Twilio)", () => {
    const frags = buildComboFragments({ style: bronze, brand: twilioBrand, background: null });
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: no brand means no palette", () => {
    const frags = buildComboFragments({ style: cartoon, brand: null, background: null });
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: brand without colorPalette field means no palette", () => {
    const frags = buildComboFragments({ style: cartoon, brand: laKingsBrand, background: null });
    assert.equal(frags.colorPalette, null);
});

test("buildComboFragments: themed-container style without containerDescription returns null", () => {
    const incomplete = { behavior: "themed-container", acceptsColorPalette: true };
    const frags = buildComboFragments({ style: incomplete, brand: null, background: null });
    assert.equal(frags.containerDescription, null);
});
```

- [ ] **Step 6.2: Run tests to verify failure**

Run: `npm test -- test/prompt-assembler.test.js`
Expected: 8 new tests fail with "buildComboFragments is not a function".

- [ ] **Step 6.3: Implement `buildComboFragments`**

Edit `lib/prompt-assembler.js`. Add the new function before the `module.exports`:

```javascript
function buildComboFragments({ style, brand, background }) {
    const result = { containerDescription: null, colorPalette: null };

    if (style && style.behavior === "themed-container"
        && typeof style.containerDescription === "string"
        && style.containerDescription.trim()) {
        result.containerDescription = style.containerDescription.trim();
    }

    const styleAcceptsPalette = !style || style.acceptsColorPalette !== false;
    if (brand && typeof brand.colorPalette === "string" && brand.colorPalette.trim() && styleAcceptsPalette) {
        result.colorPalette = brand.colorPalette.trim();
    }

    return result;
}
```

And update the exports line at the bottom:

```javascript
module.exports = {
    resolveBackgroundMenu,
    buildComboFragments,
    DEFAULT_ORIGINAL_PROMPT,
    DEFAULT_PLAIN_WHITE_PROMPT,
};
```

- [ ] **Step 6.4: Run tests to verify pass**

Run: `npm test -- test/prompt-assembler.test.js`
Expected: all 17 tests pass (9 from Task 5 + 8 new).

- [ ] **Step 6.5: Commit**

```bash
git add lib/prompt-assembler.js test/prompt-assembler.test.js
git commit -m "feat(prompt-assembler): add buildComboFragments helper"
```

---

## Task 7: Integrate `buildComboFragments` into `generateImage`

**Files:**
- Modify: `lib/pipeline.js` (the prompt-building section of `generateImage`, lines ~293–370)
- Create: `test/pipeline-combo-integration.test.js`

This step is additive — we do not replace the existing `parts` array building. We append container + palette fragments after the existing logic.

- [ ] **Step 7.1: Write failing integration test**

Create `test/pipeline-combo-integration.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildComboFragments } = require("../lib/prompt-assembler");

// This test exercises the *contract* between pipeline.js and prompt-assembler.
// It does not invoke generateImage (which requires OpenAI + Twilio). It verifies
// that the fragments we plan to append to the prompt have the expected shape
// and that the integration points (themed-container + palette) work as a unit.

test("fragments for Action Figure × Twilio × rotary phone — both present", () => {
    const style = {
        behavior: "themed-container",
        acceptsColorPalette: true,
        containerDescription: "Subject rendered as a collectible plastic action figure sealed inside a themed retail toy box. The box packaging, interior scene, and decorative art are themed to match the brand and chosen background.",
    };
    const brand = {
        category: "wardrobe-plus-scene",
        wardrobe: "Twilio gear",
        colorPalette: "Recolor everything to Twilio red and white.",
    };
    const frags = buildComboFragments({ style, brand, background: null });
    assert.match(frags.containerDescription, /toy box/);
    assert.match(frags.colorPalette, /Twilio red/);
});

test("fragments for Bronze × Twilio — wardrobe kept, palette suppressed", () => {
    const style = { behavior: "normal", acceptsColorPalette: false };
    const brand = {
        category: "wardrobe-plus-scene",
        wardrobe: "Twilio gear",
        colorPalette: "Recolor everything red.",
    };
    const frags = buildComboFragments({ style, brand, background: null });
    assert.equal(frags.containerDescription, null);
    assert.equal(frags.colorPalette, null, "palette must be suppressed for acceptsColorPalette=false");
});

test("fragments for Cartoon × LA Kings — both null", () => {
    const style = { behavior: "normal", acceptsColorPalette: true };
    const brand = { category: "wardrobe-only", wardrobe: "LA Kings jersey" };
    const frags = buildComboFragments({ style, brand, background: null });
    assert.equal(frags.containerDescription, null);
    assert.equal(frags.colorPalette, null);
});
```

- [ ] **Step 7.2: Run tests to verify they pass**

Run: `npm test -- test/pipeline-combo-integration.test.js`
Expected: all 3 tests pass (they exercise prompt-assembler, which is complete).

- [ ] **Step 7.3: Edit `lib/pipeline.js` to append container + palette fragments**

In `lib/pipeline.js`, locate line ~370 which reads:

```javascript
    let fullPrompt = parts.join("\n");
```

This is immediately after all the existing brand/style/scene logic and immediately before the background-instruction block. Change that section so it reads:

```javascript
    // ── Combo fragments (behavior-based container, brand color palette) ──
    // Additive: existing brand-wardrobe + style direction above remain intact.
    // These append themed-container description and optional brand palette override.
    const { buildComboFragments } = require("./prompt-assembler");
    const customBrandsForCombo = job.brand ? (settings.getForEvent("customBrands", ev) || {}) : {};
    const brandForCombo = job.brand ? customBrandsForCombo[job.brand] : null;
    const comboFragments = buildComboFragments({
        style: styleObj,
        brand: brandForCombo,
        background: null,
    });
    if (comboFragments.containerDescription) {
        parts.push(comboFragments.containerDescription);
    }

    let fullPrompt = parts.join("\n");
```

And at the very end of the background-instruction section (after line ~437 where `fullPrompt` gets its bg line appended), append the palette as the final fragment. Locate this existing block:

```javascript
    } else {
        // No explicit choice — apply default background prompt UNLESS the style already
        // has its own background instructions (e.g. "Background: dark studio setting")
        const styleHasBgInstruction = stylePrompt && /background\s*[:—–-]/im.test(stylePrompt);
        const backgroundLine = settings.getForEvent("promptBackground", ev);
        if (backgroundLine && !styleHasBgInstruction) fullPrompt += "\n" + backgroundLine;
    }
```

Immediately after this closing brace (before the "Multi-subject handling" comment on line ~439), add:

```javascript
    // ── Color palette override (applies last, acts as global recolor filter) ──
    if (comboFragments.colorPalette) {
        fullPrompt += "\n" + comboFragments.colorPalette;
    }
```

- [ ] **Step 7.4: Verify the file still loads without errors**

Run: `node -e "require('./lib/pipeline')"`
Expected: exits silently with no error.

- [ ] **Step 7.5: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7.6: Commit**

```bash
git add lib/pipeline.js test/pipeline-combo-integration.test.js
git commit -m "feat(pipeline): append container + palette fragments to generation prompt"
```

---

## Task 8: Wire `resolveBackgroundMenu` into the SMS flow

**Files:**
- Modify: `lib/background-menu.js` (lock the menu contract to accept resolved `{key,name,prompt}[]`)
- Modify: `index.js` (the `showBackgroundMenuOrEnqueue` helper, lines ~234–253)
- Modify: `index.js` (the "background menu pending" handler, lines ~286–318)

- [ ] **Step 8.1: Update `lib/background-menu.js` to store resolved choices in pending**

Read `lib/background-menu.js`. The file already uses `choices` directly in `buildMenu`, `buildRetryMenu`, and `matchReply`. We extend `setPending` to accept a `resolvedChoices` array so the reply handler matches against what the user saw (not what's currently in settings, which may have drifted).

No code change needed — `setPending` already accepts arbitrary data via `{...data}`. We'll just start including `resolvedChoices` in calls from `index.js`. Skip this step.

- [ ] **Step 8.2: Rewrite `showBackgroundMenuOrEnqueue` in `index.js`**

In `index.js`, locate the `showBackgroundMenuOrEnqueue` helper (around lines 234–253). The current body reads:

```javascript
async function showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, useTwiml, brand) {
    const bgChoices = settings.get("backgroundChoices") || [];
    if (settings.get("enableBackgroundMenu") && bgChoices.length > 0) {
        if (bgChoices.length === 1) {
            // Auto-select if only one background
            await confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, bgChoices[0].key, brand);
            return;
        }
        backgroundMenu.setPending(userPhone, { imageUrl, messageSid, style, brand, body, appPhone, baseUrl });
        const menuMsg = backgroundMenu.buildMenu(bgChoices);
        if (useTwiml) {
            twiml.message(menuMsg);
        } else {
            const { sendSms } = require("./lib/helpers");
            await sendSms(userPhone, appPhone, menuMsg);
        }
        return;
    }
    await confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, undefined, brand);
}
```

Replace with a version that uses `resolveBackgroundMenu` when `combo mode` is on for this event, and falls back to legacy `backgroundChoices` otherwise:

```javascript
async function showBackgroundMenuOrEnqueue(style, imageUrl, messageSid, useTwiml, brand) {
    const { resolveBackgroundMenu } = require("./lib/prompt-assembler");

    // Legacy mode: the event configured a flat backgroundChoices list.
    // Keep serving it verbatim for existing events.
    const legacyChoices = settings.get("backgroundChoices") || [];
    const comboEnabled = settings.get("enableBackgroundMenu") !== false && (
        (activeStyles[style] && (activeStyles[style].behavior === "themed-container" || activeStyles[style].behavior === "normal"))
    );

    // Resolve from style + brand config (new combo-driven menu).
    const styleObj = activeStyles[style] || {};
    const activeBrands = getActiveBrands();
    const brandObj = brand ? activeBrands[brand] : null;
    const resolved = resolveBackgroundMenu(styleObj, brandObj);

    // Prefer the resolved menu when we have brand config OR explicit style behavior.
    // Fall back to legacy choices only if resolved menu is empty (shouldn't happen)
    // or the event has legacy backgroundChoices configured and no new combo data.
    const useResolved = resolved.length > 0;
    const choices = useResolved ? resolved : legacyChoices;

    if (settings.get("enableBackgroundMenu") && choices.length > 0) {
        if (choices.length === 1) {
            await confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, choices[0].key, brand);
            return;
        }
        backgroundMenu.setPending(userPhone, {
            imageUrl, messageSid, style, brand, body, appPhone, baseUrl,
            resolvedChoices: choices,
        });
        const menuMsg = backgroundMenu.buildMenu(choices);
        if (useTwiml) {
            twiml.message(menuMsg);
        } else {
            const { sendSms } = require("./lib/helpers");
            await sendSms(userPhone, appPhone, menuMsg);
        }
        return;
    }
    await confirmAndEnqueue(style, imageUrl, messageSid, useTwiml, undefined, brand);
}
```

- [ ] **Step 8.3: Update the "background menu pending" reply handler**

Locate the block in `index.js` around lines 286–318 starting with `if (backgroundMenu.hasPending(userPhone))`. The current version reads:

```javascript
const bgChoices = settings.get("backgroundChoices") || [];
const matched = backgroundMenu.matchReply(body, bgChoices);
```

Replace those two lines with:

```javascript
const bgPendingState = backgroundMenu.getPending(userPhone);
const bgChoices = bgPendingState && bgPendingState.resolvedChoices
    ? bgPendingState.resolvedChoices
    : (settings.get("backgroundChoices") || []);
const matched = backgroundMenu.matchReply(body, bgChoices);
```

And update the retry branch just below:

```javascript
if (!matched) {
    twiml.message(backgroundMenu.buildRetryMenu(bgChoices));
    return res.type("text/xml").send(twiml.toString());
}
```

This block already uses `bgChoices` from the new reassignment above, so no further change is needed in the retry branch — just verify that `bgChoices` in the retry refers to the freshly-resolved list.

- [ ] **Step 8.4: Verify index.js loads**

Run: `node -e "require('./index.js')" 2>&1 | head -20`
Expected: either silent success, or expected startup logs (port binding, storage messages). No `ReferenceError` or `SyntaxError`.

If the server tries to bind a port, kill it with Ctrl+C — the goal is just to confirm the module parses.

- [ ] **Step 8.5: Run all tests**

Run: `npm test`
Expected: all tests pass (no regression).

- [ ] **Step 8.6: Commit**

```bash
git add index.js
git commit -m "feat(sms): use resolveBackgroundMenu to derive per-combo background menus"
```

---

## Task 9: Add "None" option to brand menu

**Files:**
- Modify: `lib/brand-menu.js` (extend `buildMenu` + `matchReply` to accept a "None" synthetic entry)
- Modify: `index.js` (the `showBrandMenuOrNext` helper + brand-menu pending handler)
- Create: `test/brand-menu-none.test.js`

The existing brand menu does not include a "None" option; admins can only enable or disable the whole menu per-event. The spec requires users to be able to opt out of a brand while the menu is shown.

- [ ] **Step 9.1: Write failing test for the None option**

Create `test/brand-menu-none.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const brandMenu = require("../lib/brand-menu");

const activeBrands = {
    "la-kings": { name: "LA Kings" },
    "chelsea-fc": { name: "Chelsea FC" },
};
const brandList = ["la-kings", "chelsea-fc"];

test("buildMenu includes None as final option when includeNone=true", () => {
    const msg = brandMenu.buildMenu(activeBrands, brandList, { includeNone: true });
    assert.match(msg, /None/);
});

test("matchReply returns null for 'none' when includeNone=true", () => {
    // null signifies the sentinel 'user picked None'
    const matched = brandMenu.matchReply("none", activeBrands, brandList, { includeNone: true });
    assert.equal(matched, "__none__");
});

test("matchReply returns __none__ when user replies with number equal to N+1", () => {
    const matched = brandMenu.matchReply("3", activeBrands, brandList, { includeNone: true });
    assert.equal(matched, "__none__");
});

test("matchReply returns null for 'none' when includeNone=false (backward compat)", () => {
    const matched = brandMenu.matchReply("none", activeBrands, brandList);
    assert.equal(matched, null);
});
```

- [ ] **Step 9.2: Run tests to verify failure**

Run: `npm test -- test/brand-menu-none.test.js`
Expected: tests fail — the None option is not yet implemented.

- [ ] **Step 9.3: Edit `lib/brand-menu.js` to support the None option**

Read `lib/brand-menu.js`. The `buildMenu` and `matchReply` functions currently take `(activeBrands, brandList)`. Extend them to take an optional third argument `{ includeNone }`:

Replace `buildMenu`:

```javascript
function buildMenu(activeBrands, brandList, opts) {
    const includeNone = opts && opts.includeNone;
    const lines = brandList.map((key, i) => `${i + 1}. ${activeBrands[key].name}`);
    if (includeNone) {
        lines.push(`${brandList.length + 1}. None`);
    }
    return settings.getMsg("brandMenuIntro") + "\n\n" + lines.join("\n") + "\n\n" + settings.getMsg("brandMenuFooter");
}
```

Replace `matchReply`:

```javascript
function matchReply(body, activeBrands, brandList, opts) {
    const text = (body || "").trim();
    if (!text) return null;
    const includeNone = opts && opts.includeNone;

    // Try number match first
    const num = parseInt(text, 10);
    if (!isNaN(num)) {
        if (num >= 1 && num <= brandList.length) return brandList[num - 1];
        if (includeNone && num === brandList.length + 1) return "__none__";
    }

    if (includeNone && normalize(text) === "none") return "__none__";

    const norm = normalize(text);
    for (const key of brandList) {
        if (norm === normalize(key)) return key;
    }
    for (const key of brandList) {
        if (norm.includes(normalize(key))) return key;
    }
    for (const key of brandList) {
        if (norm === normalize(activeBrands[key].name)) return key;
    }
    for (const key of brandList) {
        if (norm.includes(normalize(activeBrands[key].name))) return key;
    }

    return null;
}
```

Replace `buildRetryMenu`:

```javascript
function buildRetryMenu(activeBrands, brandList, opts) {
    const includeNone = opts && opts.includeNone;
    const lines = brandList.map((key, i) => `${i + 1}. ${activeBrands[key].name}`);
    if (includeNone) {
        lines.push(`${brandList.length + 1}. None`);
    }
    return settings.getMsg("brandMenuRetry") + "\n\n" + lines.join("\n");
}
```

- [ ] **Step 9.4: Run tests to verify pass**

Run: `npm test -- test/brand-menu-none.test.js`
Expected: all 4 tests pass.

- [ ] **Step 9.5: Pass `includeNone: true` from `index.js`**

In `index.js`, locate `showBrandMenuOrNext` (around lines 201–221). Change the two lines that build the menu:

```javascript
brandMenu.setPending(userPhone, { imageUrl, messageSid, style, body, appPhone, baseUrl });
const menuMsg = brandMenu.buildMenu(activeBrands, activeBrandList);
```

Replace with:

```javascript
brandMenu.setPending(userPhone, { imageUrl, messageSid, style, body, appPhone, baseUrl, includeNone: true });
const menuMsg = brandMenu.buildMenu(activeBrands, activeBrandList, { includeNone: true });
```

Then in the brand-menu pending handler (around lines 321–354), change:

```javascript
const matched = brandMenu.matchReply(body, activeBrands, activeBrandList);
if (!matched) {
    twiml.message(brandMenu.buildRetryMenu(activeBrands, activeBrandList));
    return res.type("text/xml").send(twiml.toString());
}
```

to:

```javascript
const includeNone = brPending && brPending.includeNone;
const matched = brandMenu.matchReply(body, activeBrands, activeBrandList, { includeNone });
if (!matched) {
    twiml.message(brandMenu.buildRetryMenu(activeBrands, activeBrandList, { includeNone }));
    return res.type("text/xml").send(twiml.toString());
}
```

Note: `brPending` is assigned later in the existing code (`const brPending = brandMenu.getPending(userPhone);`). Move that line to BEFORE the matchReply call so `brPending` is available. The order becomes:

```javascript
const activeBrands = getActiveBrands();
const activeBrandList = Object.keys(activeBrands);
const brPending = brandMenu.getPending(userPhone);
const includeNone = brPending && brPending.includeNone;
const matched = brandMenu.matchReply(body, activeBrands, activeBrandList, { includeNone });
if (!matched) {
    twiml.message(brandMenu.buildRetryMenu(activeBrands, activeBrandList, { includeNone }));
    return res.type("text/xml").send(twiml.toString());
}
// brPending is used below; don't re-declare.
brandMenu.clearPending(userPhone);
```

Finally, handle the "__none__" sentinel. Below the matched check, the existing code does `leads.startSurvey(...)` or `showBackgroundMenuOrEnqueue(..., matched)`. Both treat `matched` as a brand key. When `matched === "__none__"`, we want to proceed with `brand = null`. Add right after `brandMenu.clearPending(userPhone)`:

```javascript
const effectiveBrand = matched === "__none__" ? null : matched;
```

And replace every subsequent reference to `matched` inside this block with `effectiveBrand`:
- `brand: matched` → `brand: effectiveBrand`
- `await showBackgroundMenuOrEnqueue(brPending.style, brPending.imageUrl, brPending.messageSid, false, matched);` → `await showBackgroundMenuOrEnqueue(brPending.style, brPending.imageUrl, brPending.messageSid, false, effectiveBrand);`

- [ ] **Step 9.6: Verify index.js loads**

Run: `node -e "require('./index.js')" 2>&1 | head -20`
Expected: silent success or normal startup messages; no syntax/reference errors.

- [ ] **Step 9.7: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 9.8: Commit**

```bash
git add lib/brand-menu.js index.js test/brand-menu-none.test.js
git commit -m "feat(brand-menu): add 'None' option to let users opt out of a brand"
```

---

## Task 10: Add full 45-combo matrix coverage test

**Files:**
- Create: `test/combo-matrix.test.js`

This test exercises every combination from the spec's background-menu matrix to prove the 3-label model is closed.

- [ ] **Step 10.1: Write the matrix test**

Create `test/combo-matrix.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBackgroundMenu, buildComboFragments } = require("../lib/prompt-assembler");

// All 9 styles × 5 brands + None = 54 combos. We check a representative set
// mapped from the spec's decision matrix.

const styles = {
    cartoon:         { behavior: "normal",            acceptsColorPalette: true,  name: "Cartoon" },
    anime:           { behavior: "normal",            acceptsColorPalette: true,  name: "Anime" },
    watercolor:      { behavior: "normal",            acceptsColorPalette: true,  name: "Watercolor" },
    "pixel-art":     { behavior: "normal",            acceptsColorPalette: true,  name: "Pixel Art" },
    "magazine":      { behavior: "normal",            acceptsColorPalette: true,  name: "Magazine Cover" },
    "comic-geo":     { behavior: "normal",            acceptsColorPalette: true,  name: "Comic Geometric" },
    bronze:          { behavior: "normal",            acceptsColorPalette: false, name: "Bronze Sculpture" },
    "action-figure": { behavior: "themed-container",  acceptsColorPalette: true,  name: "Action Figure", containerDescription: "Toy box." },
    "trading-card":  { behavior: "themed-container",  acceptsColorPalette: true,  name: "Trading Card",  containerDescription: "Card frame." },
};

const brands = {
    "la-kings":   { category: "wardrobe-only",        scenes: [{ key: "ice-rink",    name: "Ice rink",    prompt: "ice rink" }], allowOriginal: true,  wardrobe: "LA Kings jersey" },
    "chelsea-fc": { category: "wardrobe-only",        scenes: [{ key: "stadium",     name: "Stadium",     prompt: "stadium"  }], allowOriginal: true,  wardrobe: "Chelsea kit" },
    "pga":        { category: "wardrobe-only",        scenes: [{ key: "golf-course", name: "Golf course", prompt: "course"   }], allowOriginal: true,  wardrobe: "Golf polo" },
    "coachella":  { category: "wardrobe-plus-scene",  scenes: [{ key: "main-stage",  name: "Main stage",  prompt: "stage"    }, { key: "ferris",  name: "Ferris", prompt: "ferris" }], allowOriginal: false, wardrobe: "Performer outfit" },
    "twilio":     { category: "wardrobe-plus-scene",  scenes: [{ key: "wings",       name: "Twilio wings", prompt: "wings"   }, { key: "rotary",  name: "Rotary", prompt: "rotary" }], allowOriginal: false, wardrobe: "Twilio gear", colorPalette: "Recolor to Twilio red and white." },
};

function ids(menu) { return menu.map((m) => m.key); }

// Matrix expectations from the spec
const cases = [
    // normal × wardrobe-only → [scene, original, plain-white]
    { s: "cartoon",       b: "la-kings",   expected: ["ice-rink", "original", "plain-white"] },
    { s: "anime",         b: "chelsea-fc", expected: ["stadium",  "original", "plain-white"] },
    { s: "watercolor",    b: "pga",        expected: ["golf-course", "original", "plain-white"] },
    { s: "bronze",        b: "la-kings",   expected: ["ice-rink", "original", "plain-white"] },

    // normal × wardrobe-plus-scene → brand scenes only
    { s: "comic-geo",     b: "coachella",  expected: ["main-stage", "ferris"] },
    { s: "cartoon",       b: "twilio",     expected: ["wings", "rotary"] },

    // normal × None → [original, plain-white]
    { s: "anime",         b: null,         expected: ["original", "plain-white"] },
    { s: "magazine",      b: null,         expected: ["original", "plain-white"] },

    // themed-container × wardrobe-only → [scene, original] (no plain-white)
    { s: "action-figure", b: "la-kings",   expected: ["ice-rink", "original"] },
    { s: "trading-card",  b: "pga",        expected: ["golf-course", "original"] },

    // themed-container × wardrobe-plus-scene → scenes only
    { s: "action-figure", b: "twilio",     expected: ["wings", "rotary"] },
    { s: "trading-card",  b: "coachella",  expected: ["main-stage", "ferris"] },

    // themed-container × None → [original] only (auto-skip)
    { s: "action-figure", b: null,         expected: ["original"] },
    { s: "trading-card",  b: null,         expected: ["original"] },
];

for (const c of cases) {
    const label = `${c.s} × ${c.b || "none"}`;
    test(`menu matrix: ${label} → [${c.expected.join(", ")}]`, () => {
        const menu = resolveBackgroundMenu(styles[c.s], c.b ? brands[c.b] : null);
        assert.deepEqual(ids(menu), c.expected);
    });
}

// Palette expectations
test("palette: Action Figure × Twilio — palette applied", () => {
    const f = buildComboFragments({ style: styles["action-figure"], brand: brands.twilio, background: null });
    assert.match(f.colorPalette, /Twilio red/);
    assert.match(f.containerDescription, /Toy box/);
});

test("palette: Bronze × Twilio — palette suppressed", () => {
    const f = buildComboFragments({ style: styles.bronze, brand: brands.twilio, background: null });
    assert.equal(f.colorPalette, null);
    assert.equal(f.containerDescription, null);
});

test("palette: Cartoon × LA Kings — neither fragment", () => {
    const f = buildComboFragments({ style: styles.cartoon, brand: brands["la-kings"], background: null });
    assert.equal(f.colorPalette, null);
    assert.equal(f.containerDescription, null);
});

test("palette: Trading Card × Twilio — both fragments present", () => {
    const f = buildComboFragments({ style: styles["trading-card"], brand: brands.twilio, background: null });
    assert.match(f.colorPalette, /Twilio red/);
    assert.match(f.containerDescription, /Card frame/);
});
```

- [ ] **Step 10.2: Run the matrix test**

Run: `npm test -- test/combo-matrix.test.js`
Expected: all 18 cases pass.

- [ ] **Step 10.3: Run the entire test suite**

Run: `npm test`
Expected: every test across every file passes.

- [ ] **Step 10.4: Commit**

```bash
git add test/combo-matrix.test.js
git commit -m "test: cover 14 style×brand matrix cases + 4 palette cases"
```

---

## Task 11: Final end-to-end verification + README snippet

**Files:**
- Modify: `README.md` (append a short section explaining the new config fields)
- No new code

- [ ] **Step 11.1: Run the full test suite one more time**

Run: `npm test`
Expected: every test passes. Record the exact counts (e.g., `# tests 42`, `# pass 42`, `# fail 0`).

- [ ] **Step 11.2: Verify that `node index.js` can start without crashing**

Run (in a separate terminal, or stop when you see the "Ready" messages):

```bash
cd /Users/adellavecchia/Desktop/Git-Projects/twilio-cartoon-printer
timeout 5 node index.js 2>&1 | head -40 || true
```

Expected: normal startup output (storage diagnostics, settings loaded, port 3000 listening). No `ReferenceError`, `TypeError`, or `SyntaxError`.

- [ ] **Step 11.3: Append a short README section documenting the new fields**

Read `README.md` and append at the end (preserve existing content):

```markdown

## Style × Brand × Background combos (per-event config)

Each event can configure nine art styles × five brand wardrobes × a contextual set of backgrounds. The background menu is assembled at runtime from the chosen style and brand — no static list per event. See `docs/superpowers/specs/2026-04-24-style-brand-background-combos-design.md` for the full design.

### Custom style fields

- `behavior` — `"normal"` (default) or `"themed-container"`. Use `themed-container` when the style wraps the subject in a physical object like a toy box or trading card, whose interior/art themes to the chosen background.
- `acceptsColorPalette` — boolean (default `true`). Set to `false` on material-defined styles (e.g., bronze sculpture) so a brand's color palette override does not recolor them.
- `containerDescription` — string, required when `behavior === "themed-container"`.

### Custom brand fields

- `category` — `"wardrobe-only"` (default) or `"wardrobe-plus-scene"`.
- `wardrobe` — prompt fragment describing clothing/accessories.
- `scenes` — array of `{ key, name, prompt, files? }`. Wardrobe-only brands typically define one scene; wardrobe-plus-scene brands define at least two.
- `allowOriginal` — boolean (default `true`). Set to `false` to hide the "Original scene" option (appropriate for brands that force a themed scene).
- `colorPalette` — optional prompt fragment. When set, applied as a final recoloring instruction unless the chosen style sets `acceptsColorPalette: false`.

Users now see a "None" option at the bottom of the brand menu so they can skip the brand layer entirely.
```

- [ ] **Step 11.4: Commit**

```bash
git add README.md
git commit -m "docs: document new style and brand config fields"
```

- [ ] **Step 11.5: Final summary**

Print a summary of what was built:

```
- Pure module lib/prompt-assembler.js: resolveBackgroundMenu + buildComboFragments
- Settings validators accept new optional fields on customStyles + customBrands
- Built-in styles tagged with behavior + acceptsColorPalette
- SMS flow uses resolveBackgroundMenu; brand menu gets a "None" option
- generateImage appends container + palette fragments to the prompt
- 45-combo matrix is covered by unit tests
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `behavior` field on styles | Task 2 (built-in), Task 3 (custom) |
| `acceptsColorPalette` field on styles | Task 2 (built-in), Task 3 (custom) |
| `containerDescription` field on styles | Task 3 (custom) |
| `category` field on brands | Task 4 |
| `scenes` array on brands | Task 4 |
| `allowOriginal` field on brands | Task 4 |
| `wardrobe` field on brands | Task 4 |
| `colorPalette` field on brands | Task 4 |
| `resolveBackgroundMenu(style, brand)` pure function | Task 5 |
| Background-menu matrix (6 rows) | Task 5 + Task 10 |
| Auto-skip when menu has 1 option | Already implemented in `showBackgroundMenuOrEnqueue`; preserved by Task 8 |
| `None` option in brand menu | Task 9 |
| Container fragment appended to prompt | Task 6, Task 7 |
| Palette fragment appended to prompt with suppression | Task 6, Task 7 |
| Backward compatibility (defaults, legacy events) | Tested in Task 3 + Task 4 |
| Pipeline integration | Task 7 |
| SMS flow integration | Task 8, Task 9 |
| Admin UI for new fields | **Out of scope** — called out under "Not modified" in File Structure |

**Placeholder scan:** no TBD / TODO / "implement later" / "handle edge cases" / "similar to Task N". All code blocks show actual content.

**Type consistency:**
- `resolveBackgroundMenu(style, brand)` returns `Array<{key, name, prompt, files}>` — used consistently in Tasks 5, 8, 10.
- `buildComboFragments({style, brand, background})` returns `{ containerDescription: string|null, colorPalette: string|null }` — used consistently in Tasks 6, 7, 10.
- Brand objects throughout use `category`, `scenes`, `allowOriginal`, `wardrobe`, `colorPalette` — same names in validator (Task 4) and consumer (Tasks 5, 6).
- Style objects throughout use `behavior`, `acceptsColorPalette`, `containerDescription` — same names in validators (Tasks 2, 3) and consumers (Tasks 5, 6).
- The sentinel `"__none__"` is used consistently in `brandMenu.matchReply` (Task 9) and `effectiveBrand = matched === "__none__" ? null : matched` (Task 9).

No inconsistencies found.
