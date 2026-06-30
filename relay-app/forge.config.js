const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const APP_NAME = "Twilio Print Station";

// ── Gatekeeper helper bundled with the distributable ─────────────────────────
// The app is ad-hoc signed (no paid Apple Developer account → no Developer ID
// cert, no notarization). macOS stamps com.apple.quarantine on anything
// downloaded/AirDropped/Slacked, and on Apple Silicon a quarantined ad-hoc app
// opens to the dead-end "app is damaged … Move to Trash" dialog.
//
// A quarantined *shell script*, by contrast, only gets the milder "unidentified
// developer" prompt, which has a right-click → Open escape hatch. So we ship a
// tiny .command beside the app: the operator right-click-Opens it once, it
// strips the quarantine flag off the app and launches it. No terminal, no
// dead end. This is the best achievable UX without a paid Apple account.
const HELPER = `#!/bin/bash
# Twilio Print Station — first-run helper.
# macOS quarantines downloaded apps; this removes that flag and opens the app.
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/${APP_NAME}.app"
if [ ! -d "$APP" ]; then
  osascript -e 'display alert "Twilio Print Station.app not found" message "Keep this helper in the SAME folder as the app, then double-click it again."' >/dev/null 2>&1
  exit 1
fi
# Strip the quarantine flag that triggers the "app is damaged" dialog.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
# Launch it.
open "$APP"
`;

const README = `Twilio Print Station — START HERE
==================================

macOS protects you from apps downloaded outside the App Store. Because this
app is distributed directly (not through Apple), the FIRST time you open it on
a new Mac you need to do ONE of the following. After that it opens normally.

EASIEST (no Terminal):
  1. Right-click  "Open Twilio Print Station.command"  →  Open
  2. If macOS warns about an unidentified developer, click  Open  again.
  3. The app launches. You're done — open the app directly from now on.

If you double-clicked the app first and saw "Twilio Print Station is damaged":
  That's the same macOS protection. Don't move it to Trash — just use the
  helper above (right-click the .command → Open). It fixes the app.

ALTERNATIVE (Terminal one-liner):
  Open Terminal, paste this, press Return:
    xattr -dr com.apple.quarantine "$(dirname "$0")/${APP_NAME}.app" 2>/dev/null; open "$(dirname "$0")/${APP_NAME}.app"

Keep the app and this helper together in the same folder.
`;

module.exports = {
    packagerConfig: {
        name: APP_NAME,
        icon: "./build/icon",
    },
    makers: [
        {
            name: "@electron-forge/maker-zip",
            platforms: ["darwin"],
        },
    ],
    hooks: {
        // After the .app and its plain zip are built, assemble a distribution
        // folder pairing the app with the un-quarantine helper + README, and
        // zip THAT. The plain maker-zip output is left in place; the
        // "(start here)" zip is the one to hand to event staff.
        postMake: async (_forgeConfig, makeResults) => {
            const version = require("./package.json").version;
            for (const result of makeResults) {
                const arch = result.arch;
                if (result.platform !== "darwin") continue;
                const appPath = path.resolve(__dirname, "out", `${APP_NAME}-darwin-${arch}`, `${APP_NAME}.app`);
                if (!fs.existsSync(appPath)) {
                    console.warn(`⚠️  postMake: ${APP_NAME}.app not found for ${arch}, skipping bundle`);
                    continue;
                }

                const distName = `${APP_NAME} ${version}`;
                const stage = path.resolve(__dirname, "out", "dist-bundle", distName);
                fs.rmSync(stage, { recursive: true, force: true });
                fs.mkdirSync(stage, { recursive: true });

                // ditto preserves the app's ad-hoc signature + symlinks.
                // execFileSync (arg array, no shell) so the spaces in the app
                // name need no quoting and nothing is interpolated into a shell.
                execFileSync("ditto", [appPath, path.join(stage, `${APP_NAME}.app`)]);
                fs.writeFileSync(path.join(stage, `Open ${APP_NAME}.command`), HELPER, { mode: 0o755 });
                fs.writeFileSync(path.join(stage, "READ ME FIRST.txt"), README);

                const outZip = path.resolve(__dirname, "out", "make", `${distName} (start here).zip`);
                fs.rmSync(outZip, { force: true });
                // keepParent so it unzips into the "<App> <version>" folder.
                execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", stage, outZip]);
                console.log(`\n📦 Distribution bundle (hand THIS to staff): ${outZip}`);
            }
            return makeResults;
        },
    },
};
