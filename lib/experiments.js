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
const VARIANTS_JSON = path.join(EXPERIMENTS_DIR, "variants.json");
const SETTINGS_JSON = path.join(EXPERIMENTS_DIR, "settings.json");

const DEFAULT_MAX_CONCURRENT = 30;
const MIN_CONCURRENT = 1;
const MAX_CONCURRENT_CAP = 60;
const MAX_CONCURRENT = DEFAULT_MAX_CONCURRENT; // legacy export, kept for tests
const MAX_RETRIES = 1;
const MAX_ENTRIES_PER_EXPERIMENT = 500;
const MAX_VARIANTS_PER_EXPERIMENT = 10;
const COST_PER_IMAGE_USD = 0.19;

function clampConcurrent(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_MAX_CONCURRENT;
    return Math.max(MIN_CONCURRENT, Math.min(MAX_CONCURRENT_CAP, v));
}

async function loadEvalSettings() {
    try {
        const raw = await fsp.readFile(SETTINGS_JSON, "utf8");
        const data = JSON.parse(raw);
        return { maxConcurrent: clampConcurrent(data.maxConcurrent ?? DEFAULT_MAX_CONCURRENT) };
    } catch (err) {
        if (err.code === "ENOENT") return { maxConcurrent: DEFAULT_MAX_CONCURRENT };
        throw err;
    }
}

async function saveEvalSettings(data) {
    const out = { maxConcurrent: clampConcurrent(data.maxConcurrent) };
    const tmp = `${SETTINGS_JSON}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
    await fsp.rename(tmp, SETTINGS_JSON);
    return out;
}

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

// ── Saved variant library ──────────────────────────────────────────────────

async function loadSavedVariants() {
    try {
        const raw = await fsp.readFile(VARIANTS_JSON, "utf8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") return { variants: [] };
        throw err;
    }
}

async function saveSavedVariants(data) {
    const tmp = `${VARIANTS_JSON}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, VARIANTS_JSON);
}

async function addSavedVariant({ name, description, overrides }) {
    if (!name || typeof name !== "string") throw new Error("Variant name is required");
    if (!overrides || typeof overrides !== "object") throw new Error("Variant overrides are required");
    const data = await loadSavedVariants();
    if (data.variants.find((v) => v.name === name)) throw new Error(`Variant "${name}" already exists`);
    data.variants.push({
        name,
        description: description || "",
        overrides,
        createdAt: new Date().toISOString(),
    });
    await saveSavedVariants(data);
    return data.variants[data.variants.length - 1];
}

async function updateSavedVariant(name, { description, overrides }) {
    const data = await loadSavedVariants();
    const entry = data.variants.find((v) => v.name === name);
    if (!entry) throw new Error(`Variant "${name}" not found`);
    if (description !== undefined) entry.description = description || "";
    if (overrides !== undefined) entry.overrides = overrides;
    entry.updatedAt = new Date().toISOString();
    await saveSavedVariants(data);
    return entry;
}

async function removeSavedVariant(name) {
    const data = await loadSavedVariants();
    const idx = data.variants.findIndex((v) => v.name === name);
    if (idx === -1) throw new Error(`Variant "${name}" not found`);
    data.variants.splice(idx, 1);
    await saveSavedVariants(data);
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

    const cap = clampConcurrent(manifest.config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    const inFlight = new Set();
    for (const entry of manifest.entries) {
        while (inFlight.size >= cap) {
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

function evalNav(active) {
    const tab = (key, label, href) =>
        `<a href="${href}" class="${active === key ? "active" : ""}">${label}</a>`;
    return `<div class="nav-tabs">
      <a href="/" class="nav-home" title="Back to home">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg>
        <span>Home</span>
      </a>
      <span class="nav-sep" aria-hidden="true"></span>
      ${tab("runs", "Runs", "/eval")}
      ${tab("new", "New run", "/eval/new")}
      ${tab("photos", "Photos", "/eval/photos")}
      ${tab("variants", "Saved variants", "/eval/variants")}
    </div>`;
}

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
  body { background: var(--th-bg); color: var(--th-text); font-family: 'Twilio Sans Text', system-ui, sans-serif; padding: 32px 24px 80px; line-height: 1.5; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 32px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 28px 0 10px; color: var(--th-text-muted); }
  h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  p { margin-bottom: 8px; }
  .subtitle { color: var(--th-text-muted); font-size: 14px; margin-bottom: 24px; }
  .card { background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 10px; padding: 20px; margin-bottom: 14px; }
  .card-compact { padding: 14px 16px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .row-top { align-items: flex-start; }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .stack-lg { display: flex; flex-direction: column; gap: 20px; }
  .cluster { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .btn { display: inline-flex; align-items: center; gap: 6px; background: var(--brand-red); color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 14px; font-family: inherit; line-height: 1; transition: filter 0.15s, transform 0.05s; }
  .btn:hover { filter: brightness(1.08); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: transparent; color: var(--th-text); border: 1px solid var(--th-card-border); }
  .btn-secondary:hover { background: var(--th-card-border); filter: none; }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .btn-danger { background: transparent; color: #ef4444; border: 1px solid #ef4444; }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.1); filter: none; }
  .muted { color: var(--th-text-muted); font-size: 13px; }
  .small { font-size: 12px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; vertical-align: middle; }
  .pill-running { background: #fef3c7; color: #92400e; }
  .pill-completed { background: #d1fae5; color: #065f46; }
  .pill-failed { background: #fee2e2; color: #991b1b; }
  .pill-pending { background: var(--th-card-border); color: var(--th-text-muted); }
  input[type=text], input[type=number], input[type=file], input:not([type]), select, textarea { width: 100%; background: var(--th-bg); color: var(--th-text); border: 1px solid var(--th-card-border); padding: 10px 12px; border-radius: 6px; font-family: inherit; font-size: 14px; transition: border-color 0.15s, box-shadow 0.15s; }
  input[type=text]:focus, input[type=number]:focus, input:not([type]):focus, select:focus, textarea:focus { outline: none; border-color: var(--brand-red); box-shadow: 0 0 0 3px rgba(244, 49, 60, 0.15); }
  textarea { font-family: 'Twilio Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace; line-height: 1.5; resize: vertical; }
  input[type=checkbox] { accent-color: var(--brand-red); width: 16px; height: 16px; vertical-align: middle; margin-right: 6px; }
  label { display: block; font-size: 13px; color: var(--th-text-muted); margin-bottom: 12px; }
  label.inline { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; margin-bottom: 6px; font-size: 14px; color: var(--th-text); cursor: pointer; }
  label.inline input[type=checkbox] { margin-right: 0; }
  label .label-text { display: block; margin-bottom: 6px; font-weight: 500; color: var(--th-text); font-size: 13px; }
  label .label-hint { display: block; font-size: 12px; color: var(--th-text-muted); margin-bottom: 6px; font-weight: normal; }
  fieldset { border: 1px solid var(--th-card-border); border-radius: 8px; padding: 14px 16px 16px; margin-bottom: 4px; }
  fieldset legend { font-size: 13px; font-weight: 600; padding: 0 8px; color: var(--th-text); }
  fieldset .legend-hint { font-size: 12px; color: var(--th-text-muted); margin-bottom: 10px; font-weight: normal; }
  .options-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 12px; }
  details.override-block { border: 1px solid var(--th-card-border); border-radius: 6px; padding: 10px 12px; background: var(--th-bg); }
  details.override-block summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 2px 0; }
  details.override-block summary::marker { color: var(--th-text-muted); }
  details.override-block[open] { padding-bottom: 12px; }
  a { color: var(--brand-red); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .err { color: #ef4444; font-size: 13px; margin-top: 8px; min-height: 18px; }
  .code { font-family: 'Twilio Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; background: var(--th-bg); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--th-card-border); }
  .divider { height: 1px; background: var(--th-card-border); margin: 16px 0; }
  .nav-tabs { display: flex; gap: 4px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
  .nav-tabs a { padding: 8px 14px; border-radius: 6px; color: var(--th-text-muted); font-size: 14px; font-weight: 500; }
  .nav-tabs a.active { background: var(--th-card); color: var(--th-text); }
  .nav-tabs a:hover { background: var(--th-card); text-decoration: none; }
  .nav-tabs .nav-home { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; color: var(--th-text-muted); border: 1px solid var(--th-card-border); border-radius: 6px; }
  .nav-tabs .nav-home svg { width: 14px; height: 14px; }
  .nav-tabs .nav-home:hover { color: var(--th-text); border-color: var(--th-text-muted); background: transparent; }
  .nav-tabs .nav-sep { width: 1px; height: 20px; background: var(--th-card-border); margin: 0 6px; }
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
        const evalSettings = await loadEvalSettings();

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
            return `<a href="/eval/run/${encodeURIComponent(m.id)}" style="display:block;color:inherit;"><div class="card card-compact">
              <div class="row">
                <div>
                  <div style="font-weight:600;font-size:15px;margin-bottom:4px;">${escapeHtml(m.name)} ${pill}</div>
                  <div class="muted">${escapeHtml(new Date(m.createdAt).toLocaleString())} · ${done}/${total} done${failed ? ` · <span style="color:#ef4444;">${failed} failed</span>` : ""}${cost ? ` · ${cost}` : ""}</div>
                </div>
                <div class="muted small">→</div>
              </div>
            </div></a>`;
        };

        const body = `
          ${evalNav("runs")}
          <div class="row row-top" style="margin-bottom:24px;">
            <div>
              <h1>Prompt Experiments</h1>
              <div class="subtitle">Queue runs, compare variants side-by-side, mark winners.</div>
            </div>
            <a class="btn" href="/eval/new">+ New experiment</a>
          </div>
          <div class="card card-compact" style="margin-bottom:20px;">
            <div class="row" style="gap:16px;flex-wrap:wrap;">
              <div style="flex:1;min-width:240px;">
                <div style="font-weight:600;font-size:14px;margin-bottom:2px;">Default concurrency</div>
                <div class="muted small">How many image generations run in parallel for each new experiment. Override per run on the New experiment form. Range ${MIN_CONCURRENT}–${MAX_CONCURRENT_CAP}.</div>
              </div>
              <div class="cluster" style="gap:10px;">
                <input type="number" id="cc-input" min="${MIN_CONCURRENT}" max="${MAX_CONCURRENT_CAP}" value="${evalSettings.maxConcurrent}" style="width:90px;">
                <button class="btn btn-secondary btn-sm" id="cc-save">Save</button>
                <span id="cc-msg" class="muted small" aria-live="polite"></span>
              </div>
            </div>
          </div>
          ${running.length ? `<h2>Running</h2>${running.map(card).join("")}` : ""}
          <h2>Recent</h2>
          ${recent.length ? recent.map(card).join("") : `<div class="card"><p class="muted">No experiments yet. Click <strong>+ New experiment</strong> to start.</p></div>`}
          <script>
            if (${running.length}) setTimeout(() => location.reload(), 3000);
            (function () {
              const input = document.getElementById("cc-input");
              const btn = document.getElementById("cc-save");
              const msg = document.getElementById("cc-msg");
              btn.addEventListener("click", async () => {
                const n = Number(input.value);
                msg.textContent = "Saving…";
                btn.disabled = true;
                const r = await fetch("/eval/api/settings", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ maxConcurrent: n }),
                });
                btn.disabled = false;
                if (r.ok) { msg.textContent = "Saved"; setTimeout(() => msg.textContent = "", 1500); }
                else { const j = await r.json().catch(() => ({})); msg.textContent = j.error || "Save failed"; }
              });
            })();
          </script>
        `;
        res.type("html").send(pageShell({ title: "Experiments", body }));
    });

    router.get("/new", async (req, res) => {
        const activeStyles = settings.getActiveStyles();
        const activeBrands = getActiveBrands();
        const photos = (await loadPhotos()).photos;
        const savedVariants = (await loadSavedVariants()).variants;
        const evalSettings = await loadEvalSettings();

        const styleOptions = Object.entries(activeStyles).map(([k, s]) =>
            `<label class="inline"><input type="checkbox" name="styles" value="${escapeHtml(k)}"> ${escapeHtml(s.name)}</label>`).join("");
        const brandOptions = [`<label class="inline"><input type="checkbox" name="brands" value="" checked> (no brand)</label>`]
            .concat(Object.entries(activeBrands).map(([k, b]) =>
                `<label class="inline"><input type="checkbox" name="brands" value="${escapeHtml(k)}"> ${escapeHtml(b.name || k)}</label>`)).join("");
        const bgOptions = [
            `<label class="inline"><input type="checkbox" name="backgrounds" value="" checked> (style default)</label>`,
            `<label class="inline"><input type="checkbox" name="backgrounds" value="original"> Original scene</label>`,
            `<label class="inline"><input type="checkbox" name="backgrounds" value="plain-white"> Plain white</label>`,
        ].join("");
        const photoOptions = photos.length
            ? photos.map((p) =>
                `<label class="inline"><input type="checkbox" name="photos" value="${escapeHtml(p.filename)}"> ${escapeHtml(p.displayName || p.filename)}</label>`).join("")
            : `<p class="muted">No photos uploaded. <a href="/eval/photos">Upload one</a> first.</p>`;

        const stylesForJs = Object.fromEntries(Object.entries(activeStyles).map(([k, s]) => [k, { prompt: s.prompt || "", core: s.core || "", brandCore: s.brandCore || "" }]));
        const savedForJs = savedVariants.map((v) => ({ name: v.name, description: v.description || "", overrides: v.overrides || {} }));
        const savedOptions = savedVariants.length
            ? `<option value="">— Load a saved variant —</option>` + savedVariants.map((v) =>
                `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}${v.description ? ` — ${escapeHtml(v.description.slice(0, 60))}` : ""}</option>`).join("")
            : "";

        const body = `
          ${evalNav("new")}
          <h1>New experiment</h1>
          <div class="subtitle">Each variant you add becomes a row in the output grid — so you can compare prompts side-by-side on the same photos.</div>
          <form id="f" class="stack-lg">
            <div class="card">
              <label><span class="label-text">Name</span><input name="name" required placeholder="e.g. cartoon-length-v2"></label>
            </div>

            <fieldset>
              <legend>Styles</legend>
              <div class="legend-hint">Which style prompts to evaluate.</div>
              <div class="options-grid">${styleOptions}</div>
            </fieldset>

            <fieldset>
              <legend>Brands</legend>
              <div class="legend-hint">Leave <span class="code">(no brand)</span> checked to test without brand overlays.</div>
              <div class="options-grid">${brandOptions}</div>
            </fieldset>

            <fieldset>
              <legend>Backgrounds</legend>
              <div class="legend-hint">Leave <span class="code">(style default)</span> checked to use each style's built-in background.</div>
              <div class="options-grid">${bgOptions}</div>
            </fieldset>

            <fieldset>
              <legend>Photos</legend>
              <div class="legend-hint">Upload test photos via the <a href="/eval/photos">Photos</a> tab.</div>
              <div class="options-grid">${photoOptions}</div>
            </fieldset>

            <div class="card">
              <div class="row" style="gap:24px;flex-wrap:wrap;align-items:flex-start;">
                <label style="flex:1;min-width:220px;margin-bottom:0;"><span class="label-text">Reps per combination</span>
                  <span class="label-hint">gpt-image-2 is non-deterministic. 3 reps reveals how much variance a prompt has.</span>
                  <input type="number" name="reps" value="3" min="1" max="10" style="max-width:120px;">
                </label>
                <label style="flex:1;min-width:220px;margin-bottom:0;"><span class="label-text">Max concurrent generations</span>
                  <span class="label-hint">Parallel image-edit requests. Higher = faster but more rate-limit risk. Defaults to your global setting (currently ${evalSettings.maxConcurrent}).</span>
                  <input type="number" name="maxConcurrent" value="${evalSettings.maxConcurrent}" min="${MIN_CONCURRENT}" max="${MAX_CONCURRENT_CAP}" style="max-width:120px;">
                </label>
              </div>
            </div>

            <fieldset>
              <legend>Variants</legend>
              <div class="legend-hint">Each variant becomes a row in the output grid. <strong>live</strong> = your current production prompt. Custom variants let you tweak prompts and A/B test them.</div>
              <label class="inline"><input type="checkbox" name="includeLive" checked> Include <strong>live</strong> variant</label>
              <div id="customVariants" class="stack" style="margin-top:16px;"></div>
              <div class="cluster" style="margin-top:12px;">
                <button type="button" class="btn btn-secondary btn-sm" id="addVariant">+ Add custom variant</button>
                ${savedOptions ? `<select id="loadSaved" style="max-width:280px;">${savedOptions}</select>` : `<span class="muted small">No saved variants yet — create one below and click <strong>Save</strong> to reuse it.</span>`}
              </div>
            </fieldset>

            <div class="row">
              <button class="btn" type="submit">Run experiment</button>
              <div id="err" class="err"></div>
            </div>
          </form>
          <script>
          const LIVE_STYLES = ${JSON.stringify(stylesForJs)};
          const SAVED_VARIANTS = ${JSON.stringify(savedForJs)};
          let variantCounter = 0;
          function autogrow(ta) {
              ta.style.height = "auto";
              ta.style.height = Math.max(ta.scrollHeight + 2, 80) + "px";
          }
          function makeField(labelText, hint, styleKey, field, value, variantId, minH) {
              const lbl = document.createElement("label");
              lbl.style.cssText = "display:block;margin-top:10px;margin-bottom:0;";
              const name = document.createElement("span");
              name.className = "label-text";
              name.textContent = labelText;
              lbl.appendChild(name);
              if (hint) { const h = document.createElement("span"); h.className = "label-hint"; h.textContent = hint; lbl.appendChild(h); }
              const ta = document.createElement("textarea");
              ta.dataset.variant = variantId;
              ta.dataset.style = styleKey;
              ta.dataset.field = field;
              ta.style.minHeight = minH + "px";
              ta.value = value || "";
              ta.addEventListener("input", () => autogrow(ta));
              lbl.appendChild(ta);
              setTimeout(() => autogrow(ta), 0);
              return lbl;
          }
          function buildVariantBlock(preset) {
              // preset = { name, description, overrides } or null for "from current styles"
              const checkedStyles = [...document.querySelectorAll("[name=styles]:checked")].map(x => x.value);
              const stylesForBlock = preset && preset.overrides
                  ? [...new Set([...Object.keys(preset.overrides), ...checkedStyles])]
                  : checkedStyles;
              if (!stylesForBlock.length) {
                  document.getElementById("err").textContent = "Pick at least one style before adding a variant";
                  return null;
              }
              document.getElementById("err").textContent = "";
              const id = "v" + (++variantCounter);
              const block = document.createElement("div");
              block.className = "card";
              block.dataset.variant = id;

              const header = document.createElement("div");
              header.className = "row row-top";
              const headerLeft = document.createElement("div");
              headerLeft.style.flex = "1";
              const nameLbl = document.createElement("label");
              const nameTxt = document.createElement("span");
              nameTxt.className = "label-text";
              nameTxt.textContent = "Variant name";
              nameLbl.appendChild(nameTxt);
              const nameInput = document.createElement("input");
              nameInput.setAttribute("data-variant-name", id);
              nameInput.value = (preset && preset.name) || ("custom-" + variantCounter);
              nameLbl.appendChild(nameInput);
              headerLeft.appendChild(nameLbl);

              const descLbl = document.createElement("label");
              const descTxt = document.createElement("span");
              descTxt.className = "label-text";
              descTxt.textContent = "Description (optional)";
              descLbl.appendChild(descTxt);
              const descInput = document.createElement("input");
              descInput.setAttribute("data-variant-desc", id);
              descInput.value = (preset && preset.description) || "";
              descInput.placeholder = "e.g. shorter core, stricter face preservation";
              descLbl.appendChild(descInput);
              headerLeft.appendChild(descLbl);

              const btnCluster = document.createElement("div");
              btnCluster.className = "cluster";
              const saveBtn = document.createElement("button");
              saveBtn.type = "button";
              saveBtn.className = "btn btn-secondary btn-sm";
              saveBtn.textContent = "Save to library";
              saveBtn.addEventListener("click", () => saveVariantToLibrary(block, saveBtn));
              const removeBtn = document.createElement("button");
              removeBtn.type = "button";
              removeBtn.className = "btn btn-danger btn-sm";
              removeBtn.textContent = "Remove";
              removeBtn.addEventListener("click", () => block.remove());
              btnCluster.appendChild(saveBtn);
              btnCluster.appendChild(removeBtn);

              header.appendChild(headerLeft);
              header.appendChild(btnCluster);
              block.appendChild(header);

              const stylesWrap = document.createElement("div");
              stylesWrap.style.cssText = "margin-top:16px;display:flex;flex-direction:column;gap:10px;";
              stylesForBlock.forEach((sk) => {
                  const base = (preset && preset.overrides && preset.overrides[sk]) || LIVE_STYLES[sk] || { prompt: "", core: "", brandCore: "" };
                  const det = document.createElement("details");
                  det.className = "override-block";
                  det.open = stylesForBlock.length === 1;
                  const sum = document.createElement("summary");
                  sum.textContent = sk;
                  det.appendChild(sum);
                  det.appendChild(makeField("prompt", "The main style instruction sent to gpt-image-2.", sk, "prompt", base.prompt, id, 180));
                  det.appendChild(makeField("core", "The short style tag embedded in composed prompts.", sk, "core", base.core, id, 90));
                  det.appendChild(makeField("brandCore", "Short version used when a brand is present.", sk, "brandCore", base.brandCore, id, 90));
                  stylesWrap.appendChild(det);
              });
              block.appendChild(stylesWrap);
              document.getElementById("customVariants").appendChild(block);
              return block;
          }
          async function saveVariantToLibrary(block, btn) {
              const id = block.dataset.variant;
              const name = block.querySelector("[data-variant-name='" + id + "']").value.trim();
              const description = block.querySelector("[data-variant-desc='" + id + "']").value.trim();
              if (!name) { document.getElementById("err").textContent = "Variant needs a name before saving"; return; }
              const overrides = {};
              block.querySelectorAll("textarea[data-variant='" + id + "']").forEach((ta) => {
                  if (!overrides[ta.dataset.style]) overrides[ta.dataset.style] = {};
                  overrides[ta.dataset.style][ta.dataset.field] = ta.value;
              });
              btn.disabled = true;
              const orig = btn.textContent;
              btn.textContent = "Saving…";
              const r = await fetch("/eval/api/variants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, overrides }) });
              if (r.ok) { btn.textContent = "Saved"; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
              else {
                  const j = await r.json().catch(() => ({}));
                  if (r.status === 409 && confirm("Variant '" + name + "' already exists. Overwrite?")) {
                      const r2 = await fetch("/eval/api/variants/" + encodeURIComponent(name), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description, overrides }) });
                      if (r2.ok) { btn.textContent = "Updated"; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); return; }
                  }
                  document.getElementById("err").textContent = j.error || "Save failed";
                  btn.textContent = orig; btn.disabled = false;
              }
          }
          document.getElementById("addVariant").addEventListener("click", () => buildVariantBlock(null));
          const loadSaved = document.getElementById("loadSaved");
          if (loadSaved) loadSaved.addEventListener("change", (ev) => {
              const v = SAVED_VARIANTS.find((x) => x.name === ev.target.value);
              if (v) buildVariantBlock(v);
              ev.target.value = "";
          });
          document.getElementById("f").addEventListener("submit", async (e) => {
              e.preventDefault();
              const f = e.target;
              f.querySelector("button[type=submit]").disabled = true;
              const variants = [];
              if (f.includeLive.checked) variants.push({ name: "live", type: "live" });
              document.querySelectorAll("#customVariants > [data-variant]").forEach((block) => {
                  const id = block.dataset.variant;
                  const name = block.querySelector("[data-variant-name='" + id + "']").value.trim() || "custom";
                  const descEl = block.querySelector("[data-variant-desc='" + id + "']");
                  const description = descEl ? descEl.value.trim() : "";
                  const overrides = {};
                  block.querySelectorAll("textarea[data-variant='" + id + "']").forEach((ta) => {
                      const sk = ta.dataset.style;
                      if (!overrides[sk]) overrides[sk] = {};
                      overrides[sk][ta.dataset.field] = ta.value;
                  });
                  variants.push({ name, type: "custom", description, overrides });
              });
              const data = {
                  name: f.name.value,
                  styles: [...f.querySelectorAll("[name=styles]:checked")].map(x => x.value),
                  brands: [...f.querySelectorAll("[name=brands]:checked")].map(x => x.value || null),
                  backgrounds: [...f.querySelectorAll("[name=backgrounds]:checked")].map(x => x.value || null),
                  photos: [...f.querySelectorAll("[name=photos]:checked")].map(x => x.value),
                  reps: parseInt(f.reps.value, 10) || 3,
                  maxConcurrent: parseInt(f.maxConcurrent.value, 10),
                  variants,
              };
              if (!data.variants.length) { document.getElementById("err").textContent = "Pick at least one variant"; f.querySelector("button[type=submit]").disabled = false; return; }
              const r = await fetch("/eval/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
              const j = await r.json();
              if (r.ok) location.href = "/eval/run/" + encodeURIComponent(j.id);
              else { document.getElementById("err").textContent = j.error || "Request failed"; f.querySelector("button[type=submit]").disabled = false; }
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

        const totalsGlobal = manifest.entries.reduce((acc, e) => {
            acc.total++;
            if (e.status === "completed") acc.done++;
            else if (e.status === "failed") acc.failed++;
            return acc;
        }, { total: 0, done: 0, failed: 0 });

        const renderCombo = (key, entries) => {
            const [s, b, bg] = key.split("|");
            const title = `${s} × ${b === "null" ? "(no brand)" : b} × ${bg === "null" ? "(default bg)" : bg}`;
            const winnerOpts = ["<option value=''>— no winner —</option>"]
                .concat(variantNames.map((v) => `<option value="${escapeHtml(v)}" ${manifest.winners && manifest.winners[key] && manifest.winners[key].variant === v ? "selected" : ""}>${escapeHtml(v)}</option>`));
            const currentNotes = (manifest.winners && manifest.winners[key] && manifest.winners[key].notes) || "";
            const photoBlocks = photos.map((p) => {
                const rows = variantNames.map((vn) => {
                    const cells = entries.filter((e) => e.photo === p && e.variant === vn)
                        .sort((a, b) => a.rep - b.rep)
                        .map((e) => {
                            if (e.status === "completed") {
                                const imgUrl = `/eval/images/${encodeURIComponent(manifest.id)}/${encodeURIComponent(e.outputPath)}`;
                                return `<button type="button" class="img-tile" data-img="${imgUrl}" data-prompt-b64="${Buffer.from(e.promptText || "", "utf8").toString("base64")}" data-caption="${escapeHtml(vn + " · " + p + " · rep " + e.rep)}" style="border:none;padding:0;background:none;cursor:zoom-in;">
                                  <img src="${imgUrl}" width="180" style="border-radius:8px;display:block;box-shadow:0 2px 8px rgba(0,0,0,0.15);transition:transform 0.1s;">
                                </button>`;
                            }
                            if (e.status === "failed") return `<div class="tile-failed">${escapeHtml(e.error || "failed")}</div>`;
                            return `<div class="tile-pending"><span class="muted small">${escapeHtml(e.status)}</span></div>`;
                        }).join("");
                    return `<div class="variant-row"><strong class="variant-label">${escapeHtml(vn)}</strong><div class="variant-cells">${cells}</div></div>`;
                }).join("");
                return `<div class="photo-group"><div class="photo-label">${escapeHtml(p)}</div>${rows}</div>`;
            }).join("");
            return `<div class="card combo-card" data-combo="${escapeHtml(key)}">
              <div class="row combo-header">
                <div><h3 style="margin:0;">${escapeHtml(title)}</h3></div>
                <label style="margin:0;min-width:260px;"><span class="label-text">Winner</span><select data-combo-key="${escapeHtml(key)}">${winnerOpts.join("")}</select></label>
              </div>
              <label style="margin-top:8px;"><span class="label-text">Notes for this combination</span><textarea data-combo-notes="${escapeHtml(key)}" placeholder="e.g. live loses the sunglasses, custom-1 nails them but breaks the background…" style="min-height:60px;">${escapeHtml(currentNotes)}</textarea></label>
              <div class="photo-stack">${photoBlocks}</div>
            </div>`;
        };

        const combos = [...groups.entries()].map(([k, es]) => renderCombo(k, es)).join("");
        const running = manifest.status === "running";
        const body = `
          ${evalNav("runs")}
          <div class="row row-top" style="margin-bottom:8px;">
            <div>
              <h1>${escapeHtml(manifest.name)} <span class="pill pill-${manifest.status}">${manifest.status}</span></h1>
              <div class="subtitle">${escapeHtml(new Date(manifest.createdAt).toLocaleString())} · ${totalsGlobal.done}/${totalsGlobal.total} done${totalsGlobal.failed ? ` · <span style="color:#ef4444;">${totalsGlobal.failed} failed</span>` : ""}${manifest.totalCostUsd ? ` · $${manifest.totalCostUsd.toFixed(2)}` : ""}</div>
            </div>
            <a class="btn btn-secondary btn-sm" href="/eval">← All runs</a>
          </div>
          <div class="card">
            <label style="margin:0;"><span class="label-text">Experiment-wide notes</span><textarea id="runNotes" placeholder="What are you testing? What did you learn?" style="min-height:80px;">${escapeHtml(manifest.notes || "")}</textarea></label>
          </div>
          ${combos}

          <div id="imgModal" class="modal" style="display:none;">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
              <button type="button" class="modal-close" aria-label="Close">×</button>
              <div class="modal-body">
                <div class="modal-img-wrap"><img id="modalImg" alt=""></div>
                <div class="modal-side">
                  <div id="modalCaption" class="muted small" style="margin-bottom:8px;"></div>
                  <label style="margin:0;"><span class="label-text">Prompt</span><textarea id="modalPrompt" readonly style="min-height:340px;"></textarea></label>
                  <div class="cluster" style="margin-top:10px;">
                    <button type="button" class="btn btn-secondary btn-sm" id="modalCopy">Copy prompt</button>
                    <a class="btn btn-secondary btn-sm" id="modalOpen" target="_blank" rel="noopener">Open in new tab</a>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <style>
            .combo-card { padding: 20px; }
            .combo-header { gap: 20px; margin-bottom: 4px; }
            .photo-stack { margin-top: 16px; display: flex; flex-direction: column; gap: 20px; }
            .photo-group { border-top: 1px solid var(--th-card-border); padding-top: 14px; }
            .photo-label { font-weight: 600; font-size: 13px; color: var(--th-text-muted); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
            .variant-row { display: flex; gap: 12px; align-items: flex-start; padding: 6px 0; }
            .variant-label { flex: 0 0 120px; padding-top: 8px; font-size: 13px; color: var(--th-text); word-break: break-word; }
            .variant-cells { display: flex; gap: 10px; flex-wrap: wrap; }
            .img-tile:hover img { transform: scale(1.03); }
            .tile-failed { width:180px;height:240px;background:#fee2e2;color:#991b1b;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:12px;font-size:12px;text-align:center; }
            .tile-pending { width:180px;height:240px;background:var(--th-card);border:1px dashed var(--th-card-border);border-radius:8px;display:flex;align-items:center;justify-content:center; }
            .modal { position:fixed;inset:0;z-index:1000; }
            .modal-backdrop { position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px); }
            .modal-content { position:relative;margin:3vh auto;max-width:1200px;width:94vw;max-height:94vh;background:var(--th-card);border:1px solid var(--th-card-border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden;display:flex;flex-direction:column; }
            .modal-close { position:absolute;top:10px;right:14px;background:transparent;border:none;color:var(--th-text);font-size:28px;line-height:1;cursor:pointer;padding:4px 10px;border-radius:6px;z-index:2; }
            .modal-close:hover { background:var(--th-card-border); }
            .modal-body { display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:0;flex:1;min-height:0; }
            .modal-img-wrap { background:#000;display:flex;align-items:center;justify-content:center;overflow:auto;padding:12px; }
            .modal-img-wrap img { max-width:100%;max-height:88vh;object-fit:contain;border-radius:6px; }
            .modal-side { padding:20px;display:flex;flex-direction:column;overflow:auto;border-left:1px solid var(--th-card-border); }
            .modal-side textarea { flex:1; }
            @media (max-width: 880px) { .modal-body { grid-template-columns: 1fr; } .modal-img-wrap img { max-height: 50vh; } }
          </style>

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

          const modal = document.getElementById("imgModal");
          const modalImg = document.getElementById("modalImg");
          const modalPrompt = document.getElementById("modalPrompt");
          const modalCaption = document.getElementById("modalCaption");
          const modalOpen = document.getElementById("modalOpen");
          function openModal(url, promptText, caption) {
              modalImg.src = url;
              modalPrompt.value = promptText;
              modalCaption.textContent = caption;
              modalOpen.href = url;
              modal.style.display = "block";
              document.body.style.overflow = "hidden";
          }
          function closeModal() { modal.style.display = "none"; document.body.style.overflow = ""; modalImg.src = ""; }
          modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
          modal.querySelector(".modal-close").addEventListener("click", closeModal);
          document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && modal.style.display !== "none") closeModal(); });
          document.querySelectorAll(".img-tile").forEach((btn) => btn.addEventListener("click", () => {
              const promptText = atob(btn.dataset.promptB64 || "");
              openModal(btn.dataset.img, promptText, btn.dataset.caption);
          }));
          document.getElementById("modalCopy").addEventListener("click", async (ev) => {
              try { await navigator.clipboard.writeText(modalPrompt.value); const orig = ev.target.textContent; ev.target.textContent = "Copied"; setTimeout(() => { ev.target.textContent = orig; }, 1200); }
              catch { modalPrompt.select(); document.execCommand("copy"); }
          });
          </script>
        `;
        res.type("html").send(pageShell({ title: manifest.name, body }));
    });

    router.get("/photos", async (req, res) => {
        const photos = (await loadPhotos()).photos;
        const list = photos.map((p) => `
          <div class="card">
            <div class="row row-top" style="margin-bottom:8px;">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:15px;margin-bottom:2px;">${escapeHtml(p.displayName || p.filename)}</div>
                <div class="muted small">${escapeHtml(p.filename)} · ${escapeHtml(new Date(p.uploadedAt).toLocaleDateString())}</div>
              </div>
              <button class="btn btn-secondary btn-sm" data-del="${escapeHtml(p.filename)}">Delete</button>
            </div>
            ${p.sceneDescription ? `<div class="muted">${escapeHtml(p.sceneDescription.slice(0, 240))}${p.sceneDescription.length > 240 ? "…" : ""}</div>` : `<div class="muted small">(scene not analyzed)</div>`}
          </div>`).join("");
        const body = `
          ${evalNav("photos")}
          <div class="row row-top" style="margin-bottom:24px;">
            <div>
              <h1>Test photos</h1>
              <div class="subtitle">JPEGs used as selfies when running experiments. Scene description is cached after upload.</div>
            </div>
          </div>
          <div class="card">
            <h3 style="margin-bottom:12px;">Upload a photo</h3>
            <label>Photo file (JPEG)<input type="file" id="file" accept="image/jpeg" aria-label="Test photo file"></label>
            <label>Display name (optional)<input type="text" id="displayName" placeholder="e.g. Anthony" aria-label="Display name (optional)"></label>
            <div class="row">
              <div class="muted small" id="msg"></div>
              <button class="btn" id="upload">Upload</button>
            </div>
          </div>
          <h2>Library (${photos.length})</h2>
          ${list || '<div class="card"><p class="muted">No photos yet. Upload a JPEG above.</p></div>'}
          <script>
          document.getElementById("upload").addEventListener("click", async () => {
              const f = document.getElementById("file").files[0];
              const dn = document.getElementById("displayName").value;
              const msg = document.getElementById("msg");
              if (!f) { msg.textContent = "Pick a JPEG first"; return; }
              const qs = "?filename=" + encodeURIComponent(f.name) + (dn ? "&displayName=" + encodeURIComponent(dn) : "");
              msg.textContent = "Uploading (scene analysis may take a few seconds)…";
              document.getElementById("upload").disabled = true;
              const r = await fetch("/eval/api/photos" + qs, { method: "POST", headers: { "content-type": "image/jpeg" }, body: f });
              if (r.ok) location.reload();
              else {
                  const j = await r.json().catch(() => ({}));
                  msg.textContent = j.error || "Upload failed";
                  document.getElementById("upload").disabled = false;
              }
          });
          document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
              if (!confirm("Delete " + b.dataset.del + "?")) return;
              const r = await fetch("/eval/api/photos/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
              if (r.ok) location.reload();
              else { const j = await r.json().catch(() => ({})); alert(j.error || "Delete failed"); }
          }));
          </script>
        `;
        res.type("html").send(pageShell({ title: "Test photos", body }));
    });

    router.get("/variants", async (req, res) => {
        const { variants } = await loadSavedVariants();
        const activeStyles = settings.getActiveStyles();
        const styleKeys = Object.keys(activeStyles);

        const cards = variants.map((v, i) => {
            const styleList = Object.keys(v.overrides || {});
            const preview = styleList.length
                ? styleList.map((k) => `<code class="kbd">${escapeHtml(k)}</code>`).join(" ")
                : '<span class="muted">(no overrides)</span>';
            return `
              <div class="card" data-variant-idx="${i}">
                <div class="row row-top" style="margin-bottom:8px;">
                  <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;font-size:15px;margin-bottom:2px;">${escapeHtml(v.name)}</div>
                    <div class="muted small">${escapeHtml(new Date(v.createdAt).toLocaleDateString())}${v.updatedAt ? ` · edited ${escapeHtml(new Date(v.updatedAt).toLocaleDateString())}` : ""} · ${styleList.length} style${styleList.length === 1 ? "" : "s"}</div>
                  </div>
                  <div class="cluster">
                    <button class="btn btn-secondary btn-sm" data-edit="${escapeHtml(v.name)}">Edit</button>
                    <button class="btn btn-secondary btn-sm" data-del="${escapeHtml(v.name)}">Delete</button>
                  </div>
                </div>
                ${v.description ? `<div class="muted" style="margin-bottom:8px;">${escapeHtml(v.description)}</div>` : ""}
                <div class="cluster small">${preview}</div>
              </div>`;
        }).join("");

        const body = `
          <style>
            .v-modal { position:fixed;inset:0;z-index:1000; }
            .v-modal[hidden] { display:none; }
            .v-modal-backdrop { position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px); }
            .v-modal-panel { position:relative;margin:3vh auto;max-width:820px;width:94vw;max-height:94vh;overflow:auto;background:var(--th-card);border:1px solid var(--th-card-border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.5);padding:24px; }
            .kbd { font-family:'Twilio Sans Mono',ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;background:var(--th-bg);padding:1px 6px;border-radius:4px;border:1px solid var(--th-card-border);color:var(--th-text-muted); }
          </style>
          ${evalNav("variants")}
          <div class="row row-top" style="margin-bottom:24px;">
            <div>
              <h1>Saved variants</h1>
              <div class="subtitle">Prompt overrides you've saved for reuse across experiments.</div>
            </div>
            <button class="btn" id="new-variant-btn">+ New variant</button>
          </div>
          ${variants.length ? cards : `<div class="card"><p class="muted">No saved variants yet. Build one in the <a href="/eval/new">new run form</a> and click <strong>Save to library</strong> on any custom variant.</p></div>`}

          <div id="variant-editor" class="v-modal" hidden>
            <div class="v-modal-backdrop" data-close-editor></div>
            <div class="v-modal-panel">
              <div class="row" style="margin-bottom:12px;">
                <h3 id="editor-title">Edit variant</h3>
                <button class="btn btn-secondary btn-sm" data-close-editor>Close</button>
              </div>
              <label>Name<input type="text" id="editor-name" placeholder="e.g. trimmed-cartoon-v2"></label>
              <label>Description<input type="text" id="editor-desc" placeholder="Short note about what this variant changes"></label>
              <h2 style="margin-top:16px;">Overrides</h2>
              <div class="muted small" style="margin-bottom:8px;">Leave a field blank to skip overriding it. Only styles listed here will be overridden when this variant is applied to a run.</div>
              <div id="editor-styles" class="stack"></div>
              <div class="row" style="margin-top:16px;">
                <div class="muted small" id="editor-msg"></div>
                <div class="cluster">
                  <button class="btn btn-secondary" data-close-editor>Cancel</button>
                  <button class="btn" id="editor-save">Save</button>
                </div>
              </div>
            </div>
          </div>

          <script>
            const STYLE_KEYS = ${JSON.stringify(styleKeys)};
            const STYLE_LIVE = ${JSON.stringify(
                Object.fromEntries(styleKeys.map((k) => [k, {
                    prompt: activeStyles[k].prompt || "",
                    core: activeStyles[k].core || "",
                    brandCore: activeStyles[k].brandCore || "",
                }]))
            )};
            const VARIANTS = ${JSON.stringify(variants)};

            const editor = document.getElementById("variant-editor");
            const editorStyles = document.getElementById("editor-styles");
            const editorName = document.getElementById("editor-name");
            const editorDesc = document.getElementById("editor-desc");
            const editorTitle = document.getElementById("editor-title");
            const editorMsg = document.getElementById("editor-msg");
            let editingName = null;

            function renderEditorStyles(overrides) {
                editorStyles.innerHTML = STYLE_KEYS.map((k) => {
                    const o = (overrides && overrides[k]) || {};
                    const live = STYLE_LIVE[k] || {};
                    return \`
                      <details class="card card-compact" \${o.prompt || o.core || o.brandCore ? "open" : ""}>
                        <summary><strong>\${k}</strong> <span class="muted small">\${o.prompt || o.core || o.brandCore ? "(overridden)" : "(unchanged)"}</span></summary>
                        <label>Prompt<textarea data-style="\${k}" data-field="prompt" rows="3" placeholder="\${(live.prompt || '').replace(/"/g,'&quot;').slice(0,80)}">\${(o.prompt || '').replace(/</g,'&lt;')}</textarea></label>
                        <label>Core<textarea data-style="\${k}" data-field="core" rows="2" placeholder="\${(live.core || '').replace(/"/g,'&quot;').slice(0,80)}">\${(o.core || '').replace(/</g,'&lt;')}</textarea></label>
                        <label>Brand core<textarea data-style="\${k}" data-field="brandCore" rows="2" placeholder="\${(live.brandCore || '').replace(/"/g,'&quot;').slice(0,80)}">\${(o.brandCore || '').replace(/</g,'&lt;')}</textarea></label>
                      </details>\`;
                }).join("");
            }

            function openEditor({ name, description, overrides }) {
                editingName = name || null;
                editorTitle.textContent = name ? "Edit variant" : "New variant";
                editorName.value = name || "";
                editorName.disabled = !!name;
                editorDesc.value = description || "";
                renderEditorStyles(overrides || {});
                editorMsg.textContent = "";
                editor.hidden = false;
            }

            function closeEditor() { editor.hidden = true; editingName = null; }

            document.getElementById("new-variant-btn").addEventListener("click", () => openEditor({}));
            document.querySelectorAll("[data-close-editor]").forEach((el) => el.addEventListener("click", closeEditor));
            document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !editor.hidden) closeEditor(); });

            document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
                const v = VARIANTS.find((x) => x.name === b.dataset.edit);
                if (v) openEditor(v);
            }));

            document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
                if (!confirm("Delete variant \\"" + b.dataset.del + "\\"?")) return;
                const r = await fetch("/eval/api/variants/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
                if (r.ok) location.reload();
                else { const j = await r.json().catch(() => ({})); alert(j.error || "Delete failed"); }
            }));

            document.getElementById("editor-save").addEventListener("click", async () => {
                const name = editorName.value.trim();
                if (!name) { editorMsg.textContent = "Name is required"; return; }
                const overrides = {};
                editorStyles.querySelectorAll("textarea").forEach((t) => {
                    const k = t.dataset.style, f = t.dataset.field, v = t.value.trim();
                    if (!v) return;
                    overrides[k] = overrides[k] || {};
                    overrides[k][f] = v;
                });
                if (!Object.keys(overrides).length) { editorMsg.textContent = "At least one override is required"; return; }
                editorMsg.textContent = "Saving…";
                const body = { description: editorDesc.value.trim(), overrides };
                let r;
                if (editingName) {
                    r = await fetch("/eval/api/variants/" + encodeURIComponent(editingName), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
                } else {
                    r = await fetch("/eval/api/variants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ...body }) });
                }
                if (r.ok) location.reload();
                else { const j = await r.json().catch(() => ({})); editorMsg.textContent = j.error || "Save failed"; }
            });
          </script>
        `;
        res.type("html").send(pageShell({ title: "Saved variants", body }));
    });

    router.get("/api/runs", async (req, res) => {
        try { res.json({ runs: await listManifests() }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post("/api/runs", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const { name, styles, brands, backgrounds, photos, reps, variants, maxConcurrent } = req.body || {};
            if (!name || !Array.isArray(styles) || !Array.isArray(brands) || !Array.isArray(backgrounds) || !Array.isArray(photos) || !Array.isArray(variants)) {
                return res.status(400).json({ error: "Missing required fields" });
            }
            if (variants.length > MAX_VARIANTS_PER_EXPERIMENT) {
                return res.status(400).json({ error: `Too many variants (max ${MAX_VARIANTS_PER_EXPERIMENT})` });
            }
            if (!styles.length || !photos.length || !variants.length) {
                return res.status(400).json({ error: "Pick at least one style, one photo, and one variant" });
            }
            const defaults = await loadEvalSettings();
            const resolvedBrands = brands.length ? brands : [null];
            const resolvedBackgrounds = backgrounds.length ? backgrounds : [null];
            const config = {
                styles, brands: resolvedBrands, backgrounds: resolvedBackgrounds, photos,
                reps: reps || 1, variants,
                maxConcurrent: clampConcurrent(maxConcurrent ?? defaults.maxConcurrent),
            };
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

    // ── Eval settings (global defaults) ───────────────────────────────────
    router.get("/api/settings", async (req, res) => {
        try { res.json(await loadEvalSettings()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.patch("/api/settings", express.json(), async (req, res) => {
        try {
            const current = await loadEvalSettings();
            const next = { ...current, ...(req.body || {}) };
            if (req.body && req.body.maxConcurrent !== undefined) {
                const n = Number(req.body.maxConcurrent);
                if (!Number.isFinite(n) || n < MIN_CONCURRENT || n > MAX_CONCURRENT_CAP) {
                    return res.status(400).json({ error: `maxConcurrent must be between ${MIN_CONCURRENT} and ${MAX_CONCURRENT_CAP}` });
                }
            }
            res.json(await saveEvalSettings(next));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Saved variant library ─────────────────────────────────────────────
    router.get("/api/variants", async (req, res) => {
        try { res.json(await loadSavedVariants()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post("/api/variants", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const { name, description, overrides } = req.body || {};
            if (!name || typeof name !== "string" || !/^[A-Za-z0-9 _.\-]+$/.test(name)) {
                return res.status(400).json({ error: "name is required (letters, numbers, spaces, . _ -)" });
            }
            if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
                return res.status(400).json({ error: "overrides must be an object keyed by style" });
            }
            const entry = await addSavedVariant({ name: name.trim(), description, overrides });
            res.json(entry);
        } catch (err) {
            if (/already exists/i.test(err.message)) return res.status(409).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    router.patch("/api/variants/:name", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const entry = await updateSavedVariant(req.params.name, req.body || {});
            res.json(entry);
        } catch (err) {
            if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    router.delete("/api/variants/:name", async (req, res) => {
        try {
            await removeSavedVariant(req.params.name);
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

async function mountExperiments(app) {
    await ensureDirs();
    await recoverStaleExperiments();
    app.use("/eval", buildRouter());
    console.log("[experiments] Tracker mounted at /eval");
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
    buildRouter, mountExperiments, resolveEntryInputs,
    defaultBuildPromptForEntry, defaultCallImageEdit, defaultEnsurePhotoSceneCache,
};
