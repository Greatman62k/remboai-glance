import assert from 'node:assert/strict'
import test from 'node:test'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import {
  buildGlassesPage,
  glassesPageText,
  glassesPageToPayload,
  glassesPagesHaveSameLayout,
  paginateGlassesApprovalText,
  type GlassesState,
} from '../src/glasses-ui.ts'
import { DemoFixtures, FIXTURE_CASE_ID } from '../src/demo-fixtures.ts'
import type { ReplyData } from '../src/types.ts'

function makeState(overrides: Partial<GlassesState> = {}): GlassesState {
  return {
    screen: 'pair',
    fixtureMode: true,
    connection: 'development-fixtures',
    sessionPresent: false,
    salonName: 'Synthetic cases',
    inbox: null,
    inboxStale: false,
    newCaseAvailable: false,
    selectedIndex: 0,
    caseData: null,
    stale: false,
    messagePage: 0,
    draftPage: 0,
    transcriptPage: 0,
    draft: null,
    editorText: '',
    revisionInstruction: '',
    approvalText: '',
    reviewedExactText: false,
    approvalPage: 0,
    approvalProgress: 0,
    approvalStage: 'review',
    reply: null,
    busy: false,
    busyAction: '',
    error: '',
    requestId: null,
    retryAfter: null,
    errorCode: null,
    message: '',
    resolveReason: 'handled_in_person',
    resolveNote: '',
    acknowledgedUnknown: false,
    focusedAction: 0,
    manualMode: false,
    voicePhase: 'idle',
    voiceDurationMs: 0,
    voiceTranscriptionDurationMs: null,
    voiceTranscript: '',
    voiceSimulation: true,
    voiceError: '',
    glassesAvailable: false,
    glassesStatus: 'Bridge not connected',
    ...overrides,
  }
}

function assertNativePage(page: ReturnType<typeof buildGlassesPage>): void {
  const payload = glassesPageToPayload(page)
  const text = payload.textObject
  const lists = payload.listObject ?? []
  const containers = [...text, ...lists]
  assert.equal(payload.containerTotalNum, containers.length)
  assert.ok(payload.containerTotalNum > 0 && payload.containerTotalNum <= 12)
  assert.ok(text.length <= 8)
  assert.ok(text.length + lists.length <= 8)
  assert.ok(containers.every((container) =>
    (container.xPosition ?? -1) >= 0 && (container.yPosition ?? -1) >= 0 &&
    (container.width ?? 0) > 0 && (container.height ?? 0) > 0 &&
    (container.xPosition ?? 0) + (container.width ?? 0) <= 576 &&
    (container.yPosition ?? 0) + (container.height ?? 0) <= 288))
  const ids = containers.map((container) => container.containerID)
  const names = containers.map((container) => container.containerName)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.every((name) => Boolean(name) && name!.length <= 16))
  assert.equal(containers.filter((container) => container.isEventCapture === 1).length, 1)
  assert.ok(text.every((container) => container.textColor === undefined || (container.textColor >= 0 && container.textColor <= 4)))
  assert.deepEqual(validateEvenHubPageContainer(payload), { valid: true })

  if (page.layoutKey === 'list') {
    assert.equal(lists.length, 1)
    assert.equal(lists[0].isEventCapture, 1)
    assert.ok(text.every((container) => container.isEventCapture !== 1))
    const items = lists[0].itemContainer!
    assert.equal(items.itemCount, items.itemName?.length)
    assert.ok((items.itemCount ?? 0) > 0 && (items.itemCount ?? 0) <= 20)
    assert.ok((items.itemWidth ?? 0) <= (lists[0].width ?? 0))
    assert.ok(items.itemName?.every((name) => name.length <= 64))
  } else {
    assert.equal(lists.length, 0)
    assert.equal(text.filter((container) => container.isEventCapture === 1)[0]?.containerName, 'g2-main')
  }
}

test('all eight G2 screens use bounded SDK-native layouts with one capture target', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const inbox = await fixtures.getInbox()
  const caseData = await fixtures.getCase(FIXTURE_CASE_ID)
  const draft = await fixtures.createDraft(caseData.case_id, caseData.version, 'screen-structure')
  const queuedCase = await fixtures.getCase(inbox.items[1].case_id)
  const reply: ReplyData = {
    reply_id: queuedCase.latest_reply!.reply_id,
    case_id: queuedCase.case_id,
    state: 'queued',
    delivery: 'unconfirmed',
    error_category: null,
    created_at: queuedCase.latest_reply!.updated_at,
    updated_at: queuedCase.latest_reply!.updated_at,
    submitted_at: null,
    delivered_at: null,
    failed_at: null,
  }

  const pages = [
    buildGlassesPage(makeState({ screen: 'inbox', inbox })),
    buildGlassesPage(makeState({ screen: 'case', caseData })),
    buildGlassesPage(makeState({ screen: 'draft', caseData, draft })),
    buildGlassesPage(makeState({ screen: 'voice', caseData, voicePhase: 'idle' })),
    buildGlassesPage(makeState({ screen: 'voice', caseData, voicePhase: 'recording', voiceDurationMs: 8_000 })),
    buildGlassesPage(makeState({
      screen: 'voice', caseData, voicePhase: 'transcript_ready',
      voiceTranscript: 'The owner can confirm whether walk-ins are available this afternoon.',
    })),
    buildGlassesPage(makeState({ screen: 'status', caseData: queuedCase, reply })),
  ]
  await fixtures.resolveCase(FIXTURE_CASE_ID, {
    expected_version: caseData.version,
    reason: 'handled_in_person',
    acknowledge_unknown_reply: false,
  })
  const confirmedResolved = await fixtures.getCase(FIXTURE_CASE_ID)
  pages.push(buildGlassesPage(makeState({ screen: 'case', caseData: confirmedResolved })))

  assert.deepEqual(pages.map((page) => page.screen), [
    'inbox', 'case', 'draft', 'voice-ready', 'voice-recording',
    'transcript-preview', 'reply-status', 'case-resolved',
  ])
  for (const page of pages) assertNativePage(page)
})

test('G2 approval displays the exact outgoing text while Telegram status never claims delivery', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const caseData = await fixtures.getCase(FIXTURE_CASE_ID)
  const exactText = 'Private exact outgoing message must be reviewed before sending.'
  const approval = buildGlassesPage(makeState({
    screen: 'approval', caseData, approvalText: exactText,
  }))
  assert.match(glassesPageText(approval), /Private exact outgoing message must be reviewed\s+before sending/)
  assert.match(glassesPageText(approval), /REPLY 1\/1  \|  EXACT FINAL TEXT/)
  assert.match(glassesPageText(approval), /PROGRESS 0\/1 PAGES COMPLETE/)
  assert.match(glassesPageText(approval), /SWIPE DOWN FOR FINAL CONFIRMATION/)

  const queuedCase = await fixtures.getCase((await fixtures.getInbox()).items[1].case_id)
  const reply = (state: ReplyData['state']): ReplyData => ({
    reply_id: queuedCase.latest_reply!.reply_id,
    case_id: queuedCase.case_id,
    state,
    delivery: 'unconfirmed',
    error_category: null,
    created_at: queuedCase.latest_reply!.updated_at,
    updated_at: queuedCase.latest_reply!.updated_at,
    submitted_at: state === 'submitted' ? queuedCase.latest_reply!.updated_at : null,
    delivered_at: null,
    failed_at: null,
  })
  for (const state of ['queued', 'submitted'] as const) {
    const page = buildGlassesPage(makeState({ screen: 'status', caseData: queuedCase, reply: reply(state) }))
    const text = glassesPageText(page)
    if (state === 'submitted') assert.match(text, /DELIVERY NOT CONFIRMED/)
    assert.doesNotMatch(text, /DELIVERED/)
  }
  const telegramDelivered = buildGlassesPage(makeState({ screen: 'status', caseData: queuedCase, reply: reply('delivered') }))
  assert.match(glassesPageText(telegramDelivered), /DELIVERY UNVERIFIABLE/)
  assert.doesNotMatch(glassesPageText(telegramDelivered), /DELIVERY RECEIPT CONFIRMED|DELIVERED/)
})

test('exact approval pages contain at most three wrapped text lines for the 576x288 layout', () => {
  const exactText = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')
  const pages = paginateGlassesApprovalText(exactText)
  assert.ok(pages.length > 1)
  assert.ok(pages.every((page) => page.split('\n').length <= 3))
  assert.equal(pages.join(' ').replace(/\s+/g, ' '), exactText)
})

test('display-safe draft copy is offered only within the manual-draft limit', async () => {
  const longText = 'é'.repeat(701)
  const state = makeState({
    screen: 'draft',
    draft: {
      draft_id: 'long-unicode-draft', based_on_version: 3, text: longText, source: 'ai',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    editorText: longText,
  })
  const page = buildGlassesPage(state)
  const content = glassesPageText(page)
  assert.match(content, /DISPLAY COPY EXCEEDS 700 CHARS/)
  assert.doesNotMatch(content, /CREATE ASCII COPY/)
})

test('open fixture cases remain open until the synthetic resolver confirms them', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const openCase = await fixtures.getCase(FIXTURE_CASE_ID)
  assert.equal(buildGlassesPage(makeState({ screen: 'case', caseData: openCase })).screen, 'case')

  const result = await fixtures.resolveCase(FIXTURE_CASE_ID, {
    expected_version: openCase.version,
    reason: 'handled_in_person',
    acknowledge_unknown_reply: false,
  })
  assert.equal(result.status, 'resolved')
  const resolvedCase = await fixtures.getCase(FIXTURE_CASE_ID)
  assert.equal(buildGlassesPage(makeState({ screen: 'case', caseData: resolvedCase })).screen, 'case-resolved')
})

test('case context pages render different bounded events and clamp missing or single-event pages', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const caseData = await fixtures.getCase(FIXTURE_CASE_ID)
  const first = buildGlassesPage(makeState({ screen: 'case', caseData, messagePage: 0 }))
  const middle = buildGlassesPage(makeState({ screen: 'case', caseData, messagePage: 1 }))
  const older = buildGlassesPage(makeState({ screen: 'case', caseData, messagePage: 2 }))
  const last = buildGlassesPage(makeState({ screen: 'case', caseData, messagePage: 99 }))
  const firstText = glassesPageText(first)
  const middleText = glassesPageText(middle)
  const olderText = glassesPageText(older)
  const lastText = glassesPageText(last)

  assert.match(firstText, /MSG 1\/10/)
  assert.match(firstText, /The owner is checking the request/)
  assert.match(middleText, /MSG 2\/10/)
  assert.match(middleText, /I am nearby now/)
  assert.notEqual(firstText, middleText)
  assert.match(olderText, /MSG 3\/10/)
  assert.match(olderText, /I've shared the question with the owner/)
  const earlier = glassesPageText(buildGlassesPage(makeState({ screen: 'case', caseData, messagePage: 5 })))
  assert.match(earlier, /MSG 6\/10/)
  assert.match(earlier, /I can come before five if that works/)
  assert.match(lastText, /MSG 10\/10  \|  10 VISIBLE/)
  assert.match(lastText, /EARLIER HISTORY OMITTED/)
  assert.match(lastText, /Hello, I wanted to ask about coming/)

  const singleEvent = {
    ...caseData,
    has_earlier: false,
    context: [caseData.context[0]],
  }
  const single = glassesPageText(buildGlassesPage(makeState({ screen: 'case', caseData: singleEvent, messagePage: 8 })))
  assert.match(single, /MSG 1\/1/)
  assert.match(single, /Hello, I wanted to ask about coming/)

  const empty = glassesPageText(buildGlassesPage(makeState({
    screen: 'case', caseData: { ...caseData, context: [], has_earlier: false }, messagePage: 8,
  })))
  assert.match(empty, /MSG 0\/0/)
  assert.match(empty, /NO CUSTOMER-VISIBLE MESSAGES/)
})

test('text updates can reuse stable containers while list and recording geometry changes rebuild', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const inbox = await fixtures.getInbox()
  const selectedCase = await fixtures.getCase(FIXTURE_CASE_ID)

  const inboxPage = buildGlassesPage(makeState({ screen: 'inbox', inbox }))
  const changedInbox = {
    ...inbox,
    items: inbox.items.map((item, index) => index === 0 ? { ...item, customer_label: 'Amina updated' } : item),
  }
  assert.equal(glassesPagesHaveSameLayout(inboxPage, buildGlassesPage(makeState({ screen: 'inbox', inbox: changedInbox }))), false)

  const casePage = buildGlassesPage(makeState({ screen: 'case', caseData: selectedCase }))
  const changedCasePage = buildGlassesPage(makeState({ screen: 'case', caseData: selectedCase, stale: true }))
  assert.equal(glassesPagesHaveSameLayout(casePage, changedCasePage), true)

  const voiceReady = buildGlassesPage(makeState({ screen: 'voice', caseData: selectedCase, voicePhase: 'idle' }))
  const recording = buildGlassesPage(makeState({ screen: 'voice', caseData: selectedCase, voicePhase: 'recording' }))
  assert.equal(glassesPagesHaveSameLayout(voiceReady, recording), false)
})
