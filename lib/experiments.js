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

module.exports = {
    // constants
    EXPERIMENTS_DIR, TEST_PHOTOS_DIR, PHOTOS_JSON,
    MAX_CONCURRENT, MAX_RETRIES, MAX_ENTRIES_PER_EXPERIMENT, MAX_VARIANTS_PER_EXPERIMENT, COST_PER_IMAGE_USD,
    // helpers
    ensureDirs, experimentDir, manifestPath,
    loadManifest, saveManifest, listManifests,
    buildEntries, makeId,
};
