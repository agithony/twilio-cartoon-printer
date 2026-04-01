# Twilio Print Station

A desktop app for printing portraits from the Twilio AI Photobooth. This is the **recommended way** to handle printing when the photobooth server runs in the cloud and the printer is at the event venue.

The Print Station polls the cloud app for print-ready portraits, downloads them, and prints them on a locally connected printer. It replaces the CLI relay (`pnpm relay`) with a visual interface that event staff can operate without touching a terminal.

## Why use this instead of the CLI?

| | Print Station App | CLI (`pnpm relay`) |
|---|---|---|
| Setup | Fill in fields in the UI | Edit `.env` file, run terminal command |
| Monitoring | Live status indicators, job history | Terminal log output |
| Printer selection | Dropdown with auto-detect | CLI flag or env var |
| Configuration | Saved automatically, persists between launches | `.env` file |
| Distribution | Hand someone the `.app` bundle | Requires Node.js + repo clone |
| Best for | Event staff, booth operators | Developers, CI/automation |

## Prerequisites

- **macOS** (the app builds for macOS ARM64; other platforms need Electron Forge config changes)
- **Node.js** v18+ and **npm**
- A **CUPS-compatible printer** connected via USB or WiFi (e.g. Epson EcoTank ET-8550)
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
3. **Printer** -- Select from the dropdown (auto-detects CUPS printers) or leave on "Auto-detect"
4. Click **Connect**

The status indicators will turn green when the cloud connection and printer are ready. Print jobs appear automatically as users submit selfies.

## Building for Distribution

To create a standalone `.app` bundle that event staff can run without Node.js:

```sh
npm run make
```

This produces:
- `out/Twilio Print Station-darwin-arm64/` -- the app bundle
- `out/make/zip/darwin/arm64/Twilio Print Station-darwin-arm64-1.0.0.zip` -- distributable zip (~99 MB)

Send the `.zip` to event staff. They unzip it, open the app, enter the Cloud URL and Relay Key, and they're printing.

## UI Overview

### Configuration Section
- **Cloud URL** -- The base URL of your cloud-hosted photobooth server. Click "Edit" to modify after connecting.
- **Relay Key** -- The shared secret that authenticates this station with the cloud app. Shown as a password field.
- **Printer** -- Dropdown listing all CUPS printers on this machine. Click the refresh button to re-scan.
- **Dry Run** -- Check this to download images without actually printing (useful for testing).

### Status Bar
Three status cards show the current state at a glance:
- **Cloud** -- Green = connected, Yellow = connecting/reconnecting, Red = disconnected/error
- **Printer** -- Green = online, Yellow = dry-run mode, Red = offline or not found
- **Printed** -- Running count of successfully printed jobs this session

### Recent Jobs
Shows the last several print jobs with their current state:
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
- **Persistent configuration** -- Cloud URL, Relay Key, and printer selection are saved between launches (via electron-store)
- **Dark/light theme** -- Toggle in the header, persists via localStorage
- **Dry-run mode** -- Download and process images without printing (for testing or demos)
- **Job deduplication** -- Won't re-print a job it already handled
- **Graceful shutdown** -- Close the window to stop cleanly; in-progress jobs are recovered by the cloud app after 15 minutes

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
