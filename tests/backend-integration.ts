import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ApiError, GlanceApiClient } from '../src/client.ts'
import { SessionStore, type StorageLike } from '../src/session.ts'
import { useTranscriptAsInstruction, useTranscriptAsReply } from '../src/voice-intents.ts'
import { presentReplyState } from '../src/workflow.ts'
import type { CaseData } from '../src/types.ts'

interface ReadyInfo {
  api_base: string
  origin: string
  pairing_code: string
  salon_case_id: string
  manual_case_id: string
  other_salon_case_id: string
  salon_id: string
  dispatch_signal: string
  done_signal: string
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function rejectedCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    assert(error instanceof ApiError, `Expected ApiError ${code}`)
    assert(error.code === code, `Expected ${code}, got ${error.code}`)
    return
  }
  throw new Error(`Expected request to fail with ${code}`)
}

async function main(): Promise<void> {
  const readyPath = process.argv[2]
  assert(readyPath, 'Pass the isolated readiness file path.')
  const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as ReadyInfo
  const storage = new MemoryStorage()
  const sessions = new SessionStore(storage)
  let authenticatedCorsResponseCount = 0
  const fetchWithOrigin: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Origin', ready.origin)
    const response = await fetch(input, { ...init, headers })
    if (headers.has('Authorization') && response.headers.get('access-control-allow-origin') === ready.origin) {
      authenticatedCorsResponseCount += 1
    }
    return response
  }
  const api = new GlanceApiClient(ready.api_base, sessions, fetchWithOrigin, 10_000)

  const preflight = await fetch(ready.api_base + '/transcriptions', {
    method: 'OPTIONS',
    headers: {
      Origin: ready.origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  assert(preflight.status === 204, `CORS preflight returned ${preflight.status}`)
  assert(preflight.headers.get('access-control-allow-origin') === ready.origin, 'CORS did not allow the controlled WebView origin')
  const allowedHeaders = preflight.headers.get('access-control-allow-headers')?.toLowerCase() ?? ''
  assert(allowedHeaders.includes('authorization') && allowedHeaders.includes('content-type'), 'CORS omitted Authorization or Content-Type')

  const paired = await api.exchangePairing(ready.pairing_code, 'Day 5 synthetic G2')
  sessions.save(paired)
  assert(sessions.load()?.access_token === paired.access_token, 'paired session was not stored in the injected memory store')

  const inbox = await api.getInbox()
  assert(authenticatedCorsResponseCount > 0, 'authenticated cross-origin API response omitted the configured Allow-Origin header')
  assert(inbox.items.length === 2, `Expected two open cases in the paired salon, got ${inbox.items.length}`)
  const detail = await api.getCase(ready.salon_case_id)
  assert(detail.has_earlier && detail.context.length === 10, 'case detail did not return the latest ten with earlier-message look-ahead')
  assert(detail.context.every((item, index, values) => index === 0 || values[index - 1]!.sequence < item.sequence), 'case context is not ascending by sequence')
  const foreign = await fetch(`${ready.api_base}/cases/${ready.other_salon_case_id}`, {
    headers: { Authorization: `Bearer ${paired.access_token}`, Origin: ready.origin },
  })
  const missing = await fetch(`${ready.api_base}/cases/00000000-0000-4000-8000-000000000001`, {
    headers: { Authorization: `Bearer ${paired.access_token}`, Origin: ready.origin },
  })
  assert(foreign.status === 404 && missing.status === foreign.status, 'cross-salon and absent case status differ')
  assert((await foreign.json() as { error?: { code?: string } }).error?.code === (await missing.json() as { error?: { code?: string } }).error?.code,
    'cross-salon and absent case errors differ')

  const aiCase = detail
  const initialDraft = await api.createDraft(aiCase.case_id, aiCase.version, randomUUID())
  assert(initialDraft.source === 'ai' && initialDraft.based_on_version === aiCase.version, 'AI draft was not persisted against current case version')

  const transcript = 'Please make the reply warmer and shorter.'
  const pcm = new Uint8Array(6_400)
  let transcribed
  try {
    transcribed = await api.transcribeAudio(pcm)
  } finally {
    pcm.fill(0)
  }
  assert(transcribed.transcript === transcript && Number.isFinite(transcribed.duration_ms), 'transcription response contract did not parse transcript/duration_ms')
  const caseBeforeIntent = await api.getCase(aiCase.case_id)
  assert(!caseBeforeIntent.context.some((event) => event.text.includes(transcript)), 'transcript entered case history before the owner selected an intent')
  const revised = await useTranscriptAsInstruction(api, aiCase.case_id, initialDraft.draft_id, aiCase.version, transcribed.transcript, randomUUID())
  assert(revised.draft_id !== initialDraft.draft_id && revised.source === 'ai', 'instruction did not create a replacement AI draft')
  const phoneEditedAiText = `${revised.text} Please tell us what works for you.`
  const aiReplyKey = randomUUID()
  const aiReply = await api.approveReply(aiCase.case_id, aiCase.version, revised.draft_id, phoneEditedAiText, aiReplyKey)
  const replay = await api.approveReply(aiCase.case_id, aiCase.version, revised.draft_id, phoneEditedAiText, aiReplyKey)
  assert(replay.reply_id === aiReply.reply_id && replay.case_version === aiReply.case_version, 'approval retry did not replay its original outcome')
  await rejectedCode(
    () => api.approveReply(aiCase.case_id, aiCase.version, revised.draft_id, phoneEditedAiText + ' Changed.', aiReplyKey),
    'idempotency_conflict',
  )
  const queued = await api.getReply(aiReply.reply_id)
  assert(queued.state === 'queued' && presentReplyState(queued.state, aiCase.channel).label === 'Queued', 'queued outbox state was presented as sent/delivered')
  const aiResolved = await api.resolveCase(aiCase.case_id, {
    expected_version: aiReply.case_version,
    reason: 'customer_updated',
    acknowledge_unknown_reply: false,
  })
  assert(aiResolved.status === 'resolved' && aiResolved.cancelled_reply_ids.includes(aiReply.reply_id), 'resolution did not cancel the still-queued reply')
  assert((await api.getReply(aiReply.reply_id)).state === 'cancelled', 'cancelled reply status was not recoverable')

  const manualCase = await api.getCase(ready.manual_case_id)
  const manualTranscript = await api.transcribeAudio(new Uint8Array(6_400))
  assert(manualTranscript.transcript === transcript, 'manual-reply transcription did not parse the canonical response')
  const manualDraft = await useTranscriptAsReply(api, manualCase.case_id, manualCase.version, manualTranscript.transcript, randomUUID())
  assert(manualDraft.source === 'owner' && manualDraft.text === transcript, 'Use as reply did not call the owner-authored manual-draft path')
  const phoneEditedManualText = 'Thanks for your message. I will check and update you shortly.'
  const manualReply = await api.approveReply(manualCase.case_id, manualCase.version, manualDraft.draft_id, phoneEditedManualText, randomUUID())
  const manualStatus = await api.getReply(manualReply.reply_id)
  assert(manualStatus.state === 'queued', 'manual reply was not durably queued')
  writeFileSync(ready.dispatch_signal, 'dispatch', { mode: 0o600 })
  let submitted = manualStatus
  for (let attempt = 0; attempt < 20 && ['queued', 'sending'].includes(submitted.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    submitted = await api.getReply(manualReply.reply_id)
  }
  assert(submitted.state === 'submitted', `intercepted outbox dispatcher ended in ${submitted.state}`)
  assert(presentReplyState(submitted.state, manualCase.channel).label === 'Sent to Telegram — delivery not confirmed', 'Telegram provider acceptance was shown as delivery')
  const manualDetailAfterDispatch = await api.getCase(manualCase.case_id)
  assert(manualDetailAfterDispatch.latest_reply?.state === 'submitted', 'case detail did not expose the latest submitted reply')
  const manualResolved = await api.resolveCase(manualCase.case_id, {
    expected_version: manualReply.case_version,
    reason: 'handled_in_person',
    acknowledge_unknown_reply: false,
  })
  assert(manualResolved.status === 'resolved' && !manualResolved.cancelled_reply_ids.includes(manualReply.reply_id), 'submitted reply was incorrectly treated as a queued cancellation')

  // The configured Caddy transcription matcher must accept the exact boundary
  // and reject one byte above it before the provider; other app routes retain
  // the ordinary 256 KiB request limit.
  const maximumPcm = new Uint8Array(1_280_000)
  const maximumResult = await api.transcribeAudio(maximumPcm)
  assert(maximumResult.transcript === transcript, 'Caddy did not forward the exact maximum supported audio body')
  maximumPcm.fill(0)
  const bearer = sessions.load()!.access_token
  const tooLarge = await fetch(`${ready.api_base}/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Origin: ready.origin, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(1_280_001),
  })
  assert(tooLarge.status === 413 && (await tooLarge.json() as { error?: { code?: string } }).error?.code === 'audio_too_large',
    'Caddy did not return the bounded oversized transcription error')
  const ordinaryTooLarge = await fetch(`${ready.api_base}/pairing/exchange`, {
    method: 'POST',
    headers: { Origin: ready.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '000000000000', device_label: 'x'.repeat(300_000) }),
  })
  const ordinaryErrorBytes = await ordinaryTooLarge.arrayBuffer()
  assert(ordinaryTooLarge.status === 413, `ordinary Glance endpoint did not retain the 256 KiB Caddy limit (status ${ordinaryTooLarge.status}, body ${ordinaryErrorBytes.byteLength} bytes)`)

  const stored = [...storage.values.values()].join('\n')
  assert(storage.values.size === 1, 'audio or transcript created an extra browser-persistence entry')
  assert(!stored.includes(transcript), 'transcript was written to browser persistence')
  assert(!stored.includes('Please make the reply'), 'instruction transcript was written to browser persistence')
  assert(!stored.includes('01010101'), 'PCM-like data appeared in browser persistence')
  writeFileSync(ready.done_signal, 'done', { mode: 0o600 })
  console.log('PASS: real frontend client ↔ FastAPI via Caddy; pairing, inbox, context, AI revision, manual reply, transcription, approval, status, resolution, CORS, tenant isolation, and body boundaries')
}

void main().catch((error: unknown) => {
  const safe = error instanceof ApiError ? `${error.code} (${error.status})` : error instanceof Error ? error.message : 'unknown failure'
  console.error(`FAIL: ${safe}`)
  process.exitCode = 1
})
