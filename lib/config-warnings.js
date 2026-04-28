// Soft validators that explain subtle config interactions to admins.
// Returns string[] — empty array means "no concerns". Pure functions, no I/O.
// Consumed by the /home admin UI to render inline hints per brand/style card.

function brandWarnings(brand) {
    if (!brand) return [];
    const out = [];
    const scenes = Array.isArray(brand.scenes) ? brand.scenes : [];

    if (brand.category === "wardrobe-plus-scene" && scenes.length === 0) {
        out.push("Category is \"wardrobe-plus-scene\" but no scenes are configured — the background menu will be empty.");
    }

    if (brand.category === "wardrobe-plus-scene" && brand.allowOriginal !== false) {
        out.push("\"Allow original scene\" has no effect for wardrobe-plus-scene brands — Original is always hidden.");
    }

    if (typeof brand.wardrobe === "string" && brand.wardrobe.trim()
        && typeof brand.brandPrompt === "string" && brand.brandPrompt.trim()) {
        out.push("Both wardrobe and legacy brandPrompt are set — brandPrompt will be ignored (wardrobe wins).");
    }

    for (const s of scenes) {
        if (s && s.name && (!s.prompt || !s.prompt.trim())) {
            out.push("Scene \"" + s.name + "\" has an empty prompt.");
        }
    }

    return out;
}

function styleWarnings(style) {
    if (!style) return [];
    const out = [];
    const hasContainerDesc = typeof style.containerDescription === "string" && style.containerDescription.trim();

    if (style.behavior === "themed-container" && !hasContainerDesc) {
        out.push("Behavior is \"themed-container\" but container description is empty — nothing will be injected.");
    }

    if (style.behavior && style.behavior !== "themed-container" && hasContainerDesc) {
        out.push("Container description is only used by themed-container styles — currently unused.");
    }

    return out;
}

module.exports = { brandWarnings, styleWarnings };
