# RemboAI Glance

RemboAI Glance is a glasses-first escalation client for salon and barbershop owners. The G2 is the normal operating surface: an owner can inspect cases, dictate or generate a reply, review the exact outgoing text, approve it, inspect its outcome, and resolve the case using supported glasses and ring controls. The paired phone is used for pairing and recovery and remains an optional full-text editing companion.

## Prior-work disclosure

The frontend implementation and local simulator walkthrough existed in this directory before Git was initialized. The first source commit therefore captures the integrated application rather than a granular history of its original implementation. The sibling `/home/sam/Desktop/remboai` backend is a separate repository.

## Requirements

- Node.js and npm
- `@evenrealities/even_hub_sdk` 0.0.16 (installed through the lockfile)
- Even Hub simulator 0.9.5 for local display testing

Install the locked dependencies:

```sh
npm ci
```

## Configuration

Copy `.env.example` to `.env.local` for local overrides. `.env.local` is ignored by Git.

```dotenv
VITE_GLANCE_API_BASE=https://remboai.duckdns.org/api/v1/glance
VITE_GLANCE_DEMO_FIXTURES=false
```

`VITE_GLANCE_API_BASE` is the configurable Glance API root. The default matches the intended API URL; it has not been verified against a staging service. Do not put credentials, bearer tokens, provider keys, or other secrets in Vite variables: they are compiled into the client bundle.

For local UI review only, set `VITE_GLANCE_DEMO_FIXTURES=true`. The app then shows an explicit synthetic-fixture banner and does not call the backend or send messages. Keep the flag false for normal development and builds.

## Development and verification

```sh
npm run dev
npm test
npm run build
```

To open the running Vite app in the Even Hub simulator:

```sh
evenhub-simulator http://127.0.0.1:5173 --automation-port 9898 --no-glow
```

The simulator exposes a 576 × 288 G2 display. Its `/api/ping` endpoint only means the simulator process is ready; it does not mean the WebView, Even Hub bridge, startup page, or framebuffer is ready. Wait until the phone WebView reports `G2 connected · 576 × 288` or the glasses screenshot contains a rendered frame before capturing. This prevents a screenshot taken during startup from being mistaken for a blank app page.

In a development build, render synthetic G2 states by adding `?g2-preview=` to the simulator URL: `inbox`, `case`, `case-older`, `draft`, `voice-ready`, `voice-recording`, `transcript-preview`, `approval-review`, `approval-confirm`, `reply-status`, `resolve`, or `case-resolved`. For example:

```sh
evenhub-simulator 'http://127.0.0.1:5173/?g2-preview=voice-recording' --automation-port 9898 --no-glow
```

These routes use synthetic fixtures, skip saved-session loading and backend polling, and never start a real microphone. Recording states are labeled `SIMULATION | MIC OFF`. The normal interaction model is: swipe/scroll to browse cases, messages or text pages; click to open the selected inbox case or cycle the current action; double-click to activate a selected action; and the native contextual menu for direct shortcuts. The inbox root double-click invokes Even Hub's system exit confirmation. Long press is not used for an application-critical action. See [the glasses-first workflow](docs/glasses-first-workflow.md) for the complete map and safety rules.

## Architecture

- `src/main.ts` waits for the Even Hub bridge, validates and creates/rebuilds native pages, upgrades stable text containers, and forwards SDK events through one shared handler.
- `src/glasses-ui.ts` builds bounded native 576 × 288 screen layouts using absolute SDK container geometry.
- `src/app.ts` coordinates the G2-first inbox, case, voice, draft, exact-text review, reply-status and resolution workflow.
- `src/client.ts` implements the typed `/api/v1/glance` requests, including authenticated raw PCM transcription, bearer handling, timeouts, request IDs, `Retry-After`, and no-store fetches.
- `src/session.ts` validates pairing codes and stores the revocable session token in browser `localStorage` until expiry or revocation.
- `src/workflow.ts` contains presentation helpers and payload-bound pending idempotency keys. A pending write retains its action key and exact payload in `localStorage` until success, so an uncertain retry after WebView suspension reuses the same key; successful actions clear the record.
- `src/evenhub-events.ts` parses SDK event envelopes, including source-tagged audio and ring/display lifecycle events.
- `src/audio-capture.ts` captures only owner-started G2 microphone PCM in bounded memory, with 40-second and 1,280,000-byte limits.
- `src/voice-intents.ts` keeps the explicit Use as reply and Use as instruction paths separate; both create or revise a draft and neither can approve a reply.
- `src/demo-fixtures.ts` contains synthetic-only records for offline simulator walkthroughs.

The API client calls:

- `POST /pairing/exchange` and `DELETE /sessions/current`
- `GET /inbox?limit=20` and `GET /cases/{case_id}`
- `POST /cases/{case_id}/drafts`, `/drafts/manual`, and `/drafts/{draft_id}/revise`
- `POST /cases/{case_id}/replies` and `GET /replies/{reply_id}`
- `POST /cases/{case_id}/resolve`
- `POST /transcriptions` with raw `application/octet-stream` mono 16 kHz signed 16-bit little-endian PCM; the client validates `{ data: { transcript, duration_ms }}`.

The paired session determines salon and owner authority. The client does not submit salon, customer, recipient, or channel IDs as authority. Reply approval queues exact text; Telegram acceptance is not shown as delivery confirmation. Resolution does not change payment state.

## Voice input

Voice capture starts only after the owner navigates to Voice and explicitly selects Start. The app waits for successful startup-page creation before exposing `bridge.audioControl`, opens `AudioInputSource.Glasses`, accepts only glasses-source PCM events, and closes the microphone on stop, cancellation, app backgrounding, errors, navigation, session loss, and page exit. It does not fall back to the phone microphone or automatically restart after suspension.

The app copies PCM event chunks into a bounded in-memory buffer and submits them directly to the authenticated transcription endpoint. Captured audio is cleared after upload, failure, cancellation, or navigation. A transcript is transient until the owner chooses an intent. After that explicit choice, the pending idempotency record may temporarily retain the selected reply or instruction payload so an interrupted write can be retried safely; the record is removed after success. Audio is never persisted, and neither audio nor transcript is logged or sent to analytics.

After transcription, the owner explicitly chooses **Use as reply**, **Use as instruction**, or cancel on G2. The first creates an owner-authored manual draft. The second revises only a current, unexpired, unedited AI draft and is unavailable otherwise. The owner can inspect the draft on G2, optionally use the phone editor, then review every page of the exact outgoing text on G2 and perform a separate final approval action. A transcript never sends or resolves anything.

The manifest declares the `g2-microphone` permission. The installed SDK is `@evenrealities/even_hub_sdk` 0.0.16. The simulator package is 0.9.5 and documents 100 ms audio-event frames. The local simulator environment exposes audio inputs including a zero-sample `alsa:null` device; automated capture tests inject controlled PCM events instead of treating simulator audio as captured speech. These checks do not establish physical G2 microphone, live ASR-provider, packaged WebView, staging, or Telegram delivery acceptance.

## Security and current limitations

- The bearer token is a revocable browser `localStorage` credential, not a native Keychain/Keystore secret. Lost devices should be revoked through the Telegram owner channel.
- Authenticated requests omit cookies, use bearer authorization, and set `cache: no-store`. Response data is held in app memory rather than persisted as authoritative case state.
- AI generation, revision and reply submission require an available backend. Synthetic fixtures are not live responses.
- The phone-free interaction path is implemented in the frontend state machine and simulator fixtures. Physical ring/temple behaviour and the locked-phone workflow have not been verified on hardware or through Even Hub Beta Testing.
- An Android WebView may be suspended while backgrounded. Glance persists only the session, the active case/persisted draft snapshot, and unresolved payload-bound idempotency actions. On return it refreshes server state; recording never resumes automatically. Microphone capture cannot continue while the WebView is suspended.
- Exact-text approval is disabled when the final message contains characters the installed G2 text renderer may alter. G2 offers an explicit **Create ASCII copy** action that saves a new owner draft with display-safe text; unknown glyphs become `?`. The owner reviews every page of that changed text on G2 before approval. Phone editing remains optional.
- No staging hostname or packaged WebView origin has been confirmed. Real HTTPS requests, packaged-app CORS, and production routing have not been verified from the Even Hub WebView.
- Physical G2 microphone permission and capture, real ASR provider success, packaged WebView CORS, and real HTTPS staging integration remain unverified.

## Repository history

This is a local-only repository. It has no configured remote and should not be published without an explicit project decision. The initial source snapshot groups the tightly coupled runtime because the entry point, controller, API client, session code, workflow helpers and fixtures are imported together; splitting those existing modules into staged placeholder implementations would create artificial history.
