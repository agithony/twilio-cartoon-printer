// ── DOM refs ─────────────────────────────────────────────────────────────

const DEFAULT_URL = "https://twilio-cartoon-printer.orangemeadow-7fe73fc6.centralus.azurecontainerapps.io";
const DEFAULT_KEY = "mySecretKey123";
const urlInput = document.getElementById("url");
const keyInput = document.getElementById("key");
const printerSelect = document.getElementById("printer");
const refreshBtn = document.getElementById("refreshPrinters");
const dryRunCheck = document.getElementById("dryRun");
const connectBtn = document.getElementById("connectBtn");

const cloudDot = document.getElementById("cloudDot");
const cloudLabel = document.getElementById("cloudLabel");
const printerDot = document.getElementById("printerDot");
const printerLabel = document.getElementById("printerLabel");
const jobCountEl = document.getElementById("jobCount");
const jobList = document.getElementById("jobList");
const logBox = document.getElementById("logBox");

let connected = false;
const jobs = []; // { filename, style, status, time }
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

    await refreshPrinters(config.printer);
})();

async function refreshPrinters(selectedPrinter) {
    const printers = await window.relay.listPrinters();
    printerSelect.innerHTML = '<option value="">Auto-detect</option>';
    for (const p of printers) {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        if (p === selectedPrinter) opt.selected = true;
        printerSelect.appendChild(opt);
    }
}

refreshBtn.addEventListener("click", () => refreshPrinters(printerSelect.value));

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

    const config = {
        url,
        key,
        printer: printerSelect.value,
        dryRun: dryRunCheck.checked,
    };

    await window.relay.saveConfig(config);
    await window.relay.start(config);
    setConnected();
});

function setConnected() {
    connected = true;
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("active");
    urlInput.disabled = true;
    urlEditBtn.disabled = true;
    keyInput.disabled = true;
    keyEditBtn.disabled = true;
    printerSelect.disabled = true;
    dryRunCheck.disabled = true;
    refreshBtn.disabled = true;
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
    printerSelect.disabled = false;
    dryRunCheck.disabled = false;
    refreshBtn.disabled = false;
    setDot(cloudDot, cloudLabel, "disconnected", "Disconnected");
    setDot(printerDot, printerLabel, "unknown", "Unknown");
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
        const detail = s.printerDetail ? `Error: ${s.printerDetail}` : null;
        setDot(printerDot, printerLabel, s.printer, detail);
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
    } else {
        jobs.unshift({
            filename: j.filename,
            style: j.style || "",
            status: j.status,
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
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
            <span class="job-style">${j.style}</span>
            <span class="job-status ${STATUS_CLASS[j.status] || ""}">${STATUS_LABELS[j.status] || j.status}</span>
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
