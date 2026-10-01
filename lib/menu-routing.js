function shouldShowMenu(enabled, choices) {
    return Boolean(enabled) && choices.length > 0;
}

function resolveBrandStep({ enabled, brandKeys, offerUnbranded }) {
    if (!shouldShowMenu(enabled, brandKeys)) return { kind: "skip" };
    if (offerUnbranded === false && brandKeys.length === 1) {
        return { kind: "auto", brandKey: brandKeys[0] };
    }
    return { kind: "menu", includeNone: offerUnbranded !== false };
}

module.exports = { shouldShowMenu, resolveBrandStep };
