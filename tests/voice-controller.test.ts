import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { ApiError, type GlanceApi } from '../src/client.ts'
import { GlanceAppController } from '../src/app.ts'
import { FIXTURE_CASE_ID } from '../src/demo-fixtures.ts'
import type { CaseData, DraftData } from '../src/types.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function putGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  }
}

const caseData: CaseData = {
  case_id: 'case-voice', version: 5, status: 'open', category: 'human_request', channel: 'telegram',
  customer_label: 'Synthetic owner case', latest_reply: null, has_earlier: false, context: [],
}
const aiDraft: DraftData = {
  draft_id: 'ai-draft', based_on_version: 5, text: 'I will check and update you shortly.', source: 'ai',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
}

function makeApp(api: GlanceApi) {
  const local = new MemoryStorage()
  const session = new MemoryStorage()
  const documentMock = {
    visibilityState: 'visible',
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
  }
  const restoreLocal = putGlobal('localStorage', local)
  const restoreSession = putGlobal('sessionStorage', session)
  const restoreDocument = putGlobal('document', documentMock)
  const root = {
    innerHTML: '',
    addEventListener() {},
    querySelector() { return null },
  }
  const app = new GlanceAppController(root as unknown as HTMLElement, 'https://api.example/api/v1/glance')
  app.sessions.save({
    access_token: 'token-for-test',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    salon: { name: 'Synthetic Salon' },
  })
  app.state.sessionPresent = true
  app.state.salonName = 'Synthetic Salon'
  app.state.caseData = { ...caseData }
  ;(app as unknown as { api: GlanceApi }).api = api
  return {
    app,
    local,
    session,
    documentMock,
    restore() { restoreDocument(); restoreSession(); restoreLocal() },
  }
}

test('voice intent selection uses only its explicit draft endpoint and never sends', async () => {
  const calls: Array<{ method: string; content?: string }> = []
  let replyDraft = false
  let nextRevision = false
  const api = {
    getCase: async () => { calls.push({ method: 'getCase' }); return { ...caseData } },
    createManualDraft: async (_caseId: string, _version: number, text: string) => {
      calls.push({ method: 'manual', content: text })
      replyDraft = true
      return { ...aiDraft, draft_id: 'owner-draft', text, source: 'owner' as const }
    },
    reviseDraft: async (_caseId: string, _draftId: string, _version: number, instruction: string) => {
      calls.push({ method: 'revise', content: instruction })
      nextRevision = true
      return { ...aiDraft, draft_id: 'revised-draft' }
    },
    approveReply: async () => { calls.push({ method: 'approve' }); return { reply_id: 'reply', state: 'queued' as const, case_version: 6 } },
  } as unknown as GlanceApi
  const { app, local, session, restore } = makeApp(api)
  try {
    app.state.screen = 'voice'
    app.state.voicePhase = 'transcript_ready'
    app.state.voiceTranscript = 'Please let me check and update you shortly.'
    ;(app as unknown as { renderedScreen: string }).renderedScreen = 'voice'
    await (app as unknown as { useVoiceTranscriptAsReply(): Promise<void> }).useVoiceTranscriptAsReply()
    assert.equal(replyDraft, true)
    assert.deepEqual(calls.map((call) => call.method), ['getCase', 'manual'])
    assert.equal(app.state.draft?.source, 'owner')
    assert.equal(app.state.draft?.text, 'Please let me check and update you shortly.')
    assert.equal(app.state.screen, 'draft')
    assert.equal(app.state.voiceTranscript, '')

    calls.length = 0
    app.state.screen = 'voice'
    app.state.voicePhase = 'transcript_ready'
    app.state.voiceTranscript = 'Make it shorter and warmer.'
    app.state.draft = { ...aiDraft }
    app.state.editorText = aiDraft.text
    app.state.stale = false
    ;(app as unknown as { renderedScreen: string }).renderedScreen = 'voice'
    await (app as unknown as { useVoiceTranscriptAsInstruction(): Promise<void> }).useVoiceTranscriptAsInstruction()
    assert.equal(nextRevision, true)
    assert.deepEqual(calls.map((call) => call.method), ['getCase', 'revise'])
    assert.equal(calls[1].content, 'Make it shorter and warmer.')
    assert.equal(app.state.draft?.draft_id, 'revised-draft')
    assert.equal(app.state.screen, 'draft')
    assert.equal(app.state.voiceTranscript, '')

    assert.equal(calls.some((call) => call.method === 'approve'), false)
    assert.equal([...local.values.values()].some((value) => value.includes('Please let me check') || value.includes('Make it shorter')), false)
    assert.equal([...session.values.values()].some((value) => value.includes('Please let me check') || value.includes('Make it shorter')), false)
  } finally {
    await app.dispose()
    restore()
  }
})

test('G2 capture is owner-started and microphone closes on backgrounding; session loss clears transient transcript', async () => {
  const api = {
    getCase: async () => ({ ...caseData }),
    transcribeAudio: async () => ({ transcript: 'private spoken words', duration_ms: 321 }),
  } as unknown as GlanceApi
  const { app, documentMock, restore } = makeApp(api)
  const audioCalls: Array<{ open: boolean; source?: AudioInputSource }> = []
  app.setAudioControl(async (open, source) => {
    audioCalls.push({ open, source })
    return true
  })
  try {
    app.state.screen = 'case'
    app.state.glassesAvailable = true
    await (app as unknown as { beginVoiceCapture(): Promise<void> }).beginVoiceCapture()
    assert.deepEqual(audioCalls[0], { open: true, source: AudioInputSource.Glasses })
    assert.equal(app.state.voicePhase, 'recording')
    await app.handleGlassesInput({ kind: 'audio', source: AudioInputSource.Glasses, pcm: new Uint8Array([1, 2, 3, 4]) })
    assert.equal((app as unknown as { voiceCapture: { byteLength: number } }).voiceCapture.byteLength, 4)

    documentMock.visibilityState = 'hidden'
    await (app as unknown as { onVisibilityChange(): Promise<void> }).onVisibilityChange()
    assert.equal(audioCalls.at(-1)?.open, false)
    assert.equal(app.state.voicePhase, 'error')
    assert.equal(app.state.voiceTranscript, '')
    assert.equal((app as unknown as { voiceCapture: { byteLength: number } }).voiceCapture.byteLength, 0)

    app.state.voicePhase = 'transcript_ready'
    app.state.voiceTranscript = 'temporary transcript'
    app.sessions.clear()
    const lost = (app as unknown as { handleLostSession(error: unknown): boolean }).handleLostSession(
      new ApiError('session_revoked', 401, 'safe'),
    )
    assert.equal(lost, true)
    assert.equal(app.state.screen, 'pair')
    assert.equal(app.state.voiceTranscript, '')
  } finally {
    await app.dispose()
    restore()
  }
})

test('voice cancellation and leaving transcript review clear transient speech and close recording', async () => {
  const api = { getCase: async () => ({ ...caseData }) } as unknown as GlanceApi
  const { app, local, session, restore } = makeApp(api)
  const audioCalls: boolean[] = []
  app.setAudioControl(async (open) => { audioCalls.push(open); return true })
  const click = async (action: string) => {
    const target = { hasAttribute: () => false, dataset: { action } }
    await (app as unknown as { handleClick(event: Event): Promise<void> }).handleClick({
      target: { closest: () => target },
    } as unknown as Event)
  }

  try {
    app.state.screen = 'case'
    app.state.glassesAvailable = true
    await (app as unknown as { beginVoiceCapture(): Promise<void> }).beginVoiceCapture()
    await app.handleGlassesInput({ kind: 'audio', source: AudioInputSource.Glasses, pcm: new Uint8Array([1, 2, 3, 4]) })
    await click('cancel-voice')
    assert.deepEqual(audioCalls, [true, false])
    assert.equal(app.state.screen, 'case')
    assert.equal((app as unknown as { voiceCapture: { byteLength: number } }).voiceCapture.byteLength, 0)

    app.state.screen = 'voice'
    app.state.voicePhase = 'transcript_ready'
    app.state.voiceTranscript = 'temporary recognized words'
    await click('voice-back-case')
    assert.equal(app.state.voiceTranscript, '')
    assert.equal(app.state.screen, 'case')
    assert.equal([...local.values.values(), ...session.values.values()].some((value) => value.includes('temporary recognized words')), false)
  } finally {
    await app.dispose()
    restore()
  }
})

test('losing the glasses connection while recording closes the microphone and clears PCM', async () => {
  const api = { getCase: async () => ({ ...caseData }) } as unknown as GlanceApi
  const { app, restore } = makeApp(api)
  const audioCalls: boolean[] = []
  app.setAudioControl(async (open) => { audioCalls.push(open); return true })
  try {
    app.state.screen = 'case'
    app.state.glassesAvailable = true
    await (app as unknown as { beginVoiceCapture(): Promise<void> }).beginVoiceCapture()
    await app.handleGlassesInput({ kind: 'audio', source: AudioInputSource.Glasses, pcm: new Uint8Array([1, 2, 3, 4]) })

    app.setGlassesAvailable(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(audioCalls, [true, false])
    assert.equal(app.state.voicePhase, 'error')
    assert.match(app.state.voiceError, /connection was lost/i)
    assert.equal((app as unknown as { voiceCapture: { byteLength: number } }).voiceCapture.byteLength, 0)
  } finally {
    await app.dispose()
    restore()
  }
})

test('disposing the app requests microphone shutdown before the page exit handler returns', async () => {
  const api = { getCase: async () => ({ ...caseData }) } as unknown as GlanceApi
  const { app, restore } = makeApp(api)
  const audioCalls: boolean[] = []
  app.setAudioControl(async (open) => { audioCalls.push(open); return true })
  try {
    app.state.screen = 'case'
    app.state.glassesAvailable = true
    await (app as unknown as { beginVoiceCapture(): Promise<void> }).beginVoiceCapture()
    const disposing = app.dispose()
    assert.deepEqual(audioCalls, [true, false])
    await disposing
    assert.equal((app as unknown as { voiceCapture: { byteLength: number } }).voiceCapture.byteLength, 0)
  } finally {
    await app.dispose()
    restore()
  }
})

test('G2 voice display stays glanceable and truncates transcript preview for phone review', async () => {
  const api = {} as GlanceApi
  const { app, restore } = makeApp(api)
  try {
    app.state.screen = 'voice'
    app.state.voicePhase = 'recording'
    app.state.voiceDurationMs = 8_000
    ;(app as unknown as { render(): void }).render()
    const recordingLines = app.getGlassText().split('\n')
    assert.ok(recordingLines.some((line) => line === 'MICROPHONE ACTIVE'))
    assert.ok(recordingLines.some((line) => line === 'CAPTURED 0:08'))
    assert.ok(recordingLines.some((line) => line.includes('STOP & TRANSCRIBE')))
    assert.ok(recordingLines.length <= 5)

    app.state.voicePhase = 'transcript_ready'
    app.state.voiceTranscript = 'The complete recognized sentence is visible on the phone for owner review.'
    ;(app as unknown as { render(): void }).render()
    const transcriptLines = app.getGlassText().split('\n')
    assert.ok(transcriptLines.includes('TRANSCRIPT READY · NOT SENT'))
    assert.ok(transcriptLines.includes('CHOOSE INTENT ON PHONE'))
    assert.ok(transcriptLines[2].length <= 27)
    assert.notEqual(transcriptLines[2], app.state.voiceTranscript)
  } finally {
    await app.dispose()
    restore()
  }
})

test('development demo labels voice as simulated and keeps explicit choices on fixture APIs', async () => {
  const api = {} as GlanceApi
  const { app, local, session, restore } = makeApp(api)
  try {
    app.fixtures.startDemo()
    ;(app as unknown as { api: GlanceApi }).api = app.fixtures
    app.sessions.clear()
    app.state.fixtureMode = true
    app.state.sessionPresent = false
    app.state.caseData = await app.fixtures.getCase(FIXTURE_CASE_ID)
    app.state.screen = 'case'
    ;(app as unknown as { showDemoTranscript(): void }).showDemoTranscript()
    assert.equal(app.state.voiceSimulation, true)
    const transcriptScreen = (app as unknown as { renderVoice(): string }).renderVoice()
    assert.match(transcriptScreen, /SIMULATED TRANSCRIPT · FIXTURE ONLY/)
    assert.match(transcriptScreen, /no microphone or ASR was used/i)

    const ai = await app.fixtures.createDraft(app.state.caseData!.case_id, app.state.caseData!.version, 'fixture-ai')
    app.state.draft = ai
    app.state.editorText = ai.text
    await (app as unknown as { useVoiceTranscriptAsInstruction(): Promise<void> }).useVoiceTranscriptAsInstruction()
    assert.equal(app.state.draft?.source, 'ai')
    assert.equal(app.state.screen, 'draft')

    app.state.screen = 'case'
    app.state.caseData = await app.fixtures.getCase(app.state.caseData!.case_id)
    ;(app as unknown as { showDemoTranscript(): void }).showDemoTranscript()
    await (app as unknown as { useVoiceTranscriptAsReply(): Promise<void> }).useVoiceTranscriptAsReply()
    assert.equal(app.state.draft?.source, 'owner')
    assert.equal(app.state.screen, 'draft')
    assert.equal(app.state.draft?.text, 'Please make it shorter and mention walk-ins may be available until 5 p.m.')
    assert.equal([...local.values.values(), ...session.values.values()].some((value) => value.includes('walk-ins may be available')), false)
    assert.equal(app.sessions.load(), null)
    assert.equal(app.state.fixtureMode, true)
  } finally {
    await app.dispose()
    restore()
  }
})

test('failed transcription releases captured PCM after the microphone has closed', async () => {
  const sequence: string[] = []
  const api = {
    getCase: async () => ({ ...caseData }),
    transcribeAudio: async () => {
      sequence.push('transcribe')
      throw new ApiError('transcription_timeout', 504, 'safe timeout', null, null, true)
    },
  } as unknown as GlanceApi
  const { app, local, session, restore } = makeApp(api)
  app.setAudioControl(async (open) => {
    sequence.push(open ? 'microphone_open' : 'microphone_closed')
    return true
  })

  try {
    app.state.screen = 'case'
    app.state.glassesAvailable = true
    await (app as unknown as { beginVoiceCapture(): Promise<void> }).beginVoiceCapture()
    await app.handleGlassesInput({ kind: 'audio', source: AudioInputSource.Glasses, pcm: new Uint8Array([9, 8, 7, 6]) })
    await (app as unknown as { stopAndTranscribe(reason: 'owner'): Promise<void> }).stopAndTranscribe('owner')

    assert.deepEqual(sequence, ['microphone_open', 'microphone_closed', 'transcribe'])
    assert.equal(app.state.voicePhase, 'error')
    assert.equal(app.state.voiceTranscript, '')
    assert.equal((app as unknown as { voiceCapture: { byteLength: number } }).voiceCapture.byteLength, 0)
    assert.equal([...local.values.values(), ...session.values.values()].some((value) => value.includes('9876')), false)
  } finally {
    await app.dispose()
    restore()
  }
})
