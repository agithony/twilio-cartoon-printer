// Programmatic generate endpoint — lets admins submit a selfie via HTTP
// instead of SMS. Reuses the SMS pipeline end-to-end; the only differences
// are:
//   - synthetic userPhone like "api:<id>" (no real phone to deliver to)
//   - noDelivery: true on the job, which suppresses every outbound SMS
//   - adminGenerated: true so the job doesn't count toward per-user quota
//
// Also backs /kiosk, which POSTs the camera snapshot to this same endpoint.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const settings = require("./settings");
const { enqueueJob } = require("./queue");
const kioskSubmissions = require("./kiosk-submissions");
const {
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    REVIEW_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");

// E.164: leading +, then 7–15 digits. We don't localize or assume a country.
const E164_RE = /^\+[1-9]\d{6,14}$/;
// Pragmatic email check — syntactic only, no bounce verification.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// ── Upload parsing ──────────────────────────────────────────────────────────
// Two body shapes supported:
//   1. Content-Type: image/jpeg|png|webp  → raw bytes
//   2. Content-Type: multipart/form-data  → a single file field named "image"
// Multipart is parsed by hand (no new dependency) since we only need one field.

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

function readBodyBuffer(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
                reject(Object.assign(new Error(`Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

// Minimal multipart parser — extracts the first file part with a filename,
// ignores other fields. Good enough for a single "image" field.
function parseMultipart(buffer, boundary) {
    const boundaryBuf = Buffer.from(`--${boundary}`);
    const parts = [];
    let start = 0;
    while (true) {
        const bIdx = buffer.indexOf(boundaryBuf, start);
        if (bIdx < 0) break;
        if (start < bIdx) parts.push(buffer.slice(start, bIdx));
        start = bIdx + boundaryBuf.length;
    }
    for (let part of parts) {
        if (part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2);
        if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
            part = part.slice(0, part.length - 2);
        }
        const sepIdx = part.indexOf("\r\n\r\n");
        if (sepIdx < 0) continue;
        const headerText = part.slice(0, sepIdx).toString("utf8");
        const body = part.slice(sepIdx + 4);
        const disposition = /content-disposition:[^\r\n]*filename="([^"]+)"/i.exec(headerText);
        if (!disposition) continue;
        const ctMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
        const contentType = (ctMatch ? ctMatch[1] : "application/octet-stream").trim().toLowerCase();
        return { filename: disposition[1], contentType, body };
    }
    return null;
}

// Detect image type from magic bytes — protects against a caller lying
// about Content-Type. Returns the canonical extension or null.
function sniffImageType(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
    return null;
}

async function extractUploadedImage(req) {
    const ctRaw = req.headers["content-type"] || "";
    const ct = ctRaw.toLowerCase();
    const buf = await readBodyBuffer(req);
    if (buf.length === 0) throw Object.assign(new Error("Empty upload body"), { status: 400 });

    let imageBuf;
    if (ct.startsWith("multipart/form-data")) {
        // Boundary is case-sensitive — extract it from the raw header, not
        // the lowercased copy we use for type dispatch.
        const boundaryMatch = /boundary=(.+)$/.exec(ctRaw);
        if (!boundaryMatch) throw Object.assign(new Error("Missing multipart boundary"), { status: 400 });
        const part = parseMultipart(buf, boundaryMatch[1].trim().replace(/^"|"$/g, ""));
        if (!part) throw Object.assign(new Error("No file part found in multipart body"), { status: 400 });
        imageBuf = part.body;
    } else if (ct.startsWith("image/") || ct === "application/octet-stream") {
        imageBuf = buf;
    } else {
        throw Object.assign(new Error(`Unsupported Content-Type: ${ct}. Use image/* or multipart/form-data.`), { status: 415 });
    }

    const ext = sniffImageType(imageBuf);
    if (!ext) throw Object.assign(new Error("Uploaded file is not a recognised image (JPEG/PNG/WebP)"), { status: 415 });
    return { buffer: imageBuf, ext };
}

// ── Job lookup (poll state across all queue directories) ────────────────────

async function findJobState(filePrefix) {
    // A single fs.rename is atomic, but a job in transit between two dirs
    // sits in one of them at any given instant. The lookup order below
    // mirrors the job's forward progression (pending → generating → terminal)
    // so if we read mid-transition we catch the later state — avoiding a
    // "pending" read for a job that has already moved to generating.
    const dirs = [
        { dir: DONE_DIR, state: "done" },
        { dir: READY_DIR, state: "ready" },
        { dir: FAILED_DIR, state: "failed" },
        { dir: REVIEW_DIR, state: "review" },
        { dir: GENERATING_DIR, state: "generating" },
        { dir: PENDING_DIR, state: "pending" },
    ];
    for (const { dir, state } of dirs) {
        const jobPath = path.join(dir, `${filePrefix}.json`);
        if (fs.existsSync(jobPath)) {
            try {
                const job = JSON.parse(await fsp.readFile(jobPath, "utf8"));
                return { state, job };
            } catch {
                // File was renamed out from under us mid-read. Let the caller
                // poll again rather than committing to a wrong state.
                return { state: "transient", job: null };
            }
        }
    }
    return { state: "unknown", job: null };
}

function describeJobForResponse(filePrefix, state, job) {
    const resp = {
        filePrefix,
        state,
        statusUrl: `/api/generate/${encodeURIComponent(filePrefix)}/status`,
    };
    if (state === "ready" || state === "done") {
        resp.resultUrl = `/api/generate/${encodeURIComponent(filePrefix)}/result`;
        if (job && job.baseUrl && job.eventName) {
            resp.shareUrl = `${job.baseUrl}/s/${encodeURIComponent(filePrefix)}?e=${encodeURIComponent(job.eventName)}`;
        }
    }
    if (state === "failed" && job) {
        resp.failReason = job.failReason || "unknown";
    }
    if (state === "review" && job) {
        resp.note = "Held for review — an admin must approve before the result is served.";
    }
    return resp;
}

// ── POST /api/generate ──────────────────────────────────────────────────────

router.post("/", async (req, res) => {
    try {
        const { buffer, ext } = await extractUploadedImage(req);

        // Resolve style (query param). Default: first active style.
        const activeStyleList = settings.getActiveStyleList();
        const activeStyles = settings.getActiveStyles();
        const requestedStyle = (req.query.style || "").toString().trim().toLowerCase();
        let style;
        if (requestedStyle && activeStyles[requestedStyle]) {
            style = requestedStyle;
        } else if (requestedStyle) {
            return res.status(400).json({
                error: `Unknown style "${requestedStyle}". Active styles: ${activeStyleList.join(", ")}`,
            });
        } else if (activeStyleList.length > 0) {
            style = activeStyleList[0];
        } else {
            return res.status(500).json({ error: "No active styles configured for this event" });
        }

        // Validate optional brand / background against event config
        const brand = (req.query.brand || "").toString().trim() || null;
        if (brand) {
            const customBrands = settings.get("customBrands") || {};
            if (!customBrands[brand]) {
                return res.status(400).json({ error: `Unknown brand "${brand}"` });
            }
        }
        const background = (req.query.background || "").toString().trim() || null;
        if (background) {
            const bgChoices = settings.get("backgroundChoices") || [];
            if (!bgChoices.find((b) => b.key === background)) {
                return res.status(400).json({ error: `Unknown background "${background}"` });
            }
        }

        // Optional contact info captured on the /kiosk page. Both are
        // independent: providing phone routes the job through the normal
        // SMS delivery flow; providing email just files the submission
        // in outreach for later manual follow-up.
        const rawPhone = (req.query.phone || "").toString().trim();
        const rawEmail = (req.query.email || "").toString().trim().toLowerCase();
        let contactPhone = "";
        let contactEmail = "";
        if (rawPhone) {
            if (!E164_RE.test(rawPhone)) {
                return res.status(400).json({ error: "Phone must be in E.164 format (e.g. +14155551234)" });
            }
            contactPhone = rawPhone;
        }
        if (rawEmail) {
            if (!EMAIL_RE.test(rawEmail)) {
                return res.status(400).json({ error: "Email looks invalid" });
            }
            contactEmail = rawEmail;
        }

        // Save upload into the event's downloads dir as an input file.
        // The generation pipeline downloads the image from this URL, so the
        // file must be reachable via HTTP. /images/* is already mounted to
        // the active event's download dir (index.js:101).
        const id = crypto.randomUUID();
        const inputFilename = `api_${id}_input.${ext}`;
        const downloadDir = settings.getDownloadDir();
        if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
        const inputPath = path.join(downloadDir, inputFilename);
        await fsp.writeFile(inputPath, buffer);

        // Resolve base URL — prefer BASE_URL env var (set on the deploy to
        // the public FQDN) so Twilio can actually fetch the MMS media URL.
        // Fall back to request headers for local dev where BASE_URL is blank.
        let baseUrl = process.env.BASE_URL || "";
        if (!baseUrl) {
            const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
            const host = req.headers["x-forwarded-host"] || req.headers.host;
            baseUrl = `${proto}://${host}`;
        }
        const imageUrl = `${baseUrl}/images/${encodeURIComponent(inputFilename)}`;

        // When the kiosk caller provides a phone, we treat the job exactly
        // like an SMS-submitted job: delivery MMS, share links, promo, NPS
        // and lead survey all honour the event's settings. When there's no
        // phone, we fall back to a synthetic identifier and suppress every
        // outbound SMS path via noDelivery.
        const userPhone = contactPhone || `api:${id.slice(0, 8)}`;
        const appPhone = contactPhone ? (settings.get("twilioPhoneNumber") || "") : "";
        const messageSid = `api-${id}`;
        const extras = {
            apiSubmission: true,
            uploadedInputFile: inputFilename,
            channel: "sms",
            locale: "en",
        };
        if (!contactPhone) extras.noDelivery = true;

        const enq = enqueueJob(
            imageUrl,
            messageSid,
            userPhone,
            appPhone,
            style,
            baseUrl,
            background,
            brand,
            extras,
        );
        if (!enq || !enq.filePrefix) {
            return res.status(500).json({ error: "Failed to enqueue job" });
        }

        // Record the submission so it shows up in the outreach tab — even
        // if both phone and email are empty. Keyed on filePrefix so the
        // outreach UI can look up the portrait thumbnail.
        try {
            kioskSubmissions.add({
                filePrefix: enq.filePrefix,
                event: settings.get("eventName"),
                phone: contactPhone,
                email: contactEmail,
                style,
                baseUrl,
            });
        } catch (err) {
            console.error(`⚠️  Kiosk submission record write failed: ${err.message}`);
        }

        if (req.query.wait) {
            return res.redirect(303, `/api/generate/${encodeURIComponent(enq.filePrefix)}/wait`);
        }

        const body = describeJobForResponse(enq.filePrefix, "pending", null);
        body.waitUrl = `/api/generate/${encodeURIComponent(enq.filePrefix)}/wait`;
        res.status(202).json(body);
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`❌ /api/generate failed: ${err.message}`);
        res.status(status).json({ error: err.message });
    }
});

// ── GET /api/generate/:prefix/status ────────────────────────────────────────

router.get("/:prefix/status", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).json({ error: "Invalid filePrefix" });
    const { state, job } = await findJobState(prefix);
    res.json(describeJobForResponse(prefix, state, job));
});

// ── GET /api/generate/:prefix/wait ──────────────────────────────────────────
// Long-poll: blocks until the job reaches a terminal state or the timeout
// elapses. On success, 303-redirects to /result so curl -L can save directly.

router.get("/:prefix/wait", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).json({ error: "Invalid filePrefix" });
    const timeoutMs = Math.min(180000, Math.max(5000, Number(req.query.timeout) || 90000));
    const pollEveryMs = 1000;
    const deadline = Date.now() + timeoutMs;

    // Tolerate a few consecutive "unknown" readings before treating the job
    // as gone — covers the narrow race where the job file is in transit
    // between queue dirs, or any disk hiccup.
    let consecutiveUnknown = 0;
    const MAX_UNKNOWN_BEFORE_GONE = 3;
    while (Date.now() < deadline) {
        const { state, job } = await findJobState(prefix);
        if (state === "done" || state === "ready") {
            return res.redirect(303, `/api/generate/${encodeURIComponent(prefix)}/result`);
        }
        if (state === "failed") {
            return res.status(422).json({ state, filePrefix: prefix, failReason: job ? job.failReason : "unknown" });
        }
        if (state === "unknown") {
            if (++consecutiveUnknown >= MAX_UNKNOWN_BEFORE_GONE) {
                return res.status(410).json({ state: "gone", filePrefix: prefix });
            }
        } else {
            consecutiveUnknown = 0;
        }
        await new Promise((r) => setTimeout(r, pollEveryMs));
    }
    res.status(504).json({ state: "timeout", filePrefix: prefix, message: "Generation didn't finish within the wait window — poll /status instead." });
});

// ── GET /api/generate/:prefix/debug ─────────────────────────────────────────
// Diagnostic: shows the job record + whether its output file is on disk.
// Helps diagnose "didn't show in photo book" reports.
router.get("/:prefix/debug", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).json({ error: "Invalid filePrefix" });
    const { state, job } = await findJobState(prefix);
    const downloadDir = settings.getDownloadDir(job ? job.eventName : undefined);
    const outputFile = path.join(downloadDir, `${prefix}_output_mms.jpg`);
    const stagingFile = path.join(downloadDir, ".staging", `${prefix}_output_mms.jpg`);
    res.json({
        prefix,
        state,
        job,
        outputExists: fs.existsSync(outputFile),
        stagingExists: fs.existsSync(stagingFile),
        downloadDir,
        baseUrlEnv: process.env.BASE_URL || null,
    });
});

// ── GET /api/generate/:prefix/result ────────────────────────────────────────
// Streams the MMS-sized output JPEG.

router.get("/:prefix/result", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).send("Invalid filePrefix");
    const { state, job } = await findJobState(prefix);
    if (state !== "ready" && state !== "done") {
        return res.status(409).json({ state, filePrefix: prefix, message: "Result not ready yet" });
    }
    const eventName = job ? job.eventName : undefined;
    const filePath = path.join(settings.getDownloadDir(eventName), `${prefix}_output_mms.jpg`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Output image missing on disk" });
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(filePath).pipe(res);
});

function mountApiGenerate(app) {
    app.use("/api/generate", router);
    console.log("🖼️  /api/generate mounted (programmatic selfie → portrait)");
}

module.exports = { mountApiGenerate };
