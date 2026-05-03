# Builder's Guide

A plain-language walkthrough of how this app is built, the decisions behind the design, and answers to questions that come up most often. Read this if you want to be able to explain the app to someone without opening the code.

This is different from `GUIDE.md` — that one is a feature manual for operators. This one is for you, the builder, to understand *why* things are the way they are.

## Table of Contents

- [What the app does](#what-the-app-does)
- [The 30-second architecture](#the-30-second-architecture)
- [Tech stack](#tech-stack)
- [Why these choices?](#why-these-choices)
- [How a photo flows through the system](#how-a-photo-flows-through-the-system)
- [The job queue](#the-job-queue)
- [The generation pipeline](#the-generation-pipeline)
- [Printing: local vs cloud-with-relay](#printing-local-vs-cloud-with-relay)
- [The admin surface](#the-admin-surface)
- [Deployment](#deployment)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [FAQ](#faq)

---

## What the app does

A person texts a selfie to a Twilio phone number. The app uses AI to turn the selfie into a stylized portrait (cartoon, anime, oil painting, etc.), optionally dresses the subject in branded clothing, and either:

- Prints a physical copy at your booth, and/or
- Texts the portrait back to them via MMS, and/or
- Gives them a share link to post on social media

Everything is configurable at runtime through a web admin UI — no redeploys needed to change styles, brands, messages, or printer settings.

## The 30-second architecture

```
┌───────────────┐   webhook  ┌─────────────────────┐
│  Twilio (SMS) │ ─────────► │   Node.js / Express │
│  +1-555-XXXX  │            │                     │
└───────────────┘            │   Express routes    │
                             │   + state machine   │
                             │                     │
                             │   Queue workers     │
                             │   (generation,      │
                             │    print, review)   │
                             │                     │
                             │   OpenAI client     │
                             └─────────┬───────────┘
                                       │
                             ┌─────────▼───────────┐
                             │   File-based state  │
                             │   /data (settings)  │
                             │   /queue (jobs)     │
                             │   /downloads (imgs) │
                             └─────────────────────┘
```

There is no database, no Redis, no message broker. **Everything is files on disk.** That surprises people, so it's the first thing to explain when someone asks about the design.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| **Runtime** | Node.js 20 + Express 5 | Easy async I/O for a lot of concurrent small operations (downloads, API calls, file renames). Low operational overhead. |
| **SMS/MMS** | Twilio | The obvious choice — it's literally in the product name. Handles the carrier mess for us. |
| **AI image generation** | OpenAI (`gpt-image-2` primarily, `gpt-image-1.5` for transparent-background mode) | Best quality for stylized portraits with character preservation. |
| **AI orchestration** | OpenAI (`gpt-5.4` family) | For content moderation, face detection, scene analysis, AI review, and smart replies to text-only messages. |
| **Image processing** | Sharp (libvips) | Fast, well-maintained, handles weird phone JPEGs gracefully. |
| **Printing** | CUPS (`lp` command via `child_process`) | Built into macOS/Linux, already knows how to talk to every printer your OS knows. |
| **Queue** | Filesystem directories (`queue/pending/`, `queue/generating/`, etc.) | Atomic renames across directories = atomic state transitions. No extra infrastructure. |
| **Admin UI** | Server-rendered HTML + vanilla JS | Zero-build-step deploys, no React/Vue overhead for ~15 admin pages. |
| **Deployment** | Docker → Azure Container Apps | Simplest "run a container, forget about it" platform. Auto-restarts, auto-scales (though we stay at 1 replica). |
| **Persistent storage** | Azure Files share mounted at `/app/appdata` | Azure-managed, no separate DB to operate. Survives container restarts. |
| **CI/CD** | GitHub Actions | Push to main → auto-deploy to Azure. No manual steps. |
| **Print relay distribution** | Electron + electron-forge | Desktop app that event staff run without touching a terminal. |

## Why these choices?

A few are worth explaining because they drive everything else.

**No database.** At this scale (thousands of jobs per event, not millions), filesystem queues are simpler, debuggable, and survive restarts. You can literally `ls queue/pending/` to see what's stuck. Losing a DB connection can't take the app down because there is no DB connection. The tradeoff: it doesn't scale past a single replica without rearchitecting.

**Server-rendered HTML.** The admin UI is a bunch of vanilla-JS pages. No React, no build step, no bundler, no webpack config. You edit a JS file, deploy, it works. For ~15 low-traffic admin pages, the cost of a modern SPA framework isn't worth the build complexity.

**CUPS for printing.** Every modern Mac and Linux box already speaks CUPS. WiFi, Ethernet, USB, Bonjour — doesn't matter, if CUPS sees the printer, the app works. Writing native printer drivers was never considered.

**Electron relay app instead of a CLI.** The CLI works, but event staff aren't always comfortable in terminals. The Electron app gives them a button that says "Connect" and status lights that go green. Same code underneath; different interface.

**Azure Container Apps specifically.** Could have been Render, Fly, Railway, Cloud Run, ECS. Azure was chosen because of an existing account/relationship. None of the code is Azure-specific — the Dockerfile is standard, and the startup script symlinking directories works on any platform that can mount persistent storage.

## How a photo flows through the system

This is the single most useful mental model. Follow one photo from text message to delivery.

1. **Inbound SMS/MMS.** User texts a selfie to the Twilio number. Twilio POSTs to `/sms`.
2. **Message routing.** The webhook handler decides what kind of message this is:
   - Pure text with no image → route to style menu logic, smart reply, or menu response
   - Image + text → check if caption picks a style directly, else show menu
   - A reply to a menu → advance the user's state (style chosen → brand menu → background menu → enqueue)
3. **Lead capture gate (optional).** If lead capture is configured for "before," the user answers a short SMS survey first; their photo is held in memory. For "after," the portrait is generated but the completion SMS is held until they finish the survey.
4. **Enqueue.** A job file is written to `queue/pending/`. It's named with a timestamp prefix (e.g. `20260502_143000.json`). Multi-variant mode writes N files with a shared `parentJobId`.
5. **Generation worker picks it up.** Every second, the worker scans `pending/` and claims jobs (up to `maxConcurrentGeneration`) by renaming them to `generating/`. The rename is atomic — two workers can't claim the same job.
6. **Pipeline runs** (see the next section). On success, the output lands in `downloads/<eventName>/<prefix>_output.png`, and the job moves to one of three places based on configuration: `review/` (human or AI review), `ready/` (to print), or `done/` (digital-only).
7. **Printing (if enabled).** Either the local print worker (local mode) or the Print Station relay (cloud mode) picks up jobs from `ready/`, prints them, and moves them to `done/`.
8. **SMS delivery.** Once the job is complete, the user gets an MMS (or text-only share link, depending on settings).
9. **Optional follow-ups.** Promo message 15 seconds later; NPS survey after their last allowed portrait.

Each step is fully independent. If the printer is down, generations keep queuing. If OpenAI is rate-limited, already-generated jobs keep printing. The filesystem queue decouples everything.

## The job queue

The queue is seven directories:

| Directory | What it holds |
|---|---|
| `queue/pending/` | New jobs waiting for the generation worker to claim them |
| `queue/generating/` | Jobs currently being generated (up to N concurrent) |
| `queue/review/` | Jobs waiting for human or AI approval (when review mode is on) |
| `queue/ready/` | Generation done, waiting to print |
| `queue/printing/` | Being printed right now |
| `queue/done/` | Successfully completed |
| `queue/failed/` | Permanent failures or max retries exceeded |

A job moves through the directories as it progresses. **The move itself is the state transition** — there's no separate "state" column in a database. If you want to know where a job is, run `find queue -name 20260502_143000.json`.

Why directories? Because renaming a file between directories is atomic on every filesystem. Two workers can race to claim the same job; only one of the rename calls will succeed, the other gets `ENOENT`. No locks, no race conditions.

**Recovery is built in.** On every boot, `recoverStaleJobs()` scans each directory and re-routes anything that was mid-flight when the server stopped. Jobs in `generating/` that already have an output file skip straight to `ready/`. Jobs in `printing/` get retried. Plus there's a runtime sweeper for jobs stuck in `generating/` for more than 5 minutes (added after a real incident where OpenAI calls hung and jobs never returned).

## The generation pipeline

`lib/pipeline.js` is where the actual AI work happens. For each job, in order:

1. **Download the selfie** from Twilio's media URL to `downloads/<event>/<prefix>_input.jpg`.
2. **Content moderation.** OpenAI's moderation endpoint checks for anything inappropriate. Flagged images bail out immediately with an apologetic SMS.
3. **Face detection + scene analysis.** Two parallel OpenAI vision calls: "is there a face in this photo?" and "describe the subjects (how many people, any pets, their positions)." No face → reject with SMS. Scene data feeds the next step.
4. **Prompt assembly.** Merge the user's chosen style prompt with the brand prompt, background prompt, scene-specific instructions (e.g. "2 people on a bench"), and all the global art-direction preserves/reminders. This is the thing that gets sent to the image model.
5. **Brand reference analysis (cached).** If brand references are configured, a vision model describes the outfit once, and the description is cached so parallel variant calls don't re-analyze.
6. **Image generation.** Call OpenAI's image-edit endpoint with the selfie + brand reference images + the assembled prompt. The response is a base64-encoded PNG.
7. **Save + resize.** Output saved to `downloads/<event>/<prefix>_output.png` at print resolution (1500×2100 for 5×7), and an MMS-sized JPEG at `<prefix>_output_mms.jpg`.
8. **Optional template overlay.** If a template PNG is configured, the portrait is composited into the template's transparent window.

**Error handling.** Failures get retried up to 3 times. Permanent failures (moderation, no face, content policy) skip retries and go straight to `failed/`. The user gets a "sorry, try another photo" SMS and their print count is refunded.

**The OpenAI retry rescue.** When OpenAI returns `400 Invalid image file or mode` (happens with some iPhone JPEGs — iPhone Smart HDR embeds extra metadata some decoders choke on), the pipeline re-encodes the selfie through Sharp and retries once. Added after this bit real users from multiple carriers.

## Printing: local vs cloud-with-relay

Two fundamentally different deployments, same code.

**Local mode.** The app runs on a Mac at the booth. The printer is plugged into that Mac (USB or on its WiFi). The print worker shells out to the `lp` command via Node's child_process module. Simple. Everything in one place.

**Cloud mode.** The app runs in Azure. The printer is at your event venue, hundreds of miles away. There's no way for the cloud container to talk directly to a USB printer. So: a small Electron app ("Print Station") runs on a laptop at the venue, polls the cloud every 5 seconds for ready-to-print jobs, downloads them, and prints them locally.

The cloud side exposes `/api/print-relay/*` endpoints behind a shared secret:

- `GET /jobs` — "anything ready for me?"
- `POST /jobs/:id/ack` — "I'm taking this one" (atomic rename claim)
- `GET /image/:event/:file` — "send me the bytes"
- `POST /jobs/:id/complete` — "I printed it" (or failed it)
- `POST /jobs/:id/heartbeat` — "I'm still alive and working" (v1.1+)

**Heartbeats are important.** Without them, if the Electron app crashes or the laptop goes to sleep mid-print, the job is stuck in `printing/` with no one working it. The stale-recovery path eventually catches it after 15 minutes. That's an eternity at a live event. v1.1 relays heartbeat every 20 seconds; the cloud recovers jobs after 60 seconds of missing beats.

**Multi-printer support.** You can plug multiple printers into the laptop and select all of them in the Print Station. Each gets its own worker. Jobs distribute naturally: whichever printer finishes first grabs the next one. If one jams, the others keep printing.

**Failover.** If Printer A fails a specific job, the cloud records it in the job's `failedPrinters` array. On retry, the cloud serves that job to any other printer that hasn't failed it. A busted printer doesn't keep getting handed jobs it's just going to fail again.

**Disabling a printer.** The dashboard has a disable button per printer. Disabled printers get empty responses from `/jobs`, so they stop printing. Jobs currently targeted at a disabled printer get re-targeted automatically. Useful when one station runs out of paper and you want its work to flow elsewhere.

## The admin surface

Five pages, each mounted at a different route:

| Route | What it's for |
|---|---|
| `/home` | The admin console. Launches booth displays, contains the Settings panel that controls everything. |
| `/dashboard` | Real-time monitoring. Queue depth, failures, top users, geography, print health, combined jobs panel. |
| `/outreach` | User directory with broadcast SMS, raffle draws, lead export. |
| `/photogallery` | Photo book — animated flip-through gallery of portraits for booth displays. |
| `/home/combo` | Split-screen booth display (intro video + photo book side by side). |

**The settings panel is the heart of the app for operators.** Seven collapsible sections: Event & Operations, Styles & Art, Branding, Backgrounds, Delivery & Display, Engagement & Messages, Social Sharing, API Keys. Everything in there writes to `data/settings.json` and takes effect immediately — no restart. Per-event profiles save/restore the whole set when you switch events.

**Authentication is trust-the-network.** The admin pages have no login. They rely on the URL being unguessable (which for a personal deployment is fine) and/or a review PIN for staff-level access (that lets someone approve reviews without seeing the full admin). Cloud deployments should put the whole thing behind a VPN or IP allowlist — this is a thing to know, not a bug. It's explicit: the app was never built for public admin access.

## Deployment

**Local:** `pnpm install && pnpm start`. Point ngrok at port 3000, put the ngrok URL in Twilio's webhook config. Done.

**Cloud:** the `.github/workflows/deploy.yml` workflow runs on every push to `main`. It:

1. Validates the code (`ci.yml`: install deps, smoke-start the server, check it serves `/healthz`)
2. Ensures all Azure resources exist (resource group, container registry, file share, container apps environment)
3. Builds a Docker image in Azure Container Registry using `az acr build .`
4. Updates the running container app to point at the new image

The whole thing takes ~3 minutes from merge to live. The container config (CPU, memory, env vars, volume mounts) lives in `.github/containerapp.yaml` — a YAML template rendered with `envsubst` at deploy time.

**Persistent storage gotcha worth knowing.** The `scripts/start.sh` startup script symlinks certain directories on the container's filesystem to the Azure Files mount at `/app/appdata`. This is how settings, queue, and downloads survive container restarts. One directory (`assets`) was in that list accidentally and caused a multi-week bug where CSS changes never took effect — the first deploy's CSS got copied to the share, and every subsequent deploy's CSS was refused by `cp -n` ("don't overwrite"). Fixed by removing `assets` from the list; now static files are served straight from the image.

**Secrets.** Set via `az containerapp secret set` in the deploy workflow, referenced in containerapp.yaml via `secretRef`. Twilio credentials, OpenAI API key, Google OAuth (unused currently), session secret. Rotating a secret = updating the GitHub Actions secret + re-running the deploy.

**Two Docker images, one codebase.** The main server image (`Dockerfile`, root) runs the app. The Electron Print Station is built separately with `electron-forge` in `relay-app/` and distributed as a `.zip` — not containerized, not in CI, built on-demand with `pnpm run make` when you need a new release.

## Design decisions worth knowing

A few things that came from specific pain and are worth keeping in mind if you're modifying the code.

**1. Filesystem queue with atomic rename — not because it's trendy, because it works.** Every job state transition is a `fs.rename` across directories. Two workers racing to claim the same job: only one rename succeeds, the other gets ENOENT. No locks, no transactions, no rollbacks. You can `ls` to see the queue.

**2. Stale-while-revalidate caching for directory reads.** `lib/dashboard.js` caches file lists and parsed job files for 30 seconds. Dashboard hits the cache; background refresh updates it. Azure Files is network-attached and slow (~50ms per stat call); without caching, every dashboard poll would re-read hundreds of files.

**3. Review modes exist because operators asked for them.** `off` / `human` / `ai`. Humans review brand-sensitive events. AI reviews medium-trust events where you want *something* to catch obvious failures. Multi-variant mode (`variantsPerReview > 1`) generates N candidates per request and lets reviewers pick the best.

**4. The `stillWorking` timer is in-memory on purpose.** When a user's photo takes 60+ seconds, they get a reassuring "still working on your portrait" SMS. Timer lives in process memory, armed at enqueue, cancelled on delivery or failure. If the process restarts mid-flight, the timer dies — that's the safe failure mode (no stale SMS). Don't persist this.

**5. Multi-variant supersede semantics across the whole pipeline.** When a reviewer approves one variant of a parent job, the code has to kill siblings wherever they are (`review/`, `pending/`, or mid-generation). The `_findVariantSiblings` helper scans all three. For siblings being actively generated, the supersede flag is written in place — the generation worker re-reads the file on success and drops the output if it sees the flag. This closes a race that used to produce phantom review cards.

**6. The file-based queue doesn't scale past one replica.** In-memory state (generation count, printer-busy tracking, stillWorking timers, caches) is per-process. Two replicas would double-count concurrency and possibly print the same job twice on different machines. The app is single-replica on purpose. If you ever need to scale: introduce Redis or a DB, move shared state out of process, then add replicas. Don't add replicas first.

**7. The startup script decides what's persistent vs. baked-in.** Anything in the list in `scripts/start.sh` survives container restarts via the Azure Files mount. Anything NOT in the list comes fresh from the Docker image every deploy. Getting this wrong in either direction is a real bug source (user data lost vs. stale shipped files pinned forever).

**8. Sharp is used for everything image-related.** Download normalization, thumbnailing, template compositing, MMS-size variants, chroma-keying the exact-background mode. It's fast, handles every format, and is a single dependency. No ImageMagick, no canvas.

**9. Heartbeats added to the relay specifically because of a real event day.** Operators lost 15+ minutes of prints when the relay laptop crashed. Pre-heartbeat, the stale-recovery path waited 15 min before re-queueing. Heartbeats cut that to ~60s.

**10. Every error surface has a path back.** Failed generations can be retried from the dashboard. Printer failures avoid the failed printer on retry. Disabled printers auto-release targeted jobs. The goal is: no job silently dies. Worst case it ends up in `failed/` with a readable `failReason`.

**11. Twilio Messaging Service over a single From number.** When `twilioMessagingServiceSid` is set, outbound messages use that service instead of a specific `from` number. Twilio picks the right sender from the pool per destination (10DLC for US, toll-free for international) and handles sender-pool retries automatically. The app doesn't decide per-country routing — the Messaging Service does. Leaving the SID blank falls back to the direct `from` behaviour for local dev.

## FAQ

Common questions people ask when they encounter the app for the first time.

### About the app itself

**Q: What exactly does the AI do — is it really the user's face, or a generic cartoon?**
A: It's really their face. The image model (OpenAI's gpt-image-2 edit endpoint) takes the selfie as input and transforms it into the chosen style while preserving identity — same face shape, hair, skin tone, glasses, etc. The prompt explicitly tells the model not to "de-age, smooth, or cartoonify" the person.

**Q: How long does a portrait take to generate?**
A: Typically 30-60 seconds. OpenAI's image model is the bottleneck. If the user picked a style or a brand menu, add a few seconds of SMS back-and-forth on top.

**Q: Can users send any photo, or does it have to be a selfie?**
A: Any photo with a face. The face-detection step will reject photos without a clear face. Scene analysis handles group photos — a photo of two people produces a portrait of two people, the prompt is dynamically adjusted to say "exactly 2 humans in the output."

**Q: What if someone sends an inappropriate photo?**
A: Content moderation runs first, before generation. Flagged photos get an apologetic SMS and don't cost the user a print. OpenAI's own content policy also blocks certain generations at the model level.

**Q: Can the same person use it multiple times?**
A: Yes, up to the configured `maxPrints` per phone number per event (default 2). Admin phone numbers have no limit. Quota is per-event, so if you run a new event, everyone gets a fresh allotment.

### User experience

**Q: What's the actual SMS flow a user sees?**
A: Text selfie → (optional) lead capture survey → style menu ("1. cartoon, 2. anime, …") → (optional) brand menu → (optional) background menu → "we're working on it" → portrait delivered via MMS and/or share link. Most events use just style selection; the menus are all optional and configurable.

**Q: How do users know to text the number?**
A: Booth signage. The `/home/panel` page generates a branded instruction screen with a QR code that reveals the Twilio number when scanned. You run that on a monitor at the booth.

**Q: What happens if a user types gibberish or asks a question instead of picking a style?**
A: The app uses a smaller AI model (gpt-5.4-nano) to generate a conversational response. If they ask "what is twilio?" they get a real answer. If they say "hi", they get the style menu again. Short common phrases have static responses for speed.

**Q: Do users have to choose a style every time?**
A: No — they can include the style in the photo caption ("make me anime"). If they do, the menu is skipped. If only one style is enabled for the event, it's auto-selected. Same for brand and background menus.

**Q: What if the app doesn't recognize their style choice?**
A: It uses fuzzy matching — "anime", "Anime", "anime portrait", "3" (if anime is option 3) all work. If it still can't match, they get a retry message.

### Printing

**Q: What printer does this work with?**
A: Tuned for the Epson EcoTank ET-8550, but any CUPS-compatible printer works. Non-Epson printers might need custom `lp` flags (set via `customPrintFlags` in settings).

**Q: Does the printer need to be plugged in via USB?**
A: No. Any connection CUPS sees works: USB, WiFi, Ethernet, AirPrint-discovered. Run `lpstat -p` — if it's there, the app can use it.

**Q: Can I print to multiple printers at the same event?**
A: Yes. In the Print Station, check multiple printers; jobs distribute automatically. Whichever finishes first grabs the next job.

**Q: What if a print fails?**
A: Auto-retry up to 3 times. Each retry prefers a different printer than the one that just failed. If all retries fail, the job moves to `failed/` and you can click "Retry Print" in the dashboard manually.

**Q: What if someone asks to reprint a photo they already got?**
A: Dashboard → Completed Jobs panel → Reprint button. You can optionally target a specific printer. No SMS is re-sent; no quota impact.

**Q: Can I route a specific job to a specific printer?**
A: Yes — the Retry and Reprint buttons both have a printer dropdown. Pick a printer or leave it on "Any."

**Q: Can I force all jobs to a different printer if one has issues?**
A: Yes. Dashboard → disable the bad printer. Jobs targeted at it get re-routed. New jobs flow to the remaining printers. Re-enable when fixed.

**Q: What happens if the printer runs out of paper mid-event?**
A: The relay detects the printer going offline/stopped and fails the job with an error. It's re-routed to another printer if you have one. **Caveat:** out-of-paper can appear as "media jam" or similar states the current code doesn't fully watch for; reload paper and the printer should catch up on its own, but keep an eye on the relay's job history for "failed" statuses.

### Cloud deployment and relay

**Q: Why run the app in the cloud if printing needs a local machine anyway?**
A: Because the app itself is more than printing. The Twilio webhook has to be publicly reachable 24/7, and cloud hosting is easier to keep online than a laptop at an event. Splitting the work — cloud handles SMS + AI, local laptop handles paper — is the natural division.

**Q: What is the Print Station app?**
A: A small Electron desktop app (Mac, ~99MB). It's the bridge between the cloud and the printer. Event staff run it on a laptop at the venue, enter the cloud URL and relay key, select printers, click Connect. It polls the cloud every few seconds for print jobs.

**Q: Does the Print Station laptop need constant internet?**
A: Yes — it polls the cloud. But it handles flaky connections: if the network drops mid-session, it keeps trying with exponential backoff, reconnects automatically when things come back.

**Q: What happens if the laptop crashes mid-print?**
A: v1.1+ Print Stations send a heartbeat to the cloud every 20 seconds while they're holding a job. If the cloud sees no heartbeat for 60 seconds, it assumes the laptop is dead and re-queues the job. Another Print Station (or the same one restarted) picks it up and prints it.

**Q: Can I run multiple Print Stations at the same event?**
A: Yes — they all use the same relay key. Jobs race: first to claim wins. Useful for redundancy (backup laptop) or scale (two laptops, different printers).

**Q: What if I need to update the Print Station?**
A: Download the new `.zip` from `relay-app/out/make/...` (built with `pnpm run make`). Unzip, replace the old app. Config is preserved.

**Q: Does the cloud app require Azure?**
A: No. The Dockerfile is standard. You can run it on Fly.io, Railway, Render, Cloud Run, AWS ECS, anywhere that runs a Docker container with persistent volume mounts. Azure is just what's currently set up.

### Operations and monitoring

**Q: How do I know if things are healthy during an event?**
A: The `/dashboard` page polls every 3 seconds and shows: queue depth, generation times, failure breakdown, printer status, stuck-job alerts. If anything is backing up, you'll see it there.

**Q: What's the difference between "failed" and "superseded" in the dashboard?**
A: Failed = an error happened (moderation, printer, generation). Superseded = a multi-variant job where the reviewer picked a different sibling. Superseded jobs are not failures — they're expected outcomes — so the dashboard excludes them from failure rates.

**Q: How do I broadcast an SMS to all attendees?**
A: `/outreach` page — select users (individually or all), compose, send. Good for announcements ("booth closes in 10 minutes") or follow-ups ("thanks for coming, here's a code").

**Q: How do I draw a raffle winner?**
A: `/outreach` → Draw Winner button. Animates through users before landing on one. Winner is saved permanently in `data/raffle.json`. Running it again picks a different person.

**Q: How do I export leads (if using lead capture)?**
A: `/outreach` → Lead Capture panel → Download CSV. All survey fields plus phone and capture time.

### Configuration and styles

**Q: How do I add a new art style?**
A: `/home` → Settings → Styles & Art → Add Custom Style. Give it a name and a prompt. Live immediately. Existing built-in styles are editable too, with a reset button.

**Q: How do I switch between different events?**
A: Change the Event Name field in settings. Picking an existing event from the dropdown auto-saves the current event's settings and loads that event's settings. Everything (styles, brands, messages, etc.) is per-event. Global things (API keys, printers, admin phones) stay put.

**Q: What's the difference between global and per-event settings?**
A: Creative stuff (styles, brands, backgrounds, SMS messages, booth display) is per-event — each event has its own profile. Infrastructure (Twilio/OpenAI credentials, admin phones, printer config, concurrency) is global — shared across all events.

**Q: How do I change the SMS messages users see?**
A: Settings → Engagement & Messages → SMS Messages. Every message the app sends is editable. `{variable}` interpolation works for dynamic values like `{eventName}`, `{styleName}`, `{firstName}`.

**Q: How do I add a new brand/team (e.g. LA Kings)?**
A: Settings → Branding → enable multi-brand mode → Add Brand. Give it a name, a prompt ("wearing an LA Kings jersey…"), and select reference images from the uploaded library. Brands are shared across events; each event picks which are enabled.

### Design and technical decisions

**Q: Why no database?**
A: Scale doesn't justify it. At thousands of jobs per event (not millions), filesystem directories work fine and survive restarts via the persistent volume mount. Simpler to operate (no DB to back up, no credentials, no schema migrations). The downside is lack of concurrent-writer support — which limits us to one replica. Acceptable trade-off for the use case.

**Q: Why no React/Vue/modern framework?**
A: The admin UI is a handful of low-traffic pages. Adding a framework would mean adding a build step, bundler config, dev server, hot-reload dance — for no measurable user benefit. Vanilla JS works, loads fast, deploys are one file change.

**Q: Why is everything in one Node process?**
A: Simplicity. Webhook, workers, dashboard, all share memory. You can see the state by looking at one PID. If you split workers into separate services you'd add deployment complexity and inter-service communication for questionable gain. The in-process approach limits horizontal scale, but that's a concession, not an oversight.

**Q: Is the app safe to expose to the internet?**
A: The `/sms` webhook is; Twilio authenticates requests. The admin pages (`/home`, `/dashboard`, `/outreach`) have no login. In cloud deployments, the public URL should be treated as semi-secret. For stricter setups, put it behind a VPN, reverse proxy with basic auth, or IP allowlist. Adding real auth is on the "nice to have" list, not "required."

**Q: Are user phone numbers and photos stored permanently?**
A: Photos yes — `downloads/<eventName>/<prefix>_input.jpg` and `<prefix>_output.png` stick around. Phone numbers are stored in job files, lead data, raffle data, NPS scores. Nothing is auto-deleted. For a production-grade retention policy, you'd need to add explicit cleanup — not implemented.

**Q: Can I run two events at once on the same deployment?**
A: Only one "active" event at a time. The event name in settings determines where incoming MMS gets routed. If you need two simultaneous events, the clean answer is two separate deployments with different Twilio numbers.

### Troubleshooting

**Q: A user texted but got no response — what do I check?**
A: Twilio Console first — did the webhook fire? Did it return 200? If Twilio is happy, check `/dashboard/logs` on the app for errors. Usually it's a bad phone number format, a Twilio account issue, or a full OpenAI quota.

**Q: The dashboard shows jobs stuck in "generating" for minutes.**
A: The sweeper should auto-rescue them after 5 minutes. If they're stuck longer, check `/dashboard/logs` for OpenAI errors. Manually retry from the dashboard as a last resort.

**Q: The Print Station says "Connected" but nothing is printing.**
A: Check that the printer is selected (checkbox in the printer list). Check that the cloud app has `enablePrinting = true` AND a `printRelayKey` set. On the cloud dashboard, make sure the printer shows up (it self-registers when the relay polls) and isn't disabled.

**Q: CSS changes aren't showing up after a deploy.**
A: Hard-refresh the browser (Cmd+Shift+R) to bust the 5-minute browser cache. If that doesn't fix it, the Azure Files share may have an old copy of the CSS pinned — see design note #7 above. Grep the served CSS for a known recent change; if it's missing, the deploy pipeline has the issue we patched once before.

**Q: OpenAI is returning "Invalid image file or mode" errors for one user's photo.**
A: The code auto-retries once with a Sharp re-encode, which fixes most cases (especially iPhone Smart HDR). If it still fails, the user's photo has a format we can't recover — ask them to take a new photo, preferably from a different device, or toggle their iPhone camera to "Most Compatible" format.





