# Twilio Cartoon Printer

A photobooth-style app powered by Twilio and OpenAI. Attendees text a selfie to a Twilio phone number, choose an art style, and get a printed portrait at your booth.

## How It Works

```
User sends selfie via SMS/MMS
        |
        v
  Twilio webhook receives the message
        |
        v
  Job queued to disk (survives restarts)
        |
        v
  ---- Generation (up to N concurrent) ----
  Content moderation (OpenAI)
        |
        v
  Face detection -- rejects photos without a visible face
        |
        v
  Image generation (gpt-5.2 + gpt-image-1.5)
        |
        v
  Template frame composited (optional)
        |
        v
  Resized for print (5x7 @ 300 DPI)
        |
        v
  ---- Printing (one at a time) ----
  Printed on connected printer
        |
        v
  User gets an SMS that their print is ready
```

Users pick an art style by typing the name in the same message as their selfie:

| Style | Description |
|---|---|
| **cartoon** (default) | 3D animated film style |
| **pop art** | Bold Warhol/Lichtenstein style |
| **watercolor** | Soft watercolor painting |
| **anime** | Japanese anime illustration |
| **sketch** | Graphite pencil drawing |
| **pixel art** | Retro 16-bit video game style |

If no style is specified, it defaults to cartoon.

## Prerequisites

- **Node.js** v18+
- **pnpm** -- install with `npm install -g pnpm` ([docs](https://pnpm.io/installation))
- **Twilio account** with a phone number that has SMS/MMS enabled
- **OpenAI API key** with access to gpt-5.2 and gpt-image-1.5
- **Printer** configured on the system and accessible via `lp` (macOS/Linux CUPS)

## Quick Start

### 1. Clone and install

```sh
git clone <your-repo-url>
cd twilio-cartoon-printer
pnpm install
```

### 2. Configure environment

Copy the example below into a `.env` file in the project root:

```sh
# Twilio credentials (from https://console.twilio.com)
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token

# OpenAI API key (from https://platform.openai.com/api-keys)
OPENAI_API_KEY=your_openai_key

# Printer name (run `lpstat -p` to list available printers)
PRINTER_NAME=your_printer_name

# Event config
EVENT_NAME=YourEventName
ADMIN_PHONES=+1234567890,+0987654321
MAX_PRINTS_PER_USER=2
MAX_CONCURRENT_GENERATION=5

# Legal
TERMS_URL=https://example.com/terms

# Promotional message (optional -- leave blank to disable)
PROMO_EVENT_NAME=SIGNAL San Francisco
PROMO_EVENT_DATE=May 6-7, 2026
PROMO_EVENT_URL=https://twil.io/devweek26
```

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Your Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Your Twilio Auth Token |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `PRINTER_NAME` | Yes | CUPS printer name prefix (find with `lpstat -p`). The app matches any printer starting with this name, so `EPSON_ET_8550_Series` matches `EPSON_ET_8550_Series_2`, etc. |
| `EVENT_NAME` | Yes | Name of the current event (used for per-event print limits and download folders) |
| `ADMIN_PHONES` | No | Comma-separated phone numbers in E.164 format (e.g. `+14155551234`). Admins get unlimited prints. |
| `MAX_PRINTS_PER_USER` | No | Max free prints per phone number per event. Defaults to `2`. |
| `MAX_CONCURRENT_GENERATION` | No | Max AI image generations running at the same time. Defaults to `3`. Increase for faster throughput, decrease if hitting OpenAI rate limits. |
| `TERMS_URL` | No | URL to your terms of service. Shown once in the user's first selfie confirmation. |
| `PROMO_EVENT_NAME` | No | Name of the event to promote in SMS messages |
| `PROMO_EVENT_DATE` | No | Date string for the promoted event |
| `PROMO_EVENT_URL` | No | Registration URL for the promoted event |

### 3. Template frame (optional)

Place a `template.png` in the project root. This should be a PNG with transparent areas where the generated portrait shows through. The template is composited on top of the generated image using Sharp.

If no `template.png` is found, the app skips the frame overlay and prints the portrait as-is.

### 4. Find your printer name

```sh
lpstat -p
```

Copy the printer name (e.g. `EPSON_ET_8550_Series`) into `PRINTER_NAME` in your `.env`. The app will match any printer starting with that name and prefer a healthy one over a disconnected/disabled one.

Print settings (page size, resolution, borderless options) are configured in `lib/printer.js`. The defaults are tuned for an Epson ET-8550 on 5x7 photo paper with no margins.

### 5. Start the server

```sh
sudo node index.js
```

`sudo` is required because the app listens on port 80 (needed for Twilio webhooks over HTTP).

You should see:

```
🚀 App running on port 80 | Event: YourEventName
📊 Usage cache built: 0 entries
⏱️  Workers started (polling every 3000ms, max 5 concurrent generations)
```

### 6. Connect Twilio

Point your Twilio phone number's **Messaging webhook** to your server:

```
http://your-server-ip/sms
```

You can configure this in the [Twilio Console](https://console.twilio.com) under your phone number's settings, or via the Twilio CLI. The webhook method should be `POST`.

If your server is behind a firewall or on a local network, you can use [ngrok](https://ngrok.com) to expose it:

```sh
ngrok http 80
```

Then use the ngrok URL (e.g. `https://abc123.ngrok.io/sms`) as your webhook.

## Project Structure

```
twilio-cartoon-printer/
├── index.js              Express app, Twilio webhook, server startup
├── lib/
│   ├── config.js         Shared constants, paths, API clients
│   ├── styles.js         Art style definitions and prompts
│   ├── helpers.js        Image download, SMS, moderation, face detection, compositing
│   ├── printer.js        Printer discovery and print commands
│   ├── pipeline.js       generateImage (steps 1-6) and printJob (steps 7-8)
│   └── queue.js          Concurrent generation worker, serial print worker, usage tracking
├── template.png          Frame overlay (optional, you provide this)
├── downloads/            Generated images, organized by event name
│   └── YourEventName/
│       ├── 20260211_143000_input.jpg
│       └── 20260211_143000_output.png
├── queue/                File-based job queue
│   ├── pending/          New jobs waiting for generation
│   ├── generating/       Jobs currently generating AI images (up to N concurrent)
│   ├── ready/            Generation complete, waiting to print
│   ├── printing/         Job currently being printed
│   ├── done/             Successfully printed jobs
│   └── failed/           Permanent failures or max retries exceeded
├── .env                  API keys, printer config, event settings
├── .gitignore            Excludes downloads/, queue/, .env, node_modules/
├── package.json
└── pnpm-lock.yaml
```

## Job Queue

Jobs are managed entirely via the filesystem -- no database or Redis required.

Job files, input photos, and output photos all share the same timestamp prefix so you can easily match them:

```
queue/done/20260211_143000.json
downloads/YourEventName/20260211_143000_input.jpg
downloads/YourEventName/20260211_143000_output.png
```

The pipeline is split into two independent workers:

- **Generation worker** -- Processes up to `MAX_CONCURRENT_GENERATION` jobs at the same time. Each job goes through download, moderation, face detection, AI generation, compositing, and print prep. Multiple images generate in parallel so users don't wait in a long single-threaded queue.
- **Print worker** -- Processes one job at a time from the `ready/` queue. Sends the image to the printer and notifies the user via SMS when their print is ready.

### Crash recovery

On server restart:

- Jobs in `generating/` are recovered. If the output image already exists on disk, the job skips straight to `ready/` (no re-generation). Otherwise it goes back to `pending/` for retry.
- Jobs in `printing/` are moved back to `ready/` (the image exists, just retry the print).
- Non-permanent jobs in `failed/` are recovered automatically -- routed to `ready/` or `pending/` depending on whether the output image exists.

### Permanent failures

Jobs flagged by content moderation or rejected by face detection are moved directly to `failed/` without retrying. The user's print count is refunded and they're told it didn't cost a print.

### Retry logic

Failed jobs retry up to 3 times. Each pipeline step is skipped on retry if its output already exists on disk, so only the failed step re-runs.

## Adding or Changing Styles

Art styles are defined in `lib/styles.js`. Each style has a keyword, display name, and an LLM prompt. To add a new style, add an entry to the `STYLES` object:

```js
"oil-painting": {
    name: "oil painting",
    prompt: "Transform this photo into a classical oil painting portrait..."
},
```

The style will automatically appear in SMS messages and be available for users to select. Style matching is fuzzy -- it handles extra spaces, hyphens, and case differences.

## Promotional Messages

The app can append a promotional message to SMS confirmations. Promo messages escalate based on user interaction:

- **First selfie** -- Soft intro: *"P.S. Join us at SIGNAL San Francisco..."*
- **Returning user** -- Nudge: *"Have you registered for SIGNAL San Francisco yet?..."*

To disable promos, leave `PROMO_EVENT_NAME` and `PROMO_EVENT_URL` blank in `.env`.

## Switching Events

When moving to a new event:

1. Update `EVENT_NAME` in `.env` -- this resets everyone's print count and creates a new downloads subfolder.
2. Update `PROMO_*` variables if promoting a different event.
3. Optionally update `template.png` with new event branding.
4. Restart the server.

Previous event data (downloads, completed jobs) is preserved on disk.
