function shouldShowMenu(enabled, choices) {
    return Boolean(enabled) && choices.length > 0;
}

module.exports = { shouldShowMenu };
