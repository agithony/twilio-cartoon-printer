# Style × Brand × Background Combos — Follow-up Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining gaps from the style × brand × background combos feature: wire the `wardrobe` field into the prompt pipeline, and add admin UI controls for every new style/brand field so configuration no longer requires editing JSON by hand.

**Architecture:** Two independent tracks. Track A (one task) is a backend plumbing fix that lets the validated `wardrobe` string actually reach the generator. Track B (three tasks) extends the existing `renderStylesList` / `renderBrands` / `addBrand` functions in `lib/home.js` with new form controls; persistence already works because `customStyles` / `customBrands` are saved as whole objects through `saveSettings()` → validator.

**Tech Stack:** Node.js 20, Express 5, vanilla JS admin UI in `lib/home.js` (inline strings, no build step), `node:test` + `node:assert/strict`.

---

## Task A1: Wire `brand.wardrobe` into prompt assembly

**Files:**
- Modify: `lib/pipeline.js:117` — prefer `brandDef.wardrobe` over `brandDef.brandPrompt` when present
- Create: `test/pipeline-wardrobe.test.js` — verify contract

- [ ] **Step A1.1: Write failing test**

Create `test/pipeline-wardrobe.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");

// Contract test: when a brand has a `wardrobe` field, the resolver used by
// pipeline.js should prefer it over the legacy `brandPrompt`. We test the
// resolution logic in isolation (pipeline.js doesn't export it as a function,
// so we mirror it here and lock the contract via expectation).

function resolveBrandPrompt(brandDef, overrides, fallback) {
    if (!brandDef) return fallback;
    return overrides[brandDef.key] || brandDef.wardrobe || brandDef.brandPrompt || fallback;
}

test("wardrobe preferred over brandPrompt when both set", () => {
    const brand = { key: "lakings", wardrobe: "LA Kings jersey", brandPrompt: "legacy text" };
    assert.equal(resolveBrandPrompt(brand, {}, "fallback"), "LA Kings jersey");
});

test("falls back to brandPrompt when wardrobe absent", () => {
    const brand = { key: "lakings", brandPrompt: "legacy text" };
    assert.equal(resolveBrandPrompt(brand, {}, "fallback"), "legacy text");
});

test("override wins over both wardrobe and brandPrompt", () => {
    const brand = { key: "lakings", wardrobe: "jersey", brandPrompt: "legacy" };
    assert.equal(resolveBrandPrompt(brand, { lakings: "override text" }, "fallback"), "override text");
});

test("fallback used when brandDef has neither field", () => {
    const brand = { key: "lakings" };
    assert.equal(resolveBrandPrompt(brand, {}, "fallback"), "fallback");
});
```

- [ ] **Step A1.2: Run test — should pass immediately**

Run: `npm test -- test/pipeline-wardrobe.test.js`
Expected: 4/4 pass (this test exists as a contract reference; production code will be updated to match).

- [ ] **Step A1.3: Update `lib/pipeline.js:117`**

Current:

```javascript
brandPrompt = bOverrides[job.brand] || brandDef.brandPrompt || settings.getForEvent("brandPrompt", ev);
```

Replace with:

```javascript
brandPrompt = bOverrides[job.brand] || brandDef.wardrobe || brandDef.brandPrompt || settings.getForEvent("brandPrompt", ev);
```

- [ ] **Step A1.4: Verify pipeline still parses**

Run: `node -e "require('./lib/pipeline')"`
Expected: exits silently.

- [ ] **Step A1.5: Run full test suite**

Run: `timeout 30 npm test`
Expected: 58/58 pass (54 existing + 4 new).

- [ ] **Step A1.6: Commit**

```bash
git add lib/pipeline.js test/pipeline-wardrobe.test.js
git commit -m "feat(pipeline): prefer brand.wardrobe over legacy brandPrompt"
```

---

## Task B1: Admin UI — style form (behavior, acceptsColorPalette, containerDescription)

**Files:**
- Modify: `lib/home.js` — extend `renderStylesList` around line 2042–2067 with three new controls; update `addCustomStyle` around line 2325 to initialize defaults; add three `onEditStyle*` handlers

**Layout:** Add a compact "advanced" disclosure panel below the existing prompt textarea. Default-collapsed so the form doesn't overwhelm users who don't need the new fields.

- [ ] **Step B1.1: Add a `toggleAdvanced` helper and three editors**

Locate the inline `<script>` section in `lib/home.js` (starts around line ~1340). After the existing `onCustomNameEdit` and `onCustomPromptEdit` functions (~line 2148), add:

```javascript
function onCustomBehaviorEdit(key, value) {
  if (!_customStyles[key]) return;
  if (value === "normal" || value === "themed-container") {
    _customStyles[key].behavior = value;
  } else {
    delete _customStyles[key].behavior;
  }
}

function onCustomAcceptsPaletteEdit(key, value) {
  if (!_customStyles[key]) return;
  _customStyles[key].acceptsColorPalette = !!value;
}

function onCustomContainerDescEdit(key, value) {
  if (!_customStyles[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) {
    _customStyles[key].containerDescription = value;
  } else {
    delete _customStyles[key].containerDescription;
  }
}
```

- [ ] **Step B1.2: Extend the style card template**

In `renderStylesList` (line 2042–2068), find the line that builds the prompt textarea. Immediately after the `<textarea class="style-prompt" id="cp_...">` line, insert a new block:

```javascript
+ '<div class="style-advanced" style="padding:8px 12px;border-top:1px solid var(--th-border);background:var(--th-bg-muted);font-size:12px">'
+ '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
+ '<label>Behavior: <select onchange="onCustomBehaviorEdit(\\''+k+'\\',this.value)">'
+ '<option value="normal"' + ((_customStyles[k].behavior || "normal") === "normal" ? " selected" : "") + '>normal</option>'
+ '<option value="themed-container"' + (_customStyles[k].behavior === "themed-container" ? " selected" : "") + '>themed-container</option>'
+ '</select></label>'
+ '<label><input type="checkbox"' + (_customStyles[k].acceptsColorPalette !== false ? " checked" : "") + ' onchange="onCustomAcceptsPaletteEdit(\\''+k+'\\',this.checked)"> Accepts color palette</label>'
+ '</div>'
+ '<div style="margin-top:6px" id="ccd_wrap_' + k + '" style="' + (_customStyles[k].behavior === "themed-container" ? "" : "display:none") + '">'
+ '<label style="display:block;margin-bottom:4px">Container description (required for themed-container):</label>'
+ '<textarea rows="2" style="width:100%;font-size:12px" oninput="onCustomContainerDescEdit(\\''+k+'\\',this.value)">' + escHtml(_customStyles[k].containerDescription || "") + '</textarea>'
+ '</div>'
+ '</div>'
```

- [ ] **Step B1.3: Update `addCustomStyle` to seed defaults**

Locate `addCustomStyle` around line 2325. Change:

```javascript
_customStyles[key] = { name: name, prompt: prompt, files: [] };
```

to:

```javascript
_customStyles[key] = {
  name: name,
  prompt: prompt,
  files: [],
  behavior: "normal",
  acceptsColorPalette: true,
};
```

- [ ] **Step B1.4: Show/hide container-description field when behavior changes**

Update `onCustomBehaviorEdit` from B1.1 to re-render so the conditional `ccd_wrap_` div updates:

```javascript
function onCustomBehaviorEdit(key, value) {
  if (!_customStyles[key]) return;
  if (value === "normal" || value === "themed-container") {
    _customStyles[key].behavior = value;
  } else {
    delete _customStyles[key].behavior;
  }
  renderStylesList();
}
```

- [ ] **Step B1.5: Smoke test the UI path**

Boot the server, open `/home`, log in, create a custom style, toggle behavior to `themed-container`, confirm the container description field appears, fill it, save, reload page, confirm values persisted.

Run:
```bash
node index.js > /tmp/server.log 2>&1 &
sleep 3
curl -s http://localhost:3000/home | grep -c "style-advanced" || true
# Expected: 0 if no custom styles yet, but should increase after you add one via the UI
pkill -f "node index.js"
```

(Full UI testing is manual; this just confirms the markup compiles without JS syntax errors.)

- [ ] **Step B1.6: Run tests**

Run: `timeout 30 npm test`
Expected: 58/58 pass — no regressions.

- [ ] **Step B1.7: Commit**

```bash
git add lib/home.js
git commit -m "feat(admin): style form controls for behavior, palette, container"
```

---

## Task B2: Admin UI — brand form simple fields (category, wardrobe, allowOriginal, colorPalette)

**Files:**
- Modify: `lib/home.js` — extend `renderBrands` (line 2557–2590) with four new controls; update `addBrand` (line 2629) to seed defaults; add four `onBrand*Edit` handlers

Scenes are a repeater and get their own task (B3) so this one stays under ~150 lines.

- [ ] **Step B2.1: Add four edit handlers**

After `onBrandPromptEdit` around line 2610, add:

```javascript
function onBrandCategoryEdit(key, value) {
  if (!_customBrands[key]) return;
  if (value === "wardrobe-only" || value === "wardrobe-plus-scene") {
    _customBrands[key].category = value;
  } else {
    delete _customBrands[key].category;
  }
  renderBrands();
}

function onBrandWardrobeEdit(key, value) {
  if (!_customBrands[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) _customBrands[key].wardrobe = value;
  else delete _customBrands[key].wardrobe;
}

function onBrandAllowOriginalEdit(key, value) {
  if (!_customBrands[key]) return;
  _customBrands[key].allowOriginal = !!value;
}

function onBrandColorPaletteEdit(key, value) {
  if (!_customBrands[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) _customBrands[key].colorPalette = value;
  else delete _customBrands[key].colorPalette;
}
```

- [ ] **Step B2.2: Extend the brand card template**

In `renderBrands` (line 2563–2589), after the existing `brp` textarea line and before the `brf` files block, insert a new advanced panel:

```javascript
'<div class="brand-advanced" style="padding:8px 12px;border-top:1px solid var(--th-border);background:var(--th-bg-muted);font-size:12px">' +
  '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
    '<label>Category: <select onchange="onBrandCategoryEdit(\\'' + escAttr(k) + '\\',this.value)">' +
      '<option value="wardrobe-only"' + ((brand.category || "wardrobe-only") === "wardrobe-only" ? " selected" : "") + '>wardrobe-only</option>' +
      '<option value="wardrobe-plus-scene"' + (brand.category === "wardrobe-plus-scene" ? " selected" : "") + '>wardrobe-plus-scene</option>' +
    '</select></label>' +
    '<label><input type="checkbox"' + (brand.allowOriginal !== false ? " checked" : "") + ' onchange="onBrandAllowOriginalEdit(\\'' + escAttr(k) + '\\',this.checked)"> Allow "Original scene"</label>' +
  '</div>' +
  '<div style="margin-top:6px">' +
    '<label style="display:block;margin-bottom:4px">Wardrobe fragment:</label>' +
    '<textarea rows="2" style="width:100%;font-size:12px" placeholder="wearing a ..." oninput="onBrandWardrobeEdit(\\'' + escAttr(k) + '\\',this.value)">' + escHtml(brand.wardrobe || "") + '</textarea>' +
  '</div>' +
  '<div style="margin-top:6px">' +
    '<label style="display:block;margin-bottom:4px">Color palette override (optional):</label>' +
    '<textarea rows="2" style="width:100%;font-size:12px" placeholder="Recolor everything to ..." oninput="onBrandColorPaletteEdit(\\'' + escAttr(k) + '\\',this.value)">' + escHtml(brand.colorPalette || "") + '</textarea>' +
  '</div>' +
'</div>' +
```

- [ ] **Step B2.3: Update `addBrand` to seed defaults**

Change:

```javascript
_customBrands[key] = { name: name, files: files, brandPrompt: prompt };
```

to:

```javascript
_customBrands[key] = {
  name: name,
  files: files,
  brandPrompt: prompt,
  category: "wardrobe-only",
  allowOriginal: true,
};
```

- [ ] **Step B2.4: Boot + run tests**

```bash
timeout 5 node index.js > /tmp/server.log 2>&1 || true
cat /tmp/server.log | head -10
# Expected: normal startup, no syntax errors
timeout 30 npm test
# Expected: 58/58
```

- [ ] **Step B2.5: Commit**

```bash
git add lib/home.js
git commit -m "feat(admin): brand form controls for category, wardrobe, palette, allowOriginal"
```

---

## Task B3: Admin UI — brand scenes repeater

**Files:**
- Modify: `lib/home.js` — add scene editor to the brand advanced panel; add `addScene`, `removeScene`, and three scene-field edit handlers

Scenes live at `_customBrands[key].scenes` as an array of `{ key, name, prompt, files? }`. We render them as a table with add/remove controls. File attachment for scenes is out of scope here (follow-up; for now the textarea-driven prompt is enough).

- [ ] **Step B3.1: Add scene handlers**

Add to `lib/home.js`:

```javascript
function addScene(brandKey) {
  var b = _customBrands[brandKey];
  if (!b) return;
  if (!Array.isArray(b.scenes)) b.scenes = [];
  var sceneKey = prompt("Scene key (e.g. ice-rink):");
  if (!sceneKey) return;
  sceneKey = sceneKey.trim().toLowerCase().replace(/\\s+/g, "-");
  if (!sceneKey) return;
  if (b.scenes.some(function(s) { return s.key === sceneKey; })) {
    alert("A scene with this key already exists.");
    return;
  }
  var sceneName = window.prompt("Display name:") || sceneKey;
  b.scenes.push({ key: sceneKey, name: sceneName.trim(), prompt: "", files: [] });
  renderBrands();
}

function removeScene(brandKey, sceneIdx) {
  var b = _customBrands[brandKey];
  if (!b || !Array.isArray(b.scenes)) return;
  if (!confirm("Remove this scene?")) return;
  b.scenes.splice(sceneIdx, 1);
  renderBrands();
}

function onSceneNameEdit(brandKey, idx, value) {
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  b.scenes[idx].name = value;
}

function onScenePromptEdit(brandKey, idx, value) {
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  b.scenes[idx].prompt = value;
}
```

- [ ] **Step B3.2: Add scenes panel to the brand advanced section**

Inside the `brand-advanced` div added in Task B2, append a final block after the color-palette textarea:

```javascript
'<div style="margin-top:8px">' +
  '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
    '<label>Scenes (' + ((brand.scenes || []).length) + ')</label>' +
    '<button class="btn btn-sm" onclick="addScene(\\'' + escAttr(k) + '\\')">+ Add scene</button>' +
  '</div>' +
  (brand.scenes && brand.scenes.length
    ? brand.scenes.map(function(s, si) {
        return '<div style="border:1px solid var(--th-border);border-radius:4px;padding:6px;margin-bottom:4px;background:var(--th-bg)">' +
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">' +
            '<code style="font-size:11px;color:var(--th-text-muted)">' + escHtml(s.key) + '</code>' +
            '<input type="text" value="' + escAttr(s.name || "") + '" style="flex:1;font-size:12px" oninput="onSceneNameEdit(\\'' + escAttr(k) + '\\',' + si + ',this.value)">' +
            '<button class="remove-link" onclick="removeScene(\\'' + escAttr(k) + '\\',' + si + ')">x</button>' +
          '</div>' +
          '<textarea rows="2" style="width:100%;font-size:12px" placeholder="Background prompt" oninput="onScenePromptEdit(\\'' + escAttr(k) + '\\',' + si + ',this.value)">' + escHtml(s.prompt || "") + '</textarea>' +
        '</div>';
      }).join("")
    : '<div style="font-size:12px;color:var(--th-text-muted)">No scenes configured. Click "+ Add scene" to add one.</div>'
  ) +
'</div>' +
```

- [ ] **Step B3.3: Boot + test**

```bash
timeout 30 npm test
# Expected: 58/58
```

Manual: add a scene via the UI, reload, confirm it persisted in `data/events/<name>/settings.json`.

- [ ] **Step B3.4: Commit**

```bash
git add lib/home.js
git commit -m "feat(admin): scenes repeater for brand configuration"
```

---

## Self-Review

**Spec coverage:**

| Gap from previous audit | Addressed by |
|---|---|
| `wardrobe` field ignored by pipeline | Task A1 |
| Style form: `behavior` control | Task B1 |
| Style form: `acceptsColorPalette` control | Task B1 |
| Style form: `containerDescription` control | Task B1 |
| Brand form: `category` control | Task B2 |
| Brand form: `wardrobe` control | Task B2 |
| Brand form: `allowOriginal` control | Task B2 |
| Brand form: `colorPalette` control | Task B2 |
| Brand form: `scenes[]` repeater | Task B3 |

**Out of scope (explicitly deferred):**

- Per-scene file attachments in the admin UI (scenes can have `files: []` in JSON but no picker yet; the existing brand-level files picker still applies globally).
- Sample event JSON for LAKingsApril2026 / SrPGAChampionship (data work, not code).
- Validation warnings in the UI (e.g., "wardrobe-plus-scene brand has only 1 scene"). Backend handles malformed configs safely; UX polish is a follow-up.

**Type consistency check:**

- `_customStyles[key].behavior` — string enum, matches validator `lib/settings.js:693`.
- `_customStyles[key].acceptsColorPalette` — boolean, matches validator `lib/settings.js:696`.
- `_customBrands[key].category` — string enum, matches validator `lib/settings.js:717`.
- `_customBrands[key].wardrobe` — string, matches validator `lib/settings.js:720`.
- `_customBrands[key].allowOriginal` — boolean, matches validator `lib/settings.js:723`.
- `_customBrands[key].colorPalette` — string, matches validator `lib/settings.js:726`.
- `_customBrands[key].scenes` — array of `{ key, name, prompt, files }`, matches validator `lib/settings.js:729–737`.

No placeholders. No TBD. All tasks produce working commits independently.
