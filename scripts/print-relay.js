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
//   --printer   Printer name override (default: auto-detect via lpstat)
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
const PRINTER_OVERRIDE = args.printer || process.env.PRINT_RELAY_PRINTER || "";
const POLL_INTERVAL = parseInt(args.interval || process.env.PRINT_RELAY_INTERVAL || "5", 10) * 1000;
const DRY_RUN = args["dry-run"] === "true" || process.env.PRINT_RELAY_DRY_RUN === "true";

if (!BASE_URL || !RELAY_KEY) {
    console.error("Usage: node scripts/print-relay.js --url <cloud-url> --key <relay-key>");
    console.error("  --url       Cloud app base URL (required)");
    console.error("  --key       Relay API key (required)");
    console.error("  --printer   Printer name override");
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

function findPrinter() {
    return new Promise((resolve, reject) => {
        exec("lpstat -p", (err, stdout) => {
            if (err) return reject(new Error(`Cannot list printers: ${err.message}`));
            const lines = stdout.split("\n").filter(l => l.startsWith("printer "));
            const BAD = ["looking for printer", "disabled", "unplugged or turned off"];
            const printers = lines.map(l => ({
                name: l.split(" ")[1],
                lower: l.toLowerCase(),
            }));
            if (PRINTER_OVERRIDE) {
                const match = printers.find(p => p.name === PRINTER_OVERRIDE);
                if (match) return resolve(match.name);
                return reject(new Error(`Printer "${PRINTER_OVERRIDE}" not found`));
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
            log(`Sending to printer: ${command}`);
            exec(command, { timeout: 60000 }, (err, stdout) => {
                if (err) return reject(err);
                log(`Print job accepted: ${stdout.trim()}`);

                const match = stdout.match(/request id is (\S+)/);
                if (!match) return resolve();

                waitForPrintComplete(match[1], resolve, reject);
            });
        }).catch(reject);
    });
}

function waitForPrintComplete(requestId, resolve, reject) {
    const startTime = Date.now();
    const TIMEOUT = 5 * 60 * 1000;
    const PRINTER_ERRORS = ["stopped", "offline", "unplugged", "paused", "error"];

    const poll = () => {
        if (Date.now() - startTime > TIMEOUT) {
            log(`Print job ${requestId} timed out after 5 minutes`);
            return reject(new Error("Print job timed out — printer may be offline or stuck"));
        }
        exec("lpstat -l", (err, stdout) => {
            if (err || !stdout.includes(requestId)) {
                log(`Print job ${requestId} completed`);
                return resolve();
            }
            // Check for printer error states
            const lower = stdout.toLowerCase();
            const errorFound = PRINTER_ERRORS.find(e => lower.includes(e));
            if (errorFound) {
                log(`Print job ${requestId} failed — printer is ${errorFound}`);
                return reject(new Error(`Printer is ${errorFound}`));
            }
            setTimeout(poll, 3000);
        });
    };
    setTimeout(poll, 3000);
}

// ── Temp dir for downloaded images ───────────────────────────────────────────

const TEMP_DIR = path.join(__dirname, "..", ".relay-temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Track processed job filenames to prevent double-prints (auto-expires after 1 hour)
const processedJobs = new Map(); // filename -> timestamp
const PROCESSED_TTL = 60 * 60 * 1000; // 1 hour

function cleanupProcessedJobs() {
    const cutoff = Date.now() - PROCESSED_TTL;
    for (const [key, ts] of processedJobs) {
        if (ts < cutoff) processedJobs.delete(key);
    }
}

// ── Main loop ────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${msg}`);
}

let polling = false;

async function pollOnce() {
    if (polling) return;
    polling = true;

    try {
        cleanupProcessedJobs();
        const { status, data } = await request("GET", "/api/print-relay/jobs");
        if (status !== 200) {
            log(`Poll failed: HTTP ${status} — ${JSON.stringify(data)}`);
            return;
        }

        const jobs = data.jobs || [];
        if (jobs.length === 0) return;

        // Find a printer once per poll cycle (skip in dry-run)
        let printerName = "dry-run";
        if (!DRY_RUN) {
            try {
                printerName = await findPrinter();
            } catch (err) {
                log(`Printer error: ${err.message}`);
                return;
            }
        }

        for (const job of jobs) {
            if (processedJobs.has(job.filename)) continue;


            log(`Found job: ${job.filename} (event: ${job.eventName}, style: ${job.style})`);

            // Claim the job
            const ack = await request("POST", `/api/print-relay/jobs/${job.filename}/ack`, {
                printerName,
            });
            if (ack.status !== 200) {
                log(`Failed to claim ${job.filename}: ${JSON.stringify(ack.data)}`);
                // Mark as processed so we don't retry every poll cycle
                // (e.g. 400 = image missing on server — retrying won't help)
                if (ack.status === 400 || ack.status === 404) {
                    processedJobs.set(job.filename, Date.now());
                }
                continue;
            }

            const ackData = ack.data.job;
            const imageUrl = `/api/print-relay/image/${encodeURIComponent(ackData.eventName)}/${ackData.imageFile}`;
            const localPath = path.join(TEMP_DIR, ackData.imageFile);

            try {
                // Download image
                log(`Downloading ${ackData.imageFile}...`);
                await downloadFile(imageUrl, localPath);

                if (DRY_RUN) {
                    log(`[DRY RUN] Would print: ${localPath}`);
                    await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, { success: true });
                } else {
                    // Print
                    log(`Printing ${ackData.imageFile} on ${printerName}...`);
                    await printImage(localPath, printerName);
                    await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, { success: true });
                    log(`Job ${job.filename} completed successfully`);
                }

                processedJobs.set(job.filename, Date.now());
            } catch (err) {
                log(`Print failed for ${job.filename}: ${err.message}`);
                await request("POST", `/api/print-relay/jobs/${job.filename}/complete`, {
                    success: false,
                    error: err.message,
                }).catch(() => {});
            } finally {
                // Clean up temp file
                try { fs.unlinkSync(localPath); } catch {}
            }
        }
    } catch (err) {
        log(`Poll error: ${err.message}`);
    } finally {
        polling = false;
    }
}

// ── Startup ──────────────────────────────────────────────────────────────────

(async function main() {
    log("Print Relay Agent starting...");
    log(`  Cloud URL: ${BASE_URL}`);
    log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
    log(`  Dry run: ${DRY_RUN}`);
    if (PRINTER_OVERRIDE) log(`  Printer: ${PRINTER_OVERRIDE}`);

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

    // Verify printer
    try {
        const printer = await findPrinter();
        log(`Printer found: ${printer}`);
    } catch (err) {
        log(`Warning: ${err.message} — will retry on each poll`);
    }

    log("Polling for print jobs...\n");
    const interval = setInterval(pollOnce, POLL_INTERVAL);
    pollOnce(); // first poll immediately

    // Graceful shutdown
    process.on("SIGINT", () => {
        log("Shutting down...");
        clearInterval(interval);
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        log("Shutting down...");
        clearInterval(interval);
        process.exit(0);
    });
})();
