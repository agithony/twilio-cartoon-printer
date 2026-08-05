const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relay", {
    getConfig: () => ipcRenderer.invoke("get-config"),
    saveConfig: (config) => ipcRenderer.invoke("save-config", config),
    listPrinters: () => ipcRenderer.invoke("list-printers"),
    start: (config) => ipcRenderer.invoke("start-relay", config),
    stop: () => ipcRenderer.invoke("stop-relay"),
    reprint: (filename, printerName) => ipcRenderer.invoke("reprint-job", filename, printerName),
    saveImage: (sourcePath) => ipcRenderer.invoke("save-job-image", sourcePath),

    onLog: (cb) => ipcRenderer.on("relay-log", (_, msg) => cb(msg)),
    onStatus: (cb) => ipcRenderer.on("relay-status", (_, s) => cb(s)),
    onJob: (cb) => ipcRenderer.on("relay-job", (_, j) => cb(j)),
    onStats: (cb) => ipcRenderer.on("relay-stats", (_, s) => cb(s)),
});
