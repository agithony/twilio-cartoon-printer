const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { RelayEngine, listPrinters } = require("./relay");

const store = new Store({
    defaults: { url: "", key: "", printer: "", dryRun: false },
});

let mainWindow = null;
let relay = null;

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
    if (relay) relay.stop();
    app.quit();
});

// ── IPC Handlers ─────────────────────────────────────────────────────────

ipcMain.handle("get-config", () => store.store);

ipcMain.handle("save-config", (_, config) => {
    store.set("url", config.url || "");
    store.set("key", config.key || "");
    store.set("printer", config.printer || "");
    store.set("dryRun", !!config.dryRun);
    return store.store;
});

ipcMain.handle("list-printers", async () => {
    return await listPrinters();
});

ipcMain.handle("start-relay", (_, config) => {
    if (relay) relay.stop();
    relay = new RelayEngine();

    relay.on("log", (msg) => mainWindow?.webContents.send("relay-log", msg));
    relay.on("status", (s) => mainWindow?.webContents.send("relay-status", s));
    relay.on("job", (j) => mainWindow?.webContents.send("relay-job", j));
    relay.on("stats", (s) => mainWindow?.webContents.send("relay-stats", s));

    relay.start({
        url: config.url,
        key: config.key,
        printer: config.printer || "",
        dryRun: !!config.dryRun,
        interval: 5,
    });
    return true;
});

ipcMain.handle("stop-relay", () => {
    if (relay) {
        relay.stop();
        relay = null;
    }
    return true;
});
