# Rich WhatsApp Messaging — Design Spec

- **Date:** 2026-06-04
- **Status:** Draft, pending implementation plan
- **Branch:** `feat/slack-integration` (current)
- **Builds on:** [Multi-Channel Messaging (SMS + WhatsApp)](../specs/2026-05-21-multi-channel-messaging-design.md) — that channel layer is **already built and committed**. This spec adds the rich-content layer on top of it.

---

## 1. Goals

1. Upgrade each step of the attendee flow from plain text to the richest WhatsApp content type that genuinely fits, to **showcase Twilio's rich-messaging breadth** at events.
2. Every rich message routes through the existing `lib/messaging.send()` and **auto-degrades to the current plain-text experience on SMS** — SMS attendees see no change, WhatsApp attendees get the upgrade.
3. Selection menus (style / brand / background) become **text list-pickers** (option name + short description per row). No preview images, no collage.
4. The hero delivery message becomes a **`twilio/card`** with the real generated portrait plus a **single** "View & Share" URL button pointing at the existing share page (`/s/<filePrefix>`), which already hosts download/share actions and dub.co link analytics. One button → no Meta approval needed in-session.
5. Rating becomes tappable **quick-reply** emoji buttons; the next-day promo becomes a **call-to-action** with URL buttons.
6. Preserve all existing functionality. Default behavior on WhatsApp = today's flow rendered as tappable text list-pickers; SMS entirely unchanged.

## 2. Non-Goals

- **No collage / preview images / image-based menus.** Selection menus are text-only list-pickers. (Considered and rejected during design: the options are AI text-prompts with no inherent image, and a self-composed collage added complexity for little value.)
- **No `sharp`-based collage compositor, no per-option `previewImage` upload field.** Removed from scope entirely.
- **No AI sample-generation engine** (was only needed to feed the collage — moot now).
- **No `twilio/carousel`** for selection menus (card count frozen at approval, fights per-event variability; also needs approval even in-session). Deferred — see §10.
- **No `twilio/catalog`** anywhere — it requires a Meta Commerce Manager product catalog with priced products and cannot carry a dynamic generated image; wrong tool for an art-style picker.
- **No `whatsapp/card`** for delivery — its `media` field is not variable, so it can't show the dynamic generated portrait. Delivery uses `twilio/card` (whose `media` IS variable).
- **No two-button delivery card / no Meta approval for delivery.** The delivery card uses exactly ONE URL button (WhatsApp rejects two URL buttons, and any multi-button card forces approval). See §6.3.
- **No "try another style" re-roll in v1.** Considered (would make the preview their own re-styled face), but it requires a 2nd delivery-card button → Meta approval. Deferred — see §10. Delivery stays single-button.
- **No change to the channel model** (always-on, start-channel-locked) — already built.
- **No RCS** (designed-for by the channel layer, not built here).

## 3. Architecture

```
                 Attendee selfie → POST /inbound (existing)
                              │
                  channels.detectChannel → adapter (existing)
                              │
                  index.js orchestration (existing menus)
                              │
            ┌─────────────────┴──────────────────┐
            │ NEW: rich menu rendering            │
            │  lib/rich-menu.js                   │
            │   • dynamic list-picker create+cache│
            │   • rich-vs-text decision per channel│
            └─────────────────┬──────────────────┘
                              │
                  lib/messaging.send(toPhone, templateKey, vars, opts)
                    • static contentSid  → settings.getContentSid (existing)
                    • dynamic contentSid  → opts.contentSid (NEW pass-through)
                    • _raw / plain-text fallback (existing)
                              │
                  SMS adapter (plain text)   WhatsApp adapter (rich)
```

**Module boundaries:**

- `lib/messaging.js` — extended with **one** capability: accept an explicit `opts.contentSid` (+ optional `opts.contentVariables`) for runtime-created dynamic templates, in addition to the existing settings-resolved static SIDs. No other change.
- `lib/rich-menu.js` (NEW, ~90 LOC) — the only new orchestration module. Owns: (a) creating + caching dynamic list-picker Content Templates via the Content API (delegating to `content-templates.js`), (b) deciding rich-vs-text per channel and falling back to the existing plain-text menu when rich isn't available. No image work.
- `lib/content-templates.js` (NEW, ~80 LOC) — thin wrapper over Twilio Content API `client.content.v1.contents.create()`; create + in-memory/disk cache keyed by an option-set hash. Used by `rich-menu.js`.
- Menu modules (`style-menu`, `brand-menu`, `background-menu`) — **logic unchanged**. Their `matchReply()` matches by number, normalized **key**, *and* display name. When an attendee taps a list-picker/quick-reply, WhatsApp returns the item's **display text** in inbound `Body` and the developer-defined **`id` in a separate `ButtonPayload` field** (see §3.1). We set each item's `id` to the option key, then feed `ButtonPayload || Body` into `matchReply` — so the key-match branch resolves the tap exactly. No change to the menu modules themselves; the wiring change is in `index.js` (§3.1).
- `lib/settings.js` — add: static `contentTemplates` keys for the new static templates (`delivery`, `rating`, `promo`). (No per-option preview-image field — menus are text-only.)
- `index.js` — **(a)** the inbound handler derives its working `body` from `req.body.ButtonPayload || req.body.Body` (§3.1) so tapped-item ids drive matching; **(b)** the `showMenuAndHold` / `showBrandMenuOrNext` / `showBackgroundMenuOrEnqueue` helpers call `rich-menu` instead of building plain strings, **only when the inbound adapter is WhatsApp**; SMS path unchanged.
- `lib/queue.js` — the delivery send (`queue.js:1197`, the `_raw` image MMS) gains a WhatsApp branch that sends the `delivery` `twilio/card` instead; SMS/plain path unchanged. The share-page URL (`job.shareUrl` or `${baseUrl}/s/${filePrefix}`) and portrait URL (`${baseUrl}/images/${filePrefix}_output_mms.jpg`) already exist there.

### 3.1 Inbound payload parsing (MANDATORY wiring change)

When a WhatsApp user **taps** a list-picker item or quick-reply button, Twilio's inbound webhook delivers:
- `Body` = the item/button **display text** (e.g. `"Watercolor"`, `"🤩 Loved it"`) — visible to the user.
- `ButtonText` = same display text.
- `ButtonPayload` = the developer-defined **`id`** (e.g. `watercolor`, `nps_5`) — NOT visible to the user.

Today `index.js:148` reads only `const body = req.body.Body || "";`. That means a tap is matched only via display-name normalization, and the carefully-set `id` is dropped — fragile when display text is truncated (list-picker `item` ≤24 chars) or differs from the key (`key:"plain-white"` / `name:"Solid White"`), and it makes the `nps_5`-style payloads (§8.2) unreachable.

**Change:** source the working value from the payload when present:
```js
const body = (req.body.ButtonPayload || req.body.Body || "");
```
This is backward-compatible: SMS and typed WhatsApp replies have no `ButtonPayload`, so they fall through to `Body` exactly as today. Every `matchReply` / NPS / style-detection path then receives the option key on a tap (which they already match by key) and the raw text on a type (which they already match by name/number). This single change is what makes all id-based rich matching work; it is listed in §13.

## 4. Content-type mapping (per step)

| # | Step | WhatsApp type | SMS (auto-degrade) | Approval | Created |
|---|------|---------------|--------------------|----------|---------|
| 1 | Style pick | `twilio/list-picker` (text rows) | numbered text list (today) | none (in-session) | dynamic, runtime |
| 2 | Brand pick | `twilio/list-picker` (text rows) | numbered text list | none | dynamic, runtime |
| 3 | Background pick | `twilio/list-picker` (text rows) | numbered text list | none | dynamic, runtime |
| 4 | Queued confirmation | `twilio/text` (plain — no template) | text (today) | none | n/a (plain text) |
| 5 | **Delivery (hero)** | `twilio/card`: portrait media (variable) + **ONE** "View & Share" URL button → share page | image + text (today) | **none** (1 button, in-session) | static, **script** |
| 6 | Rating / NPS | `twilio/quick-reply` (🤩 / 🙂 / 😕, 3 buttons) | "reply 1–5" text (today) | none | static, **script** |
| 7 | Promo (next-day) | `twilio/call-to-action` (2 URL buttons) | text + link (today) | **needs approval** | static, **script** |

6 of 7 need no Meta approval (replies inside the 24-hour user-initiated session, each with ≤1 URL button / ≤3 quick-reply buttons). Only the next-day promo (out-of-session, business-initiated) requires approval — and because it's an *approved* template it may carry two URL buttons. The delivery card is approval-free **because it carries exactly one button** — two URL buttons would both fail validation and force approval (verified against Twilio docs; see §6.3).

### 4.0 Template inventory (the complete set — 6 templates)

Three buckets, decided by one rule: **a template variable can change text and URL-suffixes, but never structure (item count, button count, domain).** Fixed structure → pre-create with variables. Variable structure → build at runtime.

| Bucket | Key | Content type | How created | Approval |
|---|---|---|---|---|
| **A. Static** | `delivery` | `twilio/card` (portrait + 1 share button) | **creation script**, once | none |
| **A. Static** | `rating` | `twilio/quick-reply` (3 emoji buttons) | creation script, once | none |
| **A. Static** | `promo` | `twilio/call-to-action` (2 URL buttons) | creation script, once | **one-time (script submits)** |
| **B. Dynamic** | `styleMenu` | `twilio/list-picker` | app, at runtime (cached by option-set hash) | none |
| **B. Dynamic** | `brandMenu` | `twilio/list-picker` | app, at runtime | none |
| **B. Dynamic** | `backgroundMenu` | `twilio/list-picker` | app, at runtime | none |

**Bucket C — no template (stays plain text via existing `getMsg`):** `enqueued`/queued, `quotaExceeded`, `remainingCount`, `stillWorking`, `npsThanks`, `multiplePhotos`, `moderationFail`, `noFace`, `multiSubjectReject`, and all menu **retries** (a retry re-sends the same dynamic list-picker on WhatsApp, plain text on SMS). These need no Content Template in-session.

### 4.1 Why list-picker (not quick-reply) for menus

Quick-replies cap at 3 buttons in-session; events can have more options. List-pickers hold up to 10 with a description line each. **Hard cap of 10** is accepted (per user decision): if an event somehow exceeds 10 enabled options in one menu, the menu builder logs a warning and includes only the first 10 — no overflow/category machinery is built. SMS is unaffected (its numbered text list has no such limit).

### 4.2 "None" option in the brand menu

The brand menu can include a synthetic "None" choice (`includeNone`), which today maps to the literal text `"none"` or the trailing number (`brand-menu.js:45,48`). As a list-picker item, set its `id` to `none` (lowercase) and display `None`. With the §3.1 `ButtonPayload` wiring, a tap delivers `none` → `brandMenu.matchReply` resolves it via its existing `normalize(text) === "none"` branch → `"__none__"`. No menu-module change needed.

## 5. Components

### 5.1 Dynamic list-picker creation — `content-templates.getOrCreateListPicker(menuKind, options, bodyText, buttonLabel)`

- Builds a `twilio/list-picker` Content resource via `client.content.v1.contents.create()`:
  - `body` = `bodyText` (e.g. "Pick your art style:")
  - `button` = `buttonLabel` (e.g. "Choose a style")
  - `items` = up to 10 `{ item: name (≤24 chars), id: key (≤200), description: blurb (≤72) }`
  - **All three item fields are REQUIRED by the Content API** (`item`, `id`, `description`). `description` must be non-empty — derive it from the option's existing short description/blurb if present, else synthesize a safe default (e.g. the style/brand/background name restated, or a generic `"Tap to choose"`). Truncate `item` to 24 and `description` to 72 chars. `id` = the option key (drives matching per §3.1).
- Returns the created `HX` SID synchronously (list-pickers need **no approval** in-session).
- **Cached** keyed by a hash of `(menuKind + ordered option keys + names + descriptions + bodyText + buttonLabel)` so identical menus across attendees/events reuse one template. Cache persisted to disk (survives restart) and in-memory.
- On Content API failure → return `null`; caller falls back to the existing plain-text menu (no attendee-facing break).

### 5.2 `messaging.send` extension

Extend the SID-resolution step (currently `lib/messaging.js:66`, inside the non-`_raw` branch): prefer an explicit `opts.contentSid` over the settings lookup, and let an explicit `opts.contentVariables` object override the `vars`-derived value. This lets `rich-menu` pass a runtime-created **dynamic** SID. Everything else (session guard, `_raw` branch, plain-text fallback, retry, the `mediaUrl`-incompatible-with-`contentSid` rule at line 77) is unchanged.

```js
// inside send(), in the `else` (non-_raw) branch, replacing line 66's `const sid = ...`:
const sid = opts.contentSid || settings.getContentSid(templateKey);
if (sid) {
    const cv = opts.contentVariables || vars;
    payload = { ...base, contentSid: sid, contentVariables: JSON.stringify(cv) };
} else {
    // unchanged plain-text fallback (getMsg + fallback counter)
}
```

**Critical contract for the dynamic path:** `rich-menu` MUST always pass a non-null `opts.contentSid`. It must NEVER call `send` with a `templateKey` like `"styleMenu"` expecting settings/`getMsg` resolution — there is no `contentTemplates.styleMenu` static key and no `getMsg("styleMenu")` message (the real message keys are `styleMenuIntro`/`styleMenuFooter`). If the dynamic SID is null (Content API failed), `rich-menu` does NOT call this path at all — it falls back to the existing plain-text `*.buildMenu()` + `_raw` send (§5.3 step 2b). So `messaging.send` is never asked to resolve a menu `templateKey` against settings.

### 5.3 Rich menu orchestration — `rich-menu.sendMenu(toPhone, adapter, menuKind, options, copy)`

The single entry point the `index.js` helpers call. Behavior:

1. If `adapter.name !== "whatsapp"` → return `{ rich: false }` so the caller uses its existing plain-text path. (SMS untouched.)
2. WhatsApp path:
   a. `getOrCreateListPicker(menuKind, options, copy.body, copy.button)` → SID.
   b. If SID is null (Content API failed) → return `{ rich: false }` so the caller uses its existing plain-text menu (no break).
   c. `messaging.send(toPhone, menuKind, {}, { adapter, contentSid: sid })` → returns `{ rich: true }`.
3. Pending-state (`styleMenu.setPending` etc.) is set by the caller exactly as today — unchanged, regardless of rich/text.

No image/collage step — the list-picker's text rows are the whole menu.

### 5.4 Static templates (delivery card, rating, promo) + creation script

A committed Node script (`scripts/create-content-templates.js`) creates the three static templates via the Content API (`client.content.v1.contents.create()`) and submits the `promo` for WhatsApp approval. The admin runs it once with their Twilio credentials; it prints each `HX` SID (and can optionally write them straight into settings). SIDs live in the `contentTemplates` settings map under keys `delivery`, `rating`, `promo`. `messaging.send(..., "delivery", vars, ...)` resolves them via the existing static path; if a SID is absent, the existing plain-text fallback fires (safe partial rollout). Script details + exact template JSON in §8.

(Decided over hand-creating in the Console: the variable wiring is fiddly to enter by hand three times, and a script is repeatable across accounts/re-runs.)

## 6. Data Flow

### 6.1 WhatsApp style pick

1. Attendee sends selfie. `detectChannel` → whatsapp adapter; `recordInbound` stamps preferredChannel (existing).
2. `showMenuAndHold` calls `richMenu.sendMenu(phone, adapter, "styleMenu", styleOptions, copy)`.
3. `getOrCreateListPicker("styleMenu", options, "Pick your art style:", "Choose a style")` → `HXabc` (cached by option-set hash).
4. `messaging.send(phone, "styleMenu", {}, { adapter, contentSid: "HXabc" })` → list-picker with text rows (Cartoon / Watercolor / Anime / Sketch, each with a description line). Returns `{ rich:true }`.
5. `styleMenu.setPending(phone, {...})` (existing — the caller does this whether rich or text). Webhook returns 204.
6. Attendee taps "Watercolor" → WhatsApp posts inbound with `ButtonPayload` = the item `id` = `watercolor` (and `Body` = "Watercolor"). Per §3.1, `index.js` reads `ButtonPayload || Body` = `watercolor` → `styleMenu.matchReply` matches by key. Flow proceeds exactly as today.

### 6.2 SMS style pick (unchanged)

1. `detectChannel` → sms adapter. `richMenu.sendMenu` returns `{ rich:false }` immediately.
2. Caller uses existing `styleMenu.buildMenu` plain text via `messaging.send(phone, "_raw", {}, { _body, adapter })`. Identical to today.

### 6.3 Delivery (hero card)

**Design (verified against Twilio docs):** The delivery card is a `twilio/card` with the generated portrait as variable `media` and **exactly ONE URL button** — "View & Share" — pointing at the existing share page. One button keeps it **approval-free in-session**; two URL buttons would both fail validation (`"a Content with two URL buttons will fail"`) and any multi-button card forces Meta approval. `whatsapp/card` is NOT used (its `media` isn't variable). The share page already provides download + share + dub.co analytics, so one button covers both actions.

**Media URL constraint:** a `twilio/card` variable `media` URL can only vary *after the domain* (`https://<fixed-domain>/{{N}}`). The portrait is already served at `${baseUrl}/images/${filePrefix}_output_mms.jpg` — a stable domain — so the variable supplies the path `images/<filePrefix>_output_mms.jpg` under the baked-in domain. (If `baseUrl` ever varies across deploys, host portraits under one canonical domain for the template; see §12 open item — resolved to: use the production base URL.)

This replaces the WhatsApp branch of the existing delivery send at `queue.js:1197`. The SMS/plain branch (`_raw` with `mediaUrl: imageUrl`) is unchanged.

```js
// WhatsApp branch (adapter.name === "whatsapp" && contentTemplates.delivery set):
const shareUrl = job.shareUrl || `${job.baseUrl}/s/${job.filePrefix}?e=${encodeURIComponent(ev)}`;
messaging.send(job.userPhone, "delivery", {
  1: jobStyleName,                                    // {{1}} → Body: style name
  2: `images/${job.filePrefix}_output_mms.jpg`,       // {{2}} → media path after fixed domain
  3: shareUrl,                                        // {{3}} → "View & Share" URL button
}, { adapter });
```

- Variable **count and meaning must match §8.1 exactly** (1=style name, 2=media path, 3=share URL).
- SMS / fallback: if `contentTemplates.delivery` has no SID, `messaging.send` falls back to `getMsg("delivery", vars)` + the existing image `mediaUrl` — reproducing today's image+text delivery verbatim. SMS-only setups simply leave the SID blank.
- The standalone promo + NPS that follow delivery (`queue.js:1206+`) are unchanged in flow; only their *content type* changes (steps 6–7), handled at their own call sites.

## 7. Settings additions

```js
// contentTemplates map — new static keys (admin pastes HX SIDs):
contentTemplates: {
  ...existing,
  delivery: "HX...",        // twilio/card (portrait + 1 share button)
  rating:   "HX...",        // twilio/quick-reply
  promo:    "HX...",        // twilio/call-to-action
}
```

No per-option `previewImage` field — menus are text-only list-pickers. Dynamic list-picker SIDs are NOT stored in settings — they live in the `content-templates` cache (option-set hash → SID), rebuilt on demand.

## 8. Static-template creation script — `scripts/create-content-templates.js`

A committed Node script using the Twilio SDK's Content API (`client.content.v1.contents.create({...})`) creates the three static templates and submits `promo` for WhatsApp approval. Run once: `node scripts/create-content-templates.js` (reads `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` from env). It is **idempotent**: it lists existing contents by `friendly_name` first and skips/updates rather than duplicating. It prints each `HX` SID and writes them into `contentTemplates` settings (with a `--print-only` flag to skip the write). The exact `types` payloads below are the source of truth for both the script and the variable contracts in §6.

### 8.1 `delivery` — `twilio/card` (friendly_name `pb_delivery`)
```jsonc
{
  "friendly_name": "pb_delivery", "language": "en",
  "variables": { "1": "Cartoon", "2": "images/sample_output_mms.jpg", "3": "https://example.com/s/sample" },
  "types": {
    "twilio/card": {
      "title": "Here's your {{1}} portrait! 🎉",
      "body": "Tap below to download or share it.",
      "media": ["https://<your-fixed-domain>/{{2}}"],
      "actions": [ { "type": "URL", "title": "View & Share", "url": "{{3}}" } ]
    },
    "twilio/text": { "body": "Here's your {{1}} portrait! 🎉 View & share it: {{3}}" }
  }
}
```
- **Exactly ONE URL button.** Approval-free in-session. Do NOT submit for approval. The `twilio/text` fallback covers SMS/older clients.
- `media` domain is fixed at creation; `{{2}}` supplies the path (must end in a real image extension, publicly hosted). Set `<your-fixed-domain>` to the production base URL.

### 8.2 `rating` — `twilio/quick-reply` (friendly_name `pb_rating`)
```jsonc
{
  "friendly_name": "pb_rating", "language": "en", "variables": {},
  "types": {
    "twilio/quick-reply": {
      "body": "⭐ How'd we do?",
      "actions": [
        { "type": "QUICK_REPLY", "title": "🤩 Loved it", "id": "nps_5" },
        { "type": "QUICK_REPLY", "title": "🙂 It's good", "id": "nps_3" },
        { "type": "QUICK_REPLY", "title": "😕 Meh",      "id": "nps_1" }
      ]
    },
    "twilio/text": { "body": "⭐ How'd we do? Reply 1–5 (5 = loved it)." }
  }
}
```
- 3 buttons, in-session → no approval; do not submit. SMS gets the `twilio/text` "reply 1–5".

### 8.3 `promo` — `twilio/call-to-action` (friendly_name `pb_promo`)
```jsonc
{
  "friendly_name": "pb_promo", "language": "en",
  "variables": { "1": "See how we built this.", "2": "", "3": "demos" },
  "types": {
    "twilio/call-to-action": {
      "body": "🎁 Thanks for visiting the Twilio AI Photo Booth! {{1}}",
      "actions": [
        { "type": "URL", "title": "🌐 Explore Twilio", "url": "https://www.twilio.com/{{2}}" },
        { "type": "URL", "title": "📅 Book a demo",    "url": "https://www.twilio.com/{{3}}" }
      ]
    },
    "twilio/text": { "body": "🎁 Thanks for visiting the Twilio AI Photo Booth! {{1}} https://www.twilio.com/{{3}}" }
  }
}
```
- Sent out-of-session (next day) → **must be approved**. The script calls the approval endpoint (`.../ApprovalRequests/whatsapp`) with category `MARKETING`. Two URL buttons are valid for an approved template.
- This is the **only** template needing approval; budget its lead time (minutes–hours) before the first event that uses promo.

### 8.4 NPS button mapping (code change, not a template)
With §3.1 in place, a rating tap delivers `nps_5` via `ButtonPayload` into the handler's `body`. The existing NPS handler (`index.js` ~274-283) does `parseInt(body,10)` — extend it to first match `/^nps_([1-5])$/` and use the captured digit, falling through to the existing numeric parse for typed SMS replies ("3"). Display titles ("🤩 Loved it") never need parsing because the routing value arrives in `ButtonPayload`.

## 9. Error Handling

| Failure | Handling |
|---|---|
| Content API list-picker create fails | `getOrCreateListPicker` returns null → `sendMenu` returns `{rich:false}` → caller sends existing plain-text menu. Logged. |
| Static SID absent (`delivery`/`rating`/`promo`) | Existing plain-text fallback in `messaging.send` (`getMsg` + `mediaUrl` for delivery). Safe partial rollout. |
| Portrait media URL unreachable / wrong content-type | Twilio rejects the card send → `sendWithRetry` logs + single retry (existing). Consider leaving `delivery` SID blank until media hosting verified. |
| >10 enabled options in a menu | Include first 10 in the list-picker, log a warning. SMS unaffected. |
| Tapped item id not matched | Existing `matchReply` returns null → existing retry-menu path. |
| Out-of-session promo to stale WA user | Existing `requiresSession` guard skips + logs (already built). |

## 10. Deferred / Future Work

- **Image-rich menus** (preview thumbnails per option) — deferred entirely. Would require either admin-uploaded per-option images or AI-generated samples, plus (for tap-the-image) a `twilio/carousel` with a fixed, pre-approved card count. Not worth the approval + per-event friction for v1; text list-pickers ship now.
- **`twilio/carousel`** for fixed, pre-approved option sets (tap the card image directly) — viable only when an event reuses a stable, pre-approved set; the card count can't vary per send and approval is required even in-session. Revisit if a recurring event wants the premium feel.
- **Multi-button delivery card** (separate Download + Share styled buttons) — would require Meta approval (two URL buttons / multi-button rule). The single "View & Share" button → share page covers both actions today without approval.
- **"Try another style" re-roll** on delivery — re-runs the attendee's selfie in a new style (the preview becomes their own re-styled face; immune to per-event style mutability). Deferred only because it adds a 2nd delivery-card button → Meta approval. Strong candidate for v2; could also ship as a separate quick-reply message after delivery to avoid touching the card.
- **Dashboard counters** for fallback / out-of-session (the multi-channel spec's §6.4) — still unsurfaced; out of scope here.
- **RCS** rich content (the channel layer is RCS-ready).

## 11. Testing

Node built-in `node --test`, matching existing style. New/changed coverage:

- `test/rich-menu.test.js` — `sendMenu` returns `{rich:false}` for SMS adapter; for WhatsApp creates the list-picker and sends via `contentSid`; returns `{rich:false}` (text fallback) when list-picker create returns null.
- `test/content-templates.test.js` — `getOrCreateListPicker` builds correct `items` (id=key, ≤24/≤72 truncation, non-empty description), caches by option-set hash, returns null on API error (Content API stubbed).
- `messaging-send.test.js` (extend) — `opts.contentSid` pass-through bypasses settings lookup; `opts.contentVariables` overrides `vars`; `mediaUrl` still excluded when `contentSid` present.
- `test/inbound-payload.test.js` (NEW) — the inbound handler resolves a tapped selection from `ButtonPayload` (the option key) and a typed reply from `Body`; `ButtonPayload` takes precedence when both present; SMS (no `ButtonPayload`) uses `Body` unchanged.
- Belt-and-suspenders: existing `style-menu` / `brand-menu` / `background-menu` `matchReply` tests confirm that feeding the option **key** (as `ButtonPayload` would deliver) resolves via the key-match branch — and that the "None" id `none` resolves to `"__none__"`.

### 11.1 Manual QA (WhatsApp + SMS)
1. SMS attendee: full flow identical to today (numbered text menus, image+text delivery, "reply 1–5" NPS).
2. WhatsApp attendee: style/brand/background render as tappable text list-pickers; each tap advances the flow (verify `ButtonPayload` matching, incl. brand "None" and `plain-white`/`Solid White`).
3. Delivery card on WhatsApp: portrait image + single "View & Share" button opens the share page (download/share work there). SMS gets today's image+text.
4. Rating: emoji buttons map to NPS scores (`nps_5→5` etc.); SMS gets "reply 1–5".
5. Promo next-day to WA user out-of-session: approved CTA template sends; `requiresSession` guard behaves.
6. Content API down → menus gracefully fall back to plain text on WhatsApp, no attendee break.
7. `delivery` SID blank → WhatsApp delivery falls back to image+text (verify safe partial rollout).

## 12. Open Questions

None. All design decisions confirmed during brainstorming: channel model already built; list-picker over quick-reply for menus; **text-only menus (no collage / no preview images)**; **delivery = `twilio/card` with one "View & Share" button → existing share page (no approval)**; no carousel/catalog/whatsapp-card; no "try another style" in v1; hard cap at 10; **static templates created by `scripts/create-content-templates.js` (not hand-created in Console)**; only `promo` needs Meta approval; portraits hosted under the production base URL for the card media variable.

## 13. Implementation Order (hint for writing-plans)

1. **Inbound payload parsing (§3.1):** `index.js` derives `body` from `req.body.ButtonPayload || req.body.Body`. Add `test/inbound-payload.test.js`. *Foundation — all id-based tap matching depends on it; do it first and verify SMS/typed replies are unaffected.*
2. `messaging.send` `opts.contentSid` + `opts.contentVariables` pass-through (§5.2) + extend `messaging-send.test.js`.
3. `lib/content-templates.js` (list-picker create + option-set-hash cache, null on API error) + test.
4. `lib/rich-menu.js` `sendMenu` orchestration (WhatsApp-only; text fallback when SID null) + test. No image/collage work.
5. Wire `index.js` menu helpers (`showMenuAndHold` / `showBrandMenuOrNext` / `showBackgroundMenuOrEnqueue`) to `rich-menu.sendMenu` (WhatsApp branch only; SMS untouched). Brand "None" id = `none` (§4.2).
6. **`scripts/create-content-templates.js`** (§8): creates `delivery`/`rating`/`promo` via Content API, submits `promo` for approval, prints/writes `HX` SIDs. Idempotent by `friendly_name`. Admin runs once.
7. Add `contentTemplates` settings keys (`delivery`/`rating`/`promo`). Swap the delivery send (`queue.js:1197`) to the WhatsApp `delivery` card (3 vars, §6.3) with SMS/plain fallback; swap rating + promo call sites; add NPS `nps_N → N` parse (now reachable via §3.1).
8. Full `node --test` + manual QA pass (§11.1).
```
