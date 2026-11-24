import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, GlanceApiClient } from '../src/client.ts'
import { SessionStore, type StorageLike } from '../src/session.ts'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function liveStore(): SessionStore {
  const store = new SessionStore(new MemoryStorage())
  store.save({
    access_token: 'voice-test-token',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    salon: { name: 'Synthetic Salon' },
  })
  return store
}

test('transcription submits raw octet-stream bytes with the existing bearer session and parses transcript/duration_ms', async () => {
  const pcm = new Uint8Array([0x00, 0x80, 0x34, 0x12])
  let request: { url: string; init: RequestInit } | null = null
  let uploadedBytes: number[] = []
  const client = new GlanceApiClient('https://api.example/api/v1/glance/', liveStore(), async (input, init) => {
    request = { url: String(input), init: init ?? {} }
    uploadedBytes = [...new Uint8Array(init?.body as ArrayBuffer)]
    return new Response(JSON.stringify({ data: { transcript: 'Recognized speech', duration_ms: 1234 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  })

  assert.deepEqual(await client.transcribeAudio(pcm), { transcript: 'Recognized speech', duration_ms: 1234 })
  assert.equal(request?.url, 'https://api.example/api/v1/glance/transcriptions')
  assert.equal(request?.init.method, 'POST')
  const headers = new Headers(request?.init.headers)
  assert.equal(headers.get('Content-Type'), 'application/octet-stream')
  assert.equal(headers.get('Authorization'), 'Bearer voice-test-token')
  assert.equal(request?.init.cache, 'no-store')
  assert.equal(request?.init.credentials, 'omit')
  assert.equal(headers.has('Idempotency-Key'), false)
  assert.ok(request?.init.body instanceof ArrayBuffer)
  assert.deepEqual(uploadedBytes, [...pcm])
  assert.deepEqual([...new Uint8Array(request!.init.body as ArrayBuffer)], [0, 0, 0, 0])
  // The client takes a bounded upload copy and clears it after fetch resolves.
  assert.deepEqual([...pcm], [0, 0x80, 0x34, 0x12])
})

test('transcription client enforces empty, even-byte, and 1,280,000-byte limits before fetch', async () => {
  let calls = 0
  const client = new GlanceApiClient('https://api.example', liveStore(), async () => {
    calls += 1
    return new Response(JSON.stringify({ data: { transcript: 'ok', duration_ms: 10 } }), { status: 200 })
  })
  await assert.rejects(client.transcribeAudio(new Uint8Array()), (error: unknown) => error instanceof ApiError && error.code === 'empty_audio')
  await assert.rejects(client.transcribeAudio(new Uint8Array([1])), (error: unknown) => error instanceof ApiError && error.code === 'invalid_audio')
  await assert.rejects(client.transcribeAudio(new Uint8Array(1_280_002)), (error: unknown) => error instanceof ApiError && error.code === 'audio_too_large')
  assert.equal(calls, 0)
  await client.transcribeAudio(new Uint8Array(1_280_000))
  assert.equal(calls, 1)
})

test('transcription rejects the wrong response schema instead of accepting data.text', async () => {
  const client = new GlanceApiClient('https://api.example', liveStore(), async () => new Response(
    JSON.stringify({ data: { text: 'wrong canonical field', duration_ms: 1234 } }), { status: 200 },
  ))
  await assert.rejects(client.transcribeAudio(new Uint8Array([1, 2])), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'invalid_response')
    return true
  })
})

test('stable transcription errors are normalized without provider details or automatic retries', async () => {
  const cases = [
    ['invalid_content_type', 415], ['empty_audio', 400], ['invalid_audio', 422], ['audio_too_large', 413],
    ['rate_limited', 429], ['transcription_disabled', 503], ['transcription_unavailable', 503],
    ['transcription_timeout', 504], ['empty_transcript', 422],
  ] as const
  for (const [code, status] of cases) {
    let calls = 0
    const client = new GlanceApiClient('https://api.example', liveStore(), async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { code, message: 'private provider URL and response' } }), {
        status,
        headers: { 'X-Request-ID': `request-${code}`, 'Retry-After': code === 'rate_limited' ? '6' : '' },
      })
    })
    await assert.rejects(client.transcribeAudio(new Uint8Array([1, 2])), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, code)
      assert.equal(error.requestId, `request-${code}`)
      assert.doesNotMatch(error.message, /private provider URL|response/)
      if (code === 'rate_limited') assert.equal(error.retryAfterSeconds, 6)
      return true
    })
    assert.equal(calls, 1, `${code} should not be retried automatically`)
  }
})

test('missing and invalid sessions are rejected before a transcription fetch', async () => {
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { code: 'invalid_session' } }), { status: 401 })
  }
  const absent = new GlanceApiClient('https://api.example', new SessionStore(new MemoryStorage()), fetcher)
  await assert.rejects(absent.transcribeAudio(new Uint8Array([1, 2])), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'session_expired')
    return true
  })
  assert.equal(calls, 0)

  const invalid = new GlanceApiClient('https://api.example', liveStore(), fetcher)
  await assert.rejects(invalid.transcribeAudio(new Uint8Array([1, 2])))
  assert.equal(calls, 1)
})

test('the Glance client deadline aborts transcription once with a bounded timeout code', async () => {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(callback, timeout === 20_000 ? 1 : timeout, ...args)) as typeof setTimeout
  let calls = 0
  let signal: AbortSignal | null = null
  const client = new GlanceApiClient('https://api.example', liveStore(), (_input, init) => {
    calls += 1
    signal = init?.signal ?? null
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  try {
    await assert.rejects(client.transcribeAudio(new Uint8Array([1, 2])), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'transcription_timeout')
      assert.equal(error.uncertain, true)
      return true
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
  assert.equal(calls, 1)
  assert.equal(signal?.aborted, true)
})
