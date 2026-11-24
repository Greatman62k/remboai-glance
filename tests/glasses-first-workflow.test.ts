import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { GlanceAppController } from '../src/app.ts'
import { ApiError, type GlanceApi } from '../src/client.ts'
import { paginateGlassesApprovalText } from '../src/glasses-ui.ts'
import { type CaseData, type DraftData, type InboxData, type ReplyData } from '../src/types.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function replaceGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  return () => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)
}

const transcript = Array.from({ length: 70 }, (_, index) => `word${String(index).padStart(3, '0')}`).join(' ')
const initialCase: CaseData = {
  case_id: 'synthetic-case-1', version: 5, status: 'open', category: 'complaint', channel: 'telegram',
  customer_label: 'Synthetic customer', has_earlier: true, latest_reply: null,
  context: Array.from({ length: 10 }, (_, index) => ({
    sequence: index + 2,
    actor: index % 2 === 0 ? 'customer' as const : 'assistant' as const,
    text: index === 8 ? 'The latest customer question is in this context.' : `Synthetic context event ${index + 2}.`,
    created_at: new Date(Date.now() - (10 - index) * 60_000).toISOString(),
  })),
}
const initialInbox: InboxData = {
  items: [{
    case_id: initialCase.case_id, version: initialCase.version, status: 'open', category: initialCase.category,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(), customer_label: initialCase.customer_label,
    channel: initialCase.channel, preview: 'Synthetic customer asks for an update.',
  }], open_count: 1, has_more: false, next_cursor: null,
}

function makeHarness(options: {
  transcript?: string
  failRevision?: boolean
  startingCase?: CaseData
  aiDraftText?: string
  loseApprovalResponseOnce?: boolean
} = {}) {
  const localStorage = new MemoryStorage()
  const sessionStorage = new MemoryStorage()
  const documentMock = {
    visibilityState: 'visible', activeElement: null,
    addEventListener() {}, removeEventListener() {}, querySelector() { return null },
  }
  const windowMock = {
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  }
  const restore = [
    replaceGlobal('localStorage', localStorage),
    replaceGlobal('sessionStorage', sessionStorage),
    replaceGlobal('document', documentMock),
    replaceGlobal('window', windowMock),
  ]
  const root = { innerHTML: '', addEventListener() {}, querySelector() { return null } }
  const app = new GlanceAppController(root as unknown as HTMLElement, 'https://api.example/api/v1/glance')
  app.sessions.save({ access_token: 'synthetic-test-token', expires_at: new Date(Date.now() + 60_000).toISOString(), salon: { name: 'Synthetic salon' } })
  app.state.sessionPresent = true
  app.state.salonName = 'Synthetic salon'
  app.state.connection = 'connected'
  app.state.screen = 'inbox'
  app.state.inbox = structuredClone(initialInbox)
  app.setGlassesAvailable(true)

  let currentCase = structuredClone(options.startingCase ?? initialCase)
  let draftSequence = 0
  let reply: ReplyData | null = null
  const calls: Array<{ name: string; args: unknown[] }> = []
  const makeDraft = (source: 'ai' | 'owner', text: string, version = currentCase.version): DraftData => ({
    draft_id: `draft-${++draftSequence}`, based_on_version: version, text, source,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })
  const api: Partial<GlanceApi> = {
    getInbox: async () => {
      calls.push({ name: 'getInbox', args: [] })
      const items = currentCase.status === 'open' ? structuredClone(initialInbox.items) : []
      return { items, open_count: items.length, has_more: false, next_cursor: null }
    },
    getCase: async (caseId) => {
      calls.push({ name: 'getCase', args: [caseId] })
      return structuredClone(currentCase)
    },
    getCaseStatus: async (caseId) => {
      calls.push({ name: 'getCaseStatus', args: [caseId] })
      return {
        case_id: caseId, status: currentCase.status, version: currentCase.version,
        latest_reply: currentCase.latest_reply ? {
          reply_id: currentCase.latest_reply.reply_id, state: currentCase.latest_reply.state,
          updated_at: currentCase.latest_reply.updated_at,
        } : null,
        case_updated_at: new Date().toISOString(),
      }
    },
    createDraft: async (caseId, expectedVersion, key) => {
      calls.push({ name: 'createDraft', args: [caseId, expectedVersion, key] })
      const result = makeDraft('ai', options.aiDraftText ?? 'Thanks for contacting us. I will check and update you shortly.', expectedVersion)
      return result
    },
    createManualDraft: async (caseId, expectedVersion, text, key) => {
      calls.push({ name: 'createManualDraft', args: [caseId, expectedVersion, text, key] })
      return makeDraft('owner', text, expectedVersion)
    },
    reviseDraft: async (caseId, draftId, expectedVersion, instruction, key) => {
      calls.push({ name: 'reviseDraft', args: [caseId, draftId, expectedVersion, instruction, key] })
      if (options.failRevision) throw new ApiError('draft_unavailable', 503, 'safe failure')
      return makeDraft('ai', 'Thanks. I will check and get back to you shortly.', expectedVersion)
    },
    transcribeAudio: async (pcm) => {
      calls.push({ name: 'transcribeAudio', args: [pcm.byteLength] })
      return { transcript: options.transcript ?? transcript, duration_ms: 1_250 }
    },
    approveReply: async (caseId, expectedVersion, draftId, text, key) => {
      calls.push({ name: 'approveReply', args: [caseId, expectedVersion, draftId, text, key] })
      const created = new Date().toISOString()
      reply = {
        reply_id: 'synthetic-reply-1', case_id: caseId, state: 'queued', delivery: 'unconfirmed',
        error_category: null, created_at: created, updated_at: created, submitted_at: null, delivered_at: null, failed_at: null,
      }
      currentCase = { ...currentCase, version: expectedVersion + 1, latest_reply: {
        reply_id: reply.reply_id, state: 'queued', updated_at: created, delivery: 'unconfirmed',
        error_category: null, submitted_at: null, delivered_at: null,
      } }
      if (options.loseApprovalResponseOnce) {
        options.loseApprovalResponseOnce = false
        throw new ApiError('network_error', 0, 'private network detail', null, null, true)
      }
      return { reply_id: reply.reply_id, state: 'queued', case_version: currentCase.version }
    },
    getReply: async (replyId) => {
      calls.push({ name: 'getReply', args: [replyId] })
      if (!reply) throw new Error('No synthetic reply exists.')
      return structuredClone(reply)
    },
    resolveCase: async (caseId, body) => {
      calls.push({ name: 'resolveCase', args: [caseId, body] })
      const cancelled = currentCase.latest_reply?.state === 'queued' ? [currentCase.latest_reply.reply_id] : []
      if (cancelled.length && reply) reply = { ...reply, state: 'cancelled', updated_at: new Date().toISOString() }
      currentCase = {
        ...currentCase, status: 'resolved', version: body.expected_version + 1,
        latest_reply: currentCase.latest_reply && cancelled.length ? { ...currentCase.latest_reply, state: 'cancelled' } : currentCase.latest_reply,
      }
      return {
        case_id: caseId, status: 'resolved', resolved_at: new Date().toISOString(), version: currentCase.version,
        unknown_reply_acknowledged: body.acknowledge_unknown_reply, cancelled_reply_ids: cancelled,
      }
    },
  }
  ;(app as unknown as { api: GlanceApi }).api = api as GlanceApi
  const audioCalls: Array<{ open: boolean; source?: AudioInputSource }> = []
  app.setAudioControl(async (open, source) => { audioCalls.push({ open, source }); return true })
  ;(app as unknown as { render(): void }).render()

  return {
    app, localStorage, calls, audioCalls,
    currentCase: () => currentCase,
    reply: () => reply,
    restore: async () => { await app.dispose(); restore.reverse().forEach((fn) => fn()) },
    click: async (selectedIndex?: number) => {
      await app.handleGlassesInput({
        kind: 'click', source: null, envelope: 'sysEvent', ...(selectedIndex === undefined ? {} : { selectedIndex }),
      })
      // The controller settles a possible single-click/double-click pair
      // before applying single-click navigation.
      await new Promise((resolve) => setTimeout(resolve, 300))
    },
    double: () => app.handleGlassesInput({ kind: 'double_click', source: null, envelope: 'sysEvent' }),
    down: () => app.handleGlassesInput({ kind: 'scroll_down', source: null }),
    up: () => app.handleGlassesInput({ kind: 'scroll_up', source: null }),
    audio: () => app.handleGlassesInput({ kind: 'audio', source: AudioInputSource.Glasses, pcm: new Uint8Array([1, 2, 3, 4]) }),
    text: () => app.getGlassText(),
  }
}

test('G2 can create and review a persisted display-safe copy without using the phone', async () => {
  const flow = makeHarness({ aiDraftText: 'I’m available — please call “Amina”.' })
  try {
    await flow.click(0)
    await flow.double() // Generate an AI suggestion with unsupported display glyphs.
    assert.equal(flow.app.state.screen, 'draft')
    assert.match(flow.text(), /ACTION  1\/4  > REVIEW EXACT REPLY/)

    await flow.click()
    await flow.click()
    await flow.click()
    assert.match(flow.text(), /ACTION  4\/4  > CREATE ASCII COPY/)
    await flow.double()

    assert.equal(flow.app.state.screen, 'draft')
    assert.equal(flow.app.state.draft?.source, 'owner')
    assert.equal(flow.app.state.draft?.text, 'I\'m available - please call "Amina".')
    assert.equal(flow.calls.filter((call) => call.name === 'createManualDraft').length, 1)
    assert.equal(flow.calls.some((call) => call.name === 'approveReply'), false)

    await flow.double() // Review starts again on the persisted copy.
    assert.equal(flow.app.state.screen, 'approval')
    assert.match(flow.text(), /I\'m available - please call "Amina"\./)
    assert.match(flow.text(), /PROGRESS 0\/1 PAGES COMPLETE/)
    await flow.down()
    assert.equal(flow.app.state.approvalStage, 'confirm')
    assert.doesNotMatch(flow.text(), /UNSUPPORTED DISPLAY CHARACTERS/)
    await flow.double()
    assert.equal(flow.calls.filter((call) => call.name === 'approveReply').length, 1)
  } finally {
    await flow.restore()
  }
})

test('G2 recovers a lost approval response from latest reply without a second approval', async () => {
  const flow = makeHarness({ loseApprovalResponseOnce: true })
  try {
    await flow.click(0)
    await flow.double() // Generate persisted draft.
    await flow.double() // Start exact-text review.
    await flow.down() // Reach separate final confirmation.
    assert.equal(flow.app.state.approvalStage, 'confirm')
    await flow.double() // The server commits, but the response is lost.

    assert.equal(flow.app.state.screen, 'approval')
    assert.match(flow.text(), /OUTCOME UNCERTAIN/)
    assert.match(flow.text(), /CHECK STATUS/)
    assert.match(JSON.stringify(flow.app.getGlassesPage().menuObject), /Retry same approval key/)
    assert.equal(flow.calls.filter((call) => call.name === 'approveReply').length, 1)

    await flow.double() // Recover latest_reply and its scoped status.
    assert.equal(flow.app.state.screen, 'status')
    assert.equal(flow.app.state.reply?.state, 'queued')
    assert.match(flow.text(), /QUEUED/)
    assert.equal(flow.calls.filter((call) => call.name === 'approveReply').length, 1)
    assert.equal(flow.calls.filter((call) => call.name === 'getReply').length, 1)
  } finally {
    await flow.restore()
  }
})

test('G2-only workflow opens context, drafts by voice, reviews exact pages, queues, checks status and resolves', async () => {
  const flow = makeHarness()
  try {
    await flow.click(0)
    assert.equal(flow.app.state.screen, 'case')
    assert.match(flow.text(), /MSG 1\/10/)
    const newest = flow.text()
    await flow.up()
    assert.match(flow.text(), /MSG 2\/10/)
    assert.notEqual(flow.text(), newest)
    await flow.down()
    assert.equal(flow.text(), newest)

    await flow.double() // Generate an AI suggestion.
    assert.equal(flow.app.state.screen, 'draft')
    assert.equal(flow.app.state.draft?.source, 'ai')
    assert.match(flow.text(), /AI SUGGESTION/)
    assert.equal(flow.calls.filter((call) => call.name === 'createDraft').length, 1)

    await flow.click() // Select Dictate revision/reply.
    await flow.double()
    assert.equal(flow.app.state.screen, 'voice')
    assert.equal(flow.app.state.voicePhase, 'idle')
    assert.deepEqual(flow.audioCalls, [])
    assert.match(flow.text(), /MICROPHONE OFF/)

    await flow.double() // Explicit START.
    assert.equal(flow.app.state.voicePhase, 'recording')
    assert.deepEqual(flow.audioCalls, [{ open: true, source: AudioInputSource.Glasses }])
    assert.match(flow.text(), /G2 MIC ACTIVE/)
    await flow.audio()
    await flow.double() // Explicit STOP and transcribe.
    assert.equal(flow.app.state.voicePhase, 'transcript_ready')
    assert.deepEqual(flow.audioCalls.map((call) => call.open), [true, false])
    assert.deepEqual(flow.calls.filter((call) => call.name === 'transcribeAudio').map((call) => call.args), [[4]])
    assert.equal(flow.app.state.voiceTranscript, transcript)
    assert.equal([...flow.localStorage.values.values()].some((value) => value.includes(transcript)), false)
    assert.equal(flow.calls.some((call) => call.name === 'approveReply' || call.name === 'resolveCase'), false)

    await flow.double() // Use as reply: manual draft only.
    assert.equal(flow.app.state.screen, 'draft')
    assert.equal(flow.app.state.draft?.source, 'owner')
    assert.equal(flow.app.state.draft?.text, transcript)
    assert.deepEqual(flow.calls.filter((call) => ['createManualDraft', 'reviseDraft', 'approveReply'].includes(call.name)).map((call) => call.name), ['createManualDraft'])

    await flow.double() // Open the exact-text G2 review.
    assert.equal(flow.app.state.screen, 'approval')
    assert.equal(flow.app.state.approvalStage, 'review')
    const pages = paginateGlassesApprovalText(flow.app.state.approvalText).length
    assert.ok(pages > 1)
    assert.match(flow.text(), /REPLY 1\//)
    assert.match(flow.text(), /word000/)
    for (let page = 1; page < pages; page += 1) {
      await flow.down()
      assert.equal(flow.app.state.approvalStage, 'review')
      assert.equal(flow.app.state.approvalPage, page)
      assert.match(flow.text(), new RegExp(`REPLY ${page + 1}\\/`))
    }
    assert.match(flow.text(), /word069/)
    assert.equal(flow.calls.some((call) => call.name === 'approveReply'), false)
    await flow.down() // Separate final confirmation state.
    assert.equal(flow.app.state.approvalStage, 'confirm')
    assert.equal(flow.calls.some((call) => call.name === 'approveReply'), false)
    await flow.double() // Explicit approve action from final G2 confirmation.
    assert.equal(flow.app.state.screen, 'status')
    assert.equal(flow.calls.filter((call) => call.name === 'approveReply').length, 1)
    const approval = flow.calls.find((call) => call.name === 'approveReply')!
    assert.equal(approval.args[3], transcript)
    assert.match(flow.text(), /QUEUED/)
    assert.match(flow.text(), /NOT SENT YET/)
    assert.doesNotMatch(flow.text(), /DELIVERED/)
    assert.equal(flow.app.state.caseData?.version, 6)

    await flow.click() // Select resolve from reply status.
    await flow.double()
    assert.equal(flow.app.state.screen, 'resolve')
    assert.equal(flow.app.state.focusedAction, 0)
    await flow.down() // Select a reason without opening the phone.
    assert.match(flow.text(), /CUSTOMER UPDATED/)
    assert.equal(flow.calls.filter((call) => call.name === 'resolveCase').length, 0)
    await flow.double()
    assert.equal(flow.calls.filter((call) => call.name === 'resolveCase').length, 1)
    assert.equal((flow.calls.find((call) => call.name === 'resolveCase')!.args[1] as { reason: string }).reason, 'customer_updated')
    assert.equal(flow.currentCase().version, 7)
    assert.equal(flow.currentCase().status, 'resolved')
    assert.match(flow.text(), /CANCELLED/)
    assert.match(flow.text(), /NOT SENT/)
    assert.deepEqual(flow.calls.filter((call) => ['transcribeAudio', 'createManualDraft', 'approveReply', 'resolveCase'].includes(call.name)).map((call) => call.name), [
      'transcribeAudio', 'createManualDraft', 'approveReply', 'resolveCase',
    ])
  } finally {
    await flow.restore()
  }
})

test('G2 transcript as instruction invokes only revision and a failed revision preserves its prior draft', async () => {
  const flow = makeHarness({ transcript: 'Please make the reply warmer and shorter.' })
  try {
    await flow.click(0)
    await flow.double() // AI draft.
    const originalDraftId = flow.app.state.draft?.draft_id
    await flow.click()
    await flow.double() // Voice-ready.
    await flow.double() // Start recording.
    await flow.audio()
    await flow.double() // Stop and transcribe.
    await flow.click() // Move from Use as reply to Use as instruction.
    await flow.double()

    assert.equal(flow.app.state.screen, 'draft')
    assert.notEqual(flow.app.state.draft?.draft_id, originalDraftId)
    assert.equal(flow.app.state.draft?.source, 'ai')
    assert.deepEqual(flow.calls.filter((call) => ['createManualDraft', 'reviseDraft', 'approveReply', 'resolveCase'].includes(call.name)).map((call) => call.name), ['reviseDraft'])
    assert.equal((flow.calls.find((call) => call.name === 'reviseDraft')!.args[3]), 'Please make the reply warmer and shorter.')
  } finally {
    await flow.restore()
  }

  const failed = makeHarness({ transcript: 'Make it shorter.', failRevision: true })
  try {
    await failed.click(0)
    await failed.double()
    const original = failed.app.state.draft
    await failed.click()
    await failed.double()
    await failed.double()
    await failed.audio()
    await failed.double()
    await failed.click()
    await failed.double()
    assert.equal(failed.app.state.screen, 'voice')
    assert.equal(failed.app.state.draft?.draft_id, original?.draft_id)
    assert.equal(failed.calls.filter((call) => call.name === 'reviseDraft').length, 1)
    assert.equal(failed.calls.some((call) => call.name === 'approveReply'), false)
  } finally {
    await failed.restore()
  }
})

test('G2 unknown-send resolution needs a distinct acknowledgement before the resolve confirmation', async () => {
  const unknownCase: CaseData = {
    ...initialCase,
    latest_reply: {
      reply_id: 'unknown-reply', state: 'unknown', updated_at: new Date().toISOString(),
      delivery: 'unconfirmed', error_category: null, submitted_at: null, delivered_at: null,
    },
  }
  const flow = makeHarness({ startingCase: unknownCase })
  try {
    await flow.click(0)
    flow.app.state.focusedAction = 3
    await flow.double()
    assert.match(flow.text(), /CUSTOMER MAY OR MAY NOT HAVE RECEIVED IT/)
    assert.equal(flow.calls.filter((call) => call.name === 'resolveCase').length, 0)
    await flow.double()
    assert.equal(flow.app.state.acknowledgedUnknown, true)
    assert.equal(flow.calls.filter((call) => call.name === 'resolveCase').length, 0)
    assert.match(flow.text(), /ACKNOWLEDGED/)
    await flow.double()
    const request = flow.calls.find((call) => call.name === 'resolveCase')
    assert.ok(request)
    assert.equal((request!.args[1] as { acknowledge_unknown_reply: boolean }).acknowledge_unknown_reply, true)
  } finally {
    await flow.restore()
  }
})
