# Twilio Print Station

A desktop app for printing portraits from the Twilio AI Photobooth. This is the **recommended way** to handle printing when the photobooth server runs in the cloud and the printer is at the event venue.

The Print Station polls the cloud app for print-ready portraits, downloads them, and prints them on locally connected printers. It replaces the CLI relay (`pnpm relay`) with a visual interface that event staff can operate without touching a terminal. Supports **multiple printers** — check two or more printers and they share the workload automatically.

## Why use this instead of the CLI?

| | Print Station App | CLI (`pnpm relay`) |
|---|---|---|
| Setup | Fill in fields in the UI | Edit `.env` file, run terminal command |
| Monitoring | Live status indicators, job history | Terminal log output |
| Printer selection | Checkbox list (multi-printer) with auto-detect | CLI flag or env var |
| Configuration | Saved on Connect, persists between launches | `.env` file |
| Distribution | Hand someone the `(start here)` zip | Requires Node.js + repo clone |
| Best for | Event staff, booth operators | Developers, CI/automation |

## Prerequisites

- **macOS** (the app builds for macOS ARM64; other platforms need Electron Forge config changes)
- **Node.js** 22+ and **npm** only when running from source; the release app is standalone
- A **CUPS-compatible printer** connected via USB or WiFi (e.g. Epson EcoTank ET-8550 or DNP DS-RX1), with its **driver installed** so a CUPS queue exists. A printer with no driver/queue will not appear in the app's printer list.
- Local CUPS commands available: `lpstat`, `lp`, `lpoptions`, `cancel`
- The cloud app running in **Print + Digital** mode with a **Print Relay Key** configured in Settings > Delivery & Printing

The relay key authenticates this app. Printing must also be enabled on the cloud app; if `ENABLE_PRINTING=false`, generated portraits go digital-only and no jobs appear in the relay queue.

## Install the Released App

1. Download the latest `Twilio Print Station <version> (start here).zip` from [GitHub Releases](https://github.com/anthonyjdella/twilio-cartoon-printer/releases/latest).
2. Quit and remove any older Twilio Print Station app, then unzip the new bundle.
3. Keep the app and `Open Twilio Print Station.command` in the same folder.
4. On first launch, right-click `Open Twilio Print Station.command`, choose **Open**, then confirm **Open**. The helper clears macOS quarantine and launches the app.
5. Select `Dai_Nippon_Printing_DS_RX1`, enter the Cloud URL and Relay Key, then click **Connect**.
6. In the cloud app's Delivery & Printing settings, select Print Size **4x6** for RX1 6x4 media.

The Cloud URL, Relay Key, and printer selection persist when upgrading from an older release.

## Quick Start

These steps are for running Print Station from source instead of installing the release app.

### 1. Install dependencies

```sh
cd relay-app
npm install
```

## Usage

### 1. Launch the app

```sh
npm start
```

### 2. Configure

In the app UI:

1. **Cloud URL** -- Click **Edit**, enter your cloud app URL (e.g. `https://your-app.azurecontainerapps.io`), then lock it again if desired.
2. **Relay Key** -- Click **Edit**, enter the same secret key you set in the cloud app's Settings panel, then lock it again if desired. New installations leave both credential fields blank.
3. **Printers** -- Check one or more printers from the list. Leave all unchecked only for simple single-printer auto mode.
4. **Save Downloaded Portraits To** -- Optionally choose a folder where every final PNG should be copied automatically.
5. Click **Connect**

The status indicators will turn green when the cloud connection and printers are ready. Print jobs appear automatically as users submit selfies.

**Multi-printer mode:** When two or more printers are selected, the app creates a separate worker for each printer. Jobs are distributed automatically — whichever printer finishes first grabs the next job. If one printer jams, the other keeps printing. In production multi-printer setups, explicitly check the printers you want to use; unchecked auto mode starts one unfiltered worker that picks the first healthy printer.

## Building for Distribution

To create a standalone `.app` bundle that event staff can run without Node.js:

```sh
npm run make
```

This produces:
- `out/Twilio Print Station-darwin-arm64/` -- the app bundle
- `out/make/zip/darwin/arm64/Twilio Print Station-darwin-arm64-<version>.zip` -- distributable zip (~99 MB; version matches `package.json`)
- `out/make/Twilio Print Station <version> (start here).zip` -- staff bundle with the app, `READ ME FIRST.txt`, and `Open Twilio Print Station.command`

Send the **`(start here)`** zip to event staff. They unzip it, right-click **Open Twilio Print Station.command** and choose **Open** on first launch, then open the app normally after that. The helper removes macOS quarantine from the ad-hoc-signed app.

> **First launch on macOS (Gatekeeper).** Because the `.app` isn't notarized, macOS quarantines it on download and may refuse to open it ("app is damaged" or "unidentified developer"). Clear the quarantine flag once, pointing at wherever the app was unzipped:
>
> ```sh
> xattr -dr com.apple.quarantine "$HOME/Downloads/Twilio Print Station.app"
> ```
>
> Adjust the path if the app lives elsewhere (e.g. `/Applications/Twilio Print Station.app`). After this, the app opens normally on every launch.

## UI Overview

### Configuration Section
- **Cloud URL** -- The base URL of your cloud-hosted photobooth server. The field is locked by default; click **Edit** to change it while disconnected. It is locked again while connected.
- **Relay Key** -- The shared secret that authenticates this station with the cloud app. Shown as a password field, locked by default, and saved when you connect.
- **Printers** -- Checkbox list of all CUPS printers on this machine. Select one or more. Click the refresh button to re-scan. Leave all unchecked only for single-worker auto mode, which picks the first healthy printer. If a connected printer is missing, install its driver so a CUPS queue exists, then refresh the list.
- **Save Downloaded Portraits To** -- Optional persistent folder for automatic full-resolution PNG copies. Clear it to use only the temporary 24-hour cache.
- **Dry Run** -- Check this to download images without actually printing (useful for testing).

### Status Bar
Dynamic status cards show the current state at a glance:
- **Cloud** -- Green = connected, Yellow = connecting/reconnecting, Red = disconnected/error
- **Per-printer status** -- One card per selected printer. Green = online, Yellow = dry-run mode, Red = offline or error. Shows which printer has issues at a glance.
- **Printed** -- Running count of successfully printed jobs this session (aggregated across all printers)

### Recent Jobs
Shows the last several print jobs with their current state. Each job shows which printer handled it:
- **Claiming** -- Reserving the job from the cloud queue
- **Downloading** -- Fetching the print-ready image
- **Printing** -- Sending to the local printer
- **Done** -- Successfully printed
- **Failed** -- Error occurred (check the log for details)

Completed and failed jobs include **Save** and **Reprint** actions. Save exports the cached full-resolution PNG. Reprint targets the same printer and clears local deduplication immediately.

### Log
Expandable section with timestamped messages for debugging. Shows connection events, job lifecycle, printer status, and errors.

## Features

- **Auto-reconnect** -- If the network drops or the cloud app restarts, the station reconnects automatically with exponential backoff
- **Printer health monitoring** -- Detects offline/stopped printers and reports status in real time
- **Multi-printer support** -- Select multiple printers to share the workload; jobs are distributed automatically across printers
- **Persistent configuration** -- Cloud URL, Relay Key, and printer selections are saved on Connect and persist between launches (via electron-store)
- **Dark/light theme** -- Toggle in the header, persists via localStorage
- **Dry-run mode** -- Download and process images without printing (for testing or demos)
- **Job deduplication** -- Won't re-print a job it already handled
- **Heartbeats for fast crash recovery** -- While holding a job, the app pings the cloud every 20s. If beats stop for >60s after the first heartbeat, the cloud re-queues the job within seconds. A crash before the first heartbeat, and older v1.0 relays without heartbeats, fall back to the 15-minute printing-age threshold.
- **Download validation** -- Verifies `Content-Length` on the image fetch to catch mid-stream truncation instead of silently printing partial pages.
- **Status caching** -- Fetches cloud print settings (size, quality) at startup and refreshes every 60s in the background instead of before every print, so transient cloud hiccups don't fail prints mid-job.
- **Reprint terminal jobs** -- Re-queues completed or failed jobs immediately on the printer that handled them.
- **Per-job print profiles** -- Each claimed job carries its own size, quality, orientation, and custom flags, so queued jobs are not changed by later Settings edits.
- **Landscape 6x4 and DNP DS-RX1 support** -- Epson jobs use 4x6 media with an explicit landscape orientation; DNP jobs map app size 4x6 to the driver's native `300dnp6x4` media token.
- **Epson and DNP support** -- Printer-specific CUPS flags and media mappings prevent Epson options from leaking into DNP jobs.
- **Save portraits** -- Retains authenticated full-resolution PNGs for 24 hours and lets operators save them from Recent Jobs through the native macOS save dialog.
- **Automatic portrait folder** -- Optionally copies every downloaded final PNG into an operator-selected folder without overwriting existing files or blocking printing if a copy fails.
- **Graceful shutdown** -- Close the window to stop cleanly.

## Relay API

All relay requests send `x-relay-key` and `x-relay-version`. The cloud app returns `503` when no print relay key is configured and `401` when the key does not match. A successful claim returns a `claimId`; heartbeats and completion reports include it so stale workers cannot finish a recovered claim.

The app uses this flow:

| Request | Purpose |
|---|---|
| `GET /api/print-relay/status` | Check cloud connectivity and fetch print size/quality. Runs at startup and refreshes every 60 seconds. |
| `GET /api/print-relay/jobs?printer=<name>` | Poll for ready jobs. Selected-printer workers send their printer name; unchecked auto mode sends no printer filter. |
| `POST /api/print-relay/jobs/:filename/ack` | Atomically claim a ready job by moving it to `printing/`. |
| `GET /api/print-relay/image/...` | Download the final print-resolution PNG for the claimed job. |
| `POST /api/print-relay/jobs/:filename/heartbeat` | Report that this station is still working on the job. |
| `POST /api/print-relay/jobs/:filename/complete` | Report print success or failure so the cloud app can move, retry, or fail the job. |

## Printing Notes

Printer names come from `lpstat -p`. Printing is done with `lp`, and stuck local CUPS jobs can be cancelled with `cancel`. Epson and DNP DS-RX1 use separate media, quality, and finishing flags. The job's snapshotted output profile takes precedence over the cached cloud defaults.

## Project Structure

```
relay-app/
  main.js        Electron main process -- window, IPC handlers, relay lifecycle
  relay.js       RelayEngine -- polling, job processing, CUPS printing
  cups-command.js Printer-specific Epson/DNP CUPS command generation
  job-files.js   24-hour image cache cleanup and safe portrait export
  preload.js     IPC bridge between main and renderer
  renderer.js    UI controller -- DOM updates, event handling
  index.html     App layout
  style.css      Styling with dark/light theme support
  build/         App icons (.icns, .iconset)
  fonts/         Twilio brand fonts
```

## License

ISC, matching the root package.
