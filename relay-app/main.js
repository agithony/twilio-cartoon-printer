const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { RelayEngine, listPrinters } = require("./relay");

const store = new Store({
    defaults: { url: "", key: "", printers: [], dryRun: false },
});

// Migrate old "printer" (string) → "printers" (array)
if (store.has("printer") && typeof store.get("printer") === "string") {
    const old = store.get("printer");
    if (old && !store.get("printers")?.length) {
        store.set("printers", [old]);
    }
    store.delete("printer");
}

let mainWindow = null;
let relays = new Map(); // printerName -> RelayEngine

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 640,
        resizable: true,
        minWidth: 400,
        minHeight: 500,
        title: "Twilio Print Station",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
    for (const r of relays.values()) r.stop();
    relays.clear();
    app.quit();
});

// ── IPC Handlers ─────────────────────────────────────────────────────────

ipcMain.handle("get-config", () => store.store);

ipcMain.handle("save-config", (_, config) => {
    store.set("url", config.url || "");
    store.set("key", config.key || "");
    store.set("printers", Array.isArray(config.printers) ? config.printers : []);
    store.set("dryRun", !!config.dryRun);
    return store.store;
});

ipcMain.handle("list-printers", async () => {
    return await listPrinters();
});

ipcMain.handle("start-relay", (_, config) => {
    // Stop existing relays
    for (const r of relays.values()) r.stop();
    relays.clear();

    const printers = Array.isArray(config.printers) ? [...config.printers] : [];
    if (printers.length === 0) {
        // Auto-detect: single engine with no printer override (existing behavior)
        printers.push("");
    }

    for (const printer of printers) {
        const engine = new RelayEngine();

        engine.on("log", (msg) => mainWindow?.webContents.send("relay-log", msg));
        engine.on("status", (s) => {
            s.printerName = printer;
            mainWindow?.webContents.send("relay-status", s);
        });
        engine.on("job", (j) => {
            j.printerName = printer;
            mainWindow?.webContents.send("relay-job", j);
        });
        engine.on("stats", () => {
            // Aggregate job count across all engines
            let total = 0;
            for (const r of relays.values()) total += r.jobCount;
            mainWindow?.webContents.send("relay-stats", { jobCount: total });
        });

        engine.start({
            url: config.url,
            key: config.key,
            printer: printer,
            dryRun: !!config.dryRun,
            interval: 5,
        });
        relays.set(printer, engine);
    }
    return true;
});

ipcMain.handle("stop-relay", () => {
    for (const r of relays.values()) r.stop();
    relays.clear();
    return true;
});

// Reprint a completed job. Any running engine can issue the request (they all
// share the same cloud URL + key); we just need one. If nothing is connected,
// tell the renderer so it can prompt the operator to Connect first.
ipcMain.handle("reprint-job", async (_, filename) => {
    const engine = relays.values().next().value;
    if (!engine) return { ok: false, error: "Connect to the cloud first" };
    try {
        const { status, data } = await engine.reprint(filename);
        if (status === 200) return { ok: true };
        return { ok: false, error: (data && data.error) || `HTTP ${status}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
