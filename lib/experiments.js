// lib/experiments.js
// Prompt experiment tracker — standalone runner, storage, and Express mount.
// See docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md
//
// This module is intentionally self-contained: all experiment state lives under
// data/experiments/ and nothing in the production pipeline reads from it. A
// failure here must never affect live SMS generation.

const crypto = require("node:crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const express = require("express");
const { getOpenAI, getModels } = require("./config");
const { toFile } = require("openai");
const { analyzeScene, parseScene, withRetry } = require("./helpers");
const settings = require("./settings");
const promptBuilder = require("./prompt-builder");
const { getActiveBrands } = require("./brands");
const { userBarSnippet, magicHatSnippet } = require("./auth");

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
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
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
            catch (err) { console.warn(`[experiments] Skipping malformed manifest in ${d.name}: ${err.message}`); }
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
    const reps = Math.max(1, Number(config.reps) || 1);
    const entries = [];
    for (const photo of config.photos) {
        for (const style of config.styles) {
            for (const brand of config.brands) {
                for (const background of config.backgrounds) {
                    for (const variant of config.variants) {
                        for (let rep = 1; rep <= reps; rep++) {
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
    const slug = String(name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 60)
        .replace(/-$/, "");
    return `${ts}_${slug || "experiment"}`;
}

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
    const tmp = PHOTOS_JSON + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, PHOTOS_JSON);
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
    entry.sceneDescription = sceneDescription ?? null;
    entry.parsedScene = parsedScene ?? null;
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

// ── Runner ──────────────────────────────────────────────────────────────────

// Tracks which entries have already been retried this session. Kept out of
// the entry object so it never gets serialized into the persisted manifest.
const retriedEntries = new WeakSet();

// runEntry is parameterized on `deps` so tests can mock OpenAI + builder.
// In production, mountExperiments wires the real dependencies in.
async function runEntry(entry, manifest, deps) {
    entry.status = "running";
    // Keep startedAt from the first attempt so retried entries show total wall time.
    entry.startedAt = entry.startedAt || new Date().toISOString();
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
        if (!retriedEntries.has(entry)) {
            retriedEntries.add(entry);
            console.log(`[experiments] Retrying entry ${entry.outputPath} after error: ${err.message}`);
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
        for (const entry of m.entries || []) {
            if (entry.status === "running" || entry.status === "pending") {
                entry.status = "failed";
                entry.error = "server restarted";
                entry.completedAt = new Date().toISOString();
            }
        }
        m.status = "failed";
        await saveManifest(m);
        console.log(`[experiments] Recovered stale experiment ${m.id}`);
    }
}

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
        const base = activeStyles[entry.style];
        if (base) {
            styleObj = base;
            stylePrompt = base.prompt;
        } else {
            // Style was disabled or removed after experiment was created.
            // Return a sentinel so prompt-builder consumers can still operate.
            styleObj = { name: entry.style, core: "", brandCore: "", acceptsColorPalette: true };
            stylePrompt = "";
        }
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

async function defaultBuildPromptForEntry(entry, manifest, photosSnapshot) {
    const photos = photosSnapshot || (await loadPhotos());
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

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

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
  .card { background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .btn { display: inline-block; background: var(--brand-red); color: white; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 14px; }
  .btn-secondary { background: var(--th-card); color: var(--th-text); border: 1px solid var(--th-card-border); }
  .muted { color: var(--th-text-muted); font-size: 13px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill-running { background: #fef3c7; color: #92400e; }
  .pill-completed { background: #d1fae5; color: #065f46; }
  .pill-failed { background: #fee2e2; color: #991b1b; }
  input, select, textarea { background: var(--th-card); color: var(--th-text); border: 1px solid var(--th-card-border); padding: 8px; border-radius: 6px; font-family: inherit; font-size: 14px; }
  a { color: var(--brand-red); }
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

function buildRouter() {
    const router = express.Router();

    router.get("/", async (req, res) => {
        const manifests = await listManifests();
        const running = manifests.filter((m) => m.status === "running");
        const recent = manifests.filter((m) => m.status !== "running").slice(0, 25);

        const card = (m) => {
            const totals = m.entries.reduce((acc, e) => {
                acc.total++;
                if (e.status === "completed") acc.done++;
                else if (e.status === "failed") acc.failed++;
                return acc;
            }, { total: 0, done: 0, failed: 0 });
            const { done, failed, total } = totals;
            const pill = `<span class="pill pill-${m.status}">${m.status}</span>`;
            const cost = m.totalCostUsd ? `$${m.totalCostUsd.toFixed(2)}` : "";
            return `<div class="card"><div class="row">
              <div>
                <a href="/eval/run/${encodeURIComponent(m.id)}"><strong>${escapeHtml(m.name)}</strong></a> ${pill}
                <div class="muted">${escapeHtml(new Date(m.createdAt).toLocaleString())} · ${done}/${total} done${failed ? ` · ${failed} failed` : ""}${cost ? ` · ${cost}` : ""}</div>
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

    router.get("/new", async (req, res) => {
        const activeStyles = settings.getActiveStyles();
        const activeBrands = getActiveBrands();
        const photos = (await loadPhotos()).photos;

        const styleOptions = Object.entries(activeStyles).map(([k, s]) =>
            `<label><input type="checkbox" name="styles" value="${escapeHtml(k)}"> ${escapeHtml(s.name)}</label>`).join("<br>");
        const brandOptions = [`<label><input type="checkbox" name="brands" value=""> (no brand)</label>`]
            .concat(Object.entries(activeBrands).map(([k, b]) =>
                `<label><input type="checkbox" name="brands" value="${escapeHtml(k)}"> ${escapeHtml(b.name || k)}</label>`)).join("<br>");
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
              f.querySelector("button[type=submit]").disabled = true;
              const data = {
                  name: f.name.value,
                  styles: [...f.querySelectorAll("[name=styles]:checked")].map(x => x.value),
                  brands: [...f.querySelectorAll("[name=brands]:checked")].map(x => x.value || null),
                  backgrounds: [...f.querySelectorAll("[name=backgrounds]:checked")].map(x => x.value || null),
                  photos: [...f.querySelectorAll("[name=photos]:checked")].map(x => x.value),
                  reps: parseInt(f.reps.value, 10) || 3,
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

    router.get("/run/:id", async (req, res) => {
        let manifest;
        try { manifest = await loadManifest(req.params.id); }
        catch (err) {
            if (err.code === "ENOENT") return res.status(404).send("Not found");
            throw err;
        }

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
                            return `<div style="width:180px;height:240px;background:var(--th-card);border:1px dashed var(--th-card-border);border-radius:6px;display:flex;align-items:center;justify-content:center;">${escapeHtml(e.status)}</div>`;
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
          <p class="muted">${escapeHtml(new Date(manifest.createdAt).toLocaleString())} · ${manifest.entries.length} entries${manifest.totalCostUsd ? ` · $${manifest.totalCostUsd.toFixed(2)}` : ""}</p>
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
            const photosSnapshot = await loadPhotos();
            const deps = {
                flushManifest: saveManifest,
                buildPromptForEntry: (entry, manifest) => defaultBuildPromptForEntry(entry, manifest, photosSnapshot),
                callImageEdit: defaultCallImageEdit,
                ensurePhotoSceneCache: defaultEnsurePhotoSceneCache,
            };
            runExperiment(manifest, deps).catch((err) => {
                console.error(`[experiments] Experiment ${id} crashed: ${err.message}`);
                manifest.status = "failed";
                // If this write also fails (e.g., disk full), the manifest stays in
                // "running" until recoverStaleExperiments() runs at next server startup.
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
        } catch (err) { res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.message }); }
    });

    router.delete("/api/runs/:id", async (req, res) => {
        try {
            await fsp.rm(experimentDir(req.params.id), { recursive: true, force: true });
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get("/api/photos", async (req, res) => {
        try { res.json(await loadPhotos()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Raw JPEG upload — body is the image bytes, filename in query string.
    // Keeps the route dependency-free (no multer). Max 8MB.
    router.post("/api/photos", express.raw({ type: "image/jpeg", limit: "8mb" }), async (req, res) => {
        try {
            const rawFilename = req.query.filename ? String(req.query.filename) : "";
            if (!/^[A-Za-z0-9._-]+\.(jpe?g)$/i.test(rawFilename)) {
                return res.status(400).json({ error: "filename must match [A-Za-z0-9._-]+\\.(jpg|jpeg)" });
            }
            const filename = rawFilename;
            const displayName = req.query.displayName ? String(req.query.displayName) : filename;
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
                console.warn(`[experiments] Scene analysis failed for ${filename}: ${err.message}`);
            }
            res.json(added);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete("/api/photos/:name", async (req, res) => {
        try {
            const name = req.params.name;
            if (!/^[A-Za-z0-9._-]+\.(jpe?g)$/i.test(name)) {
                return res.status(400).json({ error: "invalid filename" });
            }
            if (await isPhotoInUseByRunning(name)) {
                return res.status(409).json({ error: "Photo is in use by a running experiment" });
            }
            await removePhoto(name);
            res.json({ ok: true });
        } catch (err) {
            if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Static PNG serving. Scope tightly — only expose experiment dirs.
    router.get("/images/:id/:file", (req, res) => {
        const safeId = String(req.params.id).replace(/[^A-Za-z0-9._:-]/g, "");
        const safeFile = String(req.params.file).replace(/[^A-Za-z0-9._-]/g, "");
        if (!safeFile.endsWith(".png")) return res.status(400).end();
        const fp = path.join(experimentDir(safeId), safeFile);
        // path.join normalizes `..` segments; startsWith then rejects anything
        // that escaped the experiments tree.
        if (!fp.startsWith(EXPERIMENTS_DIR)) return res.status(400).end();
        res.sendFile(fp, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    });

    return router;
}

module.exports = {
    // constants
    EXPERIMENTS_DIR, TEST_PHOTOS_DIR, PHOTOS_JSON,
    MAX_CONCURRENT, MAX_RETRIES, MAX_ENTRIES_PER_EXPERIMENT, MAX_VARIANTS_PER_EXPERIMENT, COST_PER_IMAGE_USD,
    // helpers
    ensureDirs, experimentDir, manifestPath,
    loadManifest, saveManifest, listManifests,
    buildEntries, makeId,
    loadPhotos, savePhotos, addPhoto, updatePhotoScene, removePhoto, isPhotoInUseByRunning,
    runEntry, runExperiment, recoverStaleExperiments,
    buildRouter, resolveEntryInputs,
    defaultBuildPromptForEntry, defaultCallImageEdit, defaultEnsurePhotoSceneCache,
};
