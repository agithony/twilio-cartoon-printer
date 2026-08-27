// Relay Engine — adapted from scripts/print-relay.js for use in Electron.
// Emits events instead of console.log, controlled via start/stop.

const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { EventEmitter } = require("events");
const { buildPrintCommand } = require("./cups-command");
const { RELAY_TEMP_DIR, cleanupOldRelayFiles, autoSaveRelayImage } = require("./job-files");
const RELAY_VERSION = require("./package.json").version;

class RelayEngine extends EventEmitter {
    constructor() {
        super();
        this.running = false;
        this.polling = false;
        this.interval = null;
        this.config = null;
        this.processedJobs = new Map();
        this.PROCESSED_TTL = 10 * 60 * 1000; // 10 min (must be < server's 15-min stale threshold)
        this.jobCount = 0;
        this.consecutiveErrors = 0;
        this.basePollMs = 5000;
        this.tempDir = RELAY_TEMP_DIR;
        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
        cleanupOldRelayFiles().catch(() => {});
        // Heartbeat timer active while the relay holds a claimed job. Pings
        // the cloud every HEARTBEAT_MS so the cloud can recover the job
        // within seconds if the relay crashes or hangs, instead of waiting
        // the 15-minute printingAt-based stale threshold.
        this.heartbeatTimer = null;
        this.activeHeartbeat = null;
        this.HEARTBEAT_MS = 20 * 1000;
        this.COMPLETION_RETRY_MS = 3000;
        // Cached cloud settings (refreshed in background every STATUS_REFRESH_MS).
        // Avoids a blocking /status fetch before every single print — makes
        // prints resilient to brief cloud hiccups and drops per-print latency.
        this.cachedStatus = null;
        this.cachedStatusAt = 0;
        this.statusRefreshTimer = null;
        this.STATUS_REFRESH_MS = 60 * 1000;
        this.printerCapabilities = new Map();
        this.cacheCleanupTimer = setInterval(() => cleanupOldRelayFiles().catch(() => {}), 60 * 60 * 1000);
        if (this.cacheCleanupTimer.unref) this.cacheCleanupTimer.unref();
    }

    start(config) {
        if (this.running) return;
        this.config = config;
        this.running = true;
        this.log("Starting relay...");
        this.emit("status", { cloud: "connecting", printer: "unknown" });

        // Verify connectivity then start polling
        this._verifyAndStart();
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        if (this.interval) {
            clearTimeout(this.interval);
            this.interval = null;
        }
        this._stopHeartbeat();
        if (this.statusRefreshTimer) {
            clearInterval(this.statusRefreshTimer);
            this.statusRefreshTimer = null;
        }
        if (this.cacheCleanupTimer) {
            clearInterval(this.cacheCleanupTimer);
            this.cacheCleanupTimer = null;
        }
        this.log("Relay stopped.");
        this.emit("status", { cloud: "disconnected", printer: "unknown" });
    }

    // Ask the cloud to re-queue a terminal job so it prints again. The job
    // re-enters ready/ server-side and this (or any) relay claims it on the
    // next poll — no need to target a specific printer. Returns the parsed
    // { status, data } so the caller can surface success/failure to the UI.
    async reprint(filename) {
        const printerName = this.config && this.config.printer || null;
        const { status, data } = await this._request("POST", `/api/print-relay/jobs/${filename}/reprint`, { printerName });
        if (status === 200) {
            this.processedJobs.delete(filename);
            this.log(`Reprint queued: ${filename}`);
        } else {
            this.log(`Reprint failed for ${filename}: ${(data && data.error) || `HTTP ${status}`}`);
        }
        return { status, data };
    }

    async _verifyAndStart() {
        // Check cloud + seed the status cache in one call
        try {
            const { status, data } = await this._request("GET", "/api/print-relay/status");
            if (status === 200) {
                this.cachedStatus = data;
                this.cachedStatusAt = Date.now();
                this.log(`Connected to cloud (size: ${data.printSize}, quality: ${data.printQuality})`);
                this.emit("status", { cloud: "connected" });
            } else {
                this.log(`Cloud returned HTTP ${status}: ${JSON.stringify(data)}`);
                this.emit("status", { cloud: "error" });
            }
        } catch (err) {
            this.log(`Cannot reach cloud: ${err.message}`);
            this.emit("status", { cloud: "error" });
        }

        // Check printer
        if (!this.config.dryRun) {
            try {
                const printer = await this._findPrinter();
                this.log(`Printer found: ${printer}`);
                this.emit("status", { printer: "online" });
            } catch (err) {
                this.log(`Printer: ${err.message}`);
                this.emit("status", { printer: "error" });
            }
        } else {
            this.log("Dry run mode — skipping printer check");
            this.emit("status", { printer: "dry-run" });
        }

        if (!this.running) return;
        this.log("Polling for print jobs...");
        this.basePollMs = (this.config.interval || 5) * 1000;
        // Background-refresh the cloud status cache so printSize/printQuality
        // stay fresh without blocking any individual print. If the refresh
        // errors, we silently keep serving the last known values — a transient
        // cloud hiccup won't cause a print to fail.
        this.statusRefreshTimer = setInterval(() => {
            this._request("GET", "/api/print-relay/status").then(({ status, data }) => {
                if (status === 200 && this.running) {
                    this.cachedStatus = data;
                    this.cachedStatusAt = Date.now();
                }
            }).catch(() => { /* keep stale cache */ });
        }, this.STATUS_REFRESH_MS);
        // First poll immediate, then schedule subsequent polls
        this._pollOnce().finally(() => this._schedulePoll());
    }

    _schedulePoll() {
        if (!this.running) return;
        const delay = Math.min(this.basePollMs * Math.pow(2, this.consecutiveErrors), 120000);
        this.interval = setTimeout(() => {
            this._pollOnce().finally(() => this._schedulePoll());
        }, delay);
    }

    async _pollOnce() {
        if (this.polling || !this.running) return;
        this.polling = true;

        try {
            this._cleanupProcessedJobs();
            const printerParam = this.config.printer ? `?printer=${encodeURIComponent(this.config.printer)}` : "";
            const { status, data } = await this._request("GET", `/api/print-relay/jobs${printerParam}`);
            if (status !== 200) {
                this.consecutiveErrors++;
                this.log(`Poll failed: HTTP ${status} (retry in ${Math.min(this.basePollMs * Math.pow(2, this.consecutiveErrors), 120000) / 1000}s)`);
                this.emit("status", { cloud: "error" });
                return;
            }
            this.consecutiveErrors = 0;
            this.emit("status", { cloud: "connected" });

            const jobs = data.jobs || [];
            if (jobs.length === 0) return;

            let printerName = "dry-run";
            if (!this.config.dryRun) {
                try {
                    printerName = await this._findPrinter();
                    this.emit("status", { printer: "online" });
                } catch (err) {
                    this.log(`Printer error: ${err.message}`);
                    this.emit("status", { printer: "error" });
                    return;
                }
            }

            for (const job of jobs) {
                if (!this.running) break;
                if (this.processedJobs.has(job.filename)) continue;

                this.log(`Found job: ${job.filename} (${job.style})`);
                // Include userPhone (already masked server-side) on every emit
                // so the renderer can show a dashboard-style row without
                // looking up metadata on state changes. filename is the key;
                // additional fields here are additive for older renderers.
                this.emit("job", {
                    filename: job.filename,
                    style: job.style,
                    event: job.eventName,
                    userPhone: job.userPhone || null,
                    status: "claiming",
                });

                const ack = await this._request("POST", `/api/print-relay/jobs/${job.filename}/ack`, { printerName });
                if (ack.status !== 200) {
                    this.log(`Failed to claim ${job.filename}: ${JSON.stringify(ack.data)}`);
                    if (ack.status === 400 || ack.status === 404) {
                        this.processedJobs.set(job.filename, Date.now());
                    }
                    this.emit("job", { filename: job.filename, status: "skipped" });
                    continue;
                }

                const ackData = ack.data.job;
                const imageUrl = `/api/print-relay/image/${encodeURIComponent(ackData.eventName)}/${ackData.imageFile}`;
                const localPath = path.join(this.tempDir, ackData.imageFile);

                // Start heartbeating for this job. If the relay crashes,
                // hangs, or the operator closes the window, the timer dies
                // with the process and the cloud sees missing heartbeats
                // and recovers the job within ~60s instead of 15 minutes.
                this._startHeartbeat(job.filename, ackData.claimId);

                let imageDownloaded = false;
                let printSucceeded = false;
                try {
                    this.log(`Downloading ${ackData.imageFile}...`);
                    this.emit("job", {
                        filename: job.filename,
                        userPhone: ackData.userPhone || job.userPhone || null,
                        status: "downloading",
                    });
                    await this._downloadFile(imageUrl, localPath);
                    imageDownloaded = true;
                    this.emit("job", { filename: job.filename, thumbPath: localPath, imagePath: localPath });
                    if (this.config.outputDirectory) {
                        autoSaveRelayImage(localPath, this.config.outputDirectory).then((savedPath) => {
                            this.log(`Portrait saved automatically: ${savedPath}`);
                            this.emit("job", { filename: job.filename, savedPath });
                        }).catch((saveErr) => {
                            this.log(`Automatic save failed (printing will continue): ${saveErr.message}`);
                        });
                    }

                    if (this.config.dryRun) {
                        this.log(`[DRY RUN] Would print: ${ackData.imageFile}`);
                        printSucceeded = true;
                        await this._completeJob(job.filename, { success: true, claimId: ackData.claimId });
                    } else {
                        this.log(`Printing ${ackData.imageFile} on ${printerName}...`);
                        this.emit("job", { filename: job.filename, status: "printing" });
                        await this._printImage(localPath, printerName, ackData.outputProfile);
                        printSucceeded = true;
                        await this._completeJob(job.filename, { success: true, claimId: ackData.claimId });
                    }

                    this.jobCount++;
                    this.log(`Job ${job.filename} completed`);
                    this.emit("job", { filename: job.filename, status: "done" });
                    this.emit("stats", { jobCount: this.jobCount });
                    this.processedJobs.set(job.filename, Date.now());
                    cleanupOldRelayFiles().catch(() => {});
                } catch (err) {
                    this.log(`Print failed: ${job.filename} — ${err.message}`);
                    const isPrinterError = /printer is |timed out/i.test(err.message);
                    this.emit("job", { filename: job.filename, status: "failed", error: err.message });
                    if (printSucceeded) {
                        this.log(`Physical print succeeded but cloud completion was not accepted: ${err.message}`);
                        this.processedJobs.set(job.filename, Date.now());
                    } else if (isPrinterError) {
                        // Report failure so server re-queues the job to ready/
                        // immediately — another printer's engine can claim it
                        // on its next poll (~5s) instead of waiting 15 min.
                        await this._completeJob(job.filename, {
                            success: false, error: err.message, claimId: ackData.claimId,
                        });
                        this.processedJobs.set(job.filename, Date.now());
                        const reason = err.message.replace(/^Printer is /i, "").replace(/^Print job timed out.*/, "offline or stuck");
                        this.emit("status", { printer: "error", printerDetail: reason });
                        this._stopHeartbeat();
                        break; // Stop claiming more jobs — this printer is broken
                    } else {
                        // Non-printer error (download fail, etc.) — report to server
                        await this._completeJob(job.filename, {
                            success: false, error: err.message, claimId: ackData.claimId,
                        });
                    }
                } finally {
                    this._stopHeartbeat();
                    if (!imageDownloaded) {
                        try { fs.unlinkSync(localPath); } catch {}
                    }
                }
            }
        } catch (err) {
            this.consecutiveErrors++;
            this.log(`Poll error: ${err.message} (retry in ${Math.min(this.basePollMs * Math.pow(2, this.consecutiveErrors), 120000) / 1000}s)`);
            this.emit("status", { cloud: "error" });
        } finally {
            this.polling = false;
        }
    }

    log(msg) {
        const ts = new Date().toLocaleTimeString();
        this.emit("log", `[${ts}] ${msg}`);
    }

    _startHeartbeat(filename, claimId) {
        // Defensive: clear any previous timer first. Should never happen
        // (heartbeats are scoped to one job at a time by the serial
        // job loop), but if it ever does we'd rather leak the old
        // filename than double-beat.
        this._stopHeartbeat();
        const heartbeat = { filename, claimId, timer: null };
        this.activeHeartbeat = heartbeat;
        const beat = () => {
            this._request("POST", `/api/print-relay/jobs/${filename}/heartbeat`, { claimId })
                .then(({ status }) => {
                    // A late response from an old job must not stop a newer
                    // job's heartbeat, so only the active token may clear it.
                    if ((status === 404 || status === 409) && this.activeHeartbeat === heartbeat) {
                        this._stopHeartbeat(heartbeat);
                    } else if (status !== 200) {
                        // Other errors are noisy in the logs but not fatal.
                        // The cloud will recover on missing beats.
                    }
                })
                .catch(() => { /* network blip, next beat will retry */ });
        };
        heartbeat.timer = setInterval(beat, this.HEARTBEAT_MS);
        this.heartbeatTimer = heartbeat.timer;
        beat();
    }

    _stopHeartbeat(expectedHeartbeat = null) {
        if (expectedHeartbeat && this.activeHeartbeat !== expectedHeartbeat) return;
        const timer = this.activeHeartbeat && this.activeHeartbeat.timer || this.heartbeatTimer;
        if (timer) clearInterval(timer);
        this.activeHeartbeat = null;
        this.heartbeatTimer = null;
    }

    async _completeJob(filename, payload, attempts = 20) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                const result = await this._request("POST", `/api/print-relay/jobs/${filename}/complete`, payload);
                if (result.status === 200 && result.data && result.data.ok === true) return result.data;
                if (result.status === 409) throw new Error("Print claim was recovered by another station");
                lastError = new Error(`Cloud completion failed: HTTP ${result.status}${result.data && result.data.error ? ` (${result.data.error})` : ""}`);
            } catch (err) {
                lastError = err;
                if (/recovered by another station/.test(err.message)) throw err;
            }
            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, this.COMPLETION_RETRY_MS));
        }
        throw lastError || new Error("Cloud completion failed");
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    _request(method, urlPath, body) {
        return new Promise((resolve, reject) => {
            const fullUrl = new URL(urlPath, this.config.url);
            const mod = fullUrl.protocol === "https:" ? https : http;
            const options = {
                method,
                hostname: fullUrl.hostname,
                port: fullUrl.port,
                path: fullUrl.pathname + fullUrl.search,
                headers: {
                    "x-relay-key": this.config.key,
                    "x-relay-version": RELAY_VERSION,
                    "Content-Type": "application/json",
                },
                timeout: 30000,
            };
            const req = mod.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk);
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode, data });
                    }
                });
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
            req.on("error", reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    _downloadFile(urlPath, dest) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let ws = null;
            const fail = (err) => {
                if (settled) return;
                settled = true;
                if (ws) ws.destroy();
                try { fs.unlinkSync(dest); } catch {}
                reject(err);
            };
            const succeed = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const fullUrl = new URL(urlPath, this.config.url);
            const mod = fullUrl.protocol === "https:" ? https : http;
            const options = {
                hostname: fullUrl.hostname,
                port: fullUrl.port,
                path: fullUrl.pathname + fullUrl.search,
                headers: { "x-relay-key": this.config.key, "x-relay-version": RELAY_VERSION },
                timeout: 60000,
            };
            const req = mod.get(options, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    fail(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }
                // Track bytes so we can verify the download completed.
                // Without this check, a mid-stream network drop would
                // write a truncated file to disk and we'd happily send
                // it to CUPS to print a partial/garbage page.
                const expected = parseInt(res.headers["content-length"] || "0", 10);
                let received = 0;
                res.on("data", (chunk) => { received += chunk.length; });
                ws = fs.createWriteStream(dest);
                res.pipe(ws);
                res.on("aborted", () => fail(new Error("Download aborted before completion")));
                res.on("error", fail);
                ws.on("finish", () => {
                    ws.close(() => {
                        if (expected > 0 && received !== expected) {
                            return fail(new Error(
                                `Download truncated: expected ${expected} bytes, got ${received}`,
                            ));
                        }
                        if (received === 0) {
                            return fail(new Error("Download produced an empty file"));
                        }
                        succeed();
                    });
                });
                ws.on("error", fail);
            });
            req.on("timeout", () => { req.destroy(); fail(new Error("Download timed out")); });
            req.on("error", fail);
        });
    }

    // ── Printer helpers ──────────────────────────────────────────────────────

    _findPrinter() {
        return new Promise((resolve, reject) => {
            exec("lpstat -p", (err, stdout) => {
                if (err) return reject(new Error(`Cannot list printers: ${err.message}`));
                const lines = stdout.split("\n").filter(l => l.startsWith("printer "));
                const BAD = ["looking for printer", "disabled", "unplugged or turned off"];
                const printers = lines.map(l => ({ name: l.split(" ")[1], lower: l.toLowerCase() }));
                const override = this.config.printer;
                if (override) {
                    const match = printers.find(p => p.name === override);
                    if (match) return resolve(match.name);
                    return reject(new Error(`Printer "${override}" not found`));
                }
                const healthy = printers.filter(p => !BAD.some(b => p.lower.includes(b)));
                if (healthy.length > 0) resolve(healthy[0].name);
                else if (printers.length > 0) reject(new Error(`All printers unhealthy: ${printers.map(p => p.name).join(", ")}`));
                else reject(new Error("No printers found"));
            });
        });
    }

    async _printerCapabilities(printerName) {
        if (this.printerCapabilities.has(printerName)) return this.printerCapabilities.get(printerName);
        const capabilities = await new Promise((resolve) => {
            execFile("lpoptions", ["-p", printerName, "-l"], { timeout: 10000 }, (err, stdout) => resolve(err ? "" : stdout));
        });
        this.printerCapabilities.set(printerName, capabilities);
        return capabilities;
    }

    async _printImage(filepath, printerName, outputProfile) {
        const data = this.cachedStatus || {};
        const printerCapabilities = await this._printerCapabilities(printerName);
        const command = buildPrintCommand({
            filepath,
            printerName,
            printerCapabilities,
            printSize: data.printSize,
            printQuality: data.printQuality,
            customFlags: data.customPrintFlags || "",
            outputProfile: outputProfile || data.outputProfile || null,
        });
        this.log(`Sending to printer: ${command}`);
        return new Promise((resolve, reject) => {
            exec(command, { timeout: 60000 }, (err, stdout) => {
                if (err) return reject(err);
                this.log(`Print job accepted: ${stdout.trim()}`);
                const match = stdout.match(/request id is (\S+)/);
                if (!match) return resolve();
                this._waitForPrintComplete(match[1], printerName, resolve, reject);
            });
        });
    }

    _waitForPrintComplete(requestId, printerName, resolve, reject) {
        const startTime = Date.now();
        const TIMEOUT = 5 * 60 * 1000;
        const PRINTER_ERRORS = ["stopped", "offline", "unplugged", "paused"];

        const poll = () => {
            if (Date.now() - startTime > TIMEOUT) {
                this.log(`Print job ${requestId} timed out after 5 minutes`);
                exec(`cancel ${requestId}`, () => {});
                return reject(new Error("Print job timed out — printer may be offline or stuck"));
            }
            // Check if job is still queued
            exec("lpstat -o", (err, stdout) => {
                if (err || !stdout.includes(requestId)) {
                    this.log(`Print job ${requestId} completed`);
                    return resolve();
                }
                // Check THIS printer's status (not all printers) to avoid
                // false errors when another printer is stopped/paused
                exec(`lpstat -p "${printerName}"`, (perr, pstdout) => {
                    if (perr) { setTimeout(poll, 3000); return; }
                    const lower = pstdout.toLowerCase();
                    const errorFound = PRINTER_ERRORS.find(e => lower.includes(e))
                        || (lower.includes(" is error") ? "error" : null);
                    if (errorFound) {
                        this.log(`Print job ${requestId} failed — printer ${printerName} is ${errorFound}`);
                        exec(`cancel ${requestId}`, () => {});
                        return reject(new Error(`Printer is ${errorFound}`));
                    }
                    setTimeout(poll, 3000);
                });
            });
        };
        setTimeout(poll, 3000);
    }

    _cleanupProcessedJobs() {
        const cutoff = Date.now() - this.PROCESSED_TTL;
        for (const [key, ts] of this.processedJobs) {
            if (ts < cutoff) this.processedJobs.delete(key);
        }
    }
}

// ── Printer listing (standalone, used before relay starts) ───────────────

function listPrinters() {
    return new Promise((resolve) => {
        exec("lpstat -p", (err, stdout) => {
            if (err) { resolve([]); return; }
            const printers = stdout.split("\n")
                .filter(l => l.startsWith("printer "))
                .map(l => l.split(" ")[1])
                .filter(Boolean);
            resolve(printers);
        });
    });
}

module.exports = { RelayEngine, listPrinters };
