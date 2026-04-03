const settings = require("./settings");

// Built-in brands — intentionally empty. All brands are created via admin UI
// as "custom brands" stored in global settings, shared across events.
const BUILT_IN_BRANDS = {};

/**
 * Returns the active brands for the current event.
 * Merges built-in (none) + custom brands, filters by disabledBrands,
 * applies per-event brandPromptOverrides.
 */
function getActiveBrands() {
    const custom = settings.get("customBrands") || {};
    const disabled = settings.get("disabledBrands") || [];
    const overrides = settings.get("brandPromptOverrides") || {};
    const merged = {};

    for (const [key, val] of Object.entries(custom)) {
        if (disabled.includes(key)) continue;
        merged[key] = {
            ...val,
            brandPrompt: overrides[key] || val.brandPrompt || "",
        };
    }

    return merged;
}

function getActiveBrandList() {
    return Object.keys(getActiveBrands());
}

/**
 * Check if SMS body contains a brand name (for inline detection).
 * Returns the brand key if found, null otherwise.
 */
function detectBrand(body, activeBrands) {
    if (!body) return null;
    const lower = body.toLowerCase().trim();
    for (const [key, brand] of Object.entries(activeBrands)) {
        if (lower.includes(brand.name.toLowerCase())) return key;
    }
    return null;
}

module.exports = { BUILT_IN_BRANDS, getActiveBrands, getActiveBrandList, detectBrand };
