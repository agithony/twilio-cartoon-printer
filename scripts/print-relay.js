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
const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { buildPrintCommand } = require("../relay-app/cups-command");
const RELAY_VERSION = require("../relay-app/package.json").version + "-cli";

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

function downloadFile(urlPath, dest) {
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
        const fullUrl = new URL(urlPath, BASE_URL);
        const mod = fullUrl.protocol === "https:" ? https : http;
        const options = {
            hostname: fullUrl.hostname,
            port: fullUrl.port,
            path: fullUrl.pathname + fullUrl.search,
            headers: { "x-relay-key": RELAY_KEY, "x-relay-version": RELAY_VERSION },
            timeout: 60000,
        };
        const req = mod.get(options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                fail(new Error(`Download failed: HTTP ${res.statusCode}`));
                return;
            }
            const expected = parseInt(res.headers["content-length"] || "0", 10);
            let received = 0;
            res.on("data", (chunk) => { received += chunk.length; });
            ws = fs.createWriteStream(dest);
            res.pipe(ws);
            res.on("aborted", () => fail(new Error("Download aborted before completion")));
            res.on("error", fail);
            ws.on("finish", () => ws.close(() => {
                if (expected > 0 && received !== expected) {
                    return fail(new Error(`Download truncated: expected ${expected} bytes, got ${received}`));
                }
                if (received === 0) return fail(new Error("Download produced an empty file"));
                succeed();
            }));
            ws.on("error", fail);
        });
        req.on("timeout", () => { req.destroy(); fail(new Error("Download timed out")); });
        req.on("error", fail);
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

const printerCapabilitiesCache = new Map();
function getPrinterCapabilities(printerName) {
    if (printerCapabilitiesCache.has(printerName)) return Promise.resolve(printerCapabilitiesCache.get(printerName));
    return new Promise((resolve) => {
        execFile("lpoptions", ["-p", printerName, "-l"], { timeout: 10000 }, (err, stdout) => {
            const capabilities = err ? "" : stdout;
            printerCapabilitiesCache.set(printerName, capabilities);
            resolve(capabilities);
        });
    });
}

function printImage(filepath, printerName, outputProfile) {
    return new Promise((resolve, reject) => {
        // Read print settings from the cached /status (seeded at startup,
        // refreshed every STATUS_REFRESH_MS) instead of a blocking fetch per
        // print. Falls through to safe defaults if the cache is somehow empty.
        Promise.resolve({ data: cachedStatus || {} }).then(async ({ data }) => {
            const printerCapabilities = await getPrinterCapabilities(printerName);
            const command = buildPrintCommand({
                filepath,
                printerName,
                printerCapabilities,
                printSize: data.printSize,
                printQuality: data.printQuality,
                customFlags: data.customPrintFlags || "",
                outputProfile: outputProfile || data.outputProfile || null,
            });
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

// ── Cloud status cache ───────────────────────────────────────────────────────
// Cache the cloud's /status (printSize, printQuality) and refresh it in the
// background, instead of fetching it synchronously before EVERY print. Parity
// with the Electron relay (relay-app/relay.js) which moved to this in v1.1.
// Without it, a single transient cloud hiccup at print time fails that print;
// with it we keep serving the last-known settings and a brief blip is harmless.
let cachedStatus = null;
const STATUS_REFRESH_MS = 60 * 1000;

async function refreshStatus() {
    try {
        const { status, data } = await request("GET", "/api/print-relay/status");
        if (status === 200) cachedStatus = data;
    } catch { /* keep stale cache — next refresh retries */ }
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

    // Heartbeat timer, active only while this worker holds a claimed job.
    // Parity with the Electron relay (v1.1): the cloud distinguishes "relay
    // actively working" (recent beat) from "relay went dark" (no beat >60s)
    // and recovers the job in ~60s instead of waiting the 15-min printingAt
    // fallback. The job loop is serial, so at most one heartbeat runs at a time.
    let heartbeatTimer = null;
    let activeHeartbeat = null;
    const HEARTBEAT_MS = 20 * 1000;

    function startHeartbeat(filename, claimId) {
        stopHeartbeat();
        const heartbeat = { filename, claimId, timer: null };
        activeHeartbeat = heartbeat;
        const beat = () => {
            request("POST", `/api/print-relay/jobs/${filename}/heartbeat`, { claimId })
                .then(({ status }) => {
                    if ((status === 404 || status === 409) && activeHeartbeat === heartbeat) {
                        stopHeartbeat(heartbeat);
                    }
                })
                .catch(() => { /* network blip — next beat retries; cloud recovers on missing beats */ });
        };
        heartbeat.timer = setInterval(beat, HEARTBEAT_MS);
        heartbeatTimer = heartbeat.timer;
        beat();
    }

    async function completeJob(filename, payload, attempts = 20) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                const result = await request("POST", `/api/print-relay/jobs/${filename}/complete`, payload);
                if (result.status === 200 && result.data && result.data.ok === true) return result.data;
                if (result.status === 409) throw new Error("Print claim was recovered by another station");
                lastError = new Error(`Cloud completion failed: HTTP ${result.status}${result.data && result.data.error ? ` (${result.data.error})` : ""}`);
            } catch (err) {
                lastError = err;
                if (/recovered by another station/.test(err.message)) throw err;
            }
            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        throw lastError || new Error("Cloud completion failed");
    }

    function stopHeartbeat(expectedHeartbeat = null) {
        if (expectedHeartbeat && activeHeartbeat !== expectedHeartbeat) return;
        const timerToStop = activeHeartbeat && activeHeartbeat.timer || heartbeatTimer;
        if (timerToStop) clearInterval(timerToStop);
        activeHeartbeat = null;
        heartbeatTimer = null;
    }

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

                // We own this job now — start beating so the cloud can recover
                // it within ~60s if this process dies, instead of 15 minutes.
                startHeartbeat(job.filename, ackData.claimId);

                let printSucceeded = false;
                try {
                    // Download image
                    log(`[${label}] Downloading ${ackData.imageFile}...`);
                    await downloadFile(imageUrl, localPath);

                    if (DRY_RUN) {
                        log(`[${label}] [DRY RUN] Would print: ${localPath}`);
                        printSucceeded = true;
                        await completeJob(job.filename, { success: true, claimId: ackData.claimId });
                    } else {
                        // Print
                        log(`[${label}] Printing ${ackData.imageFile} on ${printerName}...`);
                        await printImage(localPath, printerName, ackData.outputProfile);
                        printSucceeded = true;
                        await completeJob(job.filename, { success: true, claimId: ackData.claimId });
                        log(`[${label}] Job ${job.filename} completed successfully`);
                    }

                    processedJobs.set(job.filename, Date.now());
                } catch (err) {
                    log(`[${label}] Print failed for ${job.filename}: ${err.message}`);
                    const isPrinterError = /printer is |timed out/i.test(err.message);
                    if (printSucceeded) {
                        log(`[${label}] Physical print succeeded but cloud completion was not accepted`);
                        processedJobs.set(job.filename, Date.now());
                    } else if (isPrinterError) {
                        // Report failure so server re-queues the job to ready/
                        // immediately — another printer's engine can claim it
                        // on its next poll (~5s) instead of waiting 15 min.
                        await completeJob(job.filename, {
                            success: false, error: err.message, claimId: ackData.claimId,
                        });
                        processedJobs.set(job.filename, Date.now());
                        break; // Stop claiming more jobs — this printer is broken
                    } else {
                        await completeJob(job.filename, {
                            success: false,
                            error: err.message,
                            claimId: ackData.claimId,
                        });
                    }
                } finally {
                    stopHeartbeat();
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
        stopHeartbeat();
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

    // Verify connectivity + seed the status cache in one call
    try {
        const { status, data } = await request("GET", "/api/print-relay/status");
        if (status === 200) {
            cachedStatus = data;
            log(`Connected to cloud app (printing: ${data.enablePrinting}, size: ${data.printSize}, quality: ${data.printQuality})`);
        } else {
            log(`Warning: Cloud returned HTTP ${status} — ${JSON.stringify(data)}`);
        }
    } catch (err) {
        log(`Warning: Cannot reach cloud app — ${err.message}`);
    }

    // Keep the cached print settings fresh in the background so a transient
    // cloud blip at print time can't fail a print. unref() so this timer never
    // keeps the process alive on shutdown.
    setInterval(refreshStatus, STATUS_REFRESH_MS).unref();

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
