const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { mountReviewSettings } = require("../lib/review-settings");

test("mobile Settings reflects whether Unbranded is offered", () => {
    const routes = {};
    const router = {
        get: (path, ...handlers) => { routes[path] = handlers.at(-1); },
        post: () => {},
    };
    mountReviewSettings(router, (_req, _res, next) => next());
    const response = {
        type() { return this; },
        send(html) { this.html = html; },
    };
    routes["/settings"]({}, response);

    const script = [...response.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .find((body) => body.includes("function renderSettings()"));
    assert.ok(script);

    const settingsBody = { innerHTML: "", textContent: "" };
    const context = {
        document: {
            getElementById: (id) => id === "settingsBody" ? settingsBody : null,
            querySelectorAll: () => [],
        },
        fetch: () => new Promise(() => {}),
    };
    vm.createContext(context);
    vm.runInContext(script, context);
    context.fileOptions = { brands: [{ key: "la-kings", name: "LA Kings" }] };

    context.currentSettings = { enableBrandMenu: true, offerUnbranded: false };
    context.renderSettings();
    const unchecked = settingsBody.innerHTML.match(/<input type="checkbox" id="sOfferUnbranded"[^>]*>/);
    assert.ok(unchecked, "Offer Unbranded switch is available");
    assert.doesNotMatch(unchecked[0], /checked/);

    context.currentSettings = { enableBrandMenu: true, offerUnbranded: true };
    context.renderSettings();
    const checked = settingsBody.innerHTML.match(/<input type="checkbox" id="sOfferUnbranded"[^>]*>/);
    assert.ok(checked);
    assert.match(checked[0], /checked/);

    const defaultInput = { value: "", checked: false };
    let offerUnbrandedInput = { checked: false };
    context.document.getElementById = (id) => id === "sOfferUnbranded" ? offerUnbrandedInput : defaultInput;
    assert.equal(context.buildPayload().offerUnbranded, false);
    offerUnbrandedInput = { checked: true };
    assert.equal(context.buildPayload().offerUnbranded, true);
});
