const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const appPath = process.env.PRINT_STATION_APP;
const sourceResources = path.join(__dirname, "..", "relay-app");
const sourcePackageJson = JSON.parse(fs.readFileSync(path.join(sourceResources, "package.json"), "utf-8"));

test("Print Station source package wires the persistent output-folder picker", () => {
    const index = fs.readFileSync(path.join(sourceResources, "index.html"), "utf-8");
    const main = fs.readFileSync(path.join(sourceResources, "main.js"), "utf-8");
    const preload = fs.readFileSync(path.join(sourceResources, "preload.js"), "utf-8");
    const renderer = fs.readFileSync(path.join(sourceResources, "renderer.js"), "utf-8");

    assert.match(index, /id="outputDirectory"/);
    assert.match(index, /id="chooseOutputDirectory"/);
    assert.match(index, /id="clearOutputDirectory"/);
    assert.match(main, /ipcMain\.handle\("choose-output-directory"/);
    assert.match(main, /properties:\s*\["openDirectory", "createDirectory"\]/);
    assert.match(preload, /chooseOutputDirectory:\s*\(\) => ipcRenderer\.invoke\("choose-output-directory"\)/);
    assert.match(preload, /setOutputDirectory:/);
    assert.match(renderer, /window\.relay\.chooseOutputDirectory\(\)/);
    assert.match(renderer, /window\.relay\.setOutputDirectory\(""\)/);
});

test("packaged Print Station is ad-hoc signed and contains tested print modules", { skip: !appPath }, () => {
    const resources = path.join(appPath, "Contents", "Resources", "app");
    const packageJson = JSON.parse(fs.readFileSync(path.join(resources, "package.json"), "utf-8"));
    const info = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")], { encoding: "utf-8" }).trim();
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
    const signature = spawnSync("codesign", ["-d", "--verbose=4", appPath], { encoding: "utf-8" });
    const { buildPrintCommand } = require(path.join(resources, "cups-command.js"));

    assert.equal(signature.status, 0, signature.stderr);
    assert.match(signature.stderr, /Signature=adhoc/);
    assert.equal(packageJson.version, sourcePackageJson.version);
    assert.equal(info, sourcePackageJson.version);
    assert.equal(fs.existsSync(path.join(resources, "job-files.js")), true);
    assert.equal(fs.existsSync(path.join(resources, "relay.js")), true);
    assert.match(fs.readFileSync(path.join(resources, "index.html"), "utf-8"), /id="outputDirectory"/);
    assert.match(fs.readFileSync(path.join(resources, "main.js"), "utf-8"), /properties:\s*\["openDirectory", "createDirectory"\]/);
    assert.match(fs.readFileSync(path.join(resources, "preload.js"), "utf-8"), /chooseOutputDirectory/);
    assert.match(fs.readFileSync(path.join(resources, "renderer.js"), "utf-8"), /setOutputDirectory\(""\)/);
    const command = buildPrintCommand({
        filepath: "/tmp/output.png",
        printerName: "EPSON_ET_8550_Series",
        outputProfile: { printSize: "6x4", printQuality: "high", orientation: "landscape" },
    });
    assert.match(command, /PageSize=EPKG\.NMgn/);
    assert.match(command, /orientation-requested=4/);
});
