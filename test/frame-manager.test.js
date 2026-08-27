const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const sharp = require("sharp");

const PROJECT_ROOT = path.join(__dirname, "..");

function loadIsolatedSettings(active, profiles, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frame-settings-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "data", "events"), { recursive: true });
    fs.mkdirSync(path.join(root, "templates"), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, "lib", "settings.js"), path.join(root, "lib", "settings.js"));
    fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify(active));
    for (const [eventName, profile] of Object.entries(profiles)) {
        const eventDir = path.join(root, "data", "events", eventName);
        fs.mkdirSync(eventDir, { recursive: true });
        fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify(profile));
    }
    const modulePath = path.join(root, "lib", "settings.js");
    function requireIsolated() {
        const previousTemplateFile = process.env.TEMPLATE_FILE;
        if (options.defaultTemplate !== undefined) process.env.TEMPLATE_FILE = options.defaultTemplate;
        delete require.cache[require.resolve(modulePath)];
        try {
            const isolated = require(modulePath);
            isolated.load();
            return isolated;
        } finally {
            if (options.defaultTemplate !== undefined) {
                if (previousTemplateFile === undefined) delete process.env.TEMPLATE_FILE;
                else process.env.TEMPLATE_FILE = previousTemplateFile;
            }
        }
    }
    const isolated = requireIsolated();
    return {
        root,
        settings: isolated,
        reload: requireIsolated,
        activePath: path.join(root, "data", "settings.json"),
        journalPath: path.join(root, "data", "template-reference-migration.json"),
        profilePath: (eventName) => path.join(root, "data", "events", eventName, "settings.json"),
        readActive: () => JSON.parse(fs.readFileSync(path.join(root, "data", "settings.json"), "utf8")),
        readProfile: (eventName) => JSON.parse(fs.readFileSync(path.join(root, "data", "events", eventName, "settings.json"), "utf8")),
    };
}

test("compatibility is global and rename/delete transactionally migrate every reference", () => {
    const oldName = "legacy-custom.png";
    const newName = "renamed-built-in.png";
    const activeProfile = {
        templateFile: oldName,
        templateFilesByOrientation: { portrait: oldName, landscape: oldName },
        templateCompatibilityOverrides: { [oldName]: "portrait" },
    };
    const otherProfile = {
        templateFile: oldName,
        templateFilesByOrientation: { portrait: oldName, landscape: "other.png" },
        templateCompatibilityOverrides: { [oldName]: "landscape" },
    };
    const fixture = loadIsolatedSettings(
        { eventName: "active" },
        { active: activeProfile, other: otherProfile },
    );

    try {
        assert.equal(fixture.settings.getTemplateCompatibility(oldName, "active"), "portrait");
        assert.equal(fixture.settings.getTemplateCompatibility(oldName, "other"), "portrait");

        const renamed = fixture.settings.migrateTemplateReferences(oldName, newName);
        assert.equal(renamed.activeChanged, true);
        assert.equal(renamed.profilesChanged, 2);
        assert.equal(renamed.compatibility, "portrait");

        const active = fixture.readActive();
        const activeEvent = fixture.readProfile("active");
        const otherEvent = fixture.readProfile("other");
        assert.equal(active.templateFile, newName);
        assert.deepEqual(active.templateFilesByOrientation, { portrait: newName, landscape: newName });
        assert.equal(active.templateCompatibilityOverrides[newName], "portrait");
        assert.equal(Object.hasOwn(active.templateCompatibilityOverrides, oldName), false);
        assert.deepEqual(activeEvent.templateFilesByOrientation, { portrait: newName, landscape: newName });
        assert.equal(Object.hasOwn(activeEvent.templateCompatibilityOverrides || {}, newName), false);
        assert.equal(otherEvent.templateFile, newName);
        assert.deepEqual(otherEvent.templateFilesByOrientation, { portrait: newName, landscape: "other.png" });
        assert.equal(Object.hasOwn(otherEvent.templateCompatibilityOverrides || {}, newName), false);
        assert.ok(active.templateDeletionTombstones.includes(oldName));
        assert.equal(fixture.settings.getTemplateCompatibility(newName, "other"), "portrait");

        const deleted = fixture.settings.migrateTemplateReferences(newName, "");
        assert.equal(deleted.activeChanged, true);
        assert.equal(deleted.profilesChanged, 2);
        for (const data of [fixture.readActive(), fixture.readProfile("active"), fixture.readProfile("other")]) {
            assert.notEqual(data.templateFile, newName);
            assert.equal(Object.values(data.templateFilesByOrientation).includes(newName), false);
            assert.equal(Object.hasOwn(data.templateCompatibilityOverrides || {}, newName), false);
        }
        assert.ok(fixture.readActive().templateDeletionTombstones.includes(newName));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("legacy compatibility migration removes event copies before event switching", () => {
    const fixture = loadIsolatedSettings(
        {
            eventName: "active",
            templateCompatibilityOverrides: { "global.png": "both" },
        },
        {
            active: {
                templateFile: "active.png",
                templateCompatibilityOverrides: {
                    "shared.png": "portrait",
                    "active-only.png": "both",
                },
            },
            other: {
                templateFile: "other.png",
                templateCompatibilityOverrides: {
                    "shared.png": "landscape",
                    "other-only.png": "landscape",
                },
            },
        },
    );

    try {
        assert.deepEqual(fixture.settings.get("templateCompatibilityOverrides"), {
            "global.png": "both",
            "shared.png": "portrait",
            "active-only.png": "both",
            "other-only.png": "landscape",
        });
        assert.equal(Object.hasOwn(fixture.readProfile("active"), "templateCompatibilityOverrides"), false);
        assert.equal(Object.hasOwn(fixture.readProfile("other"), "templateCompatibilityOverrides"), false);
        assert.equal(fs.existsSync(fixture.journalPath), false);

        fixture.settings.update({ eventName: "other" });
        assert.equal(fixture.settings.getTemplateCompatibility("shared.png"), "portrait");
        assert.equal(fixture.settings.getTemplateCompatibility("other-only.png"), "landscape");
        assert.equal(Object.hasOwn(fixture.readProfile("active"), "templateCompatibilityOverrides"), false);
        assert.equal(Object.hasOwn(fixture.readProfile("other"), "templateCompatibilityOverrides"), false);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("stale settings instances merge independent per-frame compatibility updates", () => {
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateCompatibilityOverrides: {} },
        { active: {} },
    );
    const staleSettings = fixture.reload();

    try {
        fixture.settings.setTemplateCompatibility("portrait.png", "portrait");
        staleSettings.setTemplateCompatibility("landscape.png", "landscape");
        assert.deepEqual(fixture.readActive().templateCompatibilityOverrides, {
            "portrait.png": "portrait",
            "landscape.png": "landscape",
        });
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("legacy per-event compatibility is only a fallback without an explicit global key", () => {
    const filename = "frame_-_overlay_-_low_center.png";
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateCompatibilityOverrides: {} },
        { active: {} },
    );

    try {
        fs.writeFileSync(fixture.profilePath("active"), JSON.stringify({
            templateCompatibilityOverrides: { [filename]: "native" },
        }));
        assert.equal(fixture.settings.getTemplateCompatibility(filename, "active"), "native");

        fixture.settings.update({ templateCompatibilityOverrides: { [filename]: "landscape" } });
        fs.writeFileSync(fixture.profilePath("active"), JSON.stringify({
            templateCompatibilityOverrides: { [filename]: "native" },
        }));
        assert.equal(fixture.settings.getTemplateCompatibility(filename, "active"), "landscape");
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("all settings mutations sanitize stale frame references after refreshing disk state", async () => {
    const fixture = loadIsolatedSettings(
        { eventName: "active" },
        { active: {
            maxPrints: 7,
            templateFile: "new.png",
            templateFilesByOrientation: { portrait: "new.png", landscape: "" },
        } },
    );

    try {
        await sharp({ create: { width: 2, height: 3, channels: 4, background: "#fff" } })
            .png()
            .toFile(path.join(fixture.root, "templates", "new.png"));
        fixture.settings.update({
            maxPrints: 8,
            templateFile: "old.png",
            templateFilesByOrientation: { portrait: "old.png", landscape: "missing.png" },
        });
        assert.equal(fixture.settings.get("maxPrints"), 8);
        assert.equal(fixture.settings.get("templateFile"), "new.png");
        assert.deepEqual(fixture.settings.get("templateFilesByOrientation"), {
            portrait: "new.png",
            landscape: "",
        });
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("object reference migration removes legacy per-event compatibility instead of recreating it", () => {
    const data = {
        templateFile: "old.png",
        templateFilesByOrientation: { portrait: "old.png", landscape: "wide.png" },
        templateCompatibilityOverrides: { "old.png": "portrait", "wide.png": "landscape" },
    };
    const settings = require("../lib/settings");
    assert.equal(settings.migrateTemplateReferencesInObject(data, "old.png", "new.png"), true);
    assert.deepEqual(data, {
        templateFile: "new.png",
        templateFilesByOrientation: { portrait: "new.png", landscape: "wide.png" },
        templateCompatibilityOverrides: { "wide.png": "landscape" },
    });
});

test("reference migration fails before writing when any profile is unreadable", () => {
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateFile: "old.png" },
        { active: { templateFile: "old.png" }, broken: {} },
    );
    fs.writeFileSync(fixture.profilePath("broken"), "{not-json");
    const beforeActive = fs.readFileSync(fixture.activePath, "utf8");
    const beforeProfile = fs.readFileSync(fixture.profilePath("active"), "utf8");

    try {
        assert.throws(() => fixture.settings.migrateTemplateReferences("old.png", "new.png"));
        assert.equal(fs.readFileSync(fixture.activePath, "utf8"), beforeActive);
        assert.equal(fs.readFileSync(fixture.profilePath("active"), "utf8"), beforeProfile);
        assert.equal(fixture.settings.get("templateFile"), "old.png");
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("reference migration rolls back files and in-memory state on a write failure", () => {
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateFile: "old.png" },
        { active: { templateFile: "old.png" }, other: { templateFile: "old.png" } },
    );
    const paths = [fixture.activePath, fixture.profilePath("active"), fixture.profilePath("other")];
    const before = new Map(paths.map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]));
    const originalRenameSync = fs.renameSync;
    let injected = false;
    fs.renameSync = function(source, target) {
        if (!injected && target.endsWith(path.join("events", "other", "settings.json"))) {
            injected = true;
            const err = new Error("injected write failure");
            err.code = "EIO";
            throw err;
        }
        return originalRenameSync.call(this, source, target);
    };

    try {
        assert.throws(
            () => fixture.settings.migrateTemplateReferences("old.png", "new.png"),
            /injected write failure/,
        );
        for (const filePath of paths) {
            assert.equal(fs.readFileSync(filePath, "utf8"), before.get(filePath));
        }
        assert.equal(fixture.settings.get("templateFile"), "old.png");
    } finally {
        fs.renameSync = originalRenameSync;
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("settings.load idempotently rolls a partial reference migration journal forward", () => {
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateFile: "old.png" },
        { active: { templateFile: "old.png" }, other: { templateFile: "old.png" } },
    );
    const finalActive = { eventName: "active", templateFile: "new.png", templateDeletionTombstones: ["old.png"] };
    const finalActiveProfile = { templateFile: "new.png" };
    const finalOtherProfile = { templateFile: "new.png" };

    try {
        fs.writeFileSync(fixture.activePath, JSON.stringify(finalActive));
        fs.writeFileSync(fixture.journalPath, JSON.stringify({
            version: 1,
            writes: [
                { path: "settings.json", contents: JSON.stringify(finalActive, null, 2) },
                { path: path.join("events", "active", "settings.json"), contents: JSON.stringify(finalActiveProfile, null, 2) },
                { path: path.join("events", "other", "settings.json"), contents: JSON.stringify(finalOtherProfile, null, 2) },
            ],
        }));

        const recovered = fixture.reload();
        assert.equal(recovered.get("templateFile"), "new.png");
        assert.equal(fixture.readProfile("active").templateFile, "new.png");
        assert.equal(fixture.readProfile("other").templateFile, "new.png");
        assert.equal(fs.existsSync(fixture.journalPath), false);

        recovered.load();
        assert.equal(recovered.get("templateFile"), "new.png");
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("tombstones reject a default template path after restart", async () => {
    const filename = "reseeded-default.png";
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateDeletionTombstones: [filename] },
        { active: {} },
        { defaultTemplate: filename },
    );

    try {
        await sharp({ create: { width: 2, height: 3, channels: 4, background: "#fff" } })
            .png()
            .toFile(path.join(fixture.root, "templates", filename));
        assert.equal(fixture.settings.getTemplatePath("active", "portrait"), "");
        assert.equal(fixture.reload().getTemplatePath("active", "portrait"), "");
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("tombstones hide reseeded files, restore explicitly, and listing rejects directory failures", async () => {
    const oldName = "built-in.png";
    const newName = "renamed.png";
    const fixture = loadIsolatedSettings(
        { eventName: "active", templateCompatibilityOverrides: { [oldName]: "both" } },
        { active: {} },
    );
    const oldPath = path.join(fixture.root, "templates", oldName);
    const newPath = path.join(fixture.root, "templates", newName);
    const image = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#fff" } }).png().toBuffer();

    try {
        fs.writeFileSync(oldPath, image);
        fs.writeFileSync(newPath, image);
        fs.writeFileSync(path.join(fixture.root, "templates", "legacy.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
        fixture.settings.migrateTemplateReferences(oldName, newName);
        let listed = await fixture.settings.listTemplates();
        assert.deepEqual(listed.map((item) => item.filename), ["legacy.svg", newName]);
        assert.equal(listed[0].supported, false);
        assert.match(listed[0].warning, /Replace with PNG, JPEG, or GIF/);

        fs.writeFileSync(oldPath, image); // Simulate Docker seeding the built-in again.
        assert.deepEqual((await fixture.settings.listTemplates()).map((item) => item.filename), ["legacy.svg", newName]);
        assert.equal(fixture.settings.getTemplateCompatibility(newName), "both");

        fixture.settings.migrateTemplateReferences(newName, "");
        assert.deepEqual((await fixture.settings.listTemplates()).map((item) => item.filename), ["legacy.svg"]);
        fixture.settings.restoreTemplate(oldName);
        assert.deepEqual((await fixture.settings.listTemplates()).map((item) => item.filename), [oldName, "legacy.svg"]);

        fs.renameSync(path.join(fixture.root, "templates"), path.join(fixture.root, "templates-offline"));
        await assert.rejects(fixture.settings.listTemplates(), /ENOENT/);
        fs.renameSync(path.join(fixture.root, "templates-offline"), path.join(fixture.root, "templates"));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

function request(server, method, requestPath, body, contentType = "application/json") {
    return new Promise((resolve, reject) => {
        const payload = body == null
            ? null
            : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        const req = http.request({
            port: server.address().port,
            method,
            path: requestPath,
            headers: payload ? { "content-type": contentType, "content-length": payload.length } : {},
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const responseBody = Buffer.concat(chunks);
                const isJson = String(res.headers["content-type"] || "").includes("application/json");
                resolve({
                    status: res.statusCode,
                    body: responseBody.length
                        ? (isJson ? JSON.parse(responseBody.toString("utf8")) : responseBody)
                        : null,
                });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function pngWithDimensions(png, width, height) {
    const copy = Buffer.from(png);
    copy.writeUInt32BE(width, 16);
    copy.writeUInt32BE(height, 20);
    let crc = 0xffffffff;
    for (const byte of copy.subarray(12, 29)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    copy.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    return copy;
}

test("frame APIs sanitize rename, reject overwrite and traversal, replace safely, and delete", async () => {
    const settings = require("../lib/settings");
    const originalDir = settings.TEMPLATES_DIR;
    const originalList = settings.listTemplates;
    const originalMigrate = settings.migrateTemplateReferences;
    const originalRestore = settings.restoreTemplate;
    const originalRefresh = settings.refreshTemplateStateFromDisk;
    const originalSetCompatibility = settings.setTemplateCompatibility;
    const originalUnlink = fsp.unlink;
    const originalCopyFile = fsp.copyFile;
    const originalStat = fsp.stat;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-api-"));
    const migrations = [];
    const restored = [];
    const tombstones = new Set();
    const compatibility = {};
    settings.TEMPLATES_DIR = tempDir;
    settings.listTemplates = async () => (await fsp.readdir(tempDir))
        .filter((filename) => /\.(png|jpg|jpeg|gif)$/i.test(filename) && !tombstones.has(filename))
        .sort()
        .map((filename) => ({ filename, width: null, height: null, orientation: "unknown" }));
    settings.migrateTemplateReferences = (oldName, newName) => {
        assert.equal(fs.existsSync(path.join(tempDir, oldName)), true, "migration must happen before source removal");
        if (newName) {
            assert.equal(fs.existsSync(path.join(tempDir, newName)), true, "rename must copy before migration");
        }
        if (oldName === "rollback.png") throw new Error("migration failed");
        migrations.push([oldName, newName]);
        tombstones.add(oldName);
    };
    settings.restoreTemplate = (filename) => {
        restored.push(filename);
        tombstones.delete(filename);
    };
    settings.refreshTemplateStateFromDisk = () => {};
    settings.setTemplateCompatibility = (filename, mode) => {
        compatibility[filename] = mode;
        return mode;
    };

    const { mountDashboard } = require("../lib/dashboard");
    const app = express();
    mountDashboard(app);
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });
    let releaseConcurrentCopy = null;
    let releaseCompatibilityStat = null;

    try {
        await Promise.all([
            fsp.writeFile(path.join(tempDir, "compat-one.png"), "one"),
            fsp.writeFile(path.join(tempDir, "compat-two.png"), "two"),
        ]);
        let compatibilityStatStarted;
        const compatibilityStatStartedPromise = new Promise((resolve) => { compatibilityStatStarted = resolve; });
        const compatibilityStatBlocked = new Promise((resolve) => { releaseCompatibilityStat = resolve; });
        let compatibilityStatsInFlight = 0;
        let maxCompatibilityStatsInFlight = 0;
        fsp.stat = async function(filePath, ...args) {
            if (filePath === path.join(tempDir, "compat-one.png") || filePath === path.join(tempDir, "compat-two.png")) {
                compatibilityStatsInFlight++;
                maxCompatibilityStatsInFlight = Math.max(maxCompatibilityStatsInFlight, compatibilityStatsInFlight);
                if (filePath === path.join(tempDir, "compat-one.png")) {
                    compatibilityStatStarted();
                    await compatibilityStatBlocked;
                }
                try {
                    return await originalStat.call(this, filePath, ...args);
                } finally {
                    compatibilityStatsInFlight--;
                }
            }
            return originalStat.call(this, filePath, ...args);
        };
        const firstCompatibility = request(server, "POST", "/dashboard/api/settings/template/compatibility", {
            filename: "compat-one.png",
            compatibility: "portrait",
        });
        await compatibilityStatStartedPromise;
        const secondCompatibility = request(server, "POST", "/dashboard/api/settings/template/compatibility", {
            filename: "compat-two.png",
            compatibility: "landscape",
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(maxCompatibilityStatsInFlight, 1, "compatibility updates must share the frame operation lock");
        releaseCompatibilityStat();
        releaseCompatibilityStat = null;
        const compatibilityResponses = await Promise.all([firstCompatibility, secondCompatibility]);
        fsp.stat = originalStat;
        assert.deepEqual(compatibilityResponses.map((response) => response.status), [200, 200]);
        assert.deepEqual(compatibility, {
            "compat-one.png": "portrait",
            "compat-two.png": "landscape",
        });

        await fsp.writeFile(path.join(tempDir, "source.png"), "source");
        await fsp.writeFile(path.join(tempDir, "occupied.png"), "occupied");
        let response = await request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "source.png",
            newName: "occupied.png",
        });
        assert.equal(response.status, 409);
        assert.equal(await fsp.readFile(path.join(tempDir, "source.png"), "utf8"), "source");
        assert.equal(await fsp.readFile(path.join(tempDir, "occupied.png"), "utf8"), "occupied");

        response = await request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "source.png",
            newName: "Renamed Frame.jpg",
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.filename, "Renamed_Frame.png");
        assert.equal(fs.existsSync(path.join(tempDir, "source.png")), false);
        assert.equal(await fsp.readFile(path.join(tempDir, "Renamed_Frame.png"), "utf8"), "source");
        assert.deepEqual(migrations.shift(), ["source.png", "Renamed_Frame.png"]);

        response = await request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "../Renamed_Frame.png",
            newName: "escaped.png",
        });
        assert.equal(response.status, 400);

        await fsp.writeFile(path.join(tempDir, "concurrent.png"), "concurrent");
        let copyStarted;
        const copyStartedPromise = new Promise((resolve) => { copyStarted = resolve; });
        const copyBlocked = new Promise((resolve) => { releaseConcurrentCopy = resolve; });
        fsp.copyFile = async function(source, target, flags) {
            if (target === path.join(tempDir, "concurrent-first.png")) {
                copyStarted();
                await copyBlocked;
            }
            return originalCopyFile.call(this, source, target, flags);
        };
        const firstRename = request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "concurrent.png",
            newName: "concurrent-first.png",
        });
        await copyStartedPromise;
        const secondRename = request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "concurrent.png",
            newName: "concurrent-second.png",
        });
        releaseConcurrentCopy();
        releaseConcurrentCopy = null;
        const [firstResponse, secondResponse] = await Promise.all([firstRename, secondRename]);
        fsp.copyFile = originalCopyFile;
        assert.equal(firstResponse.status, 200);
        assert.equal(secondResponse.status, 404);
        assert.equal(await fsp.readFile(path.join(tempDir, "concurrent-first.png"), "utf8"), "concurrent");
        assert.equal(fs.existsSync(path.join(tempDir, "concurrent-second.png")), false);
        assert.deepEqual(migrations.shift(), ["concurrent.png", "concurrent-first.png"]);

        await fsp.writeFile(path.join(tempDir, "rollback.png"), "rollback");
        response = await request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "rollback.png",
            newName: "rollback-new.png",
        });
        assert.equal(response.status, 500);
        assert.equal(await fsp.readFile(path.join(tempDir, "rollback.png"), "utf8"), "rollback");
        assert.equal(fs.existsSync(path.join(tempDir, "rollback-new.png")), false);

        const originalImage = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#f00" } }).png().toBuffer();
        const replacementImage = await sharp({ create: { width: 3, height: 2, channels: 4, background: "#00f" } }).png().toBuffer();
        await fsp.writeFile(path.join(tempDir, "replace.png"), originalImage);
        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template",
            replacementImage,
            "application/octet-stream",
        );
        assert.equal(response.status, 409);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), originalImage);

        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            Buffer.from("not an image"),
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), originalImage);

        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=legacy.svg&type=template",
            Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.equal(fs.existsSync(path.join(tempDir, "legacy.svg")), false);

        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            Buffer.alloc(25 * 1024 * 1024 + 1),
            "application/octet-stream",
        );
        assert.equal(response.status, 413);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), originalImage);

        const pixelBomb = pngWithDimensions(originalImage, 8000, 7000);
        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            pixelBomb,
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), originalImage);

        const overlongImage = await sharp({ create: { width: 10001, height: 1, channels: 4, background: "#fff" } }).png().toBuffer();
        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            overlongImage,
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), originalImage);

        const gifHeader = "47494638396101000100800000000000ffffff";
        const gifFrame = "21f90400000000002c0000000001000100000202440100";
        const animatedGif = Buffer.from(gifHeader + gifFrame + gifFrame + "3b", "hex");
        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.gif&type=template",
            animatedGif,
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.equal(fs.existsSync(path.join(tempDir, "replace.gif")), false);

        const truncatedImage = originalImage.subarray(0, Math.floor(originalImage.length * 0.8));
        await sharp(truncatedImage).metadata();
        await assert.rejects(sharp(truncatedImage, { failOn: "error" }).toBuffer());
        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            truncatedImage,
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), originalImage);

        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            replacementImage,
            "application/octet-stream",
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), replacementImage);
        assert.deepEqual(restored, ["replace.png"]);

        await fsp.writeFile(path.join(tempDir, "legacy.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=legacy.png&type=template&replace=1&replaceFilename=legacy.svg",
            replacementImage,
            "application/octet-stream",
        );
        assert.equal(response.status, 200);
        assert.equal(fs.existsSync(path.join(tempDir, "legacy.svg")), false);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "legacy.png")), replacementImage);
        assert.deepEqual(migrations.shift(), ["legacy.svg", "legacy.png"]);

        response = await request(
            server,
            "POST",
            "/dashboard/api/settings/upload?filename=replace.png&type=template&replace=1",
            null,
            "application/octet-stream",
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await fsp.readFile(path.join(tempDir, "replace.png")), replacementImage);

        fsp.unlink = async function(filePath) {
            if (filePath === path.join(tempDir, "Renamed_Frame.png")) {
                const err = new Error("file busy");
                err.code = "EBUSY";
                throw err;
            }
            return originalUnlink.call(this, filePath);
        };
        response = await request(server, "DELETE", "/dashboard/api/settings/template?filename=Renamed_Frame.png");
        fsp.unlink = originalUnlink;
        assert.equal(response.status, 200);
        assert.equal(fs.existsSync(path.join(tempDir, "Renamed_Frame.png")), true);
        assert.equal(response.body.files.some((item) => item.filename === "Renamed_Frame.png"), false);
        assert.deepEqual(migrations.shift(), ["Renamed_Frame.png", ""]);
        assert.deepEqual(migrations, []);

        settings.listTemplates = async () => { throw new Error("temporary directory failure"); };
        response = await request(server, "GET", "/dashboard/api/settings/files");
        assert.equal(response.status, 503);
        assert.notDeepEqual(response.body, { templates: [] });
    } finally {
        if (releaseConcurrentCopy) releaseConcurrentCopy();
        if (releaseCompatibilityStat) releaseCompatibilityStat();
        await new Promise((resolve) => server.close(resolve));
        settings.TEMPLATES_DIR = originalDir;
        settings.listTemplates = originalList;
        settings.migrateTemplateReferences = originalMigrate;
        settings.restoreTemplate = originalRestore;
        settings.refreshTemplateStateFromDisk = originalRefresh;
        settings.setTemplateCompatibility = originalSetCompatibility;
        fsp.unlink = originalUnlink;
        fsp.copyFile = originalCopyFile;
        fsp.stat = originalStat;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("a stale settings POST waits for rename and cannot restore removed frame state", async () => {
    const settings = require("../lib/settings");
    const originals = {
        templatesDir: settings.TEMPLATES_DIR,
        get: settings.get,
        updateForUser: settings.updateForUser,
        isTemplateUsable: settings.isTemplateUsable,
        listTemplates: settings.listTemplates,
        migrateTemplateReferences: settings.migrateTemplateReferences,
        refreshTemplateStateFromDisk: settings.refreshTemplateStateFromDisk,
        sanitizeTemplateReferenceChanges: settings.sanitizeTemplateReferenceChanges,
    };
    const originalCopyFile = fsp.copyFile;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-stale-settings-"));
    const state = {
        eventName: "active",
        templateFile: "old.png",
        templateFilesByOrientation: { portrait: "old.png", landscape: "old.png" },
        templateCompatibilityOverrides: { "old.png": "portrait" },
        templateDeletionTombstones: [],
    };
    let updateCalled = false;
    let releaseCopy;

    settings.TEMPLATES_DIR = tempDir;
    settings.get = (key) => state[key];
    settings.updateForUser = (_email, changes) => {
        updateCalled = true;
        Object.assign(state, changes);
        return JSON.parse(JSON.stringify(state));
    };
    settings.isTemplateUsable = (filename) => !state.templateDeletionTombstones.includes(filename);
    settings.listTemplates = async () => (await fsp.readdir(tempDir))
        .filter((filename) => !filename.startsWith(".") && !state.templateDeletionTombstones.includes(filename))
        .map((filename) => ({ filename, width: null, height: null, orientation: "unknown" }));
    settings.migrateTemplateReferences = (oldName, newName) => {
        state.templateFile = newName;
        state.templateFilesByOrientation = { portrait: newName, landscape: newName };
        state.templateCompatibilityOverrides = { [newName]: state.templateCompatibilityOverrides[oldName] };
        state.templateDeletionTombstones.push(oldName);
    };
    settings.refreshTemplateStateFromDisk = () => {};
    settings.sanitizeTemplateReferenceChanges = (changes) => {
        const sanitized = { ...changes };
        if (sanitized.templateFile === "old.png") sanitized.templateFile = state.templateFile;
        if (sanitized.templateFilesByOrientation) {
            sanitized.templateFilesByOrientation = { ...state.templateFilesByOrientation };
        }
        return sanitized;
    };

    await fsp.writeFile(path.join(tempDir, "old.png"), "frame");
    let copyStarted;
    const copyStartedPromise = new Promise((resolve) => { copyStarted = resolve; });
    const copyBlocked = new Promise((resolve) => { releaseCopy = resolve; });
    fsp.copyFile = async function(source, target, flags) {
        if (target === path.join(tempDir, "new.png")) {
            copyStarted();
            await copyBlocked;
        }
        return originalCopyFile.call(this, source, target, flags);
    };

    const { mountDashboard } = require("../lib/dashboard");
    const app = express();
    app.use((req, _res, next) => {
        req.user = { email: "frame-test@example.com" };
        next();
    });
    mountDashboard(app);
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });

    try {
        const rename = request(server, "POST", "/dashboard/api/settings/template/rename", {
            filename: "old.png",
            newName: "new.png",
        });
        await copyStartedPromise;
        const staleSave = request(server, "POST", "/dashboard/api/settings", {
            templateFile: "old.png",
            templateFilesByOrientation: { portrait: "old.png", landscape: "missing.png" },
            templateCompatibilityOverrides: { "old.png": "both", "missing.png": "landscape" },
            templateDeletionTombstones: [],
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(updateCalled, false, "settings save must wait for the frame operation lock");

        releaseCopy();
        releaseCopy = null;
        const [renameResponse, saveResponse] = await Promise.all([rename, staleSave]);
        assert.equal(renameResponse.status, 200);
        assert.equal(saveResponse.status, 200);
        assert.equal(state.templateFile, "new.png");
        assert.deepEqual(state.templateFilesByOrientation, { portrait: "new.png", landscape: "new.png" });
        assert.deepEqual(state.templateCompatibilityOverrides, { "new.png": "portrait" });
        assert.deepEqual(state.templateDeletionTombstones, ["old.png"]);
    } finally {
        if (releaseCopy) releaseCopy();
        await new Promise((resolve) => server.close(resolve));
        settings.TEMPLATES_DIR = originals.templatesDir;
        settings.get = originals.get;
        settings.updateForUser = originals.updateForUser;
        settings.isTemplateUsable = originals.isTemplateUsable;
        settings.listTemplates = originals.listTemplates;
        settings.migrateTemplateReferences = originals.migrateTemplateReferences;
        settings.refreshTemplateStateFromDisk = originals.refreshTemplateStateFromDisk;
        settings.sanitizeTemplateReferenceChanges = originals.sanitizeTemplateReferenceChanges;
        fsp.copyFile = originalCopyFile;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("template preparation retries and skips a frame that disappears after resolution", async () => {
    const settings = require("../lib/settings");
    const { compositeWithTemplate } = require("../lib/helpers");
    const originalGetTemplatePath = settings.getTemplatePath;
    const originalGetTemplateCompatibility = settings.getTemplateCompatibility;
    const originalStat = fsp.stat;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-disappears-"));
    const framePath = path.join(tempDir, "vanishing.png");
    const outputPath = path.join(tempDir, "portrait.png");
    await sharp({ create: { width: 20, height: 30, channels: 4, background: "#fff" } }).png().toFile(framePath);
    await sharp({ create: { width: 20, height: 30, channels: 3, background: "#369" } }).png().toFile(outputPath);
    const before = await fsp.readFile(outputPath);
    let preparationAttempts = 0;

    settings.getTemplatePath = () => framePath;
    settings.getTemplateCompatibility = () => "both";
    fsp.stat = async function(filePath, ...args) {
        if (filePath === framePath) {
            preparationAttempts++;
            if (preparationAttempts === 1) await fsp.unlink(framePath);
        }
        return originalStat.call(this, filePath, ...args);
    };

    try {
        await compositeWithTemplate(outputPath, {
            width: 20,
            height: 30,
            orientation: "portrait",
        }, "active");
        assert.equal(preparationAttempts, 3);
        assert.deepEqual(await fsp.readFile(outputPath), before);
    } finally {
        settings.getTemplatePath = originalGetTemplatePath;
        settings.getTemplateCompatibility = originalGetTemplateCompatibility;
        fsp.stat = originalStat;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("template static serving rejects tombstoned files and all SVGs", async () => {
    const settings = require("../lib/settings");
    const originalDir = settings.TEMPLATES_DIR;
    const originalIsTemplateUsable = settings.isTemplateUsable;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-static-"));
    settings.TEMPLATES_DIR = tempDir;
    settings.isTemplateUsable = (filename) => filename !== "tombstoned.png" && originalIsTemplateUsable(filename);
    fs.writeFileSync(path.join(tempDir, "visible.png"), "visible");
    fs.writeFileSync(path.join(tempDir, "tombstoned.png"), "hidden");
    fs.writeFileSync(path.join(tempDir, "legacy.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");

    const { mountHome } = require("../lib/home");
    const app = express();
    mountHome(app);
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });

    try {
        assert.equal((await request(server, "GET", "/templates/visible.png")).status, 200);
        assert.equal((await request(server, "GET", "/templates/tombstoned.png")).status, 404);
        assert.equal((await request(server, "GET", "/templates/legacy.svg")).status, 404);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        settings.TEMPLATES_DIR = originalDir;
        settings.isTemplateUsable = originalIsTemplateUsable;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("mobile settings blocks frame-library globals and sanitizes stale references", async () => {
    const settings = require("../lib/settings");
    const originals = {
        getAll: settings.getAll,
        get: settings.get,
        update: settings.update,
        refreshTemplateStateFromDisk: settings.refreshTemplateStateFromDisk,
        sanitizeTemplateReferenceChanges: settings.sanitizeTemplateReferenceChanges,
    };
    const state = {
        eventName: "active",
        maxPrints: 2,
        messages: {},
        templateFile: "new.png",
        templateFilesByOrientation: { portrait: "new.png", landscape: "" },
        templateCompatibilityOverrides: { "new.png": "portrait" },
        templateDeletionTombstones: ["old.png"],
    };
    let sanitizerInput;
    let updateChanges;
    settings.getAll = () => JSON.parse(JSON.stringify(state));
    settings.get = (key) => state[key];
    settings.update = (changes) => { updateChanges = changes; };
    settings.refreshTemplateStateFromDisk = () => {};
    settings.sanitizeTemplateReferenceChanges = (changes) => {
        sanitizerInput = { ...changes };
        return {
            ...changes,
            templateFile: "new.png",
            templateFilesByOrientation: { portrait: "new.png", landscape: "" },
        };
    };

    const { mountReviewSettings } = require("../lib/review-settings");
    const app = express();
    mountReviewSettings(app, (_req, _res, next) => next());
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });

    try {
        const getResponse = await request(server, "GET", "/api/settings");
        assert.equal(Object.hasOwn(getResponse.body, "templateCompatibilityOverrides"), false);
        assert.equal(Object.hasOwn(getResponse.body, "templateDeletionTombstones"), false);

        const response = await request(server, "POST", "/api/settings", {
            _forEvent: "active",
            maxPrints: 3,
            templateFile: "old.png",
            templateFilesByOrientation: { portrait: "old.png", landscape: "missing.png" },
            templateCompatibilityOverrides: { "old.png": "both" },
            templateDeletionTombstones: [],
        });
        assert.equal(response.status, 200);
        assert.equal(Object.hasOwn(sanitizerInput, "templateCompatibilityOverrides"), false);
        assert.equal(Object.hasOwn(sanitizerInput, "templateDeletionTombstones"), false);
        assert.equal(updateChanges.templateFile, "new.png");
        assert.deepEqual(updateChanges.templateFilesByOrientation, { portrait: "new.png", landscape: "" });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        settings.getAll = originals.getAll;
        settings.get = originals.get;
        settings.update = originals.update;
        settings.refreshTemplateStateFromDisk = originals.refreshTemplateStateFromDisk;
        settings.sanitizeTemplateReferenceChanges = originals.sanitizeTemplateReferenceChanges;
    }
});

test("audit revert excludes frame-library globals and sanitizes stale references", () => {
    const { sanitizeRevertChanges } = require("../lib/audit");
    let sanitizerInput;
    const result = sanitizeRevertChanges({
        sanitizeTemplateReferenceChanges(changes) {
            sanitizerInput = changes;
            return { ...changes, templateFile: "new.png" };
        },
    }, {
        maxPrints: 2,
        templateFile: "old.png",
        templateCompatibilityOverrides: { "old.png": "both" },
        templateDeletionTombstones: [],
    });

    assert.deepEqual(sanitizerInput, { maxPrints: 2, templateFile: "old.png" });
    assert.deepEqual(result, { maxPrints: 2, templateFile: "new.png" });
});

test("home UI renders an orientation-independent manager and a compatible-only output selector", () => {
    const { buildHomeHtml } = require("../lib/home");
    const html = buildHomeHtml();
    assert.match(html, /id="frameManager"/);
    assert.match(html, />Native<\/option>/);
    assert.match(html, />Portrait<\/option>/);
    assert.match(html, />Landscape<\/option>/);
    assert.match(html, />Both<\/option>/);
    assert.match(html, />Rename<\/button>/);
    assert.match(html, />Replace image<\/button>/);
    assert.match(html, />Delete<\/button>/);
    assert.match(html, /Compatibility is shared across all events/);
    assert.match(html, /twModal\.prompt\(/);
    assert.match(html, /twModal\.confirm\(/);
    assert.doesNotMatch(html, /templateCompatibilityOverrides: _templateCompatibilityOverrides/);
    assert.match(html, /settings\/template\/compatibility/);
    assert.match(html, /select\.value = previousMode/);

    const selectorCode = html.slice(html.indexOf("function fillTemplateSelect"), html.indexOf("function templateGroup"));
    assert.match(selectorCode, /compatibility === _activeTemplateOrientation \|\| compatibility === "both"/);
    assert.doesNotMatch(selectorCode, /opt\.disabled\s*=/);
    assert.match(selectorCode, /unsupported\.disabled = true/);
    const managerCode = html.slice(html.indexOf("function renderFrameManager"), html.indexOf("function onTemplateChange"));
    assert.match(managerCode, /\(_files\.templates \|\| \[\]\)\.map/);
    assert.doesNotMatch(managerCode, /_activeTemplateOrientation/);
    assert.match(html, /clearIncompatibleTemplateSelections\(\);/);
    assert.match(html, /migrateLocalTemplateReferences\(filename, ""\)/);
    assert.match(html, /Array\.isArray\(result\.files\)/);
    assert.match(html, /if \(!fr\.ok\) throw new Error\("Frame files are temporarily unavailable"\)/);
    assert.doesNotMatch(html, /id="uploadTemplate"[^>]*\.svg/);
    assert.doesNotMatch(html, /id="replaceTemplateInput"[^>]*\.svg/);
    assert.match(html, /type=template&replace=1/);
    assert.match(html, /Unsupported legacy SVG/);
    assert.match(html, /Replace with PNG\/JPEG\/GIF/);

    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        assert.doesNotThrow(() => new vm.Script(match[1]));
    }
});
