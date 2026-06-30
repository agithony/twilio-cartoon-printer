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

// Re-queue a completed job for printing. The button is disabled while the
// request is in flight so a double-click can't double-queue. On success the
// cloud moves the job back to ready/ and a relay worker reprints it on its
// next poll — the job row will transition through claiming → printing → done
// again on its own.
async function reprintJob(filename, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Reprinting…"; }
    try {
        const res = await window.relay.reprint(filename);
        if (res && res.ok) {
            addLog(`Reprint queued: ${filename}`);
        } else {
            addLog(`Reprint failed: ${(res && res.error) || "unknown error"}`);
            if (btn) { btn.disabled = false; btn.textContent = "Reprint"; }
        }
    } catch (err) {
        addLog(`Reprint failed: ${err.message}`);
        if (btn) { btn.disabled = false; btn.textContent = "Reprint"; }
    }
}

window.relay.onJob((j) => {
    let existing = jobs.find(x => x.filename === j.filename);
    if (existing) {
        // Partial updates arrive on state transitions (claiming → downloading →
        // printing → done). Merge each new field rather than overwriting, so
        // a later emit that only carries status: "done" doesn't blank out the
        // thumbnail or masked phone we captured earlier.
        if (j.status !== undefined) existing.status = j.status;
        if (j.printerName) existing.printerName = j.printerName;
        if (j.userPhone) existing.userPhone = j.userPhone;
        if (j.style) existing.style = j.style;
        if (j.thumbPath) existing.thumbPath = j.thumbPath;
    } else {
        jobs.unshift({
            filename: j.filename,
            style: j.style || "",
            status: j.status,
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            printerName: j.printerName || "",
            userPhone: j.userPhone || "",
            thumbPath: j.thumbPath || "",
        });
        if (jobs.length > MAX_JOBS) jobs.pop();
    }
    renderJobs();
});

window.relay.onStats((s) => {
    jobCountEl.textContent = s.jobCount;
});

function renderJobs() {
    // Build via DOM methods (not innerHTML) so caller-supplied strings
    // like printerName or style can never inject markup, even though
    // they're currently controlled server-side. Matches the safety
    // posture of tw-modal.js.
    if (jobs.length === 0) {
        while (jobList.firstChild) jobList.removeChild(jobList.firstChild);
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No jobs yet";
        jobList.appendChild(empty);
        return;
    }
    const frag = document.createDocumentFragment();
    for (const j of jobs) {
        const row = document.createElement("div");
        row.className = "job-entry";

        const time = document.createElement("span");
        time.className = "job-time";
        time.textContent = j.time;
        row.appendChild(time);

        // Thumbnail: file:// URL to the relay's temp dir (the engine
        // downloads it via auth'd HTTP after claim). If we haven't received
        // thumbPath yet the first render shows the empty placeholder;
        // the next emit with thumbPath re-renders with the real <img>.
        if (j.thumbPath) {
            const img = document.createElement("img");
            img.className = "job-thumb";
            // encodeURI preserves path separators but escapes spaces/etc.
            img.src = "file://" + encodeURI(j.thumbPath);
            img.alt = "";
            img.onerror = () => { img.remove(); };
            row.appendChild(img);
        } else {
            const placeholder = document.createElement("span");
            placeholder.className = "job-thumb-empty";
            row.appendChild(placeholder);
        }

        const phone = document.createElement("span");
        phone.className = "job-phone" + (j.userPhone ? "" : " job-phone-empty");
        phone.textContent = j.userPhone || "—";
        row.appendChild(phone);

        const style = document.createElement("span");
        style.className = "job-style";
        style.textContent = j.style || "";
        row.appendChild(style);

        const printer = document.createElement("span");
        printer.className = "job-printer";
        printer.title = j.printerName || "";
        printer.textContent = j.printerName || "";
        row.appendChild(printer);

        const status = document.createElement("span");
        status.className = "job-status" + (STATUS_CLASS[j.status] ? " " + STATUS_CLASS[j.status] : "");
        status.textContent = STATUS_LABELS[j.status] || j.status || "";
        row.appendChild(status);

        // Reprint action. Offered once a job has reached a terminal state
        // (printed or failed) — those are the jobs that exist in the cloud's
        // done/ queue and can be re-queued. In-flight jobs (claiming/
        // downloading/printing) get no button; reprinting them would risk a
        // double print. The server re-validates (must be in done/, image must
        // exist) and rejects otherwise, so this is just a convenience gate.
        if (j.status === "done" || j.status === "failed") {
            const btn = document.createElement("button");
            btn.className = "job-reprint-btn";
            btn.textContent = "Reprint";
            btn.title = "Print this portrait again";
            btn.addEventListener("click", () => reprintJob(j.filename, btn));
            row.appendChild(btn);
        } else {
            // Keep the grid column aligned for rows without a button.
            const spacer = document.createElement("span");
            spacer.className = "job-reprint-spacer";
            row.appendChild(spacer);
        }

        frag.appendChild(row);
    }
    while (jobList.firstChild) jobList.removeChild(jobList.firstChild);
    jobList.appendChild(frag);
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
