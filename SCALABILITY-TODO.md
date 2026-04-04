# Scalability Assessment & Remediation Plan
*Last updated: 2026-04-03*

## Current Architecture
- **Single container:** 1 CPU, 2GB RAM, Azure Container Apps, `maxReplicas: 1` (deploy.sh:224-225)
- **100% file-based:** No database, no Redis. Jobs = JSON files in `queue/{state}/`, images in `downloads/{event}/`
- **Azure File Share:** 10GB quota (deploy.sh:128), mounted at `/app/appdata`, ~50-100ms latency per file op
- **Single event loop:** Express server + generation worker + print worker share one Node.js process
- **Polling workers:** `setInterval(1000ms)` scans directories for pending/ready jobs (config.js:7)

## Recent Features (added since initial assessment)
- **AI Review mode** (`reviewMode: "ai"`) — automated quality check via orchestrator model, +1 API call per image
- **Brand menu** — per-event brand selection, brand reference images loaded from disk per-job during generation
- **Background menu** — per-event background selection
- **Review modes** — `"off"`, `"human"`, `"ai"` (replaces legacy `enableManualReview`)
- **Memory leak fixes** — NPS, relay quota, brand/background/style menu Maps all have cleanup intervals

## Current Data
- 469+ done jobs, 4+ events, ~3.2GB images, ~1.8MB job metadata
- Per job: ~400 bytes JSON + ~7MB images (_input.jpg ~400KB, _output.png ~6MB, _output_mms.jpg ~120KB)

---

## WHAT BREAKS AND WHEN

### At ~1,400 jobs: Azure File Share fills up
- 10GB quota / ~7MB per job = ~1,400 jobs total
- `_output.png` (5-7MB each) accounts for ~85% of storage but is ONLY used for printing
- **Fix:** Delete PNGs after print/approval, increase quota

### At ~5,000 jobs: API responses become sluggish
- `/api/images` returns ALL images as one JSON array — 5K objects = ~250KB, polled every 5 seconds
- `/api/users` iterates ALL done jobs, returns ALL users — polled every 10 seconds
- `/api/stats` loads ALL done+failed jobs into memory for aggregation — polled every 3 seconds
- `buildUsageCache()` at startup reads every file sequentially — ~5K files x 50ms = ~4 minutes on Azure Files

### At ~10,000+ jobs: App becomes unusable
- `readdir()` on done/ returns 10K+ entries — each background refresh reads all of them
- Photo book creates 10K+ DOM nodes at once (turn.js pre-builds all pages)
- Dashboard stats computation: 6+ O(n) passes over 10K jobs every 30 seconds
- Memory: 10K job objects x ~1-2KB = 10-20MB per cache (dashboard + outreach = 2 separate copies)
- Startup: `buildUsageCache()` would take 8+ minutes scanning 10K files

### At scale (hundreds of events): Event management breaks
- No event archival — old events clutter dropdowns forever
- `event=all` queries scan every event directory
- Style map builds by scanning all queue directories for every job ever processed

### AI Review at scale: Cost and latency compound
- +1 orchestrator API call per generated image (gpt-5.4 level model)
- Brand reference images re-read from disk on every generation + every AI review (not cached)
- At 15 concurrent generations: 15 simultaneous API calls + 30+ file reads for brand refs

---

## PHASE 1: IMMEDIATE FIXES (storage + sync I/O + response limits)
*Low risk, high impact. Can ship today.*

- [ ] **1a. Fix gallery.js sync I/O**
  - **File:** `lib/gallery.js:13-23`
  - `fs.readdirSync()` on hot path, polled every 5 seconds by client
  - Convert to async `fsp.readdir()` with stale-while-revalidate cache (same pattern as photogallery.js)
  - Add `const fsp = fs.promises;` at top

- [ ] **1b. Add cache headers to /images static route**
  - **File:** `index.js:84-86`
  - Currently: `express.static(settings.getDownloadDir())` with NO cache headers
  - Change to: `express.static(settings.getDownloadDir(), { maxAge: "7d" })` for final images
  - Staging route (line 80-82) should remain uncached

- [ ] **1c. Increase Azure File Share quota**
  - **File:** `deploy.sh:128`
  - Change `--quota 10` to `--quota 100` (100GB)
  - Current 10GB fills at ~1,400 jobs

- [ ] **1d. Delete _output.png after print completion or digital-only delivery**
  - **Files:** `lib/queue.js` — processSinglePrint success path (~line 600), approveJob (~line 770), and digital-only done path (~line 410)
  - After job moves to DONE_DIR, delete the large PNG: `fsp.unlink(outputPath).catch(() => {})`
  - Keep `_output_mms.jpg` (used by gallery, SMS, share links) and `_input.jpg` (used by flip-to-original)
  - **Saves ~85% of image storage** (~5.5MB per job)

- [ ] **1e. Cap /api/images response to newest 500 images**
  - **Files:** `lib/photogallery.js` (/api/images route), `lib/gallery.js:13-23`
  - After sorting, slice to first 500: `images = images.slice(0, 500)`
  - Return `{ images, total, activeStyleCount, hasMore: total > 500 }`
  - Photo book and gallery both show newest images first — users rarely scroll past #500

- [ ] **1f. Cap /api/users and /api/leads to newest 500 entries**
  - **Files:** `lib/outreach.js` — /api/users and /api/leads route handlers
  - Already sorted by lastActive/completedAt descending
  - Slice to 500 after sort, include total count for UI display

- [ ] **1g. Cap /api/failed-jobs to newest 200**
  - **File:** `lib/dashboard.js` — /api/failed-jobs route handler
  - Already sorted by createdAt descending, slice to 200

- [ ] **1h. Cache brand reference files in memory** *(NEW)*
  - **File:** `lib/pipeline.js:157, 379`
  - Brand ref PNGs are re-read from disk on every generation AND every AI review
  - At 15 concurrent generations with branding: 30+ redundant file reads
  - Cache as base64 in memory on startup and on brand settings change
  - Invalidate on brand reference upload/delete

---

## PHASE 2: CACHE CONSOLIDATION + STARTUP OPTIMIZATION
*Medium risk, reduces memory and startup time.*

- [ ] **2a. Consolidate duplicate readJobs caches**
  - **Problem:** `lib/outreach.js` and `lib/dashboard.js` both maintain independent stale-while-revalidate caches for DONE_DIR, doubling memory and I/O
  - **Fix:** Create `lib/job-cache.js` exporting shared `readJobs(dir)`, `countFiles(dir)`, and pre-warm logic
  - Both dashboard.js and outreach.js import from it — single cache, single refresh per directory

- [ ] **2b. Persist usageCache to file for fast startup**
  - **Problem:** `buildUsageCache()` (queue.js:51-73) reads every JSON file in 6 directories sequentially. At 10K jobs on Azure Files = 8+ minutes blocking startup
  - **Fix:** Save usageCache to `data/usage-cache.json` after each rebuild
  - On startup, load from file (1 read, milliseconds) then do a lightweight incremental sync
  - Increment/decrement already work in real-time; full rebuild only needed for recovery

- [ ] **2c. Make computeStats single-pass**
  - **Problem:** `computeStats()` in dashboard.js does 6+ separate iterations over allDoneJobs (user counts, style counts, hourly buckets, country breakdown, earliest/latest dates, failure breakdown)
  - **Fix:** Combine all aggregations into a single `for` loop — reduces CPU proportionally at 10K+ jobs

- [ ] **2d. Cap eventSummaryCache size**
  - **Problem:** `eventSummaryCache` Map in dashboard.js grows unbounded — one AI summary per event, never evicted
  - **Fix:** Limit to 50 entries. When full, delete oldest entry before inserting new one

- [ ] **2e. Adaptive poll interval for queue workers**
  - **Problem:** Both generation and print workers poll every 1000ms even when queues are empty. Print worker spawns `lpstat` subprocess on every tick
  - **Fix in `index.js`:** If queue empty, back off to 5000ms. If jobs found, poll at 1000ms. Only run `lpstat` when printers are configured and relay mode is disabled

---

## PHASE 3: PAGINATION + ARCHIVAL (for true 10K+ scale)
*Higher complexity. Ship when growth demands it.*

- [ ] **3a. Cursor-based pagination for /api/images**
  - Use filename as cursor (already sorted by timestamp)
  - `?limit=100&after=<last_filename>`
  - Response: `{ images: [...], total, hasMore, cursor }`
  - Client: "load more" button at end of photo book or infinite scroll in gallery

- [ ] **3b. Server-side search for /api/users**
  - Currently client-side filtering requires all rows in DOM
  - Add `?q=<search>&limit=50&offset=0` server-side filtering
  - Filter by phone (masked), style, event

- [ ] **3c. Job archival**
  - Move done/ jobs older than 90 days to `queue/archive/` directory
  - Archive not scanned by readJobs(), computeStats(), or buildUsageCache()
  - Scheduled cleanup: `setInterval` every hour, or admin button in dashboard
  - Keep usage counts in persisted file (from 2b)

- [ ] **3d. Event archival**
  - Add `archived: true` flag to event settings
  - Archived events excluded from dropdowns, polling, cache refresh
  - Admin can un-archive from settings UI

---

## PHASE 4: INFRASTRUCTURE (for production at scale)
*Architectural changes. Plan carefully.*

- [ ] **4a. Increase container resources**
  - `deploy.sh:193-194`: CPU 1.0 -> 2.0, memory 2Gi -> 4Gi
  - Allows more concurrent Sharp image processing + AI review overhead

- [ ] **4b. Add /images CDN or cache proxy**
  - Azure CDN in front of image routes
  - Or: serve from Azure Blob Storage with CDN (move images off File Share)

- [ ] **4c. Database for job metadata**
  - SQLite (single-file, zero config) or PostgreSQL
  - Replace readdir+readFile scanning with indexed queries
  - Enables: instant counts, pagination, filtering, aggregation
  - Keep file-based queue for active jobs (pending/generating/ready/printing) — these stay small

- [ ] **4d. Enable horizontal scaling**
  - `deploy.sh:224-225`: `maxReplicas: 1` -> `maxReplicas: 3`
  - Requires: distributed locking (Redis) for queue operations, shared usageCache
  - Separate generation worker from HTTP server

- [ ] **4e. Add rate limiting on /sms webhook**
  - Prevent Twilio retry storms from overwhelming the queue
  - Redis-backed rate limiter: max N requests per phone per minute

- [ ] **4f. Monitoring & alerting**
  - Add Azure Application Insights
  - Queue depth metrics endpoint (expose pending/generating/ready counts)
  - Alert on: queue backup (pending > 50), generation failure rate, storage usage > 80%

- [ ] **4g. AI review cost controls** *(NEW)*
  - Add per-event toggle for AI review (already exists via `reviewMode`)
  - Add rate limit on AI review API calls (e.g., max 20/minute)
  - Consider caching AI review results for identical input images (dedup by hash)
  - Monitor AI review latency — if > 5s average, it doubles total generation time

---

## FILES MODIFIED PER PHASE

### Phase 1
- `lib/gallery.js` — async readdir, response cap
- `lib/photogallery.js` — response cap (500 images)
- `lib/outreach.js` — response caps (users, leads)
- `lib/dashboard.js` — response cap (failed-jobs)
- `lib/queue.js` — delete PNG after print/approval/digital delivery
- `lib/pipeline.js` — cache brand reference files in memory
- `index.js` — cache headers on /images route
- `deploy.sh` — increase storage quota

### Phase 2
- New `lib/job-cache.js` — shared readJobs/countFiles cache
- `lib/dashboard.js` — import from job-cache, single-pass computeStats, cap eventSummaryCache
- `lib/outreach.js` — import from job-cache (remove duplicate cache)
- `lib/queue.js` — persist usageCache, load on startup
- `index.js` — adaptive poll interval

### Phase 3
- `lib/photogallery.js` — cursor pagination
- `lib/gallery.js` — cursor pagination
- `lib/outreach.js` — server-side search
- `lib/queue.js` — archival logic
- `lib/settings.js` — event archival flag

### Phase 4
- `deploy.sh` — resources, CDN, replicas
- `lib/queue.js` — database migration, distributed locking
- `index.js` — rate limiting, monitoring
- `lib/pipeline.js` — AI review rate limiting and caching

## Verification (Phase 1)
1. `node -c` syntax check all modified files
2. Start locally, confirm app boots and gallery/dashboard work
3. Verify PNG deletion after print completion (check downloads/ directory)
4. Verify /api/images response capped at 500
5. Verify /images route returns Cache-Control header
6. Verify brand ref caching works (check memory, no repeated disk reads in logs)
7. Push to deploy, verify on Azure

---

## WHAT DOES NOT NEED FIXING
- Memory cleanup for menu Maps (brand, background, style) — all have 30-min timeout + 5-min cleanup intervals
- NPS pending set — has 60-min timeout + 5-min cleanup (fixed in recent commit)
- Relay quota tracking — decrementUsage now called on relay max retries (fixed in recent commit)
- Settings storage — lazy-loaded per event, negligible overhead
- Leads/NPS data files — small even at scale
- Queue processing concurrency (15 concurrent generations) — appropriate for single container
- Crash recovery logic — works correctly, just slow at scale (addressed by 2b)
- Active queue directories (pending/generating/ready/printing) — these stay small by design
