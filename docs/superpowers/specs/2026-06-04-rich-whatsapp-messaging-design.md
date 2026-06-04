# Rich WhatsApp Messaging — Design Spec

- **Date:** 2026-06-04
- **Status:** Draft, pending implementation plan
- **Branch:** `feat/slack-integration` (current)
- **Builds on:** [Multi-Channel Messaging (SMS + WhatsApp)](../specs/2026-05-21-multi-channel-messaging-design.md) — that channel layer is **already built and committed**. This spec adds the rich-content layer on top of it.

---

## 1. Goals

1. Upgrade each step of the attendee flow from plain text to the richest WhatsApp content type that genuinely fits, to **showcase Twilio's rich-messaging breadth** at events.
2. Every rich message routes through the existing `lib/messaging.send()` and **auto-degrades to the current plain-text experience on SMS** — SMS attendees see no change, WhatsApp attendees get the upgrade.
3. Selection menus (style / brand / background) become **list-pickers**, optionally fronted by a **collage preview image** built from admin-uploaded per-option images.
4. The hero delivery message becomes a **card** with the real generated portrait plus Download/Share buttons.
5. Rating becomes tappable **quick-reply** emoji buttons; the next-day promo becomes a **call-to-action** with URL buttons.
6. Preserve all existing functionality. Nothing changes for an event unless an admin opts in (uploads preview images). Default behavior = today's flow, rendered as tappable menus on WhatsApp.

## 2. Non-Goals

- **No AI sample-generation engine.** Preview images are admin-*uploaded*, never auto-generated. (Explicitly rejected during design — generating on event creation would waste generations on un-curated defaults.)
- **No true `twilio/carousel`** for selection menus in v1 (its card count is frozen at approval, fighting the per-event variability). Deferred — see §10.
- **No automated Content Template creation script.** The admin hand-creates the static templates in the Console Content Template Builder using the instructions in §8. (The app still creates *dynamic* list-picker templates via the Content API at runtime — that is not optional and not console work.)
- **No change to the channel model** (always-on, start-channel-locked) — already built.
- **No RCS** (designed-for by the channel layer, not built here).
- **No per-combination previews** — one optional image per *option* (style, brand, background), never per style×brand×background combination.

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
            │   • collage build (sharp)           │
            │   • dynamic list-picker create+cache│
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

- `lib/messaging.js` — extended with **one** capability: accept an explicit `opts.contentSid` (for runtime-created dynamic templates), in addition to the existing settings-resolved static SIDs. No other change.
- `lib/rich-menu.js` (NEW, ~150 LOC) — the only new subsystem. Owns: (a) building the collage image from per-option uploads via `sharp`, (b) creating + caching dynamic list-picker Content Templates via the Content API, (c) deciding rich-vs-text per channel. Pure orchestration over existing helpers.
- `lib/content-templates.js` (NEW, ~80 LOC) — thin wrapper over Twilio Content API `client.content.v1.contents.create()`; create + in-memory/disk cache keyed by an option-set hash. Used only by `rich-menu.js`.
- Menu modules (`style-menu`, `brand-menu`, `background-menu`) — **logic unchanged**. Their `matchReply()` matches by number, normalized **key**, *and* display name. When an attendee taps a list-picker/quick-reply, WhatsApp returns the item's **display text** in inbound `Body` and the developer-defined **`id` in a separate `ButtonPayload` field** (see §3.1). We set each item's `id` to the option key, then feed `ButtonPayload || Body` into `matchReply` — so the key-match branch resolves the tap exactly. No change to the menu modules themselves; the wiring change is in `index.js` (§3.1).
- `lib/settings.js` — add: per-option `previewImage` field storage; static `contentTemplates` keys for the new static templates (`delivery`, `rating`, `promo`).
- `index.js` — **(a)** the inbound handler derives its working `body` from `req.body.ButtonPayload || req.body.Body` (§3.1) so tapped-item ids drive matching; **(b)** the `showMenuAndHold` / `showBrandMenuOrNext` / `showBackgroundMenuOrEnqueue` helpers call `rich-menu` instead of building plain strings, **only when the inbound adapter is WhatsApp**; SMS path unchanged.

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
| 1 | Style pick | collage image + `twilio/list-picker` | numbered text list (today) | none (in-session) | dynamic, runtime |
| 2 | Brand pick | collage image + `twilio/list-picker` | numbered text list | none | dynamic, runtime |
| 3 | Background pick | collage image + `twilio/list-picker` | numbered text list | none | dynamic, runtime |
| 4 | Queued confirmation | `twilio/text` | text (today) | none | n/a |
| 5 | **Delivery (hero)** | `twilio/card`: portrait media + Download + Share URL buttons | image + text (today) | in-session free | static, console |
| 6 | Rating / NPS | `twilio/quick-reply` (🤩 / 🙂 / 😕) | "reply 1–5" text (today) | none | static, console |
| 7 | Promo (next-day) | `twilio/call-to-action` (Explore / Book a demo URL buttons) | text + link (today) | **needs approval** | static, console |

5 of 7 need no Meta approval (they are replies inside the 24-hour user-initiated session). Only the next-day promo (out-of-session) requires approval; the delivery card is free because it is sent in-session immediately after the attendee's messages.

### 4.1 Why list-picker (not quick-reply) for menus

Quick-replies cap at 3 buttons in-session; events can have more options. List-pickers hold up to 10 with a description line each. **Hard cap of 10** is accepted (per user decision): if an event somehow exceeds 10 enabled options in one menu, the menu builder logs a warning and includes only the first 10 — no overflow/category machinery is built. SMS is unaffected (its numbered text list has no such limit).

### 4.2 "None" option in the brand menu

The brand menu can include a synthetic "None" choice (`includeNone`), which today maps to the literal text `"none"` or the trailing number (`brand-menu.js:45,48`). As a list-picker item, set its `id` to `none` (lowercase) and display `None`. With the §3.1 `ButtonPayload` wiring, a tap delivers `none` → `brandMenu.matchReply` resolves it via its existing `normalize(text) === "none"` branch → `"__none__"`. No menu-module change needed.

## 5. Components

### 5.1 Per-option preview image (admin upload)

Each style, brand, and background gains an **optional** `previewImage` field (a hosted filename, same pattern as the existing booth-QR uploads in `booth-uploads/`).

- Admin uploads via the event options panel (new "Preview image" upload control per option, reusing the existing upload endpoint/pattern from `uploadBoothQrChannel`).
- Blank is valid and the default. No upload → that option renders as a **text-only row** in the list-picker and a **labeled tile** in the collage.
- Stored per-event (these are per-event settings, like other style/brand/background config).

### 5.2 Collage compositor — `rich-menu.buildCollage(options)`

- Input: the ordered list of menu options, each `{ key, name, previewImage? }`.
- Uses `sharp` (already a dependency) to compose a grid:
  - Cells with an uploaded image → that image, with the option name captioned.
  - Cells without → a solid-tile with the option name (so the grid stays complete).
- Output: a PNG written to the existing static-served downloads/staging dir → public URL.
- **Cached** keyed by a hash of `(option keys + previewImage filenames + names)`. Rebuilt only when the option set or an uploaded image changes.
- WhatsApp-only. SMS never triggers collage building.

### 5.3 Dynamic list-picker creation — `content-templates.getOrCreateListPicker(menuKind, options, bodyText, buttonLabel)`

- Builds a `twilio/list-picker` Content resource via `client.content.v1.contents.create()`:
  - `body` = `bodyText` (e.g. "Pick your art style:")
  - `button` = `buttonLabel` (e.g. "Choose a style")
  - `items` = up to 10 `{ item: name (≤24 chars), id: key (≤200), description: blurb (≤72) }`
  - **All three item fields are REQUIRED by the Content API** (`item`, `id`, `description`). `description` must be non-empty — derive it from the option's existing short description/blurb if present, else synthesize a safe default (e.g. the style/brand/background name restated, or a generic `"Tap to choose"`). Truncate `item` to 24 and `description` to 72 chars. `id` = the option key (drives matching per §3.1).
- Returns the created `HX` SID synchronously (list-pickers need **no approval** in-session).
- **Cached** keyed by a hash of `(menuKind + ordered option keys + names + descriptions + bodyText + buttonLabel)` so identical menus across attendees/events reuse one template. Cache persisted to disk (survives restart) and in-memory.
- On Content API failure → return `null`; caller falls back to the existing plain-text menu (no attendee-facing break).

### 5.4 `messaging.send` extension

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

**Critical contract for the dynamic path:** `rich-menu` MUST always pass a non-null `opts.contentSid`. It must NEVER call `send` with a `templateKey` like `"styleMenu"` expecting settings/`getMsg` resolution — there is no `contentTemplates.styleMenu` static key and no `getMsg("styleMenu")` message (the real message keys are `styleMenuIntro`/`styleMenuFooter`). If the dynamic SID is null (Content API failed), `rich-menu` does NOT call this path at all — it falls back to the existing plain-text `*.buildMenu()` + `_raw` send (§5.5 step 2b). So `messaging.send` is never asked to resolve a menu `templateKey` against settings.

### 5.5 Rich menu orchestration — `rich-menu.sendMenu(toPhone, adapter, menuKind, options, copy)`

The single entry point the `index.js` helpers call. Behavior:

1. If `adapter.name !== "whatsapp"` → return `{ rich: false }` so the caller uses its existing plain-text path. (SMS untouched.)
2. WhatsApp path:
   a. If any option has a `previewImage` OR we always want the grid: `buildCollage` → send as `_raw` media message (`messaging.send(toPhone, "_raw", {}, { adapter, mediaUrl: collageUrl, _body: copy.collageCaption })`).
   b. `getOrCreateListPicker` → SID. If null, fall through to plain-text menu.
   c. `messaging.send(toPhone, menuKind, {}, { adapter, contentSid: sid })`.
3. Pending-state (`styleMenu.setPending` etc.) is set by the caller exactly as today — unchanged.

### 5.6 Static templates (delivery card, rating, promo)

Created by the admin in the **Console Content Template Builder** (instructions §8). Their `HX` SIDs are pasted into the existing `contentTemplates` settings map under new keys: `delivery`, `rating`, `promo`. `messaging.send(..., "delivery", vars, ...)` then resolves them via the existing static path. If a SID is absent, the existing plain-text fallback fires (so partial rollout is safe).

## 6. Data Flow

### 6.1 WhatsApp style pick (with one uploaded preview)

1. Attendee sends selfie. `detectChannel` → whatsapp adapter; `recordInbound` stamps preferredChannel (existing).
2. `showMenuAndHold` calls `richMenu.sendMenu(phone, adapter, "styleMenu", styleOptions, copy)`.
3. `buildCollage` composes Cartoon(image)+Watercolor(image)+Anime(tile)+Sketch(tile) → PNG → public URL. Sent as media message.
4. `getOrCreateListPicker("styleMenu", options, "Pick your art style:", "Choose a style")` → `HXabc` (cached).
5. `messaging.send(phone, "styleMenu", {}, { adapter, contentSid: "HXabc" })` → list-picker.
6. `styleMenu.setPending(phone, {...})` (existing). Webhook returns 204.
7. Attendee taps "Watercolor" → WhatsApp posts inbound with `Body`/`ButtonPayload` = the item `id` = `watercolor`. `styleMenu.matchReply` matches it (existing). Flow proceeds exactly as today.

### 6.2 SMS style pick (unchanged)

1. `detectChannel` → sms adapter. `richMenu.sendMenu` returns `{ rich:false }` immediately.
2. Caller uses existing `styleMenu.buildMenu` plain text via `messaging.send(phone, "_raw", {}, { _body, adapter })`. Identical to today.

### 6.3 Delivery (hero card)

- On portrait ready (existing pipeline), instead of bare image, send the `delivery` card with **all four variables** matching the §8.1 template definition:
  ```js
  messaging.send(phone, "delivery", {
    1: styleName,        // {{1}} → Body: "Here's your {{1}} portrait!"
    2: portraitMediaUrl, // {{2}} → card media (full public URL to the portrait .png)
    3: downloadUrl,      // {{3}} → Download URL button
    4: shareUrl,         // {{4}} → Share URL button
  }, { adapter });
  ```
- The variable **count and meaning must match §8.1 exactly** (1=style name, 2=media, 3=download, 4=share). A plan that passes fewer/misordered variables renders a broken card.
- WhatsApp: card with portrait + Download/Share buttons (static SID). SMS: plain-text fallback — if `contentTemplates.delivery` has no SID, `messaging.send` falls back to `getMsg("delivery", vars)` + the existing image `mediaUrl` path, reproducing today's image+text delivery. (For SMS-only setups, simply leave `delivery` SID blank.)

## 7. Settings additions

```js
// Per style/brand/background option (per-event), new optional field:
previewImage: ""            // hosted filename, "" = text-only row

// contentTemplates map — new static keys (admin pastes HX SIDs):
contentTemplates: {
  ...existing,
  delivery: "HX...",        // twilio/card
  rating:   "HX...",        // twilio/quick-reply
  promo:    "HX...",        // twilio/call-to-action
}
```

Dynamic list-picker SIDs are NOT stored in settings — they live in the `content-templates` cache (option-set hash → SID), rebuilt on demand.

## 8. Admin runbook — creating the static templates (Console)

For each, go to **Messaging → Content Template Builder → Create new**, then paste the resulting `HX` SID into the matching Settings field.

### 8.1 Delivery card (`delivery`) — `twilio/card`
- **Body:** `Here's your {{1}} portrait! 🎉 Tap below to download or share.`
- **Media:** `{{2}}` (sample: a public portrait URL ending in `.png`)
- **Buttons:** URL "⬇️ Download" → `{{3}}`; URL "🔗 Share" → `{{4}}`
- Submit for WhatsApp approval (cards with buttons require it for reuse). Provide valid media + URL samples.

### 8.2 Rating (`rating`) — `twilio/quick-reply`
- **Body:** `⭐ How'd we do?`
- **Buttons (quick-reply):** "🤩 Loved it" id `nps_5` · "🙂 It's good" id `nps_3` · "😕 Meh" id `nps_1`
- No approval needed for in-session use; create but don't submit.

### 8.3 Promo (`promo`) — `twilio/call-to-action`
- **Body:** `🎁 Thanks for visiting the Twilio AI Photo Booth! {{1}}`
- **Buttons:** URL "🌐 Explore Twilio" → `https://www.twilio.com/{{2}}`; URL "📅 Book a demo" → `https://www.twilio.com/{{3}}`
- **Submit for WhatsApp approval** (out-of-session marketing template). Provide samples.

NPS button mapping: with §3.1 in place, a tap delivers `nps_5` (the button `id`) via `ButtonPayload` into the handler's `body`. The existing NPS handler (`index.js` ~274-283) reads `body` and does `parseInt(body, 10)` — extend it to first match `/^nps_([1-5])$/` and use the captured digit, falling through to the existing numeric parse for typed SMS replies ("3"). Display titles ("🤩 Loved it") never need parsing because the `id` arrives in `ButtonPayload`, not the title.

## 9. Error Handling

| Failure | Handling |
|---|---|
| Content API list-picker create fails | `getOrCreateListPicker` returns null → caller sends existing plain-text menu. Logged. |
| Collage build (sharp) fails | Skip the collage media message; still send the list-picker (or text). Logged. |
| Preview image file missing on disk | That cell renders as a labeled tile (treated as no-upload). |
| Static SID absent (`delivery`/`rating`/`promo`) | Existing plain-text fallback in `messaging.send`. Safe partial rollout. |
| >10 enabled options in a menu | Include first 10 in the list-picker, log a warning. SMS unaffected. |
| Tapped item id not matched | Existing `matchReply` returns null → existing retry-menu path. |
| Out-of-session promo to stale WA user | Existing `requiresSession` guard skips + logs (already built). |

## 10. Deferred / Future Work

- **True `twilio/carousel`** for fully-imaged menus (tap the card directly): pre-approve one template per option-count; auto-fall back to collage+list-picker otherwise. Reuses the same per-option image uploads.
- **AI-generated previews** (run the Twilio owl through each option) as an *optional admin button* — explicitly deferred; uploads cover v1.
- **Dashboard counters** for fallback / out-of-session (the multi-channel spec's §6.4) — still unsurfaced; out of scope here.
- **RCS** rich content (the channel layer is RCS-ready).

## 11. Testing

Node built-in `node --test`, matching existing style. New/changed coverage:

- `test/rich-menu.test.js` — `sendMenu` returns `{rich:false}` for SMS adapter; for WhatsApp calls collage + list-picker; falls back to text when list-picker create returns null.
- `test/content-templates.test.js` — `getOrCreateListPicker` builds correct `items` (id=key, ≤24/≤72 truncation), caches by option-set hash, returns null on API error (Content API stubbed).
- `test/collage.test.js` — `buildCollage` produces a PNG for mixed uploaded/blank options; cache key changes when an image changes (sharp run on tiny fixtures).
- `messaging-send.test.js` (extend) — `opts.contentSid` pass-through bypasses settings lookup; `mediaUrl` still excluded when `contentSid` present.
- `test/inbound-payload.test.js` (NEW) — the inbound handler resolves a tapped selection from `ButtonPayload` (the option key) and a typed reply from `Body`; `ButtonPayload` takes precedence when both present; SMS (no `ButtonPayload`) uses `Body` unchanged.
- Belt-and-suspenders: existing `style-menu` / `brand-menu` / `background-menu` `matchReply` tests confirm that feeding the option **key** (as `ButtonPayload` would deliver) resolves via the key-match branch — and that the "None" id `none` resolves to `"__none__"`.

### 11.1 Manual QA (WhatsApp + SMS)
1. SMS attendee, no previews: full flow identical to today (numbered text menus, image delivery).
2. WhatsApp attendee, no previews uploaded: list-pickers render (collage = all labeled tiles); taps advance the flow.
3. WhatsApp attendee, some previews uploaded: collage shows images + tiles mixed; list-picker lists all.
4. Delivery card: portrait + Download/Share buttons tappable on WhatsApp; SMS gets image+text.
5. Rating: emoji buttons map to NPS scores; SMS gets "reply 1–5".
6. Promo next-day to WA user in-session vs out-of-session (approval-gated) behaves correctly.
7. Content API down → menus gracefully fall back to plain text, no attendee break.

## 12. Open Questions

None. All design decisions confirmed during brainstorming (channel model already built; list-picker over quick-reply for menus; admin-uploaded previews over generation; collage retained; hard cap at 10; static templates hand-created in Console).

## 13. Implementation Order (hint for writing-plans)

1. **Inbound payload parsing (§3.1):** `index.js` derives `body` from `req.body.ButtonPayload || req.body.Body`. Add `test/inbound-payload.test.js`. *This is the foundation — all id-based tap matching depends on it; do it first and verify SMS/typed replies are unaffected.*
2. `messaging.send` `opts.contentSid` + `opts.contentVariables` pass-through (§5.4) + extend `messaging-send.test.js`.
3. `lib/content-templates.js` (list-picker create + option-set-hash cache, null on API error) + test.
4. `lib/rich-menu.js` collage (sharp) + `sendMenu` orchestration (WhatsApp-only, text fallback when SID null) + tests.
5. Per-option `previewImage` settings field + admin upload control (reuse booth-QR upload pattern).
6. Wire `index.js` menu helpers (`showMenuAndHold` / `showBrandMenuOrNext` / `showBackgroundMenuOrEnqueue`) to `rich-menu.sendMenu` (WhatsApp branch only; SMS untouched). Brand "None" id = `none` (§4.2).
7. Static `contentTemplates` keys (`delivery`/`rating`/`promo`) + delivery (4-var, §6.3) / rating / promo send call-site swaps + NPS `nps_N → N` parse (now reachable via §3.1 `ButtonPayload`).
8. Admin runbook doc (§8) surfaced in-app or README.
9. Full `node --test` + manual QA pass (§11.1).
```
