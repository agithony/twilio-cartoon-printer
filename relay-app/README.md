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
- **Node.js** v18+ and **npm** only when running from source; the release app is standalone
- A **CUPS-compatible printer** connected via USB or WiFi (e.g. Epson EcoTank ET-8550 or DNP DS-RX1), with its **driver installed** so a CUPS queue exists. A printer with no driver/queue will not appear in the app's printer list.
- The cloud app running with a **Print Relay Key** configured in Settings > Delivery & Printing

## Install the Released App

1. Download `Twilio Print Station 1.2.1 (start here).zip` from [GitHub Releases](https://github.com/agithony/twilio-cartoon-printer/releases/latest).
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
- **DNP DS-RX1 support** -- Detects DS-RX1 CUPS queues and maps app size 4x6 to the driver's required 6x4 media option (`300dnp6x4`) with DNP-compatible resolution and finishing flags.
- **Graceful shutdown** -- Close the window to stop cleanly.

## Project Structure

```
relay-app/
  main.js        Electron main process -- window, IPC handlers, relay lifecycle
  relay.js       RelayEngine -- polling, job processing, CUPS printing
  cups-command.js Printer-specific CUPS command profiles
  preload.js     IPC bridge between main and renderer
  renderer.js    UI controller -- DOM updates, event handling
  index.html     App layout
  style.css      Styling with dark/light theme support
  build/         App icons (.icns, .iconset)
  fonts/         Twilio brand fonts
```
