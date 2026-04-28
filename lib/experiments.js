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
};
