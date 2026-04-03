# Detailed Guide

This document covers all features and configuration in depth. For quick setup, see the [README](../README.md).

## Table of Contents

- [Environment Variables](#environment-variables)
- [Template Frames](#template-frames)
- [Printer Setup](#printer-setup)
- [Web UI](#web-ui)
  - [Home Page](#home-page)
  - [Get Started Video](#get-started-video)
  - [Static Instruction Page](#static-instruction-page)
  - [Booth Display](#booth-display)
  - [Photo Book](#photo-book)
- [Admin Dashboard](#admin-dashboard)
  - [Event Report](#event-report)
  - [Paper Counter](#paper-counter)
- [Style Selection](#style-selection)
- [Adding or Changing Styles](#adding-or-changing-styles)
- [Branding](#branding)
  - [Single Brand Mode](#single-brand-mode)
  - [Multi-Brand Selection](#multi-brand-selection)
- [Background Selection](#background-selection)
- [Delivery Mode](#delivery-mode)
- [Print Relay (Cloud Printing)](#print-relay-cloud-printing)
- [Cloud Deployment](#cloud-deployment)
- [Lead Capture](#lead-capture)
- [Outreach](#outreach)
- [Configurable SMS Messages](#configurable-sms-messages)
- [NPS Survey](#nps-survey)
- [Social Sharing](#social-sharing)
- [BRB Screen](#brb-screen)
- [Promotional Messages](#promotional-messages)
- [Runtime Settings](#runtime-settings)
- [Import Style Prompts](#import-style-prompts)
- [Switching Events](#switching-events)
- [Job Queue](#job-queue)
  - [Crash Recovery](#crash-recovery)
  - [Permanent Failures](#permanent-failures)
  - [Retry Logic](#retry-logic)
- [Project Structure](#project-structure)

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Your Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Your Twilio Auth Token |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `PRINTER_NAME` | Yes | CUPS printer name prefix (find with `lpstat -p`). The app matches any printer starting with this name, so `EPSON_ET_8550_Series` matches `EPSON_ET_8550_Series_2`, etc. |
| `EVENT_NAME` | Yes | Name of the current event (used for per-event print limits and download folders) |
| `ADMIN_PHONES` | No | Comma-separated phone numbers in E.164 format (e.g. `+14155551234`). Admins get unlimited prints and are excluded from dashboard metrics. |
| `MAX_PRINTS_PER_USER` | No | Max free prints per phone number per event. Defaults to `2`. |
| `MAX_CONCURRENT_GENERATION` | No | Max AI image generations running at the same time. Defaults to `3`. Increase for faster throughput, decrease if hitting OpenAI rate limits. Configurable at runtime under Event & Operations. |
| `TEMPLATE_FILE` | No | Filename of the template frame in the `templates/` folder (e.g. `signal_sf.png`). Leave blank to disable. |
| `VIDEO_FILE` | No | Filename of the Get Started video in the `assets/` folder (e.g. `get-started.mp4`). Defaults to `get-started.mp4`. |
| `TERMS_URL` | No | URL to your terms of service. Displayed on booth screens (video, combo, photo gallery). |
| `ENABLE_PRINTING` | No | Set to `false` to disable printing and run digital-only (MMS delivery). Defaults to `true`. |
| `BRAND_PROMPT` | No | Global branding prompt appended to every art style (e.g. clothing, logos). Leave blank to disable. |
| `PRINT_SIZE` | No | Print paper size. Options: `4x6`, `5x7`, `8x10`. Defaults to `5x7`. Controls both image pixel dimensions and the PageSize flag sent to the printer. |
| `PRINT_QUALITY` | No | Print resolution. Options: `standard` (360 DPI), `high` (720 DPI), `max` (1440 DPI). Defaults to `high`. |
| `CUSTOM_PRINT_FLAGS` | No | Additional raw flags appended to the `lp` command. For non-Epson printers or advanced CUPS options (e.g. `-o MediaType=Glossy`). |
| `PROMO_MESSAGE` | No | Promotional message sent as a standalone SMS after each portrait delivery. Leave blank to disable. |
| `PRINT_RELAY_KEY` | No | Shared secret for the print relay agent. Set this to enable cloud-to-local printing. See [Print Relay](#print-relay-cloud-printing). |
| `PRINT_RELAY_URL` | No | Cloud app URL for the relay agent (used by the local script only, not the server). |
| `PRINT_RELAY_PRINTER` | No | Override printer name for the relay agent (default: auto-detect). |
| `PRINT_RELAY_INTERVAL` | No | Relay poll interval in seconds (default: `5`). |
| `PRINT_RELAY_DRY_RUN` | No | Set to `true` to download images without printing (for testing). |

## Template Frames

Place your template PNGs in the `templates/` folder. Set `TEMPLATE_FILE` in `.env` to the filename you want to use (e.g. `signal_sf.png`). You can also change the template at runtime from the Settings panel on the home page under **Styles & Art**, and upload new templates directly through the UI.

Templates should be PNGs with **transparent areas** where the generated portrait shows through. The opaque areas form the frame border (branding, logos, CTA, etc.). The template is composited on top of the portrait at print dimensions (1500x2100).

The app automatically detects the template's transparent window and fits the portrait within it, so frame borders never clip the subject's head or body. A small inset padding keeps the portrait from touching the frame edge. If no transparent area is found, the portrait fills the entire print area as a fallback.

The template can be **any resolution** -- it gets resized to fit the print automatically. For best results, use a 5:7 aspect ratio. Other ratios work too; the full frame design is preserved with transparent padding if the ratio doesn't match.

Leave `TEMPLATE_FILE` blank to disable the frame overlay.

## Printer Setup

### Compatible printers

The app is built and tested with the **Epson EcoTank ET-8550** wide-format photo printer. The print command options (page size, margins, resolution) in `lib/printer.js` are Epson-specific. Other Epson EcoTank models that support 5x7 borderless photo printing should also work.

Using a non-Epson printer (Canon, HP, Brother, etc.) requires changing the `-o` flags in the `lp` command in `lib/printer.js` to match that printer's supported options.

### Connection methods

The app prints through **CUPS** (Common Unix Printing System), which is built into macOS and Linux. Any printer that appears in CUPS works, regardless of how it's connected:

- **USB** -- direct connection, most reliable
- **WiFi / Network** -- printer and server on the same network
- **Bonjour / AirPrint** -- automatic discovery on local networks (common for macOS)
- **IPP** (Internet Printing Protocol) -- standard network printing

All connection methods behave identically from the app's perspective. The `lp` command sends jobs to the CUPS daemon, which handles the connection details. A WiFi-connected Epson ET-8550 works the same as a USB-connected one.

### Find your printer name

```sh
lpstat -p
```

Copy the printer name (e.g. `EPSON_ET_8550_Series`) into `PRINTER_NAME` in your `.env`. The app matches any printer starting with that prefix. If multiple printers match, it picks a healthy one over a disconnected or disabled one.

Print settings (page size, resolution, borderless options) are configured in `lib/printer.js`. The defaults are tuned for an Epson ET-8550 on 5x7 photo paper with no margins.

## Web UI

### Home Page

The home page at `/home` is the admin console for booth operators. It provides three action cards:

- **Launch Booth Display** -- opens a split-screen view (`/home/combo`) with the intro video and photo book side by side. The divider is draggable to resize each pane. An expandable "Open individually" section provides direct links to the intro video and photo book separately.
- **Open Dashboard** -- links to the admin dashboard for monitoring and management
- **Outreach** -- links to the dedicated outreach page for broadcast messaging, raffles, and lead capture reports

The home page also includes a collapsible **Settings** panel where admins can configure all app settings at runtime without editing `.env` or restarting the server. See [Runtime Settings](#runtime-settings) for details.

A **How It Works** section shows the 6-step flow from setup through attendee engagement.

### Get Started Video

The intro video at `/home/video` is a fullscreen looping video player designed to run on a booth display monitor to attract attendees and show them how the photobooth works.

- Place your video file in the `assets/` folder (or upload via the Settings panel)
- Set `VIDEO_FILE` in `.env` to the filename (defaults to `get-started.mp4`)
- The video autoplays on loop with floating BRB, Pause/Play, and Fullscreen buttons
- To switch videos, change the setting from the Settings panel on `/home` or update `.env`

### Static Instruction Page

The static page at `/home/panel` is a branded instruction panel designed for booth monitors. It displays a QR code, numbered steps, and configurable text -- all with Twilio typography (Display Extrabold headlines, Text body copy, Mono step numbers) and draft line accents.

Configure from the Settings panel under **Booth Display** when the display mode is set to "Static Page":

- **Headline** -- large text at the top (e.g. "Get Your AI Portrait")
- **Subline** -- smaller text below the headline (e.g. event name)
- **QR Code** -- uploadable image that attendees scan to start
- **Steps 1-3** -- numbered instructions shown below the QR code
- **Legal Text** -- small compliance text at the bottom

The page includes BRB and Fullscreen buttons. When no QR code is uploaded, a placeholder message is shown.

### Booth Display

The booth display at `/home/combo` is a split-screen view with the left pane and photo book side by side on a single monitor. The divider between panes is draggable to resize each side.

The **Display Mode** setting (under Booth Display in the Settings panel) controls what shows on the left side:

| Mode | Left pane | Right pane | Use case |
|------|-----------|------------|----------|
| **Video** | Looping intro video (`/home/video`) | Photo book | Attract with video |
| **Static Page** | Instruction panel with QR code (`/home/panel`) | Photo book | QR-driven engagement |
| **None** | *(no left pane)* | Photo book (full width) | Photo book only |

When the mode is "Video" but no video file is selected, the display falls back to full-width photo book (same as "None").

### Photo Book

The photo book at `/photogallery` presents AI-generated portraits as an open book with two pages side by side. Uses the [turn.js](https://github.com/nickmilo/turn.js) library for realistic page-turn animations. Designed for a tactile, physical feel on booth displays.

- Open book layout with left and right pages showing different portraits
- Realistic page-turn animations powered by turn.js (drag corners or use arrows)
- Stacked page layers and book cover for a realistic book depth effect
- Per-page "View Original" buttons to reveal the original selfie
- Page numbers on each page (highest to lowest, newest to oldest)
- White photo frame mat around each image with decorative corner mounts
- Auto-rotates through spreads every 10 seconds
- Play/Pause, keyboard arrows, and clickable thumbnails for manual navigation
- Fullscreen support with responsive sizing
- Warm parchment-toned pages with subtle paper texture
- **Event filter** -- dropdown to filter portraits by event, or view all events combined
- Live portrait counter with animated bump when new images arrive
- Polls for new images every 5 seconds

## Admin Dashboard

The admin dashboard is available at `/dashboard`.

Use the **event selector** dropdown in the header to filter all metrics by a specific event, or view combined totals across all events. Events are discovered from both job history and the `downloads/` directory, so any event with a folder or completed jobs appears in the dropdown.

The **Exclude admin** checkbox in the header filters out admin phone numbers from all metrics -- totals, averages, top users, style breakdowns, and geography. Uncheck it to include admin activity (useful during testing). PDF reports always exclude admin activity.

The dashboard shows:

- **Stats overview** -- total prints, prints in the last 24 hours, unique users, average prints per user, current queue depth
- **Generate Report** -- button to download a PDF event report (see below)
- **Style breakdown** -- bar chart showing how many prints of each art style
- **Hourly activity** -- bar chart of prints per hour over the last 24 hours with hour labels and hover tooltips
- **Top users** -- most active phone numbers (masked for privacy)
- **Job health** -- completed vs failed counts, overall success rate, content rejection rate, and average generation/print times
- **Failure breakdown** -- bar chart categorizing failures by reason (moderation, face detection, generation/API errors, printer errors, crash recovery)
- **User geography** -- bar chart showing where users are located based on phone number country codes
- **Queue status** -- live counts for each pipeline stage (pending, generating, ready, printing) and printer status. Stuck job detection alerts when a job has been generating for over 5 minutes or printing for over 10 minutes.
- **Paper counter** -- estimated remaining sheets based on prints sent, with a visual progress bar. Configurable capacity and warning threshold. Alerts when paper is low or empty. Click "Reset" after reloading the tray.

The dashboard auto-refreshes every 3 seconds. No external dependencies -- it's a single self-contained HTML page with inline CSS and JavaScript.

### Event Report

Click **Generate Report** on the dashboard to download a PDF summarizing key event metrics. The report includes:

- AI-generated event summary (via OpenAI)
- Key metrics (total prints, unique users, avg per user, most popular style, success rate, avg generation/print times)
- Style breakdown table
- Top users
- NPS score (average, response count, 1-5 distribution)
- Failure analysis with rejection rate
- User geography (top 10 countries)

The report respects the currently selected event filter. AI summaries are cached in memory so repeated downloads don't re-call the API.

### Paper Counter

The paper counter is a software estimate -- it decrements automatically each time a print completes. Most consumer/prosumer printers (including the Epson ET-8550) don't expose paper tray level via CUPS or any standard API, so this counter tracks it for you based on prints sent.

- Default capacity: 20 sheets, warning at 2 remaining
- Both values are adjustable from the dashboard
- Console logs warnings when paper is low or empty
- State persists across server restarts (saved to `data/paper.json`)
- Press "Reset" after reloading the paper tray to reset the count

## Style Selection

After sending a selfie, users receive a numbered style menu:

```
Great selfie! Pick your art style:

1. cartoon
2. pop art
3. watercolor
4. anime
5. sketch
6. pixel art

Reply with a number or style name.
```

Users can reply with a number (`3`) or type the style name (`watercolor`). If a user includes a recognized style name in the caption when sending their selfie, the menu is skipped and generation starts immediately.

If no style is specified, the default style is used (cartoon by default, configurable from the Settings panel).

The bot also responds conversationally when users send text-only messages with questions or unusual input (e.g. "what is twilio?", "how does this work?"). Common short messages like "hi" get a fast static response, while longer or more interesting messages get a dynamic AI-generated reply (via gpt-4o-mini) that answers the question and directs the user to send a selfie.

## Adding or Changing Styles

Art styles can be managed in two ways:

**From the Settings panel** (no code changes): Open the Settings panel on `/home`, scroll to the **Styles & Art** section. You can toggle built-in styles on/off, edit their prompts (with a reset button to revert to the original), add custom styles with a name and prompt, and edit custom style names and prompts after creation. You can also choose which style is used as the default when a user doesn't specify one, and import style prompt overrides from another event. All customizations are stored in `data/settings.json`.

**In code**: Built-in styles are defined in `lib/styles.js`. Each style has a keyword, display name, and an LLM prompt. To add a new built-in style, add an entry to the `STYLES` object:

```js
"oil-painting": {
    name: "oil painting",
    prompt: "Transform this photo into a classical oil painting portrait..."
},
```

Styles automatically appear in SMS messages and are available for users to select. Style matching is fuzzy -- it handles extra spaces, hyphens, and case differences.

## Branding

Branding controls how the AI renders clothing, logos, and visual themes across all art styles. The Branding section in the Settings panel has two modes, toggled by the **Enable Brand Selection Menu** switch.

### Single Brand Mode

When the brand selection toggle is OFF, all portraits use a single brand configuration:

- **Brand Prompt** -- a global modifier appended to every art style's AI prompt (e.g. "wearing a bright red Twilio t-shirt with the Twilio logo clearly visible"). Applied to all subjects in multi-person photos.
- **Brand Reference Images** -- uploaded images that show the AI what the branded items look like (jerseys, logos, gear). Stored in a shared library; each event selects which images to use via checkboxes.

Configure from the Settings panel under **Branding**. Leave the brand prompt blank to disable. Can also be set via the `BRAND_PROMPT` environment variable.

### Multi-Brand Selection

When the brand selection toggle is ON, users choose a brand/team via SMS after picking their art style. This mirrors the style and background selection menus.

**SMS flow:** Selfie → Style → Brand → Background → Enqueue

Each brand is a card in the Settings panel with:

- **Display name** -- what users see in the SMS menu (e.g. "LA Kings")
- **Brand prompt** -- per-brand AI prompt override
- **Reference files** -- selected from the shared brand reference library

Brands are stored as a global library (`customBrands` in settings), shared across events. Per-event controls include:

- **Enable/disable individual brands** -- toggle brands on or off per event without deleting them
- **Brand prompt overrides** -- customize a brand's prompt for a specific event

If only one brand is active, it's auto-selected (no menu shown). Brand menu SMS messages (intro, footer, retry) are configurable under **Engagement & Messages**.

Brand reference images are stored in the `brand-references/` folder. Uploading adds to the shared library; each brand selects which images to use. Deleting an image removes it from the library and from all brands that reference it.

## Background Selection

The app includes a configurable background system for AI-generated portraits. By default, a background instruction is appended to every generation prompt that tells the AI to recreate the original photo's background in the chosen art style. This default prompt is editable from the Settings panel under **Backgrounds**.

When **Enable Background Selection** is turned on, users get a numbered background menu via SMS after choosing their art style -- similar to the style selection menu. Admins configure the available background options (name + prompt) from the Settings panel. Each option tells the AI what background to render (e.g. "Solid White", "Original Scene", "City Skyline").

If only one background option is configured, it's auto-selected (no menu shown). If the background menu is disabled, the default background prompt is used for all portraits. Leave the default prompt blank to let the AI decide freely.

Background menu SMS messages (intro, footer, retry) are configurable under **Engagement & Messages**.

## Delivery Mode

The app supports three delivery modes, configurable from the Settings panel under **Delivery & Display**:

- **Print + Digital (local)** -- Portraits are printed on a directly connected printer and sent to the user via MMS after printing completes. Requires a CUPS printer on the server machine. Set `ENABLE_PRINTING=true` in `.env` or toggle in the Settings panel.
- **Print + Digital (cloud relay)** -- The server runs in the cloud. A relay agent on the event laptop polls for print-ready jobs, downloads images, and prints locally. Set a **Print Relay Key** in the Settings panel to enable. See [Print Relay](#print-relay-cloud-printing) for full setup.
- **Digital Only** -- Portraits are sent via MMS immediately after AI generation. No printer required. Use this for demos, remote events, or setups without a physical printer. Set `ENABLE_PRINTING=false` and leave the Print Relay Key blank.

The delivery mode affects the SMS messages users receive (e.g. "head to the booth to pick up your print" vs "we'll text it to you").

## Print Relay (Cloud Printing)

The print relay enables physical printing when the app runs in the cloud (Azure, Docker, etc.) and the printer is at the event venue. A polling agent runs on the event laptop and bridges the gap.

There are two ways to run the relay:

| | Print Station App | CLI (`pnpm relay`) |
|---|---|---|
| **Location** | `relay-app/` directory | `scripts/print-relay.js` |
| **Best for** | Event staff, booth operators | Developers, CI/automation |
| **Setup** | Fill in fields in the UI | Edit `.env` file, run terminal command |
| **Distribution** | Build a standalone `.app` bundle | Requires Node.js + repo clone |

### Architecture

```
Cloud App                              Event Laptop
┌────────────────────────┐             ┌────────────────────────┐
│                        │   poll/5s   │  Print Station app     │
│  /api/print-relay/jobs ◄─────────────┤  (or pnpm relay CLI)   │
│                        │             │                        │
│  /api/print-relay/     │   claim     │  1. Poll for ready jobs│
│    jobs/:id/ack        ◄─────────────┤  2. Claim a job        │
│                        │             │  3. Download image     │
│  /api/print-relay/     │  download   │  4. Print via CUPS     │
│    image/:event/:file  ├────────────►│  5. Report completion  │
│                        │             │                        │
│  /api/print-relay/     │  complete   │  Handles: offline      │
│    jobs/:id/complete   ◄─────────────┤  printers, retries,    │
│                        │             │  crashes, reconnects   │
│  sendPrintCompletionMms│             │                        │
│  (after relay reports) │             │                        │
└────────────────────────┘             └────────────────────────┘
```

### Setup -- Step 1: Cloud App

Open the admin Settings panel. Under **Delivery & Display**, enter a **Print Relay Key** (any secret string, e.g. `my-event-2026`). Save settings. This enables the relay API and routes generated portraits to the relay print queue instead of trying to print locally.

You do NOT need to enable the "Print + Digital" toggle -- the relay key alone is enough.

### Setup -- Step 2: Event Laptop

#### Print Station App (Recommended)

The Print Station is a desktop app in the `relay-app/` directory. Event staff enter the Cloud URL and Relay Key in the UI, pick a printer from the dropdown, and click Connect. No terminal or `.env` files needed.

**Install and run:**

```sh
cd relay-app
npm install
npm start
```

**In the app UI:**
1. Enter your **Cloud URL** (e.g. `https://your-app.azurecontainerapps.io`)
2. Enter the **Relay Key** (same one you set in the cloud app's Settings)
3. Select a **Printer** from the dropdown (or leave on Auto-detect)
4. Click **Connect**

The status bar shows live indicators for cloud connection (green/yellow/red), printer status, and a printed job count. Jobs appear in the Recent Jobs list as users submit selfies.

**Building for distribution** -- To create a standalone `.app` that event staff can run without Node.js installed:

```sh
cd relay-app
npm run make
```

This creates a `.zip` in `out/make/zip/darwin/arm64/` (~99 MB). Send it to event staff -- they unzip, open the app, and configure in the UI.

See **[relay-app/README.md](../relay-app/README.md)** for full documentation including UI overview, features, and project structure.

#### CLI Relay (Alternative)

For developers or automated setups, the CLI relay runs in the terminal. Clone the repo and install dependencies:

```sh
git clone <your-repo-url>
cd twilio-cartoon-printer
pnpm install
```

Create a `.env` file:

```sh
PRINT_RELAY_URL=https://your-cloud-app.example.com
PRINT_RELAY_KEY=my-event-2026
```

Start the relay:

```sh
pnpm relay
```

**Verify** -- You should see:

```
Connected to cloud app (printing: false, size: 5x7, quality: high)
Printer found: EPSON_ET_8550_Series
Polling for print jobs...
```

Text a selfie to your Twilio number. The relay should claim the job, download the image, and print it. After printing, the cloud app sends the MMS.

### CLI options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--url` | `PRINT_RELAY_URL` | (required) | Cloud app base URL |
| `--key` | `PRINT_RELAY_KEY` | (required) | Shared secret matching the cloud app |
| `--printer` | `PRINT_RELAY_PRINTER` | auto-detect | Override printer name |
| `--interval` | `PRINT_RELAY_INTERVAL` | `5` | Poll interval in seconds |
| `--dry-run` | `PRINT_RELAY_DRY_RUN` | `false` | Download images but skip printing |

### Reliability

- **Network drops** -- The relay keeps polling. When the network comes back, it reconnects automatically. No manual intervention needed.
- **Relay crash** -- If the relay crashes while a job is in the "printing" state, the cloud app detects the stale job after 15 minutes and moves it back to the ready queue. The relay picks it up on the next poll after restart.
- **Printer offline** -- If the printer is offline or stopped, the relay detects this within seconds and reports failure. The cloud app re-queues the job for retry (up to 3 retries).
- **Multiple agents** -- You can run multiple relay agents with the same key for redundancy. They race to claim jobs; only one wins each job. The others gracefully skip it.
- **Image missing** -- If the output image doesn't exist on the server (e.g. disk error), the relay is told to skip the job and it won't retry for 1 hour.
- **Graceful shutdown** -- Press Ctrl+C to stop the relay cleanly.

### Print settings

The relay fetches print settings (size, quality) from the cloud app on each print. Changing print size or quality in the Settings panel takes effect on the next job without restarting the relay.

## Cloud Deployment

### Docker

```sh
docker build -t twilio-cartoon-printer .
docker run --rm -p 8080:8080 --env-file .env twilio-cartoon-printer
```

The container listens on port 8080 (set in the Dockerfile via `PORT=8080`).

### Persistent storage

Without persistent storage, all data (settings, jobs, downloads, leads) is lost when the container restarts. Mount a volume at `/app/appdata` to persist everything:

```sh
docker run --rm -p 8080:8080 --env-file .env \
  -v /path/to/storage:/app/appdata \
  twilio-cartoon-printer
```

The startup script (`scripts/start.sh`) automatically symlinks these directories to the mount:

| Directory | Contents |
|-----------|----------|
| `data/` | Settings, leads, NPS scores, raffle history, paper counter |
| `queue/` | Job files in all pipeline stages |
| `downloads/` | Input photos and generated portraits |
| `brand-references/` | Brand reference images for AI generation |
| `templates/` | Frame overlay PNGs |
| `assets/` | Videos and media files |

Set `DATA_MOUNT` to customize the mount path (defaults to `/app/appdata`).

### Azure Container Apps

1. Build and push the Docker image to Azure Container Registry
2. Create an Azure Container App with the image
3. Set environment variables (Twilio, OpenAI credentials) in the container app configuration
4. Create an Azure Files share and mount it at `/app/appdata` for persistent storage
5. Point your Twilio webhook to `https://your-app.azurecontainerapps.io/sms`
6. (Optional) Set up the [print relay](#print-relay-cloud-printing) for physical printing at events

### Twilio webhook

Point your Twilio phone number's Messaging webhook (POST) to:

```
https://your-cloud-app.example.com/sms
```

No ngrok needed for cloud deployments -- the app is already publicly accessible.

## Lead Capture

The app can collect attendee contact information via a short SMS survey. When enabled, each user completes a one-time survey (per event). Each field can be individually toggled on/off with custom prompts and error messages from the Settings panel:

| # | Field | Validation | Default Prompt |
|---|-------|------------|----------------|
| 1 | First name | Non-empty | "What's your first name?" |
| 2 | Last name | Non-empty | "And your last name?" |
| 3 | Country code | 2-3 letter code | "What country are you from? (2-letter code...)" |
| 4 | Business email | Valid email, personal domains rejected | "What's your business email?" |
| 5 | Company | Non-empty | "What company do you work for?" |
| 6 | Job title | Non-empty | "Last one -- what's your job title?" |

### Modes

Configure Lead Capture from the Settings panel on `/home`. Toggle it on to enable, then choose the timing:

- **Before** -- Survey runs when a user first texts the app. If they sent a selfie, it's held and auto-enqueued after survey completion. If they texted without an image, they're prompted to send a selfie after finishing. On completion the user receives a brief thank-you and proceeds to the normal portrait flow.
- **After** -- Normal flow proceeds (selfie, generation, printing). When the portrait is ready, the completion MMS is held back and the survey starts. After completion, the held portrait is delivered.

The survey only runs once per user per event. Admin phone numbers always skip the survey. Leads persist to `data/leads.json` and survive server restarts. In-memory survey state (active conversations) is lost on restart, but the user's next message will restart the survey if their lead hasn't been saved yet.

### Lead Reports

The Outreach page (`/outreach`) includes a Lead Capture panel that shows captured leads for the selected event. Admins can download a CSV export with all survey fields plus the phone number and capture date.

## Outreach

The Outreach page at `/outreach` is a dedicated tool for engaging attendees after they've used the photobooth. It's accessible from the home page and provides a focused workflow separate from the monitoring-oriented dashboard.

Features:

- **User directory** -- lists every attendee who has generated an image, with masked phone numbers, print counts, art styles used, and time since last activity
- **Event filtering** -- dropdown to filter users by event, matching the dashboard's event selector
- **Broadcast messaging** -- select individual users or "Select All", compose a message, and send SMS to all selected recipients at once
- **Raffle system** -- "Draw Winner" button with an animated random selection that highlights users in sequence before landing on a winner. Winners are automatically persisted to `data/raffle.json` and marked with a trophy icon in the user list
- **Raffle history** -- scrollable list of past raffle winners with timestamps, persisted across server restarts
- **Lead Capture** -- panel showing captured leads for the selected event with a CSV download button for exporting lead data
- **Stat cards** -- at-a-glance counts for total recipients, currently selected, raffle winners drawn, and leads captured

The page uses a two-column layout on desktop (user list on the left, actions on the right) and stacks to a single column on mobile. It auto-refreshes the user list every 10 seconds.

## Configurable SMS Messages

Every SMS message the app sends to users is configurable from the Settings panel. Messages are organized into categories:

- **Welcome & Onboarding** -- welcome text, quota counts, multiple photo warning
- **Style Selection** -- menu intro, footer, retry on invalid input
- **Brand Selection** -- menu intro, footer, retry on invalid input (shown when multi-brand is enabled)
- **Background Selection** -- menu intro, footer, retry on invalid input (shown when background selection is enabled)
- **Processing & Delivery** -- enqueue confirmation, pickup instructions, delivery text, last portrait notice, Twilio blurb
- **Error Responses** -- moderation failure, no face detected
- **Lead Capture** -- intro (before/after), completion, CTA
- **NPS** -- prompt and thank you

Messages support `{variable}` interpolation for dynamic values. Available variables depend on the message:

| Variable | Available in | Description |
|---|---|---|
| `{firstName}` | Lead capture completion messages | User's first name from survey |
| `{eventName}` | Welcome count, quota exceeded | Current event name |
| `{maxPrints}` | Welcome count, quota exceeded | Max prints per user |
| `{remaining}` | Remaining count | Prints/portraits left |
| `{unit}` | Welcome count, remaining count | "print"/"prints" or "portrait"/"portraits" (auto-pluralized) |
| `{units}` | Quota exceeded | Plural unit name |
| `{confirmLabel}` | Enqueued | "Your portrait" or "Your {style} portrait" |
| `{styleName}` | Delivery messages | Name of the art style used |

Lead capture survey fields (first name, last name, country, email, company, job title) can each be toggled on/off with custom prompts and error messages.

All message customizations are stored in `data/settings.json` and take effect immediately.

## NPS Survey

The app can send a Net Promoter Score survey after a user's final portrait (when their quota is exhausted). When enabled, the app waits a configurable delay (default 30 seconds) after the last delivery, then texts the user asking for a 1-5 rating.

Configure from the Settings panel under **Engagement & Messages**:

- **Enable/Disable** toggle
- **Delay** -- seconds to wait after delivery before sending the prompt (default 30)
- **Prompt and Thank You messages** -- editable in the SMS Messages section

NPS data is visible in:

- **Dashboard** -- NPS Score panel with average rating, response count, and 1-5 distribution bar chart
- **PDF Reports** -- NPS section with average, count, and distribution

Scores persist to `data/nps.json` across restarts. Admin phone numbers are excluded from NPS surveys.

## Social Sharing

When enabled, delivery messages include clickable share links for X/Twitter and LinkedIn. The share text is configurable and supports `{eventName}` interpolation.

Configure from the Settings panel under **Engagement & Messages**:

- **Enable Share Links** toggle
- **Twitter Handle** -- included in tweet text (default `@twilio`)
- **LinkedIn Share Text** -- customizable template (default: "Check out my AI portrait from {eventName}, powered by Twilio!")

The share URLs point to the portrait's MMS image on your server, so they only work while the server is accessible at the same URL.

## BRB Screen

All three booth displays (intro video, combo, photo book) include a **BRB** button in the bottom toolbar. Clicking it shows a fullscreen "We'll Be Right Back" overlay with animated visuals, the event name, and an optional custom message. Click anywhere to dismiss.

The break message is configurable from the Settings panel under **Event & Operations**. The standalone break screen is also available directly at `/home/break`.

## Promotional Messages

The app can send a promotional message as a standalone SMS after each portrait is delivered. The promo is always the last message in the conversation for each portrait -- it arrives a few seconds after the completion MMS, separate from all status messages.

The promo is sent after every portrait completion (including repeat users). Admins are excluded. If the promo message field is empty, no promo is sent.

Configure the message from the Settings panel on the home page under **Engagement & Messages**. Set `PROMO_MESSAGE` in `.env` to configure a default, or leave blank to disable.

## Runtime Settings

The Settings panel on the home page (`/home`) lets admins change all app configuration at runtime without editing `.env` or restarting the server. Changes take effect immediately and are persisted to `data/settings.json`.

The settings panel is organized into seven sections:

**Event & Operations** -- Event Name (combo-box with existing events, saved-profile badges, or type a new name to create one -- selecting auto-saves and switches), Max Prints Per User, Admin Phone Numbers, Max Concurrent Generations, Queue Control (pause/resume), Manual Review toggle, Review PIN, Break Screen Message

**Styles & Art** -- Default Style selector, art style toggles with editable prompts (and reset for built-ins), custom style creation with editable names and prompts, "Import from another event" button to copy style prompt overrides between events, Multi-Subject Photos mode, Template Frame (PNG overlay composited on portraits) with Frame Border toggle and color picker, AI Prompts (Preserve Line, Composition Line, Face Detection, Scene Analysis, Smart Reply, User Directive -- each with reset button)

**Branding** -- Single/multi toggle. Single mode: Brand Prompt + Brand Reference Images. Multi mode: brand reference file library, brand cards with per-brand prompts and file selection, enable/disable per brand, brand menu SMS messages. See [Branding](#branding) for details.

**Backgrounds** -- Default Background Prompt, optional Background Selection Menu with configurable choices (name + prompt pairs), background menu SMS messages

**Delivery & Display** -- Delivery Mode (Print + Digital or Digital Only), Printer selection, Print Size (4x6, 5x7, 8x10), Print Quality (Standard, High, Max), Custom Print Flags, Print Relay Key (for cloud-to-local printing), Booth Display Mode (Video / Static Page / None), Intro Video, Static Page settings (headline, subline, QR code, steps, legal text), Terms URL

**Engagement & Messages** -- Lead Capture (enable/disable, before/after timing, survey messages and fields), Promotional Message, Social Share Links (X/Twitter and LinkedIn), NPS Survey toggle and delay, SMS Messages organized by category (Welcome & Onboarding, Style Selection, Brand Selection, Background Selection, Processing & Delivery, Error Responses, Lead Capture, NPS) with `{variable}` interpolation support. See [Lead Capture](#lead-capture) for details.

**API Keys** -- Twilio credentials (Phone Number, Account SID, Auth Token) and OpenAI configuration (API Key, Orchestrator Model, Vision Light Model, Image Generation Model, Smart Reply Model). These override values from `.env`.

Settings are stored as overrides on top of `.env` defaults. Per-event settings are saved automatically when switching events (see [Switching Events](#switching-events)). Click "Reset to Defaults" to revert all overrides for the current event.

The settings API is also available programmatically:

- `GET /dashboard/api/settings` -- current settings
- `POST /dashboard/api/settings` -- update settings
- `POST /dashboard/api/settings/reset` -- revert to `.env` defaults
- `GET /dashboard/api/settings/files` -- list available templates, videos, printers, known events, and event profiles with saved settings
- `GET /dashboard/api/settings/event-styles/:eventName` -- read another event's style prompt overrides (for importing)
- `POST /dashboard/api/settings/upload?type=<type>&filename=<name>` -- upload a file (types: `template`, `video`, `brand-reference`, `booth-image`)

## Import Style Prompts

When you craft a great style prompt override for one event and want to reuse it in another, the **Import from another event** button (in the Styles & Art section) lets you copy overrides without manual copy-paste.

1. Click **Import from another event** below the custom style form
2. Select a source event from the dropdown (only events with saved profiles appear)
3. The panel shows all style prompt overrides from that event with a preview of each prompt
4. Overrides that differ from the current event are pre-checked
5. Click **Import Selected** to apply the checked overrides to the current event's style prompts
6. Click **Save** to persist -- no auto-save, same as any other edit

This only imports style prompt overrides (the text you've customized for each art style). It does not copy custom styles, disabled styles, or any other settings.

## Switching Events

Settings are saved and restored **per event**. Each event keeps its own complete settings profile -- art styles, brand references, prompts, SMS messages, lead capture, background config, and all other creative settings. Infrastructure settings (API keys, admin phones, printers, concurrency) are global and shared across all events.

### How it works

The Event Name field in the Settings panel is a combo-box. Click the arrow to select a previous event, or type a new name to create one. Selecting an event from the dropdown **immediately saves** the current event's settings and loads the selected event's settings -- no manual Save click needed.

When you switch events, the app:

1. Saves the current event's per-event settings to `data/events/{eventName}/settings.json`
2. Loads the target event's saved settings (or starts with defaults for a new event)
3. Creates a downloads subfolder for the event
4. Resets everyone's print count
5. Refreshes the entire Settings UI with the loaded configuration

Events with saved profiles show a green **saved** badge in the dropdown. New events show a **+ Create** option.

### What's saved per event

All creative and event-specific settings, including:

- Art styles (custom styles, disabled styles, prompt overrides, default style)
- Branding (brand prompt, brand reference file selection, enabled/disabled brands, brand prompt overrides, brand menu toggle)
- AI prompts (preserve, composition, brand, background, face detection, scene analysis, smart reply)
- Background settings (default prompt, background menu toggle, background choices)
- Booth display mode (video/static/none), static page content (headline, subline, QR image, steps, legal text)
- SMS messages (all categories including brand menu messages)
- Template frame, frame border, video
- Lead capture mode and fields
- Delivery mode, print size/quality
- NPS, social sharing, promo messages
- Max prints per user, terms URL, break message

### What stays global

- Twilio credentials (Account SID, Auth Token, Phone Number)
- OpenAI credentials (API Key, model selections)
- Admin phone numbers
- Printer selection
- Max concurrent generations
- Queue pause state
- Custom brands library (brand definitions are shared; per-event controls are disabled brands and prompt overrides)

### Brand reference images

Brand reference images are stored in a shared library (`brand-references/` folder). Each event **selects** which images to use via checkboxes -- uploading an image adds it to the library and auto-selects it for the current event. Switching events changes the selection, not the files on disk. Deleting an image removes it from the library for all events.

### Example workflow

1. Configure "LAKingsHockey" with hockey jerseys, brand refs, custom styles → Save
2. Type "GolfTournament" in event name → click "+ Create" → starts with defaults
3. Upload golf brand refs, configure golf styles → Save
4. Switch back to "LAKingsHockey" from dropdown → all hockey settings restored instantly

Previous event data (downloads, completed jobs, leads, NPS scores) is always preserved on disk regardless of which event is active.

## Job Queue

Jobs are managed entirely via the filesystem -- no database or Redis required.

Job files, input photos, and output photos all share the same timestamp prefix so you can easily match them:

```
queue/done/20260211_143000.json
downloads/YourEventName/20260211_143000_input.jpg
downloads/YourEventName/20260211_143000_output.png
```

The pipeline is split into two independent workers:

- **Generation worker** -- Processes up to `MAX_CONCURRENT_GENERATION` jobs at the same time. Each job goes through download, moderation, face detection, scene analysis, AI generation, compositing, and print prep. The scene analysis step describes the subjects in the photo (number of people, positions, pets) so the generation model includes everyone. Multiple images generate in parallel so users don't wait in a long single-threaded queue.
- **Print worker** -- Processes one job at a time from the `ready/` queue. In local mode, sends the image directly to the printer. In relay mode, the cloud app exposes the ready queue via API and a remote agent handles printing. In both cases, the user is notified via SMS when their print is ready.
- **Stale relay recovery** -- Periodically scans `printing/` for jobs older than 15 minutes. If a relay agent crashes mid-print, these jobs are moved back to `ready/` for retry.

Each job tracks timestamps for every state transition (`pendingAt`, `generatingAt`, `readyAt`, `printingAt`, `completedAt`) which are used by the dashboard to compute average generation/print times and detect stuck jobs.

### Crash Recovery

On server restart:

- Jobs in `generating/` are recovered. If the output image already exists on disk, the job skips straight to `ready/` (no re-generation). Otherwise it goes back to `pending/` for retry.
- Jobs in `printing/` are moved back to `ready/` (the image exists, just retry the print).
- Non-permanent jobs in `failed/` are recovered automatically -- routed to `ready/` or `pending/` depending on whether the output image exists.

### Permanent Failures

Jobs flagged by content moderation or rejected by face detection are moved directly to `failed/` without retrying. The user's print count is refunded and they're told it didn't cost a print. Each failed job records a `failReason` field (`moderation`, `face_detection`, `generation`, `printer`, `max_retries`) used by the dashboard's failure breakdown panel.

### Retry Logic

Failed jobs retry up to 3 times. Each pipeline step is skipped on retry if its output already exists on disk, so only the failed step re-runs.

## Project Structure

```
twilio-cartoon-printer/
├── index.js              Express app, Twilio webhook, server startup
├── lib/
│   ├── config.js         Static constants, paths, API clients
│   ├── settings.js       Runtime mutable settings (persists to data/settings.json)
│   ├── styles.js         Art style definitions and prompts
│   ├── helpers.js        Image download, SMS, moderation, face detection, compositing, AI smart replies
│   ├── style-menu.js     Style selection menu after selfie (numbered list, pending state)
│   ├── brand-menu.js     Brand selection menu after style choice (numbered list, pending state)
│   ├── brands.js         Brand library -- active brands, brand resolution for pipeline
│   ├── background-menu.js Background selection menu after brand/style choice (numbered list, pending state)
│   ├── printer.js        Printer discovery and print commands
│   ├── pipeline.js       generateImage (steps 1-6) and printJob (steps 7-8)
│   ├── queue.js          Concurrent generation worker, serial print worker, usage tracking, stale relay recovery
│   ├── print-relay.js    Cloud-side relay API (poll, claim, download, complete endpoints)
│   ├── dashboard.js      Admin dashboard (mounted at /dashboard)
│   ├── home.js           Home page, settings panel, intro video, booth display (mounted at /home)
│   ├── brb.js            Shared BRB overlay (CSS, HTML, script) used by all booth displays
│   ├── leads.js          Lead capture SMS survey engine and persistence
│   ├── nps.js            NPS survey engine and persistence
│   ├── outreach.js       Outreach -- broadcast messaging, raffles, lead reports (mounted at /outreach)
│   ├── photogallery.js   Photo book (mounted at /photogallery)
│   └── paper.js          Paper counter with file persistence
├── scripts/
│   ├── print-relay.js    Local relay agent -- polls cloud, downloads images, prints via CUPS
│   └── start.sh          Docker entrypoint -- symlinks dirs to persistent storage
├── docs/
│   └── GUIDE.md          Detailed documentation (this file)
├── assets/               Video and media files for the home page
│   └── get-started.mp4   Attract loop video (gitignored)
├── brand-references/     Brand reference images for AI generation
├── templates/            Frame overlays (PNGs with transparent center)
│   └── signal_sf.png     Example: SIGNAL SF branded frame
├── downloads/            Generated images, organized by event name
│   └── YourEventName/
│       ├── 20260211_143000_input.jpg
│       └── 20260211_143000_output.png
├── queue/                File-based job queue
│   ├── pending/          New jobs waiting for generation
│   ├── generating/       Jobs currently generating AI images (up to N concurrent)
│   ├── ready/            Generation complete, waiting to print or relay
│   ├── printing/         Job currently being printed (local or relay)
│   ├── done/             Successfully printed/delivered jobs
│   └── failed/           Permanent failures or max retries exceeded
├── data/                 Persistent app data
│   ├── events/           Per-event settings profiles
│   │   └── YourEventName/
│   │       └── settings.json  Saved per-event overrides
│   ├── leads.json        Captured leads — keyed by phone:event (gitignored)
│   ├── nps.json          NPS survey scores — keyed by phone:event (gitignored)
│   ├── paper.json        Paper counter state
│   ├── raffle.json       Raffle winner history
│   └── settings.json     Active runtime settings overrides
├── .env                  API keys, printer config, event settings
├── .env.example          Template with all available environment variables
├── Dockerfile            Production container image
├── .gitignore            Excludes downloads/, queue/, .env, node_modules/, data/leads.json
├── package.json
└── pnpm-lock.yaml
```
