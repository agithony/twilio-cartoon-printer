#!/usr/bin/env node
// Print Relay Agent — polls the cloud app for print-ready jobs,
// downloads the image, prints locally via CUPS, and reports completion.
//
// Usage:
//   pnpm relay                          (reads from .env)
//   pnpm relay --dry-run                (test without printing)
//   node scripts/print-relay.js --url https://your-app.example.com --key YOUR_RELAY_KEY
//
// Options:
//   --url       Cloud app base URL (or set PRINT_RELAY_URL in .env)
//   --key       Relay API key (or set PRINT_RELAY_KEY in .env)
//   --printer   Single printer override (default: auto-detect via lpstat)
//   --printers  Comma-separated list of printers (e.g. "PrinterA,PrinterB")
//   --interval  Poll interval in seconds (default: 5)
//   --dry-run   Download image but skip actual printing

require("dotenv").config();
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ── Parse CLI args ───────────────────────────────────────────────────────────

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith("--")) {
        const key = arg.slice(2);
        const val = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
        args[key] = val;
    }
}

const BASE_URL = args.url || process.env.PRINT_RELAY_URL;
const RELAY_KEY = args.key || process.env.PRINT_RELAY_KEY;
const POLL_INTERVAL = parseInt(args.interval || process.env.PRINT_RELAY_INTERVAL || "5", 10) * 1000;
const DRY_RUN = args["dry-run"] === "true" || process.env.PRINT_RELAY_DRY_RUN === "true";

// Multi-printer: --printers "A,B" or PRINT_RELAY_PRINTERS, falls back to --printer / PRINT_RELAY_PRINTER
const PRINTERS_ARG = args.printers || process.env.PRINT_RELAY_PRINTERS || "";
const PRINTER_OVERRIDE = args.printer || process.env.PRINT_RELAY_PRINTER || "";

if (!BASE_URL || !RELAY_KEY) {
    console.error("Usage: node scripts/print-relay.js --url <cloud-url> --key <relay-key>");
    console.error("  --url       Cloud app base URL (required)");
    console.error("  --key       Relay API key (required)");
    console.error("  --printer   Single printer override");
    console.error("  --printers  Comma-separated printer list (e.g. \"PrinterA,PrinterB\")");
    console.error("  --interval  Poll interval in seconds (default: 5)");
    console.error("  --dry-run   Download but don't print");
    process.exit(1);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const fullUrl = new URL(urlPath, BASE_URL);
        const mod = fullUrl.protocol === "https:" ? https : http;
        const options = {
            method,
            hostname: fullUrl.hostname,
            port: fullUrl.port,
            path: fullUrl.pathname + fullUrl.search,
            headers: {
                "x-relay-key": RELAY_KEY,
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

function downloadFile(urlPath, dest) {
    return new Promise((resolve, reject) => {
        const fullUrl = new URL(urlPath, BASE_URL);
        const mod = fullUrl.protocol === "https:" ? https : http;
        const options = {
            hostname: fullUrl.hostname,
            port: fullUrl.port,
            path: fullUrl.pathname + fullUrl.search,
            headers: { "x-relay-key": RELAY_KEY },
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

// ── Printer helpers ──────────────────────────────────────────────────────────

function findAllPrinters() {
    return new Promise((resolve, reject) => {
        exec("lpstat -p", (err, stdout) => {
            if (err) return reject(new Error(`Cannot list printers: ${err.message}`));
            const lines = stdout.split("\n").filter(l => l.startsWith("printer "));
            const BAD = ["looking for printer", "disabled", "unplugged or turned off"];
            const printers = lines.map(l => ({ name: l.split(" ")[1], lower: l.toLowerCase() }));
            const healthy = printers.filter(p => !BAD.some(b => p.lower.includes(b)));
            resolve(healthy.map(p => p.name));
        });
    });
}

function findPrinter(override) {
    return new Promise((resolve, reject) => {
        exec("lpstat -p", (err, stdout) => {
            if (err) return reject(new Error(`Cannot list printers: ${err.message}`));
            const lines = stdout.split("\n").filter(l => l.startsWith("printer "));
            const BAD = ["looking for printer", "disabled", "unplugged or turned off"];
            const printers = lines.map(l => ({
                name: l.split(" ")[1],
                lower: l.toLowerCase(),
            }));
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

function printImage(filepath, printerName) {
    return new Promise((resolve, reject) => {
        // Fetch print settings from cloud
        request("GET", "/api/print-relay/status").then(({ data }) => {
            const printSize = data.printSize || "5x7";
            const printQuality = data.printQuality || "high";

            const PRINT_SIZES = {
                "4x6":  { pageSize: "4x6" },
                "5x7":  { pageSize: "EPPhotoPaper2L" },
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
            log(`[${printerName}] Sending to printer: ${command}`);
            exec(command, { timeout: 60000 }, (err, stdout) => {
                if (err) return reject(err);
                log(`[${printerName}] Print job accepted: ${stdout.trim()}`);

                const match = stdout.match(/request id is (\S+)/);
                if (!match) return resolve();

                waitForPrintComplete(match[1], printerName, resolve, reject);
            });
        }).catch(reject);
    });
}

function waitForPrintComplete(requestId, printerName, resolve, reject) {
    const startTime = Date.now();
    const TIMEOUT = 5 * 60 * 1000;
    const PRINTER_ERRORS = ["stopped", "offline", "unplugged", "paused"];

    const poll = () => {
        if (Date.now() - startTime > TIMEOUT) {
            log(`[${printerName}] Print job ${requestId} timed out after 5 minutes`);
            exec(`cancel ${requestId}`, () => {});
            return reject(new Error("Print job timed out — printer may be offline or stuck"));
        }
        // Check if job is still queued
        exec("lpstat -o", (err, stdout) => {
            if (err || !stdout.includes(requestId)) {
                log(`[${printerName}] Print job ${requestId} completed`);
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
                    log(`[${printerName}] Print job ${requestId} failed — printer ${printerName} is ${errorFound}`);
                    exec(`cancel ${requestId}`, () => {});
                    return reject(new Error(`Printer is ${errorFound}`));
                }
                setTimeout(poll, 3000);
            });
        });
    };
    setTimeout(poll, 3000);
}

// ── Temp dir for downloaded images ───────────────────────────────────────────

const TEMP_DIR = path.join(__dirname, "..", ".relay-temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${msg}`);
}

// ── Worker factory — one worker per printer ─────────────────────────────────

function createWorker(printerOverride) {
    const label = printerOverride || "auto";
    const processedJobs = new Map(); // filename -> timestamp
    const PROCESSED_TTL = 10 * 60 * 1000; // 10 min (must be < server's 15-min stale threshold)
    let consecutiveErrors = 0;
    let polling = false;
    let timer = null;
    let stopped = false;

    function cleanupProcessedJobs() {
        const cutoff = Date.now() - PROCESSED_TTL;
        for (const [key, ts] of processedJobs) {
            if (ts < cutoff) processedJobs.delete(key);
        }
    }

    async function pollOnce() {
        if (polling || stopped) return;
        polling = true;

        try {
            cleanupProcessedJobs();
            const printerParam = printerOverride ? `?printer=${encodeURIComponent(printerOverride)}` : "";
            const { status, data } = await request("GET", `/api/print-relay/jobs${printerParam}`);
            if (status !== 200) {
                consecutiveErrors++;
                log(`[${label}] Poll failed: HTTP ${status} (retry in ${Math.min(POLL_INTERVAL * Math.pow(2, consecutiveErrors), 120000) / 1000}s)`);
                return;
            }
            consecutiveErrors = 0;

            const jobs = data.jobs || [];
            if (jobs.length === 0) return;

            // Find printer once per poll cycle (skip in dry-run)
            let printerName = "dry-run";
            if (!DRY_RUN) {
                try {
                    printerName = await findPrinter(printerOverride);
                } catch (err) {
                    log(`[${label}] Printer error: ${err.message}`);
                    return;
                }
            }

            for (const job of jobs) {
                if (stopped) break;
                if (processedJobs.has(job.filename)) continue;

                log(`[${label}] Found job: ${job.filename} (event: ${job.eventName}, style: ${job.style})`);

                // Claim the job
                const ack = await request("POST", `/api/print-relay/jobs/${job.filename}/ack`, {
                    printerName,
                });
                if (ack.status !== 200) {
                    log(`[${label}] Failed to claim ${job.filename}: ${JSON.stringify(ack.data)}`);
                    if (ack.status === 400 || ack.status === 404) {
                        processedJobs.set(job.filename, Date.now());
                    }
                    continue;
                }

                const ackData = ack.data.job;
                const imageUrl = `/api/print-relay/image/${encodeURIComponent(ackData.eventName)}/${ackData.imageFile}`;
                const localPath = path.join(TEMP_DIR, `${label}_${ackData.imageFile}`);

                try {
                    // Download image
                    log(`[${label}] Downloading ${ackData.imageFile}...`);
                    await downloadFile(imageUrl, localPath);

                    if (DRY_RUN) {
                        log(`[${label}] [DRY RUN] Would print: ${localPath}`);
                        await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, { success: true });
                    } else {
                        // Print
                        log(`[${label}] Printing ${ackData.imageFile} on ${printerName}...`);
                        await printImage(localPath, printerName);
                        await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, { success: true });
                        log(`[${label}] Job ${job.filename} completed successfully`);
                    }

                    processedJobs.set(job.filename, Date.now());
                } catch (err) {
                    log(`[${label}] Print failed for ${job.filename}: ${err.message}`);
                    const isPrinterError = /printer is |timed out/i.test(err.message);
                    if (isPrinterError) {
                        // Report failure so server re-queues the job to ready/
                        // immediately — another printer's engine can claim it
                        // on its next poll (~5s) instead of waiting 15 min.
                        await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, {
                            success: false, error: err.message,
                        }).catch(() => {});
                        processedJobs.set(job.filename, Date.now());
                        break; // Stop claiming more jobs — this printer is broken
                    } else {
                        await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, {
                            success: false,
                            error: err.message,
                        }).catch(() => {});
                    }
                } finally {
                    try { fs.unlinkSync(localPath); } catch {}
                }
            }
        } catch (err) {
            consecutiveErrors++;
            log(`[${label}] Poll error: ${err.message} (retry in ${Math.min(POLL_INTERVAL * Math.pow(2, consecutiveErrors), 120000) / 1000}s)`);
        } finally {
            polling = false;
        }
    }

    function schedulePoll() {
        if (stopped) return;
        const delay = consecutiveErrors === 0
            ? POLL_INTERVAL
            : Math.min(POLL_INTERVAL * Math.pow(2, consecutiveErrors), 120000);
        timer = setTimeout(() => {
            pollOnce().finally(schedulePoll);
        }, delay);
    }

    function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
    }

    return {
        label,
        start: () => pollOnce().finally(schedulePoll),
        stop,
    };
}

// ── Startup ──────────────────────────────────────────────────────────────────

(async function main() {
    log("Print Relay Agent starting...");
    log(`  Cloud URL: ${BASE_URL}`);
    log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
    log(`  Dry run: ${DRY_RUN}`);

    // Verify connectivity
    try {
        const { status, data } = await request("GET", "/api/print-relay/status");
        if (status === 200) {
            log(`Connected to cloud app (printing: ${data.enablePrinting}, size: ${data.printSize}, quality: ${data.printQuality})`);
        } else {
            log(`Warning: Cloud returned HTTP ${status} — ${JSON.stringify(data)}`);
        }
    } catch (err) {
        log(`Warning: Cannot reach cloud app — ${err.message}`);
    }

    // Determine printer list
    let printerNames = [];
    if (PRINTERS_ARG) {
        printerNames = PRINTERS_ARG.split(",").map(s => s.trim()).filter(Boolean);
        log(`  Printers (from arg): ${printerNames.join(", ")}`);
    } else if (PRINTER_OVERRIDE) {
        printerNames = [PRINTER_OVERRIDE];
        log(`  Printer: ${PRINTER_OVERRIDE}`);
    } else {
        // Auto-detect all healthy printers
        try {
            printerNames = await findAllPrinters();
            if (printerNames.length === 0) {
                log("Warning: No healthy printers found — will retry on each poll");
                printerNames = [""]; // single worker with auto-detect
            } else {
                log(`  Auto-detected printers: ${printerNames.join(", ")}`);
            }
        } catch (err) {
            log(`Warning: ${err.message} — will retry on each poll`);
            printerNames = [""]; // single worker with auto-detect
        }
    }

    // Create one worker per printer
    const workers = printerNames.map(name => createWorker(name));
    log(`Starting ${workers.length} worker${workers.length > 1 ? "s" : ""}...\n`);

    for (const w of workers) {
        w.start();
    }

    // Graceful shutdown
    function shutdown() {
        log("Shutting down...");
        for (const w of workers) w.stop();
        process.exit(0);
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})();
