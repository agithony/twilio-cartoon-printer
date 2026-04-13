// Relay Engine — adapted from scripts/print-relay.js for use in Electron.
// Emits events instead of console.log, controlled via start/stop.

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { EventEmitter } = require("events");

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
        this.tempDir = path.join(require("os").tmpdir(), "print-relay-temp");
        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
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
        this.log("Relay stopped.");
        this.emit("status", { cloud: "disconnected", printer: "unknown" });
    }

    async _verifyAndStart() {
        // Check cloud
        try {
            const { status, data } = await this._request("GET", "/api/print-relay/status");
            if (status === 200) {
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
                this.emit("job", { filename: job.filename, style: job.style, event: job.eventName, status: "claiming" });

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

                try {
                    this.log(`Downloading ${ackData.imageFile}...`);
                    this.emit("job", { filename: job.filename, status: "downloading" });
                    await this._downloadFile(imageUrl, localPath);

                    if (this.config.dryRun) {
                        this.log(`[DRY RUN] Would print: ${ackData.imageFile}`);
                        await this._request("POST", `/api/print-relay/jobs/${job.filename}/complete`, { success: true });
                    } else {
                        this.log(`Printing ${ackData.imageFile} on ${printerName}...`);
                        this.emit("job", { filename: job.filename, status: "printing" });
                        await this._printImage(localPath, printerName);
                        await this._request("POST", `/api/print-relay/jobs/${job.filename}/complete`, { success: true });
                    }

                    this.jobCount++;
                    this.log(`Job ${job.filename} completed`);
                    this.emit("job", { filename: job.filename, status: "done" });
                    this.emit("stats", { jobCount: this.jobCount });
                    this.processedJobs.set(job.filename, Date.now());
                } catch (err) {
                    this.log(`Print failed: ${job.filename} — ${err.message}`);
                    const isPrinterError = /printer is |timed out/i.test(err.message);
                    this.emit("job", { filename: job.filename, status: "failed", error: err.message });
                    if (isPrinterError) {
                        // Report failure so server re-queues the job to ready/
                        // immediately — another printer's engine can claim it
                        // on its next poll (~5s) instead of waiting 15 min.
                        await this._request("POST", `/api/print-relay/jobs/${job.filename}/complete`, {
                            success: false, error: err.message,
                        }).catch(() => {});
                        this.processedJobs.set(job.filename, Date.now());
                        const reason = err.message.replace(/^Printer is /i, "").replace(/^Print job timed out.*/, "offline or stuck");
                        this.emit("status", { printer: "error", printerDetail: reason });
                        break; // Stop claiming more jobs — this printer is broken
                    } else {
                        // Non-printer error (download fail, etc.) — report to server
                        await this._request("POST", `/api/print-relay/jobs/${job.filename}/complete`, {
                            success: false, error: err.message,
                        }).catch(() => {});
                    }
                } finally {
                    try { fs.unlinkSync(localPath); } catch {}
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
            const fullUrl = new URL(urlPath, this.config.url);
            const mod = fullUrl.protocol === "https:" ? https : http;
            const options = {
                hostname: fullUrl.hostname,
                port: fullUrl.port,
                path: fullUrl.pathname + fullUrl.search,
                headers: { "x-relay-key": this.config.key },
                timeout: 60000,
            };
            const req = mod.get(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    res.resume();
                    return;
                }
                const ws = fs.createWriteStream(dest);
                res.pipe(ws);
                ws.on("finish", () => ws.close(resolve));
                ws.on("error", reject);
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
            req.on("error", reject);
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

    _printImage(filepath, printerName) {
        return new Promise((resolve, reject) => {
            this._request("GET", "/api/print-relay/status").then(({ data }) => {
                const printSize = data.printSize || "5x7";
                const printQuality = data.printQuality || "high";
                const PRINT_SIZES = {
                    "4x6": { pageSize: "4x6" },
                    "5x7": { pageSize: "EPPhotoPaper2L" },
                    "8x10": { pageSize: "8x10" },
                };
                const PRINT_QUALITIES = {
                    standard: "360x360dpi",
                    high: "720x720dpi",
                    max: "1440x1440dpi",
                };
                const sizePreset = PRINT_SIZES[printSize] || PRINT_SIZES["5x7"];
                const pageSize = sizePreset.pageSize + ".NMgn";
                const resolution = PRINT_QUALITIES[printQuality] || PRINT_QUALITIES["high"];
                const flags = [
                    `-d "${printerName}"`,
                    `-o PageSize=${pageSize}`,
                    "-o EPIJ_RmMg=1",
                    "-o EPIJ_exmg=0",
                    "-o print-scaling=none",
                    "-o scaling=100",
                    `-o Resolution=${resolution}`,
                ];
                const command = `lp ${flags.join(" ")} "${filepath}"`;
                this.log(`Sending to printer: ${command}`);
                exec(command, { timeout: 60000 }, (err, stdout) => {
                    if (err) return reject(err);
                    this.log(`Print job accepted: ${stdout.trim()}`);
                    const match = stdout.match(/request id is (\S+)/);
                    if (!match) return resolve();
                    this._waitForPrintComplete(match[1], printerName, resolve, reject);
                });
            }).catch(reject);
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
