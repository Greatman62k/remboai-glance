# RemboAI Glance

RemboAI Glance is the Even Hub G2 client for salon owner escalations. The phone WebView handles pairing, conversation review, editing and exact-text approval. The G2 display shows compact case summaries and a small set of actions.

## Prior-work disclosure

The frontend implementation and local simulator walkthrough existed in this directory before Git was initialized. The first source commit therefore captures the integrated application rather than a granular history of its original implementation. The sibling `/home/sam/Desktop/remboai` backend was inspected for API compatibility and was not edited by this frontend work.

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

The simulator exposes a 576 × 288 G2 display. Its `/api/ping` endpoint only means the simulator process is ready; it does not mean the WebView, Even Hub bridge, startup page, or framebuffer is ready. Wait until the phone WebView reports `Even Hub display connected · 576 × 288` or the glasses screenshot contains a nontransparent frame before capturing. This prevents a screenshot taken during startup from being mistaken for a blank app page.

In a development build, render the eight synthetic G2 screens by adding `?g2-preview=` to the simulator URL: `inbox`, `case`, `draft`, `voice-ready`, `voice-recording`, `transcript-preview`, `reply-status`, or `case-resolved`. For example:

```sh
evenhub-simulator 'http://127.0.0.1:5173/?g2-preview=voice-recording' --automation-port 9898 --no-glow
```

These routes use local synthetic fixtures, skip saved-session loading and backend polling, and never start the microphone. The recording screen is labeled `SIMULATION | MIC OFF`. Scroll navigates cases or list items, click changes the focused action, and double-click activates it. Full transcript review, draft editing, intent selection and exact outgoing-message approval stay on the phone.

## Architecture

- `src/main.ts` waits for the Even Hub bridge, validates and creates/rebuilds native pages, upgrades stable text containers, and forwards SDK events through one shared handler.
- `src/glasses-ui.ts` builds bounded native 576 × 288 screen layouts using absolute SDK container geometry.
- `src/app.ts` coordinates pairing, inbox, case, voice, draft, approval, reply-status and resolution screens.
- `src/client.ts` implements the typed `/api/v1/glance` requests, including authenticated raw PCM transcription, bearer handling, timeouts, request IDs, `Retry-After`, and no-store fetches.
- `src/session.ts` validates pairing codes and stores the revocable session token in browser `localStorage` until expiry or revocation.
- `src/workflow.ts` contains presentation helpers and payload-bound pending idempotency keys. Pending actions are tab-scoped so an uncertain retry can reuse its key after a WebView reload; successful actions clear their record.
- `src/evenhub-events.ts` parses SDK event envelopes, including source-tagged audio and ring/display lifecycle events.
- `src/audio-capture.ts` captures only owner-started G2 microphone PCM in bounded memory, with 40-second and 1,280,000-byte limits.
- `src/voice-intents.ts` keeps the explicit Use as reply and Use as instruction paths separate; both continue into persisted draft review and neither can approve a reply.
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

Voice capture starts only after the owner selects Record from an open case. The app waits for successful startup-page creation before exposing `bridge.audioControl`, opens `AudioInputSource.Glasses`, accepts only glasses-source PCM events, and closes the microphone on stop, cancellation, app backgrounding, errors, navigation, session loss, and page exit. It does not fall back to the phone microphone.

The app copies PCM event chunks into a bounded in-memory buffer and submits them directly to the authenticated transcription endpoint. Captured audio is cleared after upload, failure, cancellation, or navigation. Transcripts are held only in the active app state and are not written to local/session storage, IndexedDB, logs, or analytics. Voice-derived retry keys are memory-only so their payloads cannot persist speech text.

After transcription, the owner must explicitly choose **Use as reply** or **Use as instruction** on the phone. The first creates a persisted manual draft. The second revises only a current, unexpired, unedited AI draft and is unavailable otherwise. Both paths lead to the existing full-text editor; the owner must inspect and approve the exact outgoing message separately. A transcript never sends or resolves anything.

The manifest declares the `g2-microphone` permission. The installed SDK is `@evenrealities/even_hub_sdk` 0.0.16. The simulator package is 0.9.5 and documents 100 ms audio-event frames. The local simulator environment exposes audio inputs including a zero-sample `alsa:null` device; automated capture tests inject controlled PCM events instead of treating simulator audio as captured speech. These checks do not establish physical G2 microphone, live ASR-provider, packaged WebView, staging, or Telegram delivery acceptance.

## Security and current limitations

- The bearer token is a revocable browser `localStorage` credential, not a native Keychain/Keystore secret. Lost devices should be revoked through the Telegram owner channel.
- Authenticated requests omit cookies, use bearer authorization, and set `cache: no-store`. Response data is held in app memory rather than persisted as authoritative case state.
- AI generation, revision and reply submission require an available backend. Synthetic fixtures are not live responses.
- No staging hostname or packaged WebView origin has been confirmed. Real HTTPS requests, packaged-app CORS, and production routing have not been verified from the Even Hub WebView.
- Physical G2 microphone permission and capture, real ASR provider success, packaged WebView CORS, and real HTTPS staging integration remain unverified.

## Repository history

This is a local-only repository. It has no configured remote and should not be published without an explicit project decision. The initial source snapshot groups the tightly coupled runtime because the entry point, controller, API client, session code, workflow helpers and fixtures are imported together; splitting those existing modules into staged placeholder implementations would create artificial history.
