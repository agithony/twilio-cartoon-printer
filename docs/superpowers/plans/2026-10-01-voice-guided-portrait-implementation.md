# Voice-Guided Portrait Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an event operator enable Voice so a selfie sender calls a Twilio number, describes an arbitrary permitted edit to an interruptible AI agent, and receives the finished portrait through the original SMS or WhatsApp conversation.

**Architecture:** V1 stores the selfie and request durably before inviting a call. Conversation Relay carries speech to a bounded agent state machine; a server policy gate and explicit confirmation produce an approved brief. A deterministic queue group copies the staged photo into the existing pipeline, which uses a neutral Voice prompt and delivers digitally after generation and review.

**Tech Stack:** Node.js 22+, CommonJS, Express 5, Twilio SDK 5.12.1 and Conversation Relay, `ws` 8.21.0, OpenAI SDK 6.21.0, Sharp, file-backed `data/` and `queue/`, `node:test`, pnpm 10.20.0.

**Spec:** `docs/superpowers/specs/2026-10-01-voice-guided-portrait-design.md`

## Global Constraints

- Implement in the live V1 `twilio-cartoon-printer` repository; do not route real attendee traffic through V2.
- Keep Voice disabled by default and scoped per event; the Voice number is global. Require a public HTTPS `BASE_URL` and derive `wss://<host>/voice/ws` from it.
- Match the normalized call `From` number to the latest unexpired eligible selfie in the active event. Do not add a pairing code. Treat caller ID as a convenience key, never as strong identity proof; reveal no selfie-specific details on the call and send results only to the original message conversation.
- Use the 30-minute invitation expiry, one active call per phone and event, and a durable `MessageSid` intake key. A crash after Twilio accepts an invitation may cause a second invitation, but never a second job group.
- Enable Conversation Relay speech interruptions for the greeting and subsequent turns with `interruptSensitivity="medium"` and `reportInputDuringAgentSpeech="speech"`. An interrupted readback is not confirmation.
- Subscribe to Conversation Relay playback events. Sending a final text token is not proof that the caller heard the readback; accept confirmation only after its full playback is reported, and invalidate that eligibility on an interrupt or early caller speech.
- Support English and Brazilian Portuguese. If `languageMode="ask"` has no stored locale, send a bilingual invitation immediately, ask for language on the call, and persist the chosen locale into every queued job.
- For an unknown locale, explicitly configure Conversation Relay's `multi` STT/TTS with Deepgram transcription and ElevenLabs TTS; after the caller chooses, switch to `en-US` or `pt-BR`. Twilio onboarding must make that provider combination available.
- Reject invalid media and group selfies before the invitation. For Voice, service errors during moderation, face detection, scene analysis, or policy checks fail closed with a retryable explanation; existing menu mode keeps its current behavior.
- Queue only a server-approved structured brief after an explicit confirmation. Do not log raw transcripts, personal phone numbers, or the full Voice image prompt in routine logs.
- Charge quota once per Voice group, including when usage is rebuilt from job files after a restart. Apply the selfie-time snapshot of review, printing, branding, composition, and subject rules to every Voice variant; later operator setting changes must not silently alter an accepted request.
- Deliver the Voice result digitally after generation and any required review, regardless of print timing; printing may continue independently. A lead survey or NPS message never delays delivery.
- Persist Voice delivery attempts and retry state across ready/done queue transitions and restarts. A send failure never clears the pending state or sets `smsSentAt`; a crash after Twilio accepts a send but before its SID is saved can still produce a duplicate message on retry.
- Outside WhatsApp's freeform window, use approved result and failure Content Templates for the selected locale. Never fall back to freeform text or mark an unsent portrait as delivered.
- Use the selfie's original `To` sender for the invitation, result, and failure notice. If a Messaging Service is configured, supply both its SID and that `From` sender; an unregistered sender failure stays retryable rather than sending from a different conversation.
- Reject `enableVoice=true` with `leadCaptureMode="before"` at the settings API as well as the UI. External Twilio number routing, Conversation Relay onboarding, and WhatsApp template approval are operator setup steps, not automatic mutations.

## Review Focus

1. Missing, malformed, oversized, or non-image `MediaUrl0` must produce one useful reply and no call invitation; test this in Task 3.
2. Duplicate webhook, two simultaneous calls, and a newer selfie during an active call must bind a call to exactly one request and enqueue at most once; test this in Tasks 2, 4, and 8.
3. A caller who interrupts the agent's brief readback or speaks while an LLM response is still arriving must not trigger submission or play stale speech; test this in Tasks 6 and 7.
4. A WhatsApp request delayed past 24 hours by manual review must use approved templates for success or failure and retain a retryable send state if Twilio fails; test this in Task 5.
5. Restart between copying review variants, publishing queue files, and marking the request queued must reconcile the same group without a missing input or second quota charge; test this in Task 4.
6. Restart after a call claim but before WebSocket setup, or after a failed Voice delivery, must release or retry the durable state without submitting another portrait; test this in Tasks 5 and 7.

## File Map and Interfaces

| File | Responsibility |
| --- | --- |
| `lib/voice/readiness.js` | Pure configuration checks; `readinessIssues(config, baseUrl): string[]`. |
| `lib/voice/store.js` | Durable request records and phone claim lock; `createVoiceStore({dir, now})` exposing `record`, `get`, `patch`, `claimLatest`, `release`, `findLatest`, `list`, and `expire`. |
| `lib/voice/preflight.js` | Strict media validation, photo analysis, invitation, and recovery; `createVoiceIntake(deps)` exposing `acceptSelfie` and `recover`. |
| `lib/voice/submit.js` | Approved brief handoff; `submitVoiceEdit({store, requestId, brief, locale, queue})`. |
| `lib/voice/policy.js` | Bounded brief schema, moderation, and server approval; `validateVoiceBrief(brief, request, deps)`. |
| `lib/voice/agent.js` | Natural conversation, readback, confirmation, and locale state; `createVoiceAgent(deps)` exposing `onPrompt`, `onInterrupt`, and `onClose`. |
| `lib/voice/delivery.js` | Original-channel result/failure sends with no dependency on queue or pipeline; `sendVoiceDelivery(job)` and `sendVoiceFailure(job, reason)`. |
| `lib/voice/transport.js` | Signed Voice webhook, TwiML, signed WebSocket upgrade, Conversation Relay messages; `mountVoiceHttp(app, deps)` and `attachVoiceSocket(server, deps)`. |
| `lib/settings.js`, `lib/home.js`, `lib/dashboard.js`, `lib/i18n.js` | Per-event switch, global number, readiness display, localized copy. |
| `index.js`, `lib/auth.js`, `lib/voice/inbound-route.js` | Voice selfie intake before in-memory SID/language-menu routing, `MENU` fallback, transport mounting and worker recovery. |
| `lib/queue.js`, `lib/pipeline.js`, `lib/prompt-builder.js` | Deterministic queue groups, staged input copies, neutral image prompt, and delivery-first behavior. |
| `lib/messaging.js`, `scripts/create-content-templates.js` | Approved Voice result and failure templates and original-channel delivery. |

`VoiceBrief` has six required strings: `{ visualStyle, clothingOrSubject, setting, mood, importantDetails, preserve }`. Each string is at most 500 characters; all-empty briefs are rejected. `VoiceRequest` stores the original `messageSid`, E.164 `phone`, `channel`, `appPhone`, `eventName`, `eventSettings` snapshot, `imageUrl`, `stagedInputPath`, `locale`, `receivedAt`, `expiresAt`, `status`, `callSid`, `claimedAt`, `lastSocketAt`, `brief`, `policyOutcome`, and `groupId`. Its disk filename is a SHA-256 digest of `messageSid`, with no phone number in the filename. `eventSettings` captures review mode, variant count, output profile, printing choice, branding, prompt preservation and composition rules, and the multi-subject rule at selfie intake.

### Task 1: Operator settings and readiness

**Files:** Modify `lib/settings.js`, `lib/home.js`, `lib/dashboard.js`; create `lib/voice/readiness.js`, `test/voice-readiness.test.js`.

**Interfaces:** Produces `readinessIssues(config, baseUrl)` for the settings API and UI. Settings keys are `enableVoice` (per event, Boolean, default `false`) and `twilioVoiceNumber` (global E.164 string, default `process.env.TWILIO_VOICE_NUMBER || ""`).

- [ ] **Step 1: Write failing tests.** Assert a valid setup has no issues, a missing Voice number or non-HTTPS base URL is rejected, a before-survey conflicts, and each enabled WhatsApp locale requires `voiceDelivery` and `voiceFailure` Content SIDs.

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readinessIssues } = require("../lib/voice/readiness");
const ready = { twilioVoiceNumber: "+14155550100", twilioAccountSid: "ACtest", twilioAuthToken: "token", openaiApiKey: "key", leadCaptureMode: "disabled", twilioWhatsappNumber: "", contentTemplates: { en: {}, pt_BR: {} } };
test("Voice readiness rejects missing number and incompatible lead mode", () => {
  assert.deepEqual(readinessIssues(ready, "https://booth.example"), []);
  assert.match(readinessIssues({ ...ready, twilioVoiceNumber: "" }, "https://booth.example").join(" "), /Voice number/);
  assert.match(readinessIssues({ ...ready, leadCaptureMode: "before" }, "https://booth.example").join(" "), /lead capture/);
});
```

- [ ] **Step 2: Run** `node --test test/voice-readiness.test.js`; expect `MODULE_NOT_FOUND` for the new module.
- [ ] **Step 3: Implement the pure check, settings validation, and UI fields.** In `settings.update`, compute the prospective settings before saving and reject a Voice-on configuration with a nonempty issue list. In the dashboard settings POST, return `400` with the reasons. The UI shows a Voice switch, global number field, readiness reasons, and an operator test-call note; saving persists both keys.

```js
function readinessIssues(cfg, baseUrl) {
  const issues = [];
  if (!/^\+[1-9]\d{7,14}$/.test(cfg.twilioVoiceNumber || "")) issues.push("Voice number must be E.164");
  if (!/^https:\/\//.test(baseUrl || "")) issues.push("Public HTTPS BASE_URL is required");
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken || !cfg.openaiApiKey) issues.push("Twilio and OpenAI credentials are required");
  if (cfg.leadCaptureMode === "before") issues.push("Voice cannot run with before lead capture");
  if (cfg.twilioWhatsappNumber || cfg.twilioWhatsappMessagingServiceSid) {
    for (const locale of ["en", "pt_BR"]) for (const key of ["voiceDelivery", "voiceFailure"])
      if (!cfg.contentTemplates?.[locale]?.[key]) issues.push(`${locale} ${key} WhatsApp template is required`);
  }
  return issues;
}
module.exports = { readinessIssues };
```

- [ ] **Step 4: Run** `node --test test/voice-readiness.test.js test/settings-combo-validation.test.js test/ui-localization.test.js`; expect all pass, including a settings-API `400` for Voice plus before-survey.
- [ ] **Step 5: Commit** the five files with `git commit -m "feat: add voice settings and readiness"`.

### Task 2: Durable selfie request store and call claims

**Files:** Create `lib/voice/store.js`, `test/voice-store.test.js`.

**Interfaces:** Produces the `createVoiceStore` methods in the file map. `record(payload)` is idempotent by `messageSid`; `claimLatest({phone,eventName,callSid})` returns a claimed request or `null` and persists `claimedAt`; `touchCall(callSid)` persists a bounded `lastSocketAt` heartbeat; `release(callSid)` restores an unqueued claim only if unexpired and not superseded. `reconcileClaims(activeCallSids, now)` releases orphaned claims after a two-minute no-socket lease, and never releases a queued request.

- [ ] **Step 1: Write failing tests** for duplicate SID records, latest eligible SMS/WhatsApp selection by normalized phone, a second call during an active claim even when a newer selfie exists, supersession by a newer selfie after release, event switch, expiry, private staged-file cleanup, and reload from disk. Cover a crash immediately after `claimLatest` but before WebSocket setup: the lease retains the claim briefly, then releases it after two minutes if no live socket remains.

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createVoiceStore } = require("../lib/voice/store");
test("a second call cannot claim the same pending selfie", async (t) => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "voice-store-"));
  t.after(() => require("node:fs").rmSync(dir, { recursive: true, force: true }));
  const store = createVoiceStore({ dir, now: () => 1000 });
  const first = await store.record({ messageSid: "SM1", phone: "+14155550100", eventName: "Expo", channel: "sms", receivedAt: 1000 });
  await store.patch(first.id, { status: "awaiting_call", expiresAt: 1000 + 1800000 });
  assert.equal((await store.claimLatest({ phone: "+14155550100", eventName: "Expo", callSid: "CA1" })).id, first.id);
  assert.equal(await store.claimLatest({ phone: "+14155550100", eventName: "Expo", callSid: "CA2" }), null);
});
```

- [ ] **Step 2: Run** `node --test test/voice-store.test.js`; expect `MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement atomic records and serialized per-phone claims.** Use `atomicWriteFile` in `data/voice-requests/`, hash `messageSid` for the filename, and serialize both duplicate-SID creation and phone claims in-process so a late duplicate write cannot revert progress. Reject state changes that would unqueue a submitted request. Store `receivedAt` separately from invitation `expiresAt`; filter claims by active event, `awaiting_call`, and expiry. Persist claim and socket timestamps, and reconcile only claims without a live socket after the lease; a signed `/voice/action` callback or normal socket close releases immediately. Expiry and supersession delete only staged paths that resolve inside `data/voice-media/`, never a caller-supplied path.

```js
const idForSid = (sid) => require("node:crypto").createHash("sha256").update(sid).digest("hex");
async function record(payload) {
  const id = idForSid(payload.messageSid);
  const existing = await get(id);
  if (existing) return existing;
  const request = { ...payload, id, status: "received", receivedAt: payload.receivedAt || now() };
  await atomicWriteFile(path.join(dir, `${id}.json`), JSON.stringify(request));
  return request;
}
```

- [ ] **Step 4: Run** `node --test test/voice-store.test.js`; expect all cases pass and temp request files contain no phone number in their names.
- [ ] **Step 5: Commit** with `git commit -m "feat: persist voice selfie requests and claims"`.

### Task 3: Strict photo preflight and invitation

**Files:** Create `lib/voice/preflight.js`, `test/voice-preflight.test.js`; modify `lib/helpers.js`, `lib/i18n.js`, `lib/messaging.js`.

**Interfaces:** Produces `createVoiceIntake({store, downloadImage, assessImage, send, settings, now})` with `acceptSelfie(payload)` and `recover()`. The payload includes `MediaUrl0`, `MediaContentType0`, and a snapshot of event settings. `acceptSelfie` persists `received` before a webhook can acknowledge; `recover` progresses unprocessed requests through preflight and invitation. `assessImage` returns `{flagged, hasFace, scene}` or throws on uncertain service results.

- [ ] **Step 1: Write failing tests** for JPEG/PNG acceptance, invalid or oversized input, moderation/face/scene API error, `multiSubjectMode="reject"`, active event switch, bilingual invitation when locale unknown, duplicate webhook, invitation send failure, and crash recovery. Pass an actual PNG through preflight and queue staging, then verify that the pipeline receives valid JPEG bytes when it declares `image/jpeg`. A `received` record that could not finish preflight for 30 minutes must not send a stale invitation; after the WhatsApp window closes, its failure notice must use the approved `voiceFailure` template. Use injected `downloadImage`, `assessImage`, and `send` functions; assert no invitation on invalid photos and one localized rejection notice.

```js
test("group selfie receives a rejection before any invitation", async () => {
  const sent = [];
  const intake = createVoiceIntake({ store, downloadImage, assessImage: async () => ({ flagged: false, hasFace: true, scene: { subjects: 2 } }), send: async (...args) => { sent.push(args); return { sid: "SMout" }; }, settings, now });
  await intake.acceptSelfie(selfie);
  await intake.recover();
  assert.equal(sent.length, 1);
  assert.match(sent[0][3]._body, /group|grupo/i);
});
```

- [ ] **Step 2: Run** `node --test test/voice-preflight.test.js`; expect missing module or failing assertions.
- [ ] **Step 3: Add strict options to the existing image helpers without changing menu defaults.** `moderateImage(base64, {strict:true})`, `detectPerson(base64, {strict:true})`, and `analyzeScene(base64, {strict:true})` rethrow service errors; the current no-options behavior remains unchanged. Preflight downloads once, checks file size and Sharp metadata, normalizes accepted JPEG/PNG pixels to JPEG with Sharp, and atomically stores the actual JPEG in `data/voice-media/<request-id>.jpg` before running the strict checks. It stores the scene and sends an invitation on the original adapter with `fromPhone: request.appPhone` so the invitation appears in the same conversation. Abandon uninvited requests 30 minutes after `receivedAt`; a WhatsApp failure outside its freeform window uses `voiceFailure` with its approved SID. Add `fromPhone` to `messaging.send`: validate normalized E.164, format it for the adapter, and include it beside the configured Messaging Service SID when present.

```js
async function assessImageStrict(base64) {
  const [moderation, hasFace, description] = await Promise.all([
    moderateImage(base64, { strict: true }),
    detectPerson(base64, { strict: true }),
    analyzeScene(base64, { strict: true }),
  ]);
  if (!/^Subjects:\s*\d+/im.test(description)) throw new Error("scene analysis unavailable");
  return { flagged: moderation.flagged, hasFace, scene: parseScene(description) };
}
// In messaging.send, after adapter.senderId() has supplied service settings:
if (opts.fromPhone) {
  if (!/^\+[1-9]\d{7,14}$/.test(opts.fromPhone)) throw new Error("Invalid original sender");
  senderFields.from = adapter.formatTo(opts.fromPhone);
}
```

- [ ] **Step 4: Run** `node --test test/voice-preflight.test.js test/inbound-payload.test.js test/i18n.test.js test/messaging-send.test.js`; expect pass. Re-run the strict service-error test after reloading the module to prove the error is not silently allowed.
- [ ] **Step 5: Commit** with `git commit -m "feat: preflight voice selfies and invite callers"`.

### Task 4: Idempotent queue group and neutral Voice prompt

**Files:** Create `lib/voice/submit.js`, `test/voice-submit.test.js`, `test/voice-prompt.test.js`; modify `lib/queue.js`, `lib/pipeline.js`, `lib/prompt-builder.js`.

**Interfaces:** Produces `queue.enqueueVoiceGroup({request, brief, locale, groupId})`, `queue.getVoiceGroup(groupId)`, and `submitVoiceEdit({store, requestId, brief, locale, queue})`. The queue group manifest lives in `queue/voice-groups/<groupId>.json`; pending Voice jobs have `inputMode:"voice"`, `voiceGroupId`, and `voiceBrief`. The group ID begins with the request's stable `formatTimestamp(receivedAt)` so lexical queue order stays chronological, followed by `_voice_` and the request digest. The generation worker filters out Voice jobs until the manifest says `committed`, before choosing work slots.

- [ ] **Step 1: Write failing tests** for one- and three-variant groups. Create a private staged selfie in a temporary directory; assert each variant has its own `jobPaths(job, {staged:true}).inputPath` copy before the manifest is committed, a retry returns the same prefixes, quota changes once both before and after `buildUsageCache()` rebuilds from disk, and an interrupted partial group is completed on recovery. Assert submission refuses an unapproved brief, exhausted quota, stale event, or already superseded request. Test that Voice prompt assembly includes the approved brief, source-person preservation, subject count, and event branding but no selected menu style or raw transcript. Change review, brand, composition, and print settings after intake and prove the Voice variants still use their saved rules.

```js
test("repeating submission reuses one committed group", async () => {
  const { formatTimestamp } = require("../lib/config");
  const groupId = `${formatTimestamp(request.receivedAt)}_voice_${request.id.slice(0, 16)}`;
  const first = await queue.enqueueVoiceGroup({ request, brief, locale: "pt_BR", groupId });
  const second = await queue.enqueueVoiceGroup({ request, brief, locale: "pt_BR", groupId });
  assert.deepEqual(second.filePrefixes, first.filePrefixes);
  assert.equal(usageCount(), 1);
  assert.equal(first.jobs.every((job) => require("node:fs").existsSync(jobPaths(job, { staged: true }).inputPath)), true);
});
```

- [ ] **Step 2: Run** `node --test test/voice-submit.test.js test/voice-prompt.test.js`; expect missing exports or failed assertions.
- [ ] **Step 3: Implement deterministic prefixes, per-variant copies, manifest commit, and prompt branch.** `submitVoiceEdit` locks the request and rechecks active event, expiry, quota, status, approved policy outcome, and locale. Derive `groupId` from stable `receivedAt` plus request ID, and take variant count, output profile, review mode, printing choice, branding, prompt rules, and subject rule from the request's settings snapshot. Copy those values into every job rather than rereading mutable event settings in queue or pipeline Voice branches. Write copies through a temporary filename and rename, publish all job JSON files, then atomically set the group manifest to `committed`. The worker filters uncommitted Voice jobs before taking queue slots. On restart, replay a `submitting` request with the same prefixes and finish missing files. Extend `buildUsageCache` to count one committed `voiceGroupId` once across all queue directories, while preserving legacy job accounting and usage overrides. In `generateImage`, keep the default style key only for legacy print metadata, skip menu style/background references for Voice, and build its prompt from approved fields plus the saved preservation and event rules. Suppress full-prompt logging for Voice jobs.

```js
const groupId = `${formatTimestamp(request.receivedAt)}_voice_${request.id.slice(0, 16)}`;
const prefixes = Array.from({ length: variantCount }, (_, index) =>
  variantCount === 1 ? groupId : `${groupId}-v${index + 1}`);
for (const prefix of prefixes) {
  const destination = jobPaths({ eventName: request.eventName, filePrefix: prefix }, { staged: true }).inputPath;
  await fsp.copyFile(request.stagedInputPath, `${destination}.copying`);
  await fsp.rename(`${destination}.copying`, destination);
}
```

```js
function buildVoice({ brief, scene, preserve, composition, brandPrompt, backgroundLine }) {
  return [
    "Edit the supplied selfie into the attendee's requested portrait. Keep the same real people recognizable.",
    preserve,
    `Requested look: ${brief.visualStyle}; subject or clothing: ${brief.clothingOrSubject}; setting: ${brief.setting}; mood: ${brief.mood}; details: ${brief.importantDetails}.`,
    `Preserve: ${brief.preserve}. Exactly ${scene.subjects} human subject(s); do not invent additional people.`,
    brandPrompt && `Event branding: ${brandPrompt}`,
    backgroundLine,
    composition,
  ].filter(Boolean).join("\n");
}
```

- [ ] **Step 4: Run** `node --test test/voice-submit.test.js test/voice-prompt.test.js test/prompt-builder-parity.test.js test/variant-overrides.test.js`; expect pass, including quota after cache rebuild and unchanged Voice review/prompt rules after an operator setting change. Also run `node --test test/queue-poll-activity.test.js` to verify an uncommitted Voice group remains unclaimed.
- [ ] **Step 5: Commit** with `git commit -m "feat: submit approved voice edits to portrait queue"`.

### Task 5: Digital-first delivery and WhatsApp templates

**Files:** Create `lib/voice/delivery.js`, `test/voice-delivery.test.js`; modify `lib/queue.js`, `lib/pipeline.js`, `lib/i18n.js`, `lib/settings.js`, `lib/dashboard.js`, `lib/home.js`, `scripts/create-content-templates.js`.

**Interfaces:** Produces `sendVoiceDelivery(job)` and `sendVoiceFailure(job, reason)` in `lib/voice/delivery.js`. Both use `job.channel`, `job.locale`, `job.appPhone`, and `job.baseUrl`; neither imports queue or pipeline, so both callers can use them without a module cycle. `voiceDelivery` is an approved media card template; `voiceFailure` is an approved text template. The template-creation script submits both as WhatsApp utility templates in `en` and `pt_BR` and saves only approved SIDs.

- [ ] **Step 1: Write failing tests** for Voice delivery with `enablePrinting=true` and `immediateDigitalDelivery=false`, an approved review result, a WhatsApp contact whose last message was more than 24 hours ago, missing or failed Content SID, failure after long review, and `leadCaptureMode="after"`. Assert the media is sent before a survey, a print-only message is never sent, an out-of-window `_raw` fallback is never attempted, and the original sender appears in the Twilio payload even when a Messaging Service SID is configured. Inject send failures in both ready/printing and digital-only done paths; reload queue state and run recovery, then assert the pending marker survives, one retry is scheduled, and `smsSentAt` appears only after Twilio returns a SID. Cover both result and terminal-failure notices.

```js
test("late WhatsApp Voice result uses its approved template", async () => {
  const result = await sendVoiceDelivery({ ...job, channel: "whatsapp", locale: "pt_BR", inputMode: "voice" });
  assert.equal(result.sid, "SMdelivered");
  assert.equal(sent[0].templateKey, "voiceDelivery");
  assert.equal(sent[0].opts.allowOutOfSession, true);
  assert.equal(sent.some((entry) => entry.templateKey === "_raw"), false);
});
```

- [ ] **Step 2: Run** `node --test test/voice-delivery.test.js`; expect missing exports or failed assertions.
- [ ] **Step 3: Add dedicated result/failure templates and Voice delivery branches.** For WhatsApp, require `settings.getContentSid(key, job.locale)` before calling `messaging.send(..., {allowOutOfSession:true, fromPhone:job.appPhone})`; for SMS/MMS, use `_raw` with media URL and `fromPhone`. Reuse Task 3's `fromPhone` support so a Messaging Service may send from the original sender in its pool. Give Voice jobs durable `voiceDeliveryState` (`pending`, `sending`, `sent`), `voiceDeliveryPendingAt`, attempt count, last error code, and accepted message SID. Mark pending before crossing into ready/done, claim a bounded sending lease to prevent concurrent retries, and save the SID before marking sent. In Voice branches of `recoverStaleJobs`, both immediate-send catches, and both digital-only catches, retain pending state on failure instead of clearing `digitalDeliveryPendingAt` or silently logging. Sweep ready and done jobs at startup and on a bounded timer with capped backoff; expose a protected dashboard retry action for a failed send that calls the same sender. Do not let a print transition or after-survey consume the pending state. A crash after Twilio accepted a send but before its SID was saved may cause a duplicate on retry, so log and expose the uncertain attempt for the operator. Route every terminal Voice failure path in queue, manual/AI review, and pipeline `notify` through `sendVoiceFailure` with the same durable retry treatment. Send the result before starting an after-delivery lead survey or NPS.

```js
async function sendVoiceChannelMessage(job, key, vars, smsBody, mediaUrl) {
  const adapter = channels.ADAPTERS[job.channel];
  if (adapter.name === "whatsapp") {
    const contentSid = settings.getContentSid(key, job.locale);
    if (!contentSid) throw new Error(`Missing approved ${key} template for ${job.locale}`);
    const result = await messaging.send(job.userPhone, key, vars, { adapter, locale: job.locale, contentSid, allowOutOfSession: true, fromPhone: job.appPhone });
    if (result.error || result.skipped) throw new Error(result.error || result.skipped);
    return result;
  }
  const result = await messaging.send(job.userPhone, "_raw", {}, { adapter, _body: smsBody, mediaUrl, fromPhone: job.appPhone });
  if (result.error || result.skipped) throw new Error(result.error || result.skipped);
  return result;
}
```

- [ ] **Step 4: Run** `node --test test/voice-delivery.test.js test/delivery-media.test.js test/content-templates.test.js test/leads-session.test.js test/nps-locale.test.js`; expect pass, including retry after a process restart in ready and done. Search every Voice terminal send site to confirm no `_raw` WhatsApp escape path.
- [ ] **Step 5: Commit** with `git commit -m "feat: deliver voice portraits before print and surveys"`.

### Task 6: Dynamic agent turns, policy gate, and explicit confirmation

**Files:** Create `lib/voice/agent.js`, `lib/voice/policy.js`, `test/voice-agent.test.js`, `test/voice-policy.test.js`.

**Interfaces:** Produces `createVoiceAgent({respond, moderate, submit, store})` with `onPrompt(session, text)`, `onInterrupt(session, utteranceUntilInterrupt)`, and `onClose(session)`. `respond` uses OpenAI Responses `text.format` with a strict JSON schema for `{speech, readyToConfirm, brief}`; `brief` has the six `VoiceBrief` strings. `validateVoiceBrief` checks schema/length, source preflight status, event subject rule, text moderation, and model limitations before readback or submission, then persists a bounded `policyOutcome` on the request.

- [ ] **Step 1: Write failing tests** for a freeform request that combines outfit, setting, and art style; a clarifying follow-up; prompt-injection text; a disallowed edit; moderation service failure; an ambiguous “okay”; explicit English and Portuguese confirmation; a caller revision after readback; and an interruption during readback. An early “yes” while readback is still playing, including one delivered without an `interrupt` event, cannot call `submit`; only an explicit confirmation after playback completion of a server-approved brief may submit.

```js
test("an interrupted readback does not submit", async () => {
  const session = { phase: "awaiting_confirmation", spoken: "I will make your photo", brief };
  agent.onInterrupt(session, "I will make");
  await agent.onPrompt(session, "Actually, make the background snowy");
  assert.equal(submissions.length, 0);
  assert.equal(session.phase, "collecting");
});
```

- [ ] **Step 2: Run** `node --test test/voice-agent.test.js test/voice-policy.test.js`; expect missing modules.
- [ ] **Step 3: Implement a bounded state machine and strict structured output.** Keep at most 16 recent caller/agent turns in memory and place caller speech only in user-role input. An unknown-locale call first accepts an English or Portuguese choice, persists it to the request, and asks the localized photo-look question with examples. `collecting` accepts any visual request and asks concise questions. When the model marks a complete brief, the server moderates and validates it before constructing a deterministic readback. Track a readback generation ID and separate `reading_back` from `awaiting_confirmation`; only a Conversation Relay playback event proving the final readback token played can move to `awaiting_confirmation`. Sending `last:true` does not make it eligible. Early caller speech or an interruption invalidates that generation, and any modification routes back to `collecting`. After full playback, `awaiting_confirmation` accepts only explicit affirmative forms (`yes, do it`, `yes`, `sim`, `pode fazer`). If playback completion cannot be established, repeat or clarify; never submit on an inferred timeout. After `submitVoiceEdit` reports a committed queue group, speak “I've got your request and started your portrait. You can hang up now; I'll send it in the same chat when it's ready,” localized to the selected language. A rejected brief gets a localized explanation and another chance. A service error produces a retryable response, never approval. Do not persist raw transcripts.

```js
const BRIEF_PROPERTIES = Object.fromEntries(
  ["visualStyle", "clothingOrSubject", "setting", "mood", "importantDetails", "preserve"]
    .map((key) => [key, { type: "string" }]));
const TURN_SCHEMA = {
  type: "object",
  properties: {
    speech: { type: "string" },
    readyToConfirm: { type: "boolean" },
    brief: { type: "object", properties: BRIEF_PROPERTIES, required: Object.keys(BRIEF_PROPERTIES), additionalProperties: false },
  },
  required: ["speech", "readyToConfirm", "brief"],
  additionalProperties: false,
};
const response = await getOpenAI().responses.create({
  model: getModels().orchestrator,
  input: [{ role: "system", content: rules }, ...history.slice(-16), { role: "user", content: callerText }],
  text: { format: { type: "json_schema", name: "voice_turn", strict: true, schema: TURN_SCHEMA } },
});
const turn = JSON.parse(response.output_text);
if (turn.readyToConfirm) await validateVoiceBrief(turn.brief, request, { moderate });
```

- [ ] **Step 4: Run** `node --test test/voice-agent.test.js test/voice-policy.test.js`; expect all pass. Verify a rejected or interrupted brief cannot call `submit` even after an LLM response arrives late.
- [ ] **Step 5: Commit** with `git commit -m "feat: converse about voice edits with policy approval"`.

### Task 7: Signed Conversation Relay transport and interruption handling

**Files:** Create `lib/voice/transport.js`, `test/voice-transport.test.js`; modify `lib/auth.js`, `package.json`, `pnpm-lock.yaml`.

**Interfaces:** Produces `mountVoiceHttp(app, {store, settings, agent})` and `attachVoiceSocket(server, {store, settings, agent})`. HTTP `POST /voice/inbound` accepts only a valid Twilio signature and returns TwiML; signed `POST /voice/action` releases an unsubmitted claim by its `CallSid`. WebSocket upgrades only on `/voice/ws` with a valid `X-Twilio-Signature` for the public `wss://` URL. The TwiML `<Parameter name="requestId">` carries only the opaque request ID.

- [ ] **Step 1: Write failing protocol tests** for signed/unsigned HTTP calls, unmatched caller, matching caller, a recent queued caller who hears only generic progress, setup `accountSid`/`callSid`/`from`/`to` mismatches, greeting and reply interruptions, stale LLM output after an interrupt, language switch, and disconnect/retry. Assert TwiML includes `welcomeGreetingInterruptible="speech"`, `interruptible="speech"`, `interruptSensitivity="medium"`, `reportInputDuringAgentSpeech="speech"`, and `events="speaker-events tokens-played"`. Simulate token playback and an early affirmative prompt with and without an interrupt; submission remains blocked until the final readback token is reported played. Test a signed action callback and a restart after claim but before setup, then verify a later call can reclaim the unsubmitted selfie. A matched call's opening explicitly asks how their photo should look and gives examples, but never speaks image-specific details before submission; already invited calls still work when the setting is turned off.

```js
test("matching call gets an interruptible Conversation Relay session", async () => {
  const xml = await invokeVoiceWebhook({ From: "+14155550100", To: "+14155550101", CallSid: "CA1", AccountSid: "ACtest" });
  assert.match(xml, /<ConversationRelay[^>]*interruptible="speech"/);
  assert.match(xml, /interruptSensitivity="medium"/);
  assert.match(xml, /<Parameter name="requestId" value="[a-f0-9]+"/);
});
```

- [ ] **Step 2: Run** `node --test test/voice-transport.test.js`; expect missing module/dependency.
- [ ] **Step 3: Add direct `ws@8.21.0` dependency, signed TwiML route, and signed upgrade handler.** Use `createTwilioWebhookValidator` for HTTP, `twilio.validateRequest(authToken, signature, publicWsUrl, {})` for upgrade, and reject every setup message whose account/call/from/to/request ID differs from the claimed record. The signed `/voice/action` callback and socket close release only that call's unsubmitted claim; startup recovery invokes `store.reconcileClaims` for claims with no live socket after the two-minute lease. The TwiML greeting asks for language first only when unknown; otherwise it uses the localized photo-look opening. Set unknown-language sessions to `multi` with explicit Deepgram STT and ElevenLabs TTS; set known sessions to `en-US` or `pt-BR`. Subscribe to `speaker-events tokens-played`; map playback reports to the current readback generation and accept a confirmation prompt only after the final token is reported played. Treat absent or stale playback reports as unconfirmed. Send short `text` chunks with `last:true` on the last chunk. An `interrupt` increments a turn generation counter, drops late chunks, and passes `utteranceUntilInterrupt` to the agent before the next caller prompt. A `language` message changes both TTS and transcription language when the caller chooses one.

```js
const response = new (require("twilio").twiml.VoiceResponse)();
const relay = response.connect({ action: `${baseUrl}/voice/action` }).conversationRelay({
  url: `${baseUrl.replace(/^https:/, "wss:")}/voice/ws`,
  welcomeGreeting: greeting,
  welcomeGreetingInterruptible: "speech",
  interruptible: "speech",
  interruptSensitivity: "medium",
  reportInputDuringAgentSpeech: "speech",
  events: "speaker-events tokens-played",
  language: request.locale === "pt_BR" ? "pt-BR" : request.locale === "en" ? "en-US" : "multi",
  ttsProvider: "ElevenLabs",
  transcriptionProvider: "Deepgram",
});
relay.parameter({ name: "requestId", value: request.id });
res.type("text/xml").send(response.toString());
```

- [ ] **Step 4: Run** `node --test test/voice-transport.test.js test/twilio-webhook.test.js test/auth-pin.test.js`; expect pass. Verify an unauthenticated WebSocket upgrade closes before the agent sees any event.
- [ ] **Step 5: Commit** with `git commit -m "feat: connect signed voice calls to conversation relay"`.

### Task 8: Route attendee selfies and provide `MENU` fallback

**Files:** Modify `index.js`, `lib/queue.js`, `lib/auth.js`; create `lib/voice/inbound-route.js`, `test/voice-inbound.test.js`.

**Interfaces:** Produces `routeVoiceInbound({body, eventName, sender, adapter, locale, store, intake, quota})` with `{handled:boolean, status:number}`. `index.js` invokes it for an enabled event before `markSid` and before the message language-picker branch. Existing non-Voice traffic follows the current menu flow. `MENU` while a call holds the selfie claim gets a localized “finish or end your call, then send MENU” response and leaves the claim untouched. After the call ends, `MENU` atomically marks the unqueued request `menu_fallback` and passes its server-derived `stagedInputPath` through pending menu context as `sourceImagePath`.

- [ ] **Step 1: Write failing tests** for SMS and WhatsApp selfies, duplicate `MessageSid`, `languageMode="ask"` with no locale, one versus multiple media, quota exceeded, latest selfie supersession, event switch, `MENU` before call, `MENU` while call active, `MENU` after a released call, and a menu job that still works after the Twilio media URL has expired. Assert the active-call reply leaves the claim and queue unchanged, and the menu queue copies `sourceImagePath` into every job variant before publishing a job file.

```js
test("Voice selfie bypasses the language and style menus", async () => {
  const result = await routeVoiceInbound({ body: { From: "whatsapp:+14155550100", NumMedia: "1", MessageSid: "SM1", MediaUrl0: "https://api.twilio.com/photo" }, eventName: "Expo", sender: "+14155550100", adapter: whatsapp, locale: null, store, intake, quota });
  assert.deepEqual(result, { handled: true, status: 204 });
  assert.equal(intakeCalls.length, 1);
  assert.equal(menuCalls.length, 0);
});
```

- [ ] **Step 2: Run** `node --test test/voice-inbound.test.js`; expect missing route module.
- [ ] **Step 3: Move the Voice decision ahead of in-memory deduplication and language selection.** Compute sender, event, and preferred locale before the Voice branch; pass `MediaUrl0` and `MediaContentType0` to intake and keep the existing quota/admin rules, sender/channel recording, and non-Voice logic. `acceptSelfie` records before returning `204`; the recovery worker sends the invitation later. Recognize `MENU` for any unexpired pending Voice request even if the operator has since disabled Voice. Under the same store lock used by `claimLatest` and `submitVoiceEdit`, reject `MENU` while a call is claimed and transition an unclaimed request to `menu_fallback` before displaying menus; the call agent must refuse a request that entered fallback. Carry `sourceImagePath` in `resolvePendingContext`, `styleMenu`, `brandMenu`, and `backgroundMenu` contexts. In legacy `enqueueJob`, if `extras.sourceImagePath` exists, copy it to every new job's staged input path before writing that job JSON; after a successful enqueue, mark the Voice request superseded and let normal retention remove its original staging file. Mount `mountVoiceHttp` and `attachVoiceSocket` on the existing server; run intake recovery, claim reconciliation, delivery retries, and expiry sweeps at startup and on a bounded timer.

```js
const wantsVoiceMenuFallback = String(body || "").trim().toUpperCase() === "MENU";
if (wantsVoiceMenuFallback || (settings.getForEvent("enableVoice", eventName) && numMedia === 1)) {
  const routed = await routeVoiceInbound({ body: req.body, eventName, sender: userPhone, adapter: inboundAdapter, locale, store: voiceStore, intake: voiceIntake, quota: { used: getUsageCount(userPhone), max: settings.get("maxPrints") } });
  if (routed.handled) return res.status(routed.status).end();
}
if (markSid(req.body.MessageSid)) return res.status(204).end();
```

- [ ] **Step 4: Run** `node --test test/voice-inbound.test.js test/language-menu.test.js test/menu-routing.test.js test/channels-whatsapp.test.js`; expect pass. Then run a mock HTTP inbound request and verify no Voice selfie receives a style/brand/background menu.
- [ ] **Step 5: Commit** with `git commit -m "feat: route new selfies into voice or menu fallback"`.

### Task 9: Recovery, full integration, and operator setup guide

**Files:** Create `test/voice-flow.test.js`; modify `README.md`. If an integration assertion fails, make the correction in its owning file from Tasks 1–8: `lib/voice/store.js`, `lib/voice/preflight.js`, `lib/voice/submit.js`, `lib/voice/agent.js`, `lib/voice/transport.js`, `lib/voice/delivery.js`, `lib/queue.js`, `lib/pipeline.js`, or `index.js`.

**Interfaces:** The full path is inbound selfie → durable preflight → invitation → signed call/setup → freeform edit and interruption → approved confirmation → one queue group → generation/review → original-channel result or failure. All service calls use test doubles; this task does not place a real call or send a real message.

- [ ] **Step 1: Write failing integration tests** that run the flow through both channel adapters and simulated Conversation Relay events. Cover a restart after `received`, after Twilio invitation acceptance, after a claim with no socket setup, after a failed ready/done send, and after a partial variant group; a call from a different number; a new selfie during an active call; an early “yes” and an interrupted readback; `MENU` during and after a call; an actual PNG input; a settings change before generation; quota after usage rebuild; a WhatsApp result and failure after 24 hours; and delivery before an after-survey and printer completion.

```js
test("Portuguese WhatsApp caller gets one result after a delayed review", async () => {
  const flow = createVoiceFlowHarness({ channel: "whatsapp", languageMode: "ask", reviewMode: "human", lastInboundAgeMs: 25 * 60 * 60 * 1000 });
  await flow.sendSelfie("SMphoto");
  await flow.call("CAcall", "+14155550100");
  await flow.say("Português");
  await flow.say("Quero uma roupa espacial numa aquarela em Marte");
  await flow.confirm("Sim, pode fazer");
  await flow.approveReview();
  assert.equal(flow.jobs().length, 1);
  assert.equal(flow.sent().filter((item) => item.templateKey === "voiceDelivery").length, 1);
  assert.equal(flow.sent().some((item) => item.templateKey === "_raw" && item.outOfSession), false);
});
```

- [ ] **Step 2: Run** `node --test test/voice-flow.test.js`; expect the missing integration harness or a failing behavior assertion. Build the test harness with temp `data/` and `queue/` roots and injected Twilio/OpenAI/print doubles, then run the test again to expose the first real gap.
- [ ] **Step 3: Resolve every failing integration path and document setup.** README must identify the global Voice number, `BASE_URL`, Conversation Relay onboarding, Twilio Console Voice webhook URL `/voice/inbound`, `wss://` endpoint `/voice/ws`, bilingual Voice copy, template approval script, event switch, known caller ID limitation, and a live rehearsal checklist using the operator's own number. Keep real credentials and sample photos out of the repository.

```md
Voice setup: set `TWILIO_VOICE_NUMBER` and a public HTTPS `BASE_URL`, configure the Twilio number's incoming-call webhook to `POST /voice/inbound`, complete Conversation Relay onboarding, and approve both `voiceDelivery` and `voiceFailure` templates for English and Brazilian Portuguese before turning on Voice for an event.
```

- [ ] **Step 4: Run** `node --test test/voice-flow.test.js`, then `pnpm test`, `node --check index.js`, and `git diff --check`; expect all pass. Run `BASE_URL=https://booth.example TWILIO_TEMPLATE_SAMPLE_PORTRAIT_PATH=s/sample/img pnpm templates:create --print-only` to inspect template payloads without calling Twilio. Record any unverified live-call step as an external setup requirement, not a passing test.
- [ ] **Step 5: Commit** with `git commit -m "test: cover complete voice portrait flow and setup"`.

## Primary References

- [Twilio Conversation Relay TwiML and interruption attributes](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- [Twilio Conversation Relay WebSocket messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
- [Twilio Conversation Relay onboarding and signed handshake](https://www.twilio.com/docs/voice/conversationrelay/onboarding)
- [Twilio WhatsApp customer-service windows](https://www.twilio.com/docs/whatsapp/key-concepts)
- [Twilio Messaging Service with a specified `From` sender](https://www.twilio.com/docs/messaging/services)
- [OpenAI Structured Outputs for Responses](https://developers.openai.com/api/docs/guides/structured-outputs)
