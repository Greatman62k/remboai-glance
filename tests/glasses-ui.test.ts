import assert from 'node:assert/strict'
import test from 'node:test'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import {
  actionFooter,
  APPROVAL_LINES_PER_PAGE,
  BODY_LINES,
  buildGlassesPage,
  CHARS_PER_LINE,
  fitDisplay,
  glassesPageText,
  glassesPageToPayload,
  glassesPagesHaveSameLayout,
  paginateGlassesApprovalText,
  paginateGlassesDisplayText,
  type GlassesState,
} from '../src/glasses-ui.ts'
import { DemoFixtures, FIXTURE_CASE_ID, FIXTURE_UNKNOWN_CASE_ID } from '../src/demo-fixtures.ts'
import type { ReplyData } from '../src/types.ts'

function makeState(overrides: Partial<GlassesState> = {}): GlassesState {
  return {
    screen: 'pair',
    fixtureMode: true,
    connection: 'development-fixtures',
    sessionPresent: false,
    salonName: 'Synthetic cases',
    inbox: null,
    schedule: null,
    scheduleOffset: 0,
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

  if (lists.length) {
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
  const draft = {
    draft_id: 'approval-review-draft',
    based_on_version: caseData.version,
    text: exactText,
    source: 'owner' as const,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }
  const approval = buildGlassesPage(makeState({
    screen: 'approval', caseData, draft, editorText: exactText, approvalText: exactText,
  }))
  assert.match(glassesPageText(approval), /Private exact outgoing message must be reviewed\s+before sending/)
  assert.match(glassesPageText(approval), /Exact reply 1\/1 \| Not sent/)
  assert.match(glassesPageText(approval), /Reviewed 0\/1 pages/)
  assert.match(glassesPageText(approval), /Swipe to confirm/)

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
    if (state === 'submitted') assert.match(text, /Delivery not confirmed/)
    assert.doesNotMatch(text, /Delivered/)
  }
  const telegramDelivered = buildGlassesPage(makeState({ screen: 'status', caseData: queuedCase, reply: reply('delivered') }))
  assert.match(glassesPageText(telegramDelivered), /Delivery unverifiable/)
  assert.doesNotMatch(glassesPageText(telegramDelivered), /Delivery receipt confirmed|Delivered/)
})

test('exact approval pages stay within the configured 576x288 body line budget', () => {
  const exactText = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')
  const pages = paginateGlassesApprovalText(exactText)
  assert.ok(pages.length > 1)
  assert.ok(pages.every((page) => page.split('\n').length <= APPROVAL_LINES_PER_PAGE))
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
  assert.match(page.textObject[0].content ?? '', /Display copy too long/)
  assert.doesNotMatch(JSON.stringify(page.menuObject), /ASCII copy/)
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

test('unknown reply status and resolution warning stay concise and actionable', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const caseData = await fixtures.getCase(FIXTURE_UNKNOWN_CASE_ID)
  assert.ok(caseData.latest_reply)
  const reply = await fixtures.getReply(caseData.latest_reply.reply_id)
  const status = buildGlassesPage(makeState({ screen: 'status', caseData, reply }))
  const statusText = glassesPageText(status)
  assert.match(statusText, /Status uncertain/)
  assert.match(statusText, /Glance will not resend it automatically/)
  assert.doesNotMatch(statusText, /Customer may have received it/)

  const resolve = buildGlassesPage(makeState({ screen: 'resolve', caseData }))
  const resolveText = glassesPageText(resolve)
  assert.match(resolveText, /Customer may or may not have received it/)
  assert.match(resolveText, /Menu: acknowledge/)
  assert.match(JSON.stringify(resolve.menuObject), /Acknowledge uncertainty/)
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

  assert.match(firstText, /Message 1\/10/)
  assert.match(firstText, /The owner is checking the request/)
  assert.match(middleText, /Message 2\/10/)
  assert.match(middleText, /I am nearby now/)
  assert.notEqual(firstText, middleText)
  assert.match(olderText, /Message 3\/10/)
  assert.match(olderText, /I've shared the question with the owner/)
  const earlier = glassesPageText(buildGlassesPage(makeState({ screen: 'case', caseData, messagePage: 5 })))
  assert.match(earlier, /Message 6\/10/)
  assert.match(earlier, /I can come before five if that works/)
  assert.match(lastText, /Message 10\/10 \| Earlier hidden/)
  assert.match(lastText, /Hello, I wanted to ask about coming/)

  const singleEvent = {
    ...caseData,
    has_earlier: false,
    context: [caseData.context[0]],
  }
  const single = glassesPageText(buildGlassesPage(makeState({ screen: 'case', caseData: singleEvent, messagePage: 8 })))
  assert.match(single, /Message 1\/1/)
  assert.match(single, /Hello, I wanted to ask about coming/)

  const empty = glassesPageText(buildGlassesPage(makeState({
    screen: 'case', caseData: { ...caseData, context: [], has_earlier: false }, messagePage: 8,
  })))
  assert.match(empty, /No messages/)
  assert.match(empty, /No customer-visible messages/)
})

test('G2 inbox rows lead with severity and selected case gets a readable summary', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const inbox = await fixtures.getInbox()
  const ordinary = { ...inbox.items[0], category: 'human_request', customer_label: 'Amina' }
  const urgent = { ...inbox.items[1], category: 'emergency', customer_label: 'Urgent customer', preview: 'Please help with an urgent request.' }
  const page = buildGlassesPage(makeState({
    screen: 'inbox',
    inbox: { ...inbox, open_count: 2, has_more: false, items: [ordinary, urgent] },
    selectedIndex: 1,
  }))
  const text = glassesPageText(page)
  const rows = page.listObject?.[0].itemContainer?.itemName ?? []
  assert.match(text, /2 Open \| ! 1 urgent/)
  assert.match(rows[0], /^○ Amina \| Owner request \|/)
  assert.match(rows[1], /^! Urgent customer \| Emergency \|/)
  assert.match(text, /▶ 2\/2 \| Urgent \| Telegram/)
  assert.match(text, /Please help with an urgent request\./)
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
  const updatedContext = selectedCase.context.map((message, index) => index === 0
    ? { ...message, text: `${message.text} Updated.` }
    : message)
  const changedCasePage = buildGlassesPage(makeState({
    screen: 'case', caseData: { ...selectedCase, context: updatedContext },
  }))
  assert.equal(glassesPagesHaveSameLayout(casePage, changedCasePage), true)
  assert.equal(glassesPagesHaveSameLayout(casePage,
    buildGlassesPage(makeState({ screen: 'case', caseData: selectedCase, stale: true }))), false)

  const voiceReady = buildGlassesPage(makeState({ screen: 'voice', caseData: selectedCase, voicePhase: 'idle' }))
  const recording = buildGlassesPage(makeState({ screen: 'voice', caseData: selectedCase, voicePhase: 'recording' }))
  assert.equal(glassesPagesHaveSameLayout(voiceReady, recording), false)

  const schedule = await fixtures.getSchedule()
  const schedulePage = buildGlassesPage(makeState({ screen: 'schedule', schedule, scheduleOffset: 20 }))
  const updatedSchedule = {
    ...schedule,
    items: schedule.items.map((item, index) => index === 1 ? { ...item, customer_label: 'Nia updated' } : item),
  }
  const nextSchedulePage = buildGlassesPage(makeState({ screen: 'schedule', schedule: updatedSchedule, scheduleOffset: 20 }))
  assert.equal(schedulePage.layoutKey, 'choices-schedule')
  assert.equal(glassesPagesHaveSameLayout(schedulePage, nextSchedulePage), false)
})

test('G2 header and action helpers retain alert-first order and drop an overflowing hint', () => {
  const header = fitDisplay('▲ Action needed | Glance | AI suggestion 1/10 | Not sent')
  assert.ok(header.length <= CHARS_PER_LINE)
  assert.match(header, /^▲ Action needed \| Glance/)

  const shortFooter = actionFooter(0, 2, 'Confirm', 'Double select')
  const longFooter = actionFooter(0, 2, 'Acknowledge uncertainty', 'Swipe reason')
  assert.match(shortFooter, /Double select/)
  assert.doesNotMatch(longFooter, /Swipe reason/)
  assert.ok(shortFooter.length <= CHARS_PER_LINE)
  assert.ok(longFooter.length <= CHARS_PER_LINE)
})

test('long inbox and schedule alert headers stay glyph-safe and fit the display width', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const inbox = await fixtures.getInbox()
  const schedule = await fixtures.getSchedule()
  const pages = [
    buildGlassesPage(makeState({
      screen: 'inbox', inbox, connection: 'offline', inboxStale: true, error: 'Synthetic network error.',
    })),
    buildGlassesPage(makeState({
      screen: 'schedule', schedule, connection: 'offline', error: 'Synthetic network error.',
    })),
  ]
  for (const page of pages) {
    const header = page.textObject[0].content ?? ''
    assert.ok([...header].length <= CHARS_PER_LINE, `${page.screen} header exceeded ${CHARS_PER_LINE} characters`)
    assert.match(header, page.screen === 'inbox'
      ? /^▲ Action needed \| Glance demo/
      : /^▲ Action needed \| Schedule/)
    assert.doesNotMatch(header, /\? Action needed/)
  }
})

test('G2 body text respects the shared 52-character and five-line layout budgets', async () => {
  const fixtures = new DemoFixtures()
  fixtures.startDemo()
  const inbox = await fixtures.getInbox()
  const caseData = await fixtures.getCase(FIXTURE_CASE_ID)
  const measureBody = (page: ReturnType<typeof buildGlassesPage>) => {
    const body = page.textObject.find((container) => container.containerName === 'g2-main')?.content ?? ''
    const lines = body.split('\n')
    assert.ok(lines.length <= BODY_LINES, `${page.screen} had ${lines.length} body lines`)
    assert.ok(lines.every((line) => [...line].length <= CHARS_PER_LINE), `${page.screen} had a line over ${CHARS_PER_LINE} characters`)
    return body
  }

  const longCase = {
    ...caseData,
    has_earlier: true,
    context: [{ ...caseData.context[0], actor: 'assistant' as const, text: 'x'.repeat(160) }],
  }
  const caseBody = measureBody(buildGlassesPage(makeState({ screen: 'case', caseData: longCase })))
  assert.match(caseBody, /^\(RemboAI\)\n+x+/)
  assert.ok(caseBody.split('\n').length <= BODY_LINES)

  const longDraft = '…'.repeat(700)
  const draftPage = buildGlassesPage(makeState({
    screen: 'draft', caseData, stale: true,
    draft: { draft_id: 'synthetic-long', based_on_version: caseData.version, text: longDraft, source: 'ai', expires_at: '2000-01-01T00:00:00Z' },
    editorText: longDraft,
  }))
  const draftBody = measureBody(draftPage)
  assert.match(draftBody, /^\.{52}/)
  assert.match(draftPage.textObject[0].content ?? '', /^▲ Case changed \| Draft stale/)
  assert.ok(paginateGlassesDisplayText(longDraft, BODY_LINES - 1).length > 1)

  const transcript = 'The owner can confirm whether walk-ins are available this afternoon. '.repeat(8)
  const transcriptBody = measureBody(buildGlassesPage(makeState({
    screen: 'voice', caseData, voicePhase: 'transcript_ready', voiceTranscript: transcript,
    voiceSimulation: true, draft: null, editorText: '',
  })))
  assert.match(transcriptBody, /^The owner can confirm/)
  assert.match(JSON.stringify(buildGlassesPage(makeState({
    screen: 'voice', caseData, voicePhase: 'transcript_ready', voiceTranscript: transcript,
    voiceSimulation: true, draft: null, editorText: '',
  })).menuObject), /Draft needed/)

  const approvalBody = measureBody(buildGlassesPage(makeState({
    screen: 'approval', caseData, stale: true, approvalText: 'Exact outgoing text '.repeat(40),
  })))
  assert.match(approvalBody, /^Exact outgoing text/)
  assert.match(buildGlassesPage(makeState({ screen: 'approval', caseData, stale: true })).textObject[0].content ?? '', /^▲ Case changed \| Stop review/)
})
