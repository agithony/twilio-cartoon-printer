# English and Brazilian Portuguese Messaging Design

- **Locales:** `en`, `pt_BR`
- **Default language mode:** `en`
- **Scope:** SMS and WhatsApp attendee messages, rich menus, approved templates, lead capture, NPS, errors, outreach, and booth QR entry points
- **Release rule:** Do not submit production WhatsApp templates until both locale catalogs and language selection are implemented.

## Goals

1. Let administrators choose English, Brazilian Portuguese, or per-attendee selection at runtime for each event.
2. Keep stable internal IDs across languages. Only user-facing text changes.
3. Route every message through one locale-aware message resolver.
4. Create and approve separate static WhatsApp templates for each locale.
5. Include locale in dynamic list-picker cache keys.
6. Preserve SMS behavior with localized text fallbacks.

## Locale Selection

The event-scoped `languageMode` setting is changed at runtime from desktop or staff-mobile Settings:

| Mode | Behavior |
|---|---|
| `en` | New conversations use English without a chooser. This is the default. |
| `pt_BR` | New conversations use Brazilian Portuguese without a chooser. |
| `ask` | Attendees choose a language on first contact; the choice is persisted by phone and event. |

Active menus, surveys, ratings, and queued jobs retain the locale they started with when the setting changes. In `ask` mode, when no locale is stored, send a two-option language prompt.

### WhatsApp

Use an in-session quick reply:

| Title | Payload |
|---|---|
| English | `lang_en` |
| Português | `lang_pt_BR` |

Body:

```text
Choose your language / Escolha seu idioma
```

### SMS

```text
Choose your language / Escolha seu idioma

1. English
2. Português
```

Accept `1`, `English`, and `lang_en` for English. Accept `2`, `Português`, `Portugues`, `PT`, and `lang_pt_BR` for Portuguese.

If the first message contains a selfie, persist the media URL and message SID while asking for language. Resume the original selfie flow after selection.

## Locale Persistence

Persist locale by normalized phone identity and event:

```json
{
  "phone": "+14155551234",
  "eventName": "Twilio Tropical Escape",
  "preferredLocale": "pt_BR"
}
```

Resolution precedence:

1. Locale snapshotted by an active menu, survey, rating, or queued job
2. Forced event mode (`en` or `pt_BR`)
3. Persisted phone/event locale when mode is `ask`
4. Application default `en`

In `ask` mode, users may request the chooser with `LANGUAGE` or `IDIOMA`, or switch outside an active flow with `ENGLISH` or `PORTUGUÊS`. Numeric replies `1` and `2` select a language only while language selection is pending, so they remain safe for menus and ratings.

## Message Catalog

Add `lib/i18n.js` with stable keys:

```js
t(locale, "welcome", vars)
t(locale, "styleMenuIntro", vars)
t(locale, "deliveryDigital", vars)
```

All existing `settings.getMsg()` call sites must migrate to the locale-aware resolver. Internal identifiers such as style keys, background keys, `nps_5`, and `none` remain unchanged.

Initial catalogs live in code. Per-event/admin translation editing is deferred until both built-in catalogs are complete and tested.

## Static WhatsApp Templates

Each approved template needs an English and Portuguese Content SID.

```json
{
  "contentTemplates": {
    "en": {
      "delivery": "HX...",
      "rating": "HX...",
      "promo": "HX...",
      "nudgeDropoff": "HX..."
    },
    "pt_BR": {
      "delivery": "HX...",
      "rating": "HX...",
      "promo": "HX...",
      "nudgeDropoff": "HX..."
    }
  }
}
```

Existing flat English settings migrate automatically into `contentTemplates.en`.

### Delivery

English title:

```text
Your {{1}} portrait is ready!
```

Portuguese title:

```text
Seu retrato em estilo {{1}} está pronto!
```

English subtitle:

```text
Created at the Twilio AI Photo Booth
```

Portuguese subtitle:

```text
Criado no Twilio AI Photo Booth
```

English button: `View & Share`

Portuguese button: `Ver e compartilhar`

### Optional Rating

English body:

```text
How would you rate your portrait experience?
```

Portuguese body:

```text
Como você avalia sua experiência com o retrato?
```

| Score | English | Portuguese | Payload |
|---:|---|---|---|
| 5 | `5 - Loved it` | `5 - Adorei` | `nps_5` |
| 4 | `4 - Great` | `4 - Ótima` | `nps_4` |
| 3 | `3 - Good` | `3 - Boa` | `nps_3` |
| 2 | `2 - Fair` | `2 - Regular` | `nps_2` |
| 1 | `1 - Not for me` | `1 - Não gostei` | `nps_1` |

### Promo

English:

```text
Want to build experiences like this? See what you can create with Twilio.
```

Portuguese:

```text
Quer criar experiências como esta? Veja o que você pode construir com a Twilio.
```

English button: `Explore Twilio`

Portuguese button: `Conheça a Twilio`

### Drop-Off Nudge

English:

```text
Still want your AI portrait from {{1}}? Reply with a selfie to get started. Reply STOP to opt out.
```

Portuguese:

```text
Ainda quer seu retrato com IA do evento {{1}}? Responda com uma selfie para começar. Responda STOP para cancelar.
```

Configure localized Advanced Opt-Out keywords before enabling Portuguese outreach.

## Dynamic List Pickers

Dynamic pickers remain in-session and do not need approval. The cache hash includes locale, body, button text, option names, descriptions, and IDs.

### Style

English body: `Great selfie! Choose your portrait style.`

Portuguese body: `Ótima selfie! Escolha o estilo do seu retrato.`

English button: `Choose a style`

Portuguese button: `Escolher estilo`

### Theme

English body: `Choose a theme for your portrait.`

Portuguese body: `Escolha um tema para o seu retrato.`

English button: `Choose a theme`

Portuguese button: `Escolher tema`

### Background

English body: `Choose a background for your portrait.`

Portuguese body: `Escolha o fundo do seu retrato.`

English button: `Choose background`

Portuguese button: `Escolher fundo`

Style, theme, and background display names and descriptions require explicit translations. Never expose or machine-truncate internal generation prompts as attendee descriptions.

## Template Provisioning

The creation script loops over both locales and uses Twilio language codes `en` and `pt_BR`. Each locale receives a separately versioned friendly name and separate approval request.

Example:

```text
pb_delivery_en_<hash>
pb_delivery_pt_BR_<hash>
```

The script keeps the currently approved SID active while a replacement version is pending. It switches only after the new version reports `approved`.

## Testing

Required automated coverage:

- Language selection by button, number, accented text, and unaccented text
- Selfie received before language selection
- Locale persistence across restart
- Locale isolation by event
- English and Portuguese SMS menus
- English and Portuguese WhatsApp picker payloads
- Static template variable parity across locales
- Portuguese character and button limits
- NPS payloads remain language-neutral
- Language switching during an active flow
- Missing translation fails CI instead of silently falling back

Required live testing:

- English SMS
- Portuguese SMS with accents
- English WhatsApp
- Portuguese WhatsApp
- Portuguese template approval and delivery
- STOP and localized opt-out behavior

## Implementation Order

1. Add locale catalog and translation-completeness tests.
2. Add preferred locale persistence.
3. Add runtime event language mode, optional first-contact selection, and held-selfie state.
4. Convert deterministic inbound messages to `t(locale, key)`.
5. Add localized style/theme/background labels and descriptions.
6. Include locale in dynamic picker creation and cache.
7. Change static template settings to nested locale maps.
8. Update creation script to provision both languages.
9. Update booth QR configuration with per-language entry points.
10. Run live bilingual tests before submitting templates.
