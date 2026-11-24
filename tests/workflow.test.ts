import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { DemoFixtures, FIXTURE_CASE_ID, FIXTURE_UNKNOWN_CASE_ID } from '../src/demo-fixtures.ts'
import { parseEvenHubEvent, PhysicalPressDeduplicator } from '../src/evenhub-events.ts'
import {
  IdempotencyKeyBook,
  caseIsStale,
  messagePage,
  moreCaseCount,
  normalizeOwnerText,
  presentReplyState,
  replyPollDelay,
  shouldPollReply,
  sortInboxOldestFirst,
} from '../src/workflow.ts'

const uuid = () => '11111111-1111-4111-8111-111111111111'

test('inbox ordering, more count, fixed context chunks, and version stale checks', () => {
  const items = [
    { case_id: 'later', created_at: '2026-01-02T00:00:00Z' },
    { case_id: 'older', created_at: '2026-01-01T00:00:00Z' },
  ] as never[]
  assert.deepEqual(sortInboxOldestFirst(items).map((item) => item.case_id), ['older', 'later'])
  assert.equal(moreCaseCount(27, 20), 7)
  assert.deepEqual(messagePage([0, 1, 2, 3, 4, 5, 6], 2, 3), [6])
  assert.equal(caseIsStale({ version: 4 } as never, 5), true)
  assert.equal(caseIsStale({ version: 4 } as never, 4), false)
})

test('owner text normalization enforces length and strips only surrounding whitespace', () => {
  assert.equal(normalizeOwnerText('  Thanks!  ', 20), 'Thanks!')
  assert.throws(() => normalizeOwnerText('   ', 20), /1 to 20/)
  assert.throws(() => normalizeOwnerText('A\u0000B', 20), /control character/)
  assert.throws(() => normalizeOwnerText('abcd', 3), /1 to 3/)
})

test('idempotency key is reused for the same payload and blocks a conflicting retry', () => {
  const keys = new IdempotencyKeyBook()
  let generated = 0
  const create = () => { generated += 1; return uuid() }
  const first = keys.acquire('case:ai-draft', { expected_version: 3 }, create)
  const repeated = keys.acquire('case:ai-draft', { expected_version: 3 }, create)
  assert.equal(first, repeated)
  assert.equal(generated, 1)
  assert.throws(() => keys.acquire('case:ai-draft', { expected_version: 4 }, create), /uncertain outcome/)
  keys.complete('case:ai-draft')
  assert.equal(keys.acquire('case:ai-draft', { expected_version: 4 }, create), uuid())
  assert.equal(generated, 2)
})

test('pending idempotency key and payload binding survive a WebView reload', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const firstPage = new IdempotencyKeyBook(storage)
  const key = firstPage.acquire('approve:case-1', { text: 'Exact message' }, () => uuid())
  const reloadedPage = new IdempotencyKeyBook(storage)
  assert.equal(reloadedPage.acquire('approve:case-1', { text: 'Exact message' }), key)
  assert.throws(() => reloadedPage.acquire('approve:case-1', { text: 'Changed message' }), /uncertain outcome/)
  reloadedPage.complete('approve:case-1')
  assert.equal(values.size, 0)
})

test('reply labels preserve provider acceptance versus delivery and bounded polling', () => {
  assert.equal(presentReplyState('queued', 'telegram').label, 'Queued')
  assert.equal(presentReplyState('sending', 'telegram').label, 'Sending')
  assert.match(presentReplyState('submitted', 'telegram').label, /delivery not confirmed/i)
  assert.match(presentReplyState('delivered', 'whatsapp').label, /receipt confirmed/i)
  assert.match(presentReplyState('delivered', 'telegram').label, /delivery not confirmed/i)
  assert.match(presentReplyState('delivered', 'whatsapp').label, /receipt confirmed/i)
  assert.equal(presentReplyState('failed', 'telegram').label, 'Failed to send')
  assert.match(presentReplyState('unknown', 'telegram').label, /uncertain/i)
  assert.match(presentReplyState('cancelled', 'telegram').label, /not sent/i)
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(replyPollDelay), [1000, 2000, 4000, 8000, 15000, 15000])
  assert.equal(shouldPollReply('queued'), true)
  assert.equal(shouldPollReply('unknown'), false)
})

test('Even Hub envelope parser distinguishes click, scroll, double-click, and lifecycle events', () => {
  const click = parseEvenHubEvent({ sysEvent: { eventSource: 1 } })
  const explicitZeroClick = parseEvenHubEvent({ textEvent: { containerID: 2, eventType: 0 } })
  const listClick = parseEvenHubEvent({ listEvent: { containerID: 2, currentSelectItemIndex: 0 } })
  const omittedListZeroClick = parseEvenHubEvent({ listEvent: { containerID: 2 } })
  const selectedDoubleClick = parseEvenHubEvent({
    sysEvent: { eventType: 3, eventSource: 1 },
    listEvent: { containerID: 2, currentSelectItemIndex: 2, currentSelectItemName: 'Kendi' },
  })
  const scroll = parseEvenHubEvent({ sysEvent: { eventType: 1, eventSource: 2 } })
  const double = parseEvenHubEvent({ sysEvent: { eventType: 3, eventSource: 2 } })
  const foreground = parseEvenHubEvent({ sysEvent: { eventType: 5, eventSource: 2 } })
  const sdkEnvelope = parseEvenHubEvent({ jsonData: { containerID: 2, containerName: 'text-1', eventType: 2 }, textEvent: { containerID: 2, containerName: 'text-1', eventType: 2 } })
  assert.equal(click?.kind, 'click')
  assert.equal(explicitZeroClick?.kind, 'click')
  assert.equal(listClick?.kind, 'click')
  if (listClick?.kind === 'click') assert.equal(listClick.selectedIndex, 0)
  assert.equal(omittedListZeroClick?.kind, 'click')
  if (omittedListZeroClick?.kind === 'click') assert.equal(omittedListZeroClick.selectedIndex, undefined)
  assert.equal(selectedDoubleClick?.kind, 'double_click')
  if (selectedDoubleClick?.kind === 'double_click') {
    assert.equal(selectedDoubleClick.selectedIndex, 2)
    assert.equal(selectedDoubleClick.selectedItemName, 'Kendi')
  }
  assert.equal(scroll?.kind, 'scroll_up')
  assert.equal(double?.kind, 'double_click')
  assert.equal(foreground?.kind, 'foreground_exit')
  assert.equal(sdkEnvelope?.kind, 'scroll_down')
  assert.equal(parseEvenHubEvent({ textEvent: {} }), null)
  assert.equal(parseEvenHubEvent({ sysEvent: {} }), null)
  assert.equal(parseEvenHubEvent({}), null)

  const pcm = new Uint8Array([1, 2, 3, 4])
  const audio = parseEvenHubEvent({ audioEvent: { audioPcm: pcm, source: AudioInputSource.Glasses } })
  assert.equal(audio?.kind, 'audio')
  if (audio?.kind === 'audio') {
    assert.equal(audio.source, AudioInputSource.Glasses)
    assert.equal(audio.pcm, pcm)
  }
})

test('physical press deduplication drops cross-envelope echoes but preserves same-envelope presses', () => {
  const dedupe = new PhysicalPressDeduplicator(1_200)
  const systemClick = { kind: 'click', source: null, envelope: 'sysEvent' } as const
  const textClick = { kind: 'click', source: null, envelope: 'textEvent' } as const
  assert.equal(dedupe.accept(systemClick, 1_000), true)
  assert.equal(dedupe.accept(systemClick, 1_100), true)
  assert.equal(dedupe.accept(textClick, 1_200), false)
  assert.equal(dedupe.accept(textClick, 1_300), true)
  assert.equal(dedupe.accept(systemClick, 2_600), true)
})

test('synthetic inbox and detail fixtures are clearly isolated and include look-ahead context', async () => {
  const demo = new DemoFixtures()
  demo.startDemo()
  const inbox = await demo.getInbox()
  assert.equal(inbox.items.length, 3)
  assert.equal(inbox.items[0].case_id, FIXTURE_CASE_ID)
  const detail = await demo.getCase(FIXTURE_CASE_ID)
  assert.equal(detail.context.length, 10)
  assert.equal(detail.has_earlier, true)
  assert.equal(detail.context.at(-1)?.sequence, 11)
  assert.equal(detail.customer_label, 'Amina')
})

test('AI draft, revision provenance, and retry preserve one persisted draft until revision succeeds', async () => {
  const demo = new DemoFixtures()
  demo.startDemo()
  const draft = await demo.createDraft(FIXTURE_CASE_ID, 3, 'ai-generation-key')
  assert.equal(draft.source, 'ai')
  assert.match(draft.text, /confirming today.s availability/i)
  const same = await demo.createDraft(FIXTURE_CASE_ID, 3, 'ai-generation-key')
  assert.equal(same.draft_id, draft.draft_id)
  await assert.rejects(demo.createDraft(FIXTURE_CASE_ID, 4, 'ai-generation-key'), (error: any) => error.code === 'idempotency_conflict')
  await assert.rejects(demo.reviseDraft(FIXTURE_CASE_ID, draft.draft_id, 4, 'shorter', 'revision-key'), (error: any) => error.code === 'stale_case_version')
  const next = await demo.reviseDraft(FIXTURE_CASE_ID, draft.draft_id, 3, 'make it shorter', 'revision-key')
  assert.notEqual(next.draft_id, draft.draft_id)
  assert.equal(next.source, 'ai')
  await assert.rejects(demo.reviseDraft(FIXTURE_CASE_ID, draft.draft_id, 3, 'again', 'new-key'), (error: any) => error.code === 'draft_not_found')
})

test('manual draft is persisted as owner-authored before exact approval; retries do not increment version twice', async () => {
  const demo = new DemoFixtures()
  demo.startDemo()
  const caseData = await demo.getCase(FIXTURE_CASE_ID)
  const manual = await demo.createManualDraft(FIXTURE_CASE_ID, caseData.version, 'I will check and update you shortly.', 'manual-key')
  assert.equal(manual.source, 'owner')
  assert.equal((await demo.createManualDraft(FIXTURE_CASE_ID, caseData.version, manual.text, 'manual-key')).draft_id, manual.draft_id)
  const approved = await demo.approveReply(FIXTURE_CASE_ID, 3, manual.draft_id, manual.text, 'approval-key')
  assert.equal(approved.state, 'queued')
  assert.equal(approved.case_version, 4)
  const replay = await demo.approveReply(FIXTURE_CASE_ID, 3, manual.draft_id, manual.text, 'approval-key')
  assert.deepEqual(replay, approved)
  assert.equal((await demo.getCase(FIXTURE_CASE_ID)).version, 4)
  const another = await demo.createManualDraft(FIXTURE_CASE_ID, 4, 'Another reply.', 'another-manual-key')
  await assert.rejects(demo.approveReply(FIXTURE_CASE_ID, 4, another.draft_id, another.text, 'second-approval'), (error: any) => error.code === 'unresolved_reply_exists')
  await assert.rejects(demo.approveReply(FIXTURE_CASE_ID, 3, manual.draft_id, 'different text', 'approval-key'), (error: any) => error.code === 'idempotency_conflict')
})

test('reply status progresses and unknown replies require separate acknowledgement; queued resolve cancels', async () => {
  const demo = new DemoFixtures()
  demo.startDemo()
  const unknownCase = await demo.getCase(FIXTURE_UNKNOWN_CASE_ID)
  await assert.rejects(demo.resolveCase(FIXTURE_UNKNOWN_CASE_ID, {
    expected_version: unknownCase.version,
    reason: 'customer_updated',
    acknowledge_unknown_reply: false,
  }), (error: any) => error.code === 'unknown_reply_requires_acknowledgement')
  const resolved = await demo.resolveCase(FIXTURE_UNKNOWN_CASE_ID, {
    expected_version: unknownCase.version,
    reason: 'customer_updated',
    acknowledge_unknown_reply: true,
  })
  assert.equal(resolved.unknown_reply_acknowledged, true)
  const repeated = await demo.resolveCase(FIXTURE_UNKNOWN_CASE_ID, {
    expected_version: 1,
    reason: 'customer_updated',
    acknowledge_unknown_reply: true,
  })
  assert.equal(repeated.version, resolved.version)

  const caseData = await demo.getCase(FIXTURE_CASE_ID)
  const draft = await demo.createDraft(FIXTURE_CASE_ID, caseData.version, 'generation')
  const result = await demo.approveReply(FIXTURE_CASE_ID, caseData.version, draft.draft_id, draft.text, 'approval')
  assert.equal((await demo.getReply(result.reply_id)).state, 'sending')
  assert.equal((await demo.getReply(result.reply_id)).state, 'submitted')

  const depositId = '68606ee1-a125-4c25-876a-75256809a134'
  const deposit = await demo.getCase(depositId)
  const canceled = await demo.resolveCase(depositId, {
    expected_version: deposit.version,
    reason: 'no_action_needed',
    acknowledge_unknown_reply: false,
  })
  assert.deepEqual(canceled.cancelled_reply_ids, [deposit.latest_reply?.reply_id])
  assert.equal((await demo.getReply(deposit.latest_reply!.reply_id)).state, 'cancelled')
})
