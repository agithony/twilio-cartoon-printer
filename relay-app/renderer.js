// ── DOM refs ─────────────────────────────────────────────────────────────

const DEFAULT_URL = "https://twilio-cartoon-printer.orangemeadow-7fe73fc6.centralus.azurecontainerapps.io";
const DEFAULT_KEY = "mySecretKey123";
const urlInput = document.getElementById("url");
const keyInput = document.getElementById("key");
const printerList = document.getElementById("printerList");
const refreshBtn = document.getElementById("refreshPrinters");
const dryRunCheck = document.getElementById("dryRun");
const connectBtn = document.getElementById("connectBtn");

const cloudDot = document.getElementById("cloudDot");
const cloudLabel = document.getElementById("cloudLabel");
const printerStatusList = document.getElementById("printerStatusList");
const jobCountEl = document.getElementById("jobCount");
const jobList = document.getElementById("jobList");
const logBox = document.getElementById("logBox");

let connected = false;
const jobs = []; // { filename, style, status, time, printerName }
const MAX_JOBS = 50;

// ── Init ─────────────────────────────────────────────────────────────────

const urlEditBtn = document.getElementById("urlEditBtn");
const keyEditBtn = document.getElementById("keyEditBtn");

(async function init() {
    const config = await window.relay.getConfig();
    urlInput.value = config.url || DEFAULT_URL;
    keyInput.value = config.key || DEFAULT_KEY;
    dryRunCheck.checked = !!config.dryRun;

    // Lock URL field by default
    urlInput.disabled = true;
    urlEditBtn.addEventListener("click", () => {
        if (urlInput.disabled) {
            urlInput.disabled = false;
            urlEditBtn.textContent = "Lock";
            urlInput.focus();
        } else {
            urlInput.disabled = true;
            urlEditBtn.textContent = "Edit";
        }
    });

    // Lock key field by default
    keyInput.disabled = true;
    keyEditBtn.addEventListener("click", () => {
        if (keyInput.disabled) {
            keyInput.disabled = false;
            keyEditBtn.textContent = "Lock";
            keyInput.focus();
        } else {
            keyInput.disabled = true;
            keyEditBtn.textContent = "Edit";
        }
    });

    // Migrate old "printer" string to "printers" array
    let selectedPrinters = config.printers || [];
    if (!Array.isArray(selectedPrinters)) selectedPrinters = [];
    if (config.printer && typeof config.printer === "string" && selectedPrinters.length === 0) {
        selectedPrinters = [config.printer];
    }

    await refreshPrinters(selectedPrinters);
})();

async function refreshPrinters(selectedPrinters) {
    if (!Array.isArray(selectedPrinters)) {
        // Read from current checkboxes
        selectedPrinters = getSelectedPrinters();
    }
    const printers = await window.relay.listPrinters();
    printerList.innerHTML = "";
    if (printers.length === 0) {
        printerList.innerHTML = '<div class="empty">No printers found</div>';
        return;
    }
    for (const p of printers) {
        const label = document.createElement("label");
        label.className = "printer-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = p;
        cb.checked = selectedPrinters.includes(p);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + p));
        printerList.appendChild(label);
    }
}

function getSelectedPrinters() {
    return Array.from(printerList.querySelectorAll('input[type="checkbox"]:checked'))
        .map(cb => cb.value);
}

refreshBtn.addEventListener("click", () => refreshPrinters());

// ── Connect / Disconnect ─────────────────────────────────────────────────

connectBtn.addEventListener("click", async () => {
    if (connected) {
        await window.relay.stop();
        setDisconnected();
        return;
    }

    const url = urlInput.value.trim();
    const key = keyInput.value.trim();
    if (!url || !key) {
        addLog("Cloud URL and Relay Key are required.");
        return;
    }

    const printers = getSelectedPrinters();

    const config = {
        url,
        key,
        printers,
        dryRun: dryRunCheck.checked,
    };

    await window.relay.saveConfig(config);
    await window.relay.start(config);
    setConnected(printers);
});

function setConnected(printers) {
    connected = true;
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("active");
    urlInput.disabled = true;
    urlEditBtn.disabled = true;
    keyInput.disabled = true;
    keyEditBtn.disabled = true;
    dryRunCheck.disabled = true;
    refreshBtn.disabled = true;

    // Disable printer checkboxes
    printerList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.disabled = true);

    // Build per-printer status cards
    const activePrinters = (printers && printers.length > 0) ? printers : ["auto"];
    printerStatusList.innerHTML = "";
    for (const p of activePrinters) {
        const card = document.createElement("div");
        card.className = "status-card";
        card.dataset.printer = p;
        card.innerHTML = `
            <span class="dot" id="pDot-${cssId(p)}"></span>
            <div>
                <div class="status-label">${escHtml(p || "Printer")}</div>
                <div class="status-value" id="pLabel-${cssId(p)}">Unknown</div>
            </div>
        `;
        printerStatusList.appendChild(card);
    }
}

function setDisconnected() {
    connected = false;
    connectBtn.textContent = "Connect";
    connectBtn.classList.remove("active");
    urlInput.disabled = true;
    urlEditBtn.disabled = false;
    urlEditBtn.textContent = "Edit";
    keyInput.disabled = true;
    keyEditBtn.disabled = false;
    keyEditBtn.textContent = "Edit";
    dryRunCheck.disabled = false;
    refreshBtn.disabled = false;

    // Re-enable printer checkboxes
    printerList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.disabled = false);

    setDot(cloudDot, cloudLabel, "disconnected", "Disconnected");
    printerStatusList.innerHTML = "";
}

// ── Helpers ──────────────────────────────────────────────────────────────

function cssId(name) {
    return (name || "auto").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

// ── Status updates ───────────────────────────────────────────────────────

const STATUS_MAP = {
    connected:    { dot: "green",  label: "Connected" },
    connecting:   { dot: "yellow", label: "Connecting..." },
    disconnected: { dot: "",       label: "Disconnected" },
    error:        { dot: "red",    label: "Error" },
    online:       { dot: "green",  label: "Online" },
    unknown:      { dot: "",       label: "Unknown" },
    "dry-run":    { dot: "yellow", label: "Dry Run" },
};

function setDot(dot, label, status, text) {
    const m = STATUS_MAP[status] || STATUS_MAP.unknown;
    dot.className = "dot" + (m.dot ? " " + m.dot : "");
    label.textContent = text || m.label;
}

window.relay.onStatus((s) => {
    if (s.cloud) setDot(cloudDot, cloudLabel, s.cloud);
    if (s.printer) {
        const id = cssId(s.printerName);
        const dot = document.getElementById(`pDot-${id}`);
        const label = document.getElementById(`pLabel-${id}`);
        if (dot && label) {
            const detail = s.printerDetail ? `Error: ${s.printerDetail}` : null;
            setDot(dot, label, s.printer, detail);
        }
    }
});

// ── Job updates ──────────────────────────────────────────────────────────

const STATUS_LABELS = {
    claiming: "Claiming...",
    downloading: "Downloading...",
    printing: "Printing...",
    done: "Printed",
    failed: "Failed",
    skipped: "Skipped",
};

const STATUS_CLASS = {
    claiming: "downloading",
    downloading: "downloading",
    printing: "printing",
    done: "done",
    failed: "failed",
    skipped: "failed",
};

window.relay.onJob((j) => {
    let existing = jobs.find(x => x.filename === j.filename);
    if (existing) {
        existing.status = j.status;
        if (j.printerName) existing.printerName = j.printerName;
    } else {
        jobs.unshift({
            filename: j.filename,
            style: j.style || "",
            status: j.status,
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            printerName: j.printerName || "",
        });
        if (jobs.length > MAX_JOBS) jobs.pop();
    }
    renderJobs();
});

window.relay.onStats((s) => {
    jobCountEl.textContent = s.jobCount;
});

function renderJobs() {
    if (jobs.length === 0) {
        jobList.innerHTML = '<div class="empty">No jobs yet</div>';
        return;
    }
    jobList.innerHTML = jobs.map(j => `
        <div class="job-entry">
            <span class="job-time">${j.time}</span>
            <span class="job-printer">${escHtml(j.printerName || "")}</span>
            <span class="job-style">${escHtml(j.style)}</span>
            <span class="job-status ${STATUS_CLASS[j.status] || ""}">${STATUS_LABELS[j.status] || escHtml(j.status)}</span>
        </div>
    `).join("");
}

// ── Log ──────────────────────────────────────────────────────────────────

window.relay.onLog((msg) => addLog(msg));

function addLog(msg) {
    const line = document.createElement("div");
    line.className = "log-line";
    line.textContent = msg;
    logBox.appendChild(line);
    // Keep last 100 lines
    while (logBox.children.length > 100) logBox.removeChild(logBox.firstChild);
    logBox.scrollTop = logBox.scrollHeight;
}
