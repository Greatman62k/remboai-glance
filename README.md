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

The simulator exposes a 576 × 288 G2 display. The SDK text container is positioned within that display; use the phone WebView for longer text and forms. Scroll navigates cases or context chunks, click changes the highlighted G2 action, and double-click activates it. The app does not rely on long press or programmatic display scrolling.

## Architecture

- `src/main.ts` waits for the Even Hub bridge, creates the text container and forwards SDK events.
- `src/app.ts` coordinates pairing, inbox, case, draft, approval, reply-status and resolution screens.
- `src/client.ts` implements the typed `/api/v1/glance` requests, bearer handling, timeouts, request IDs, `Retry-After`, and no-store fetches.
- `src/session.ts` validates pairing codes and stores the revocable session token in browser `localStorage` until expiry or revocation.
- `src/workflow.ts` contains presentation helpers and payload-bound pending idempotency keys. Pending actions are tab-scoped so an uncertain retry can reuse its key after a WebView reload; successful actions clear their record.
- `src/evenhub-events.ts` parses SDK event envelopes, including ring and display lifecycle events.
- `src/demo-fixtures.ts` contains synthetic-only records for offline simulator walkthroughs.

The API client calls:

- `POST /pairing/exchange` and `DELETE /sessions/current`
- `GET /inbox?limit=20` and `GET /cases/{case_id}`
- `POST /cases/{case_id}/drafts`, `/drafts/manual`, and `/drafts/{draft_id}/revise`
- `POST /cases/{case_id}/replies` and `GET /replies/{reply_id}`
- `POST /cases/{case_id}/resolve`

The paired session determines salon and owner authority. The client does not submit salon, customer, recipient, or channel IDs as authority. Reply approval queues exact text; Telegram acceptance is not shown as delivery confirmation. Resolution does not change payment state.

## Security and current limitations

- The bearer token is a revocable browser `localStorage` credential, not a native Keychain/Keystore secret. Lost devices should be revoked through the Telegram owner channel.
- Authenticated requests omit cookies, use bearer authorization, and set `cache: no-store`. Response data is held in app memory rather than persisted as authoritative case state.
- AI generation, revision and reply submission require an available backend. Synthetic fixtures are not live responses.
- No staging hostname or packaged WebView origin has been confirmed. Real HTTPS requests, packaged-app CORS, and production routing have not been verified from the Even Hub WebView.
- Microphone capture and ASR are not implemented in this frontend milestone.

## Repository history

This is a local-only repository. It has no configured remote and should not be published without an explicit project decision. The initial source snapshot groups the tightly coupled runtime because the entry point, controller, API client, session code, workflow helpers and fixtures are imported together; splitting those existing modules into staged placeholder implementations would create artificial history.
