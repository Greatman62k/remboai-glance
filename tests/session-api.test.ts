import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, GlanceApiClient, parseRetryAfter } from '../src/client.ts'
import { SESSION_STORAGE_KEY, SessionStore, isValidPairingCode, normalizePairingCode } from '../src/session.ts'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const session = (token = 'token-secret-for-test', expires = new Date(Date.now() + 60_000).toISOString()) => ({
  access_token: token,
  expires_at: expires,
  salon: { name: 'Synthetic Salon' },
})

test('pairing input normalizes case/separators and accepts only 12 Crockford Base32 symbols', () => {
  assert.equal(normalizePairingCode(' abcd-efgh-jkmn '), 'ABCDEFGHJKMN')
  assert.equal(isValidPairingCode('0000-0000-0000'), true)
  assert.equal(isValidPairingCode('0000-0000-000I'), false)
  assert.equal(isValidPairingCode('00000000000'), false)
  assert.equal(isValidPairingCode('0000000000000'), false)
})

test('session token is persisted, loaded, expires, and clears on revocation', () => {
  const storage = new MemoryStorage()
  let now = 1_000
  const store = new SessionStore(storage, () => now)
  store.assertCanPersist()
  store.save(session('bearer-value', new Date(10_000).toISOString()))
  assert.equal(storage.getItem(SESSION_STORAGE_KEY)?.includes('bearer-value'), true)
  assert.equal(store.load()?.access_token, 'bearer-value')
  now = 10_000
  assert.equal(store.load(), null)
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null)
  store.save(session('revoked'))
  store.clear()
  assert.equal(store.load(), null)
})

test('session persistence fails closed when browser storage is absent or rejects writes', () => {
  assert.throws(() => new SessionStore(null).assertCanPersist(), /storage is unavailable/i)
  const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
  assert.throws(() => new SessionStore(blocked).assertCanPersist(), /storage is unavailable/i)
})

test('pairing exchange has no bearer authority; authenticated API calls use no-store and omit cookies', async () => {
  const storage = new MemoryStorage()
  const store = new SessionStore(storage)
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const data = url.endsWith('/pairing/exchange')
      ? session('backend-token')
      : { items: [], open_count: 0, has_more: false, next_cursor: null }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }
  const client = new GlanceApiClient('https://api.example/api/v1/glance', store, fetcher)
  const paired = await client.exchangePairing('0123456789AB', 'RemboAI Glance G2')
  assert.equal(paired.access_token, 'backend-token')
  assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false)
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { code: '0123456789AB', device_label: 'RemboAI Glance G2' })

  store.save(paired)
  await client.getInbox()
  const request = calls[1]
  assert.equal(new Headers(request.init.headers).get('Authorization'), 'Bearer backend-token')
  assert.equal(request.init.cache, 'no-store')
  assert.equal(request.init.credentials, 'omit')
  assert.equal(request.url, 'https://api.example/api/v1/glance/inbox?limit=20')
})

test('backend errors normalize codes, request IDs, and Retry-After without exposing raw server text', async () => {
  const store = new SessionStore(new MemoryStorage())
  store.save(session())
  const fetcher = async () => new Response(JSON.stringify({
    error: { code: 'unresolved_reply_exists', message: 'raw message ignored' },
    request_id: 'body-request',
  }), {
    status: 409,
    headers: { 'X-Request-ID': 'header-request', 'Retry-After': '4', 'Content-Type': 'application/json' },
  })
  const client = new GlanceApiClient('https://api.example', store, fetcher)
  await assert.rejects(client.getInbox(), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'unresolved_reply_exists')
    assert.equal(error.requestId, 'header-request')
    assert.equal(error.retryAfterSeconds, 4)
    assert.doesNotMatch(error.message, /raw message ignored/)
    return true
  })
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')), 60)
})

test('401/403 invalidates local bearer session', async () => {
  const store = new SessionStore(new MemoryStorage())
  store.save(session())
  const client = new GlanceApiClient('https://api.example', store, async () => new Response(
    JSON.stringify({ error: { code: 'session_revoked' } }), { status: 401 },
  ))
  await assert.rejects(client.getInbox())
  assert.equal(store.load(), null)
})

test('client deadline aborts the fetch and marks an unknown network outcome', async () => {
  const store = new SessionStore(new MemoryStorage())
  store.save(session())
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  const client = new GlanceApiClient('https://api.example', store, fetcher, 5)
  await assert.rejects(client.getInbox(), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'request_timeout')
    assert.equal(error.uncertain, true)
    return true
  })
})

test('all Glance API methods use the backend route and request contracts', async () => {
  const storage = new MemoryStorage()
  const store = new SessionStore(storage)
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = []
  const caseId = 'd6e306ac-b222-46d5-bfc9-a54bcd6f24a1'
  const draftId = '11111111-1111-4111-8111-111111111111'
  const replyId = '22222222-2222-4222-8222-222222222222'
  const responseFor = (path: string): unknown => {
    if (path === '/pairing/exchange') return session('route-test-token')
    if (path === '/inbox?limit=20') return { items: [], open_count: 0, has_more: false, next_cursor: null }
    if (path === `/cases/${caseId}`) return { case_id: caseId, version: 3, status: 'open', category: 'human_request', channel: 'telegram', customer_label: 'Amina', latest_reply: null, has_earlier: false, context: [] }
    if (path === `/cases/${caseId}/drafts` || path === `/cases/${caseId}/drafts/manual` || path === `/cases/${caseId}/drafts/${draftId}/revise`) return { draft_id: draftId, based_on_version: 3, text: 'Exact customer text.', source: 'ai', expires_at: new Date(Date.now() + 60_000).toISOString() }
    if (path === `/cases/${caseId}/replies`) return { reply_id: replyId, state: 'queued', case_version: 4 }
    if (path === `/replies/${replyId}`) return { reply_id: replyId, case_id: caseId, state: 'queued', delivery: 'unsupported', error_category: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), submitted_at: null, delivered_at: null, failed_at: null }
    if (path === `/cases/${caseId}/resolve`) return { case_id: caseId, status: 'resolved', resolved_at: new Date().toISOString(), version: 5, unknown_reply_acknowledged: false, cancelled_reply_ids: [] }
    return {}
  }
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const parsed = new URL(url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    calls.push({ url, init: init ?? {}, body })
    if (parsed.pathname.endsWith('/sessions/current')) return new Response(null, { status: 204 })
    const route = parsed.pathname.replace('/api/v1/glance', '') + parsed.search
    return new Response(JSON.stringify({ data: responseFor(route) }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }
  const client = new GlanceApiClient('https://api.example/api/v1/glance', store, fetcher)

  const paired = await client.exchangePairing('0123456789AB', 'G2 device')
  store.save(paired)
  await client.getInbox()
  await client.getCase(caseId)
  await client.createDraft(caseId, 3, '33333333-3333-4333-8333-333333333333')
  await client.createManualDraft(caseId, 3, 'Owner text.', '44444444-4444-4444-8444-444444444444')
  await client.reviseDraft(caseId, draftId, 3, 'Make it shorter.', '55555555-5555-4555-8555-555555555555')
  await client.approveReply(caseId, 3, draftId, 'Exact customer text.', '66666666-6666-4666-8666-666666666666')
  await client.getReply(replyId)
  await client.resolveCase(caseId, { expected_version: 4, reason: 'customer_updated', acknowledge_unknown_reply: false })
  await client.revokeCurrentSession()

  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname.replace('/api/v1/glance', ''), call.init.method]), [
    ['/pairing/exchange', 'POST'], ['/inbox', 'GET'], [`/cases/${caseId}`, 'GET'],
    [`/cases/${caseId}/drafts`, 'POST'], [`/cases/${caseId}/drafts/manual`, 'POST'],
    [`/cases/${caseId}/drafts/${draftId}/revise`, 'POST'], [`/cases/${caseId}/replies`, 'POST'],
    [`/replies/${replyId}`, 'GET'], [`/cases/${caseId}/resolve`, 'POST'], ['/sessions/current', 'DELETE'],
  ])
  assert.deepEqual(calls[3].body, { expected_version: 3 })
  assert.deepEqual(calls[4].body, { expected_version: 3, text: 'Owner text.' })
  assert.deepEqual(calls[5].body, { expected_version: 3, instruction: 'Make it shorter.' })
  assert.deepEqual(calls[6].body, { expected_version: 3, draft_id: draftId, text: 'Exact customer text.' })
  assert.equal(new Headers(calls[3].init.headers).get('Idempotency-Key'), '33333333-3333-4333-8333-333333333333')
  assert.equal(new Headers(calls[6].init.headers).get('Idempotency-Key'), '66666666-6666-4666-8666-666666666666')
  assert.equal(calls[0].body?.salon_id, undefined)
  assert.equal(calls[6].body?.recipient, undefined)
  assert.equal(store.load(), null)
})
