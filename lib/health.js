const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR } = require("./config");

// ── Rolling 5-minute windows for API call tracking ─────────────────────────

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const windows = new Map(); // service -> [{ ts, success, latencyMs }]

function trackApiCall(service, success, latencyMs) {
    if (!windows.has(service)) windows.set(service, []);
    const arr = windows.get(service);
    arr.push({ ts: Date.now(), success, latencyMs });
    // Prune entries older than window
    const cutoff = Date.now() - WINDOW_MS;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
}

// ── Count JSON files in a queue directory ──────────────────────────────────

function countJsonFiles(dir) {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith(".json")).length;
    } catch {
        return 0;
    }
}

// ── Compute health status ──────────────────────────────────────────────────

const startTime = Date.now();

async function getHealthStatus() {
    const checks = {};

    // Filesystem
    const settings = require("./settings");
    try {
        const start = Date.now();
        await fsp.access(settings.getDownloadDir());
        checks.filesystem = { status: "ok", latencyMs: Date.now() - start };
    } catch (e) {
        checks.filesystem = { status: "fail", error: e.message };
    }

    // Queue depths
    checks.queue = {
        pending: countJsonFiles(PENDING_DIR),
        generating: countJsonFiles(GENERATING_DIR),
        review: countJsonFiles(REVIEW_DIR),
        ready: countJsonFiles(READY_DIR),
        printing: countJsonFiles(PRINTING_DIR),
    };

    // Memory
    const mem = process.memoryUsage();
    checks.memory = {
        rss_mb: Math.round(mem.rss / 1048576),
        heapUsed_mb: Math.round(mem.heapUsed / 1048576),
        heapTotal_mb: Math.round(mem.heapTotal / 1048576),
    };

    // Uptime
    checks.uptime_s = Math.round(process.uptime());

    // API services
    const cutoff = Date.now() - WINDOW_MS;
    checks.services = {};
    for (const [service, calls] of windows) {
        const recent = calls.filter(c => c.ts >= cutoff);
        const total = recent.length;
        const failures = recent.filter(c => !c.success).length;
        const errorRate = total > 0 ? Math.round((failures / total) * 100) : 0;
        const avgLatencyMs = total > 0 ? Math.round(recent.reduce((s, c) => s + c.latencyMs, 0) / total) : 0;
        const lastCall = recent.length > 0 ? new Date(recent[recent.length - 1].ts).toISOString() : null;
        checks.services[service] = { calls: total, failures, errorRate, avgLatencyMs, lastCall };
    }

    // Overall status
    const fsOk = checks.filesystem.status === "ok";
    const maxErrorRate = Math.max(0, ...Object.values(checks.services).map(s => s.errorRate));
    let status = "healthy";
    if (!fsOk || maxErrorRate > 50) status = "unhealthy";
    else if (maxErrorRate > 20) status = "degraded";

    // Version
    let version = "unknown";
    try {
        version = require(path.join(__dirname, "..", "package.json")).version;
    } catch {}

    return {
        status,
        version,
        checks,
        timestamp: new Date().toISOString(),
    };
}

// ── Mount route ────────────────────────────────────────────────────────────

function mountHealth(app) {
    app.get("/healthz", async (req, res) => {
        try {
            const report = await getHealthStatus();
            const code = report.status === "unhealthy" ? 503 : 200;
            res.status(code).json(report);
        } catch (err) {
            res.status(500).json({ status: "unhealthy", error: err.message });
        }
    });
    console.log("🏥 Health check mounted at /healthz");
}

module.exports = { trackApiCall, getHealthStatus, mountHealth };
