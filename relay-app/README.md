# Twilio Print Station

A desktop app for printing portraits from the Twilio AI Photobooth. This is the **recommended way** to handle printing when the photobooth server runs in the cloud and the printer is at the event venue.

The Print Station polls the cloud app for print-ready portraits, downloads them, and prints them on locally connected printers. It replaces the CLI relay (`pnpm relay`) with a visual interface that event staff can operate without touching a terminal. Supports **multiple printers** — check two or more printers and they share the workload automatically.

## Why use this instead of the CLI?

| | Print Station App | CLI (`pnpm relay`) |
|---|---|---|
| Setup | Fill in fields in the UI | Edit `.env` file, run terminal command |
| Monitoring | Live status indicators, job history | Terminal log output |
| Printer selection | Checkbox list (multi-printer) with auto-detect | CLI flag or env var |
| Configuration | Saved automatically, persists between launches | `.env` file |
| Distribution | Hand someone the `.app` bundle | Requires Node.js + repo clone |
| Best for | Event staff, booth operators | Developers, CI/automation |

## Prerequisites

- **macOS** (the app builds for macOS ARM64; other platforms need Electron Forge config changes)
- **Node.js** v18+ and **npm**
- A **CUPS-compatible printer** connected via USB or WiFi (e.g. Epson EcoTank ET-8550), with its **driver installed** so a CUPS queue exists. For the ET-8550, get the macOS driver from [Epson's support page](https://epson.com/Support/Printers/All-In-Ones/ET-Series/Epson-ET-8550/s/SPT_C11CJ21201). A printer with no driver/queue will not appear in the app's printer list.
- The cloud app running with a **Print Relay Key** configured in Settings > Delivery & Printing

## Quick Start

### 1. Install dependencies

```sh
cd relay-app
npm install
```

### 2. Launch the app

```sh
npm start
```

### 3. Configure

In the app UI:

1. **Cloud URL** -- Enter your cloud app URL (e.g. `https://your-app.azurecontainerapps.io`)
2. **Relay Key** -- Enter the same secret key you set in the cloud app's Settings panel
3. **Printers** -- Check one or more printers from the list (auto-detects CUPS printers). Leave all unchecked for auto-detect.
4. Click **Connect**

The status indicators will turn green when the cloud connection and printers are ready. Print jobs appear automatically as users submit selfies.

**Multi-printer mode:** When two or more printers are selected, the app creates a separate worker for each printer. Jobs are distributed automatically — whichever printer finishes first grabs the next job. If one printer jams, the other keeps printing.

## Building for Distribution

To create a standalone `.app` bundle that event staff can run without Node.js:

```sh
npm run make
```

This produces:
- `out/Twilio Print Station-darwin-arm64/` -- the app bundle
- `out/make/zip/darwin/arm64/Twilio Print Station-darwin-arm64-<version>.zip` -- distributable zip (~99 MB; version matches `package.json`)

Send the `.zip` to event staff. They unzip it, open the app, enter the Cloud URL and Relay Key, and they're printing.

> **First launch on macOS (Gatekeeper).** Because the `.app` isn't notarized, macOS quarantines it on download and may refuse to open it ("app is damaged" or "unidentified developer"). Clear the quarantine flag once, pointing at wherever the app was unzipped:
>
> ```sh
> xattr -dr com.apple.quarantine "~/Downloads/Twilio Print Station.app"
> ```
>
> Adjust the path if the app lives elsewhere (e.g. `/Applications/Twilio Print Station.app`). After this, the app opens normally on every launch.

## UI Overview

### Configuration Section
- **Cloud URL** -- The base URL of your cloud-hosted photobooth server. Click "Edit" to modify after connecting.
- **Relay Key** -- The shared secret that authenticates this station with the cloud app. Shown as a password field.
- **Printers** -- Checkbox list of all CUPS printers on this machine. Select one or more. Click the refresh button to re-scan. Leave all unchecked for auto-detect (picks the first healthy printer). If a connected printer is missing from this list, its driver isn't installed yet — install the driver (see [Prerequisites](#prerequisites)), then click refresh.
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

### Log
Expandable section with timestamped messages for debugging. Shows connection events, job lifecycle, printer status, and errors.

## Features

- **Auto-reconnect** -- If the network drops or the cloud app restarts, the station reconnects automatically with exponential backoff
- **Printer health monitoring** -- Detects offline/stopped printers and reports status in real time
- **Multi-printer support** -- Select multiple printers to share the workload; jobs are distributed automatically across printers
- **Persistent configuration** -- Cloud URL, Relay Key, and printer selections are saved between launches (via electron-store)
- **Dark/light theme** -- Toggle in the header, persists via localStorage
- **Dry-run mode** -- Download and process images without printing (for testing or demos)
- **Job deduplication** -- Won't re-print a job it already handled
- **Heartbeats for fast crash recovery** -- While holding a job, the app pings the cloud every 20s. If beats stop for >60s (crash, force-quit, network drop), the cloud re-queues the job within seconds. Older v1.0 relays without heartbeats fall back to the 15-minute printing-age threshold.
- **Download validation** -- Verifies `Content-Length` on the image fetch to catch mid-stream truncation instead of silently printing partial pages.
- **Status caching** -- Fetches cloud print settings (size, quality) at startup and refreshes every 60s in the background instead of before every print, so transient cloud hiccups don't fail prints mid-job.
- **Graceful shutdown** -- Close the window to stop cleanly.

## Project Structure

```
relay-app/
  main.js        Electron main process -- window, IPC handlers, relay lifecycle
  relay.js       RelayEngine -- polling, job processing, CUPS printing
  preload.js     IPC bridge between main and renderer
  renderer.js    UI controller -- DOM updates, event handling
  index.html     App layout
  style.css      Styling with dark/light theme support
  build/         App icons (.icns, .iconset)
  fonts/         Twilio brand fonts
```
