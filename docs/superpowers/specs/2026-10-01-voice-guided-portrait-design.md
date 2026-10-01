# Voice-Guided Portrait Requests — Design

**Status:** In-chat design approved 2026-10-01; written spec awaiting review.

## Goal

An operator can enable Voice for an event. An attendee sends a selfie by SMS/MMS or WhatsApp, receives a message asking them to call a Twilio Voice number, describes how they want their photo to look in a natural conversation, and receives the finished image through the channel that received the selfie. Voice replaces the style, brand, and background menus for new selfies while the setting is enabled.

The first implementation targets the live V1 app in this repository. The isolated V2 successor has a separate real-attendee intake and provider-readiness path and is outside this design.

## Success Criteria

- The first reply to an accepted selfie contains a dialable Voice number and no style, brand, or background menu or pairing code.
- A call from the same phone number selects that phone's latest eligible pending selfie for the active event. The result returns to that selfie's original SMS or WhatsApp conversation.
- The agent explicitly asks how the attendee wants **their photo to look**, offers a few examples, handles open-ended follow-up requests, and allows the attendee to cut in while it speaks.
- A request reaches the image queue only after the attendee confirms a specific edit brief and the server accepts it. The agent says the attendee can hang up only after the job is durably queued.
- Existing quota, image safety, review, delivery, optional printing, and failure handling still apply. Voice requests always receive a digital result even when printing is also enabled.
- Duplicate webhooks, repeated calls, interrupted speech, and call disconnects cannot enqueue the same selfie twice or attach one person's call to another person's image.

## Approach

Use Conversation Relay directly for the first release. It connects a normal Twilio Voice call to a public `wss://` endpoint, converts speech to text and text to speech, and reports caller interruptions. The app supplies the LLM conversation, content policy, image job, and messaging delivery. The existing SMS/WhatsApp code remains responsible for intake and outbound messages.

Twilio Agent Connect (TAC) also uses Conversation Relay for Voice. Its channel, memory, and orchestration features would be useful if the same agent later handled ongoing SMS and WhatsApp conversations. This first feature needs a single voice handoff into the booth's existing job pipeline, so adopting full TAC now would add a second owner for messaging state.

```
SMS/MMS or WhatsApp selfie
  → private media staging and preflight
  → durable pending Voice request
  → invitation on the original channel
  → ordinary call to Twilio Voice number
  → Voice webhook and Conversation Relay WebSocket
  → agent conversation and server policy check
  → confirmed, approved edit brief
  → existing portrait queue, generation, review, and delivery
  → digital result on the original channel
```

## Selfie Intake and Call Matching

1. The messaging webhook detects an enabled Voice event after its usual sender, media-count, and quota checks. It records the Twilio `MessageSid`, normalized E.164 sender number, inbound channel, sending endpoint, event name, locale, and event settings relevant to this request. The `whatsapp:` prefix is removed for matching; the original channel and sender are retained for delivery.
2. Intake writes a durable preflight record before acknowledging the webhook. A recoverable background task downloads the image into private staging, validates type and size, and runs the existing moderation and face checks. Invalid photos receive the existing channel-specific failure message and never receive a call invitation.
3. A passing preflight creates an `awaiting_call` request that expires 30 minutes after the invitation. The invitation says to call the configured Voice number from the phone used to send the selfie. It contains no code or style choices.
4. The Voice webhook validates Twilio's HTTP signature, account, and called number. It normalizes the call's `From` number and atomically claims the most recent unexpired `awaiting_call` request for that phone and the currently active event. This works if the attendee used either SMS or WhatsApp to send the selfie. If both channels have pending selfies, the most recently received eligible selfie wins. When there is no pending request, a recent `queued` request from that phone may be read only to tell a repeat caller that their portrait is already in progress.
5. A new selfie supersedes an earlier request that has not yet been claimed by a call. An active call stays bound to its original selfie; a newer upload cannot silently switch the image during the conversation. Only one active Voice call is allowed per sender and event. A concurrent call hears that a photo call is already in progress, even if a newer selfie is waiting. If the active call ends without submitting and a newer selfie exists, the older request is superseded before the next call.
6. If the caller ID is absent, uses a different number, or has no eligible selfie, the agent explains that it could not find a photo from that phone and asks the caller to send a selfie or call back from the phone that sent it. It must not guess from a name or another attendee's message. Switching the active event invalidates unqueued pending requests from the old event, following the existing menu flow's event boundary.

The pending request is stored under the existing persistent `data/` mount, with atomic writes and a per-phone claim lock. V1's current single-replica deployment is the concurrency boundary for this file-backed store. A multi-replica deployment would require a transactional shared store before Voice is enabled there. Private staging files are deleted when requests expire, are superseded, or are handed to the existing queue's retention path. Phone numbers and raw transcripts are omitted from routine logs. The existing full-prompt log is suppressed for Voice jobs; logs retain request IDs and bounded outcome codes instead.

## Voice Conversation

The opening is short and specific:

> Thanks for sending your selfie! Tell me how you'd like your photo to look. You could change your outfit, put yourself on Mars, or turn it into a watercolor painting. What would you like to try?

The agent receives the request's event rules and, if preflight produced one, a bounded visual description of the selfie. It may acknowledge the photo but may not invent visual details it has not been given. It asks clarifying questions only when the desired look is ambiguous, such as whether a request for “retro” means the setting, clothing, or art style. It can explain why a proposed edit is disallowed or unlikely to work and offer a nearby alternative.

The Conversation Relay session explicitly enables speech interruption for the greeting and subsequent replies, starts with `interruptSensitivity="medium"`, and reports caller input during agent speech. Agent output is streamed in short spoken chunks. On an `interrupt` message, the app cancels any unplayed response tokens, trims the agent's last turn to `utteranceUntilInterrupt`, and processes the new caller utterance. An interrupted readback is not treated as confirmation. The agent must receive a clear affirmative response to a complete brief before submission. The sensitivity is tuned with real call tests to balance fast cut-ins against room noise.

Voice HTTP and WebSocket handshakes both validate Twilio signatures. The WebSocket receives only an opaque request identifier through Conversation Relay's custom parameters; it loads the corresponding request server-side. Per-call state is keyed by `CallSid`. A dropped call before submission leaves the request available for a new call until expiry. A dropped call after submission does not cancel the queued job.

## Edit Brief and Safety Gate

The LLM converts the conversation into a structured brief with desired visual style, clothing or subject treatment, setting/background, mood, important details, and details that must remain recognizable. The brief describes the attendee's requested result in plain language; it is not the raw transcript. The agent reads back a concise summary and asks for confirmation.

The server, rather than the agent's spoken judgment, decides whether a brief can be submitted. It checks the selfie and proposed text with the configured moderation service, validates bounded length and schema, applies event restrictions and image-model limitations, and rejects or requests revision when the outcome is uncertain. Caller speech is always treated as user data, including attempts to instruct the agent to ignore its rules. A rejected brief is not sent to image generation. The agent explains the limitation and invites a revised request.

After an affirmative confirmation, a `submitVoiceEdit` operation locks the request, verifies it is still active, within quota, and unsubmitted, and persists the approved brief and policy outcome with a deterministic request ID. Queue creation uses that ID as a durable idempotency key and returns the existing job on a retry. A recoverable `submitting` state bridges the request record and queue file: on restart, reconciliation finds the existing job or completes the same submission, never creating a second one. The operation reports success only after the queue file is durable and the request is marked `queued`. The spoken closing is then: “I've got your request and started your portrait. You can hang up now; I'll send it to you in the same chat when it's ready.” The agent does not guarantee exact visual details or a delivery time.

## Image Generation and Delivery

Voice jobs carry an explicit `inputMode: "voice"` and the approved brief. The pipeline uses a dedicated neutral voice-edit prompt path instead of silently selecting a configured menu style. That prompt combines the approved brief with fixed source-person preservation, subject-count, event branding, framing, and output instructions. Unapproved raw transcript text is never appended to an image prompt. The existing image-edit model receives the staged selfie and the assembled prompt. Existing moderation, review mode, variants, print handling, retry, and terminal failure paths remain in force. Reviewers can see the approved brief so they can judge whether a result fits the request.

The queue records the original SMS or WhatsApp channel and uses the existing sender and delivery adapters. Voice mode requires digital delivery even when the event also prints. For WhatsApp, the result uses an approved Content Template when its 24-hour customer-service window has expired; an ordinary Voice call does not reopen that window. If generation or delivery fails, the attendee receives the existing failure or support message through the original channel, subject to WhatsApp template rules.

## Settings and Compatibility

- Add a per-event **Enable Voice** switch, default off. The configured Voice number is global infrastructure, like the existing Twilio sender settings, and may be the SMS number if it is Voice capable; a WhatsApp sender is not assumed to be callable.
- The UI checks local readiness for a configured Voice number, public TLS WebSocket endpoint, Conversation Relay configuration, and digital delivery. If WhatsApp intake is enabled, an approved out-of-window delivery Content Template is also required. The UI directs the operator to place a test call to verify Twilio's external webhook routing. The switch cannot be enabled while required local configuration is missing.
- Voice invitation copy and the agent's opening are available in the existing English and Brazilian Portuguese locales. The session begins in the attendee's known locale; language changes during the call update speech recognition, spoken output, and the brief language together.
- The existing `leadCaptureMode="before"` message survey conflicts with an invitation immediately after the selfie. The first release prevents enabling Voice with that mode. After-delivery lead capture and NPS continue through the current messaging flow.
- Disabling Voice affects new selfies. Already invited requests can finish until their 30-minute expiry unless the active event switches. If Voice is unavailable before submission, the attendee receives a message explaining that they can retry the call or reply `MENU` to use the existing menu flow with the staged selfie.

## Failure and Lifecycle Rules

| Situation | Result |
| --- | --- |
| No call within 30 minutes | Expire the request and delete its staged image; a new selfie starts a new request. |
| No matching caller number | Speak the send-selfie/call-from-same-phone instruction; reveal no photo or attendee details. |
| Call drops before confirmed submission | Release the call claim; no job is created, and a new call can use the same request before expiry. |
| Call drops after confirmed submission | The durable job continues; a repeat call says the portrait is already in progress. |
| User interrupts the agent | Stop unheard speech, correct conversation history, and respond to the new utterance; never infer confirmation from an interrupted turn. |
| Duplicate webhook or submission | Return the recorded state/job; do not send another invitation or create another portrait. |
| Active event switches before submission | Reject the stale request and ask for a new selfie under the current event. |
| Safety or image provider rejects the request | Explain or message the failure; do not claim the result is ready. |

## Verification

Unit tests cover phone normalization and latest-request matching across SMS and WhatsApp, expiration and event changes, state transitions, structured-brief policy, confirmation, idempotent queue handoff, and voice prompt assembly. Protocol tests feed Conversation Relay setup, prompt, interrupt, disconnect, and repeat-call events into the WebSocket handler, including interruption during readback. Integration tests exercise the inbound selfie through mock messaging, staging, a simulated call, queueing, review, and delivery on the original channel, including WhatsApp delivery outside its freeform window. A test number then validates actual speech latency, cut-in behavior, caller matching, and the final result in a small live rehearsal.

## Expected Code Boundaries

- `index.js`: route SMS/WhatsApp selfies into Voice intake and mount Voice HTTP/WebSocket handlers.
- `lib/settings.js`, `lib/home.js`, `lib/i18n.js`: per-event switch, readiness, and bilingual invitation/opening copy.
- New focused modules under `lib/voice/`: durable pending requests and preflight, call matching and protocol, agent turns, and the server policy gate.
- `lib/queue.js`, `lib/pipeline.js`, `lib/prompt-builder.js`: idempotent voice job handoff and dedicated freeform prompt assembly.
- Existing messaging adapters: send invitation and completed result through the original channel.

## References

- [Twilio Conversation Relay TwiML attributes](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- [Twilio Conversation Relay WebSocket messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
- [Twilio Agent Connect overview](https://www.twilio.com/docs/conversations/agent-connect/overview)
- [Twilio WhatsApp customer-service windows](https://www.twilio.com/docs/whatsapp/key-concepts)
- [OpenAI image editing guidance](https://developers.openai.com/api/docs/guides/image-prompting)
