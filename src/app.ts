import { EventSourceType } from '@evenrealities/even_hub_sdk'
import { GlanceApiClient, ApiError, userMessageForError, type GlanceApi } from './client.ts'
import { DEMO_FIXTURES_ENABLED } from './config.ts'
import { DemoFixtures } from './demo-fixtures.ts'
import { RING_EVENT_SOURCE, type GlanceInput } from './evenhub-events.ts'
import { AudioCaptureError, G2PcmCapture, type AudioInputControl, type CaptureStopReason, type CaptureStopRequest } from './audio-capture.ts'
import { DEVICE_LABEL, SessionStore, isValidPairingCode, normalizePairingCode } from './session.ts'
import { canUseTranscriptAsInstruction, useTranscriptAsInstruction, useTranscriptAsReply } from './voice-intents.ts'
import type {
  CaseData,
  DraftData,
  ResolveReason,
  ResolveRequest,
} from './types.ts'
import type { AppStateView, GlanceScreen } from './state-view.ts'
import {
  IdempotencyKeyBook,
  categoryLabel,
  messagePage,
  moreCaseCount,
  normalizeOwnerText,
  presentReplyState,
  replyPollDelay,
  shouldPollReply,
  sortInboxOldestFirst,
} from './workflow.ts'

interface AppState extends AppStateView {
  code: string
  manualMode: boolean
  inboxStale: boolean
  busyAction: string
  replyId: string | null
  autoPolls: number
  acknowledgedUnknown: boolean
  reviewedExactText: boolean
  glassesAvailable: boolean
  glassesStatus: string
  voicePhase: 'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing' | 'transcript_ready' | 'error'
  voiceDurationMs: number
  voiceTranscriptionDurationMs: number | null
  voiceTranscript: string
  voiceSimulation: boolean
  voiceError: string
}

const REASONS: Array<{ value: ResolveReason; label: string }> = [
  { value: 'handled_in_person', label: 'Handled in person' },
  { value: 'customer_updated', label: 'Customer updated' },
  { value: 'no_action_needed', label: 'No action needed' },
  { value: 'other', label: 'Other' },
]

const EMPTY_STATE: AppState = {
  screen: 'pair',
  fixtureMode: false,
  connection: 'loading',
  sessionPresent: false,
  salonName: '',
  inbox: null,
  inboxStale: false,
  selectedIndex: 0,
  caseData: null,
  stale: false,
  messagePage: 0,
  draft: null,
  editorText: '',
  revisionInstruction: '',
  approvalText: '',
  reviewedExactText: false,
  reply: null,
  busy: false,
  busyAction: '',
  error: '',
  errorCode: null,
  requestId: null,
  retryAfter: null,
  message: '',
  resolveReason: 'handled_in_person',
  resolveNote: '',
  acknowledgedUnknown: false,
  focusedAction: 0,
  code: '',
  manualMode: false,
  replyId: null,
  autoPolls: 0,
  glassesAvailable: false,
  glassesStatus: 'Connecting to the Even Hub bridge…',
  voicePhase: 'idle',
  voiceDurationMs: 0,
  voiceTranscriptionDurationMs: null,
  voiceTranscript: '',
  voiceSimulation: false,
  voiceError: '',
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}

function button(label: string, action: string, options: { primary?: boolean; disabled?: boolean; extra?: string } = {}): string {
  const classes = options.primary ? 'button primary' : 'button'
  return `<button class="${classes}" type="button" data-action="${escapeHtml(action)}" ${options.disabled ? 'disabled' : ''} ${options.extra ?? ''}>${escapeHtml(label)}</button>`
}

function formMessage(message: string): string {
  return message ? `<p class="notice" role="status">${escapeHtml(message)}</p>` : ''
}

function dateTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'Time unavailable'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function caseStatusText(status: string): string {
  return status === 'resolved' ? 'Resolved' : 'Open'
}

export class GlanceAppController {
  readonly state: AppState = structuredClone(EMPTY_STATE)
  readonly sessions: SessionStore
  readonly liveApi: GlanceApiClient
  readonly fixtures = new DemoFixtures()
  private api: GlanceApi
  private readonly keys = new IdempotencyKeyBook()
  // Voice payloads must never be written to sessionStorage with a retry key.
  private readonly voiceKeys = new IdempotencyKeyBook(null)
  private readonly voiceCapture = new G2PcmCapture()
  private readonly root: HTMLElement
  private glassesWriter: ((text: string) => void) | null = null
  private audioControl: AudioInputControl | null = null
  private replyTimer: number | null = null
  private pollTimer: number | null = null
  private foreground = true
  private pollController: AbortController | null = null
  private transcriptionController: AbortController | null = null
  private uploadingPcm: Uint8Array | null = null
  private voiceGeneration = 0
  private voiceFinish: Promise<void> | null = null
  private demoCaptureTimer: ReturnType<typeof globalThis.setInterval> | null = null
  private demoCaptureStartedAt = 0
  private voiceDerivedDraftIds = new Set<string>()
  private lastRenderedGlasses = ''
  private renderedScreen: GlanceScreen | null = null
  private readonly visibilityHandler = () => void this.onVisibilityChange()

  constructor(root: HTMLElement, apiBase: string) {
    this.root = root
    this.sessions = new SessionStore()
    this.liveApi = new GlanceApiClient(apiBase, this.sessions)
    this.api = this.liveApi
  }

  async start(): Promise<void> {
    this.root.addEventListener('click', (event) => void this.handleClick(event))
    this.root.addEventListener('input', (event) => this.handleInput(event))
    this.root.addEventListener('change', (event) => this.handleChange(event))
    this.root.addEventListener('submit', (event) => void this.handleSubmit(event))
    document.addEventListener('visibilitychange', this.visibilityHandler)
    this.pollTimer = window.setInterval(() => void this.pollVisibleState(), 5_000)

    const session = this.sessions.load()
    if (!session) {
      this.render()
      return
    }
    this.state.sessionPresent = true
    this.state.salonName = session.salon.name
    this.state.connection = 'loading'
    this.state.screen = 'inbox'
    this.render()
    await this.loadInbox()
  }

  setGlassesWriter(writer: (text: string) => void): void {
    this.glassesWriter = writer
    this.updateGlasses()
  }

  setGlassesAvailable(available: boolean): void {
    if (this.state.glassesAvailable === available) return
    this.state.glassesAvailable = available
    if (!available && ['starting', 'recording'].includes(this.voiceCapture.phase)) {
      void this.stopForGlassesDisconnect()
    }
    this.render()
  }

  setAudioControl(control: AudioInputControl): void {
    this.audioControl = control
  }

  async dispose(): Promise<void> {
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pollController?.abort()
    this.transcriptionController?.abort()
    await this.clearVoiceWorkflow('')
    this.keys.clear()
    this.voiceKeys.clear()
    this.voiceDerivedDraftIds.clear()
    this.glassesWriter = null
    this.audioControl = null
  }

  setGlassesStatus(status: string): void {
    if (this.state.glassesStatus === status) return
    this.state.glassesStatus = status
    this.render()
  }

  getGlassText(): string {
    return this.lastRenderedGlasses
  }

  private async beginVoiceCapture(): Promise<void> {
    const item = this.state.caseData
    if (this.state.busy || this.state.voicePhase === 'starting' || this.state.voicePhase === 'recording' ||
        this.state.voicePhase === 'stopping' || this.state.voicePhase === 'transcribing') return
    if (!item || item.status !== 'open' || this.state.screen !== 'case' && this.state.screen !== 'voice') return
    if (this.state.fixtureMode || !this.state.sessionPresent || !this.sessions.load()) {
      this.failLocal('Pair this device with a live owner session before using voice transcription.', 'session_expired')
      return
    }
    if (!this.state.glassesAvailable || !this.audioControl) {
      this.failLocal('The G2 microphone is unavailable until the Even Hub startup page is ready and glasses are connected.', 'microphone_unavailable')
      return
    }
    if (!this.foreground || document.visibilityState === 'hidden') {
      this.failLocal('Bring Glance to the foreground before recording.', 'microphone_unavailable')
      return
    }

    const generation = ++this.voiceGeneration
    this.state.focusedAction = 0
    this.clearError()
    this.state.voicePhase = 'starting'
    this.state.voiceDurationMs = 0
    this.state.voiceTranscriptionDurationMs = null
    this.state.voiceTranscript = ''
    this.state.voiceSimulation = false
    this.state.voiceError = ''
    this.state.message = 'Starting the G2 microphone…'
    this.state.screen = 'voice'
    this.render()
    try {
      const opened = await this.voiceCapture.start(
        this.audioControl,
        (reason) => this.onCaptureStopRequested(reason),
        () => {
          this.state.voiceDurationMs = this.voiceCapture.durationMs
          const duration = this.root.querySelector<HTMLElement>('.voice-duration')
          if (duration) duration.textContent = this.formatDuration(this.state.voiceDurationMs)
          this.updateGlasses()
        },
      )
      if (generation !== this.voiceGeneration) return
      if (!opened) {
        this.state.voicePhase = 'error'
        this.state.voiceError = userMessageForError('microphone_unavailable')
        this.state.message = ''
      } else {
        this.state.voicePhase = 'recording'
        this.state.voiceError = ''
        this.state.message = 'Microphone active. Speak briefly, then stop to transcribe.'
      }
    } catch (error) {
      if (generation !== this.voiceGeneration) return
      const closed = await this.voiceCapture.cancel()
      if (!closed) {
        this.markMicrophoneShutdownUnconfirmed()
        this.render()
        return
      }
      this.state.voicePhase = 'error'
      this.state.voiceError = userMessageForError('microphone_unavailable')
      this.state.message = ''
    }
    this.render()
  }

  private onCaptureStopRequested(reason: CaptureStopRequest): void {
    if (reason === 'stream_interrupted' || reason === 'invalid_audio') {
      void this.stopInvalidCapture(reason)
      return
    }
    void this.stopAndTranscribe(reason)
  }

  private async stopInvalidCapture(reason: 'stream_interrupted' | 'invalid_audio'): Promise<void> {
    if (this.voiceFinish) return this.voiceFinish
    const generation = this.voiceGeneration
    this.state.voicePhase = 'stopping'
    this.state.voiceError = ''
    this.state.message = ''
    this.render()
    const work = (async () => {
      const closed = await this.voiceCapture.cancel()
      if (generation !== this.voiceGeneration) return
      if (!closed) {
        this.markMicrophoneShutdownUnconfirmed()
        this.render()
        return
      }
      this.state.voicePhase = 'error'
      this.state.voiceError = reason === 'invalid_audio'
        ? userMessageForError('invalid_audio')
        : userMessageForError('audio_stream_interrupted')
      this.state.voiceDurationMs = 0
      this.state.message = ''
      this.render()
    })()
    this.voiceFinish = work
    try { await work } finally { if (this.voiceFinish === work) this.voiceFinish = null }
  }

  private async stopAndTranscribe(reason: CaptureStopReason): Promise<void> {
    if (this.voiceFinish) return this.voiceFinish
    if (this.voiceCapture.phase !== 'recording') return
    const generation = this.voiceGeneration
    this.state.voicePhase = 'stopping'
    this.state.message = 'Stopping the G2 microphone…'
    this.render()
    const work = (async () => {
      let captured: Awaited<ReturnType<G2PcmCapture['stop']>> = null
      let controller: AbortController | null = null
      let shutdownUnconfirmed = false
      let microphoneStopFailed = false
      try {
        captured = await this.voiceCapture.stop(reason)
        if (!captured || generation !== this.voiceGeneration) return
        this.state.voiceDurationMs = captured.durationMs
        if (!captured.pcm.byteLength) {
          this.state.voicePhase = 'error'
          this.state.voiceError = userMessageForError('empty_audio')
          this.state.message = ''
          return
        }
        this.state.voicePhase = 'transcribing'
        this.state.message = 'Transcribing in memory. The audio is not saved.'
        this.render()
        controller = new AbortController()
        this.transcriptionController = controller
        this.uploadingPcm = captured.pcm
        const result = await this.api.transcribeAudio(captured.pcm, controller.signal)
        if (generation !== this.voiceGeneration) return
        this.state.voiceTranscript = result.transcript
        this.state.voiceSimulation = false
        this.state.voiceTranscriptionDurationMs = result.duration_ms
        this.state.voicePhase = 'transcript_ready'
        this.state.voiceError = ''
        this.state.message = 'Transcript ready for your choice. Nothing has been sent.'
      } catch (error) {
        if (generation !== this.voiceGeneration) return
        if (error instanceof AudioCaptureError && error.code === 'microphone_stop_failed') {
          const closed = await this.voiceCapture.cancel()
          if (!closed) {
            this.markMicrophoneShutdownUnconfirmed()
            shutdownUnconfirmed = true
          } else microphoneStopFailed = true
        }
        if (this.handleLostSession(error)) return
        this.state.voiceTranscript = ''
        this.state.voiceTranscriptionDurationMs = null
        this.state.voicePhase = 'error'
        this.state.voiceError = shutdownUnconfirmed
          ? 'Even Hub did not confirm microphone shutdown. Keep Glance open and reconnect the glasses before recording again.'
          : microphoneStopFailed
          ? 'The G2 microphone did not stop on the first attempt. Audio was cleared and not sent. The microphone is now closed; reconnect the glasses if the issue repeats.'
          : error instanceof ApiError
          ? userMessageForError(error.code)
          : 'Transcription could not be completed. The recording was cleared; start a new recording if you want to try again.'
        this.state.errorCode = error instanceof ApiError ? error.code : null
        this.state.requestId = error instanceof ApiError ? error.requestId : null
        this.state.retryAfter = error instanceof ApiError ? error.retryAfterSeconds : null
        if (error instanceof ApiError && ['network_error', 'request_timeout', 'transcription_timeout'].includes(error.code)) {
          this.state.connection = 'offline'
        }
        this.state.message = ''
      } finally {
        captured?.pcm.fill(0)
        if (this.uploadingPcm === captured?.pcm) this.uploadingPcm = null
        if (controller && this.transcriptionController === controller) this.transcriptionController = null
        if (generation === this.voiceGeneration) this.render()
      }
    })()
    this.voiceFinish = work
    try { await work } finally { if (this.voiceFinish === work) this.voiceFinish = null }
  }

  private async useVoiceTranscriptAsReply(): Promise<void> {
    const current = this.state.caseData
    if (!current || this.state.voicePhase !== 'transcript_ready' || !this.state.voiceTranscript || this.state.busy) return
    const transcript = this.state.voiceTranscript
    try { normalizeOwnerText(transcript, 700) } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'The transcript cannot be used as a reply.', 'invalid_text')
      return
    }
    const fresh = await this.refreshCase()
    if (!fresh || fresh.status !== 'open' || fresh.version !== current.version) {
      this.state.stale = true
      this.state.message = 'The case changed. Refresh its context before using this transcript.'
      this.render()
      return
    }
    const scope = `voice-manual:${fresh.case_id}`
    let key: string
    try { key = this.voiceKeys.acquire(scope, { expected_version: fresh.version, text: transcript }) } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the same voice action.', 'uncertain_action')
      return
    }
    await this.withBusy('voice-manual-draft', async () => {
      const draft = await useTranscriptAsReply(this.api, fresh.case_id, fresh.version, transcript, key)
      this.voiceKeys.complete(scope)
      this.voiceDerivedDraftIds.add(draft.draft_id)
      await this.clearVoiceWorkflow('')
      this.acceptDraft(draft, true)
      this.state.message = 'Owner-authored draft saved from your transcript. Review and approve the exact text on the phone.'
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook: this.voiceKeys })
  }

  /** Synthetic-only voice walkthrough. It never opens the microphone or calls the backend. */
  private showDemoTranscript(): void {
    if (!this.state.fixtureMode || !this.state.caseData || this.state.caseData.status !== 'open') return
    this.clearDemoCaptureTimer()
    this.voiceKeys.clear()
    this.state.voicePhase = 'transcript_ready'
    this.state.voiceDurationMs = 6_400
    this.state.voiceTranscriptionDurationMs = 240
    this.state.voiceTranscript = 'Please make it shorter and mention walk-ins may be available until 5 p.m.'
    this.state.voiceSimulation = true
    this.state.voiceError = ''
    this.state.message = 'SIMULATED TRANSCRIPT · no microphone, ASR, backend, or customer message was used.'
    this.state.screen = 'voice'
    this.render()
  }

  /** Fixture-only recording state for deterministic display review. It never opens a microphone or calls ASR. */
  private async beginDemoRecording(): Promise<void> {
    if (!this.state.fixtureMode || !this.state.caseData || this.state.caseData.status !== 'open') return
    await this.clearVoiceWorkflow('')
    this.state.focusedAction = 0
    this.state.voicePhase = 'recording'
    this.state.voiceSimulation = true
    this.state.voiceDurationMs = 0
    this.state.voiceTranscript = ''
    this.state.message = 'SIMULATED CAPTURE · microphone and ASR are off.'
    this.demoCaptureStartedAt = Date.now()
    this.state.screen = 'voice'
    this.render()
    this.demoCaptureTimer = globalThis.setInterval(() => {
      if (!this.state.fixtureMode || this.state.screen !== 'voice' || this.state.voicePhase !== 'recording') {
        this.clearDemoCaptureTimer()
        return
      }
      this.state.voiceDurationMs = Math.min(40_000, Date.now() - this.demoCaptureStartedAt)
      this.render()
    }, 250)
  }

  private stopDemoRecording(): void {
    if (!this.state.fixtureMode || this.state.voicePhase !== 'recording') return
    this.state.voiceDurationMs = Math.max(1_000, Math.min(40_000, Date.now() - this.demoCaptureStartedAt))
    this.clearDemoCaptureTimer()
    this.state.voicePhase = 'transcript_ready'
    this.state.voiceTranscriptionDurationMs = null
    this.state.voiceTranscript = 'Please make it shorter and mention walk-ins may be available until 5 p.m.'
    this.state.voiceSimulation = true
    this.state.voiceError = ''
    this.state.message = 'SIMULATED TRANSCRIPT · no microphone, ASR, backend, or customer message was used.'
    this.render()
  }

  private clearDemoCaptureTimer(): void {
    if (this.demoCaptureTimer !== null) globalThis.clearInterval(this.demoCaptureTimer)
    this.demoCaptureTimer = null
    this.demoCaptureStartedAt = 0
  }

  private async useVoiceTranscriptAsInstruction(): Promise<void> {
    const current = this.state.caseData
    const draft = this.state.draft
    const transcript = this.state.voiceTranscript
    if (!canUseTranscriptAsInstruction(current, draft, this.state.stale, this.state.editorText, transcript)) {
      this.failLocal('Use as instruction requires an unexpired, current AI draft with no unsaved edits and a transcript of 300 characters or fewer.', 'draft_unavailable')
      return
    }
    if (!current || !draft || this.state.busy) return
    const fresh = await this.refreshCase()
    if (!fresh || !canUseTranscriptAsInstruction(fresh, draft, this.state.stale, this.state.editorText, transcript)) {
      this.state.stale = true
      this.state.message = 'Refresh the case or create a current AI suggestion before using a voice instruction.'
      this.render()
      return
    }
    const scope = `voice-revise:${fresh.case_id}:${draft.draft_id}`
    let key: string
    try { key = this.voiceKeys.acquire(scope, { expected_version: fresh.version, instruction: transcript }) } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the same voice action.', 'uncertain_action')
      return
    }
    await this.withBusy('voice-revise', async () => {
      const next = await useTranscriptAsInstruction(this.api, fresh.case_id, draft.draft_id, fresh.version, transcript, key)
      this.voiceKeys.complete(scope)
      this.voiceDerivedDraftIds.add(next.draft_id)
      await this.clearVoiceWorkflow('')
      this.acceptDraft(next, false)
      this.state.message = 'Revised AI draft saved. Review and edit the exact customer text on the phone.'
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook: this.voiceKeys })
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }

  private async stopForBackground(): Promise<void> {
    if (this.state.screen !== 'voice' && this.voiceCapture.phase === 'idle' && !this.transcriptionController) return
    await this.clearVoiceWorkflow('Voice activity stopped because Glance moved to the background. Audio and transcript were cleared.')
    this.state.voicePhase = 'error'
    if (this.state.glassesAvailable) {
      this.state.voiceError = 'Recording stopped in the background. Return to the case and start again when ready.'
    }
    this.render()
  }

  private async stopForGlassesDisconnect(): Promise<void> {
    const closed = await this.clearVoiceWorkflow('')
    this.state.voicePhase = 'error'
    if (closed) {
      this.state.voiceError = 'The Even Hub connection was lost. Recording and transcript were cleared. Reconnect the glasses before recording again.'
    }
    this.state.message = ''
    this.render()
  }

  private async clearVoiceWorkflow(message: string): Promise<boolean> {
    ++this.voiceGeneration
    this.clearDemoCaptureTimer()
    this.transcriptionController?.abort()
    this.transcriptionController = null
    this.uploadingPcm?.fill(0)
    this.uploadingPcm = null
    this.voiceFinish = null
    this.voiceKeys.clear()
    this.state.voicePhase = 'idle'
    this.state.voiceDurationMs = 0
    this.state.voiceTranscriptionDurationMs = null
    this.state.voiceTranscript = ''
    this.state.voiceSimulation = false
    this.state.voiceError = ''
    if (message) this.state.message = message
    const closed = await this.voiceCapture.cancel()
    if (!closed) {
      this.markMicrophoneShutdownUnconfirmed()
      this.render()
    }
    return closed
  }

  private markMicrophoneShutdownUnconfirmed(): void {
    this.state.glassesAvailable = false
    this.state.glassesStatus = 'G2 microphone shutdown was not confirmed. Keep Glance open and reconnect the glasses before recording again.'
    this.state.voicePhase = 'error'
    this.state.voiceError = 'Even Hub did not confirm microphone shutdown. Keep Glance open and reconnect the glasses before recording again.'
  }

  async handleGlassesInput(input: GlanceInput): Promise<void> {
    if (input.kind === 'foreground_exit') {
      this.foreground = false
      this.clearReplyTimer()
      await this.stopForBackground()
      return
    }
    if (input.kind === 'foreground_enter') {
      this.foreground = true
      await this.onForegroundResume()
      return
    }
    if (input.kind === 'audio') {
      if (this.foreground && document.visibilityState !== 'hidden') {
        const result = this.voiceCapture.receive(input.source, input.pcm)
        if (!result.ignored && result.acceptedBytes === 0 && input.pcm?.byteLength) {
          this.state.voiceError = 'The audio chunk was invalid. Recording stopped; please try again.'
        }
      }
      return
    }
    if (input.kind === 'system_exit' || input.kind === 'abnormal_exit') {
      await this.clearVoiceWorkflow('')
      return
    }
    if (input.kind === 'menu') {
      await this.stopForBackground()
      return
    }
    if (input.source !== null && input.source !== RING_EVENT_SOURCE && input.source !== EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) return

    if (input.kind === 'scroll_up' || input.kind === 'scroll_down') {
      const delta = input.kind === 'scroll_down' ? 1 : -1
      if (this.state.screen === 'inbox') {
        const count = this.state.inbox?.items.length ?? 0
        if (count) this.state.selectedIndex = (this.state.selectedIndex + delta + count) % count
      } else if (this.state.screen === 'case' && this.state.caseData) {
        const pages = Math.max(1, Math.ceil(this.state.caseData.context.length / 3))
        this.state.messagePage = Math.min(pages - 1, Math.max(0, this.state.messagePage + delta))
      } else {
        this.state.focusedAction = this.nextActionIndex(delta)
      }
      this.render()
      return
    }
    if (input.kind === 'click') {
      this.state.focusedAction = this.nextActionIndex(1)
      this.render()
      return
    }
    if (input.kind === 'double_click') await this.activateGlassAction()
  }

  private async handleSubmit(event: Event): Promise<void> {
    const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>('form[data-form]')
    if (!form) return
    event.preventDefault()
    const formName = form.dataset.form
    if (formName === 'pair') await this.pair()
    if (formName === 'manual-draft') await this.createManualDraft()
    if (formName === 'revise') await this.reviseDraft()
    if (formName === 'resolve') await this.resolveCase()
  }

  private async handleClick(event: Event): Promise<void> {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]')
    if (!target || target.hasAttribute('disabled')) return
    const action = target.dataset.action
    if (!action) return
    this.clearError()

    if (action === 'start-demo') return this.startDemo()
    if (action === 'simulate-voice') return this.showDemoTranscript()
    if (action === 'start-demo-recording') return this.beginDemoRecording()
    if (action === 'pair') return this.pair()
    if (action === 'refresh-inbox') return this.loadInbox()
    if (action === 'open-case') return this.openCase(target.dataset.caseId ?? '')
    if (action === 'open-selected') {
      const item = this.state.inbox?.items[this.state.selectedIndex]
      if (item) return this.openCase(item.case_id)
    }
    if (action === 'refresh-case') { await this.refreshCase(true); return }
    if (action === 'start-voice') return this.beginVoiceCapture()
    if (action === 'stop-voice') return this.state.fixtureMode ? this.stopDemoRecording() : this.stopAndTranscribe('owner')
    if (action === 'cancel-voice') {
      await this.clearVoiceWorkflow('Voice recording cancelled. Audio was cleared from memory.')
      this.state.screen = 'case'
      this.render()
      return
    }
    if (action === 'use-transcript-reply') return this.useVoiceTranscriptAsReply()
    if (action === 'use-transcript-instruction') return this.useVoiceTranscriptAsInstruction()
    if (action === 'voice-back-case') {
      await this.clearVoiceWorkflow('Voice transcript cleared.')
      this.state.screen = 'case'
      this.render()
      return
    }
    if (action === 'generate-draft') return this.generateDraft()
    if (action === 'write-manually') return this.beginManualDraft()
    if (action === 'save-manual') return this.createManualDraft()
    if (action === 'save-owner-copy') return this.createManualDraft(this.state.editorText, Boolean(this.state.draft && this.voiceDerivedDraftIds.has(this.state.draft.draft_id)))
    if (action === 'revise') return this.reviseDraft()
    if (action === 'open-approval') return this.openApproval()
    if (action === 'approve') return this.approveExactText()
    if (action === 'cancel-approval') {
      this.state.screen = 'draft'
      this.state.reviewedExactText = false
      this.render()
      return
    }
    if (action === 'recover-reply') return this.recoverReply()
    if (action === 'check-status') return this.checkReplyStatus()
    if (action === 'open-latest-reply') return this.openLatestReply()
    if (action === 'resolve') {
      const fresh = await this.refreshCase()
      if (!fresh) return
      this.state.screen = 'resolve'
      this.state.acknowledgedUnknown = false
      this.render()
      return
    }
    if (action === 'cancel-resolve') {
      this.state.screen = this.state.reply || this.state.caseData?.latest_reply ? 'status' : 'case'
      this.render()
      return
    }
    if (action === 'back-case') {
      this.state.screen = 'case'
      this.render()
      return
    }
    if (action === 'back-inbox') {
      this.state.screen = 'inbox'
      this.render()
      return
    }
    if (action === 'back-draft') {
      this.state.screen = 'draft'
      this.render()
      return
    }
    if (action === 'page-back') {
      this.state.messagePage = Math.max(0, this.state.messagePage - 1)
      this.render()
      return
    }
    if (action === 'page-next') {
      const count = this.state.caseData?.context.length ?? 0
      const pages = Math.max(1, Math.ceil(count / 3))
      this.state.messagePage = Math.min(pages - 1, this.state.messagePage + 1)
      this.render()
      return
    }
    if (action === 'revoke') return this.revokeCurrentDevice()
    if (action === 'leave-demo') {
      return this.stopDemo()
    }
    if (action === 'retry-write') return this.retryUncertainAction()
  }

  private handleInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | null
    if (!target?.dataset.field) return
    const field = target.dataset.field
    if (field === 'code') {
      const start = target.selectionStart
      const normalized = normalizePairingCode(target.value).slice(0, 12)
      target.value = normalized
      this.state.code = normalized
      if (start !== null && document.activeElement === target) target.setSelectionRange(normalized.length, normalized.length)
      return
    }
    if (field === 'editorText') {
      this.state.editorText = target.value
      this.state.reviewedExactText = false
      const counter = target.closest('label')?.querySelector('.counter')
      if (counter) counter.textContent = `${[...target.value].length}/${target.maxLength}`
      return
    }
    if (field === 'approvalText') {
      this.state.approvalText = target.value
      this.state.reviewedExactText = false
      const counter = target.closest('label')?.querySelector('.counter')
      if (counter) counter.textContent = `${[...target.value].length}/${target.maxLength}`
      const check = this.root.querySelector<HTMLInputElement>('[data-field="reviewedExactText"]')
      if (check) check.checked = false
      return
    }
    if (field === 'revisionInstruction') {
      this.state.revisionInstruction = target.value
      const counter = target.closest('label')?.querySelector('.counter')
      if (counter) counter.textContent = `${[...target.value].length}/${target.maxLength}`
    }
    if (field === 'resolveNote') this.state.resolveNote = target.value
  }

  private handleChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null
    if (!target?.dataset.field) return
    if (target.dataset.field === 'reviewedExactText' || target.dataset.field === 'acknowledgedUnknown') {
      if (target instanceof HTMLInputElement && target.dataset.field === 'reviewedExactText') this.state.reviewedExactText = target.checked
      if (target instanceof HTMLInputElement && target.dataset.field === 'acknowledgedUnknown') this.state.acknowledgedUnknown = target.checked
      this.render()
    }
    if (target.dataset.field === 'resolveReason') {
      this.state.resolveReason = target.value as ResolveReason
      this.render()
    }
  }

  private async pair(): Promise<void> {
    if (this.state.busy) return
    const code = normalizePairingCode(this.state.code)
    if (!isValidPairingCode(code)) {
      this.failLocal('Enter the complete 12-character code from the Telegram owner chat.', 'invalid_pairing_code')
      return
    }
    try {
      this.sessions.assertCanPersist()
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Session storage is unavailable.', 'storage_unavailable')
      return
    }
    await this.withBusy('pair', async () => {
      const session = await this.liveApi.exchangePairing(code, DEVICE_LABEL)
      this.sessions.save(session)
      this.state.code = ''
      this.state.fixtureMode = false
      this.state.sessionPresent = true
      this.state.salonName = session.salon.name
      this.state.screen = 'inbox'
      this.state.message = 'This device is paired. Session expires ' + dateTime(session.expires_at) + '.'
      this.state.connection = 'loading'
      await this.loadInbox()
    })
  }

  private async startDemo(): Promise<void> {
    if (!DEMO_FIXTURES_ENABLED) return
    await this.clearVoiceWorkflow('')
    this.sessions.clear()
    this.keys.clear()
    this.fixtures.startDemo()
    this.api = this.fixtures
    this.state.fixtureMode = true
    this.state.sessionPresent = false
    this.state.salonName = 'Safi Salon · synthetic'
    this.state.connection = 'loading'
    this.state.screen = 'inbox'
    this.state.message = 'Development fixtures only. No backend was contacted and no message can be sent.'
    this.state.error = ''
    this.state.inbox = null
    this.state.caseData = null
    this.state.draft = null
    this.state.reply = null
    this.state.replyId = null
    await this.loadInbox()
  }

  private async stopDemo(): Promise<void> {
    await this.clearVoiceWorkflow('')
    this.keys.clear()
    this.api = this.liveApi
    this.state.fixtureMode = false
    this.state.sessionPresent = false
    this.state.salonName = ''
    this.state.inbox = null
    this.state.caseData = null
    this.state.draft = null
    this.state.reply = null
    this.state.replyId = null
    this.state.screen = 'pair'
    this.state.connection = 'loading'
    this.state.message = 'Development fixtures closed. Pair through Telegram to use the live backend.'
    this.render()
  }

  private async loadInbox(): Promise<void> {
    this.pollController?.abort()
    const controller = new AbortController()
    this.pollController = controller
    if (!this.state.inbox) this.state.connection = 'loading'
    this.render()
    try {
      const inbox = await this.api.getInbox(controller.signal)
      if (controller.signal.aborted) return
      inbox.items = sortInboxOldestFirst(inbox.items.filter((item) => item.status === 'open')).slice(0, 20)
      this.state.inbox = inbox
      this.state.inboxStale = false
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      this.state.selectedIndex = Math.min(this.state.selectedIndex, Math.max(0, inbox.items.length - 1))
      this.state.error = ''
      this.state.message = this.state.fixtureMode
        ? 'Synthetic records · local demo only · no customer message is sent.'
        : ''
    } catch (error) {
      if (controller.signal.aborted) return
      this.state.connection = 'offline'
      this.state.inboxStale = Boolean(this.state.inbox)
      this.captureError(error)
      if (this.handleLostSession(error)) return
    } finally {
      if (this.pollController === controller) this.pollController = null
      this.render()
    }
  }

  private async openCase(caseId: string): Promise<void> {
    if (!caseId) return
    await this.withBusy('open-case', async () => {
      const data = await this.api.getCase(caseId)
      this.state.caseData = data
      this.state.messagePage = 0
      this.state.stale = false
      this.state.draft = null
      this.state.editorText = ''
      this.state.reply = null
      this.state.replyId = data.latest_reply?.reply_id ?? null
      this.state.screen = 'case'
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      this.clearError()
    })
  }

  private async refreshCase(showFeedback = false): Promise<CaseData | null> {
    const current = this.state.caseData
    if (!current) return null
    try {
      const fresh = await this.api.getCase(current.case_id)
      const changed = fresh.version !== current.version
      const latestReplyChanged = JSON.stringify(fresh.latest_reply) !== JSON.stringify(current.latest_reply)
      const previousConnection = this.state.connection
      this.state.caseData = fresh
      this.state.replyId = fresh.latest_reply?.reply_id ?? this.state.replyId
      if (this.state.draft && this.state.draft.based_on_version === fresh.version && Date.parse(this.state.draft.expires_at) > Date.now()) {
        this.state.stale = false
      }
      if (changed && this.state.draft && this.state.draft.based_on_version !== fresh.version) {
        this.state.stale = true
        this.state.message = 'The case changed. Context refreshed; create a new draft before approving.'
      } else if (changed && showFeedback) {
        this.state.message = 'Case context refreshed from the backend.'
      }
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      if (showFeedback) this.clearError()
      if (changed || latestReplyChanged || showFeedback || previousConnection !== this.state.connection) this.render()
      return fresh
    } catch (error) {
      this.state.connection = 'offline'
      if (current) this.state.stale = true
      this.captureError(error)
      this.handleLostSession(error)
      this.render()
      return null
    }
  }

  private async generateDraft(): Promise<void> {
    const current = this.state.caseData
    if (!current || this.state.busy || this.state.fixtureMode && current.status !== 'open') return
    const fresh = await this.refreshCase()
    if (!fresh || fresh.status !== 'open') return
    if (fresh.version !== current.version) {
      this.state.stale = true
      this.state.message = 'The case changed. Review the refreshed context, then request a new suggestion.'
      this.render()
      return
    }
    const scope = `ai-draft:${fresh.case_id}`
    const payload = { expected_version: fresh.version }
    let key: string
    try {
      key = this.keys.acquire(scope, payload)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the original request first.', 'uncertain_action')
      return
    }
    await this.withBusy('generate-draft', async () => {
      const draft = await this.api.createDraft(fresh.case_id, fresh.version, key)
      this.keys.complete(scope)
      this.acceptDraft(draft, false)
    }, { keepKeyOnFailure: true, keyScope: scope })
  }

  private beginManualDraft(): void {
    const current = this.state.caseData
    if (!current || current.status !== 'open') return
    this.state.manualMode = true
    this.state.draft = null
    this.state.editorText = ''
    this.state.revisionInstruction = ''
    this.state.screen = 'draft'
    this.state.stale = false
    this.render()
  }

  private async createManualDraft(textOverride?: string, voiceDerived = false): Promise<void> {
    const current = this.state.caseData
    if (!current || current.status !== 'open') return
    let text: string
    try {
      text = normalizeOwnerText(textOverride ?? this.state.editorText, 700)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Review the reply text.', 'invalid_text')
      return
    }
    const fresh = await this.refreshCase()
    if (!fresh || fresh.version !== current.version || fresh.status !== 'open') {
      this.state.stale = true
      this.render()
      return
    }
    const scope = voiceDerived ? `voice-manual:${fresh.case_id}` : `manual-draft:${fresh.case_id}`
    const keyBook = voiceDerived ? this.voiceKeys : this.keys
    const payload = { expected_version: fresh.version, text }
    let key: string
    try {
      key = keyBook.acquire(scope, payload)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the original request first.', 'uncertain_action')
      return
    }
    await this.withBusy('manual-draft', async () => {
      const draft = await this.api.createManualDraft(fresh.case_id, fresh.version, text, key)
      keyBook.complete(scope)
      if (voiceDerived) this.voiceDerivedDraftIds.add(draft.draft_id)
      this.acceptDraft(draft, true)
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook })
  }

  private async reviseDraft(): Promise<void> {
    const current = this.state.caseData
    const draft = this.state.draft
    if (!current || !draft || this.state.busy) return
    let instruction: string
    try {
      instruction = normalizeOwnerText(this.state.revisionInstruction, 300)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Enter a short revision instruction.', 'invalid_text')
      return
    }
    const fresh = await this.refreshCase()
    if (!fresh || fresh.version !== current.version || draft.based_on_version !== fresh.version) {
      this.state.stale = true
      this.state.message = 'This draft is tied to an older case version. Review the current context and make a new draft.'
      this.render()
      return
    }
    const voiceDerived = this.voiceDerivedDraftIds.has(draft.draft_id)
    const scope = `${voiceDerived ? 'voice-revise' : 'revise'}:${fresh.case_id}:${draft.draft_id}`
    const keyBook = voiceDerived ? this.voiceKeys : this.keys
    const payload = { expected_version: fresh.version, instruction }
    let key: string
    try {
      key = keyBook.acquire(scope, payload)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the original request first.', 'uncertain_action')
      return
    }
    await this.withBusy('revise', async () => {
      const next = await this.api.reviseDraft(fresh.case_id, draft.draft_id, fresh.version, instruction, key)
      keyBook.complete(scope)
      if (voiceDerived) this.voiceDerivedDraftIds.add(next.draft_id)
      this.acceptDraft(next, false)
      this.state.message = 'Revised draft persisted. The previous draft was replaced by the backend.'
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook })
  }

  private acceptDraft(draft: DraftData, manual: boolean): void {
    this.state.draft = draft
    this.state.editorText = draft.text
    this.state.manualMode = manual || draft.source === 'owner'
    this.state.revisionInstruction = ''
    this.state.reviewedExactText = false
    this.state.stale = false
    this.state.screen = 'draft'
    this.state.message = `Draft saved · expires ${dateTime(draft.expires_at)} · not sent.`
  }

  private async openApproval(): Promise<void> {
    const current = this.state.caseData
    const draft = this.state.draft
    if (!current || !draft || this.state.busy) return
    if (Date.parse(draft.expires_at) <= Date.now()) {
      this.failLocal('This draft expired. Refresh the case and save a new draft.', 'draft_expired')
      return
    }
    const fresh = await this.refreshCase()
    if (!fresh || fresh.status !== 'open') return
    if (fresh.version !== current.version || draft.based_on_version !== fresh.version || this.state.stale) {
      this.state.stale = true
      this.state.message = 'Refresh the case and create a current draft before approval.'
      this.render()
      return
    }
    try {
      this.state.approvalText = normalizeOwnerText(this.state.editorText, 1000)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Review the exact reply text.', 'invalid_text')
      return
    }
    this.state.reviewedExactText = false
    this.state.screen = 'approval'
    this.render()
  }

  private async approveExactText(): Promise<void> {
    const current = this.state.caseData
    const draft = this.state.draft
    if (!current || !draft || !this.state.reviewedExactText || this.state.busy) {
      if (!this.state.reviewedExactText) this.failLocal('Read the full customer-facing text on the phone and confirm before queueing.', 'review_required')
      return
    }
    let text: string
    try {
      text = normalizeOwnerText(this.state.approvalText, 1000)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Review the exact reply text.', 'invalid_text')
      return
    }
    const fresh = await this.refreshCase()
    if (!fresh || fresh.status !== 'open') return
    if (fresh.version !== current.version || fresh.version !== draft.based_on_version || this.state.stale) {
      this.state.stale = true
      this.state.screen = 'case'
      this.state.message = 'Approval stopped because the case changed. Review the latest context and create a new draft.'
      this.render()
      return
    }
    const voiceDerived = this.voiceDerivedDraftIds.has(draft.draft_id)
    const scope = `approve:${fresh.case_id}`
    const keyBook = voiceDerived ? this.voiceKeys : this.keys
    const payload = { expected_version: fresh.version, draft_id: draft.draft_id, text }
    let key: string
    try {
      key = keyBook.acquire(scope, payload)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the original approval text.', 'uncertain_action')
      return
    }
    await this.withBusy('approve', async () => {
      const result = await this.api.approveReply(fresh.case_id, fresh.version, draft.draft_id, text, key)
      keyBook.complete(scope)
      this.state.replyId = result.reply_id
      this.state.reply = {
        reply_id: result.reply_id,
        case_id: fresh.case_id,
        state: 'queued',
        delivery: 'unconfirmed',
        error_category: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        submitted_at: null,
        delivered_at: null,
        failed_at: null,
      }
      this.state.caseData = { ...fresh, version: result.case_version, latest_reply: {
        reply_id: result.reply_id,
        state: 'queued',
        updated_at: new Date().toISOString(),
        delivery: 'unconfirmed',
        error_category: null,
        submitted_at: null,
        delivered_at: null,
      } }
      this.state.screen = 'status'
      this.state.autoPolls = 0
      this.state.message = 'Reply queued. It has not been confirmed delivered.'
      await this.refreshCase()
      await this.fetchReply(result.reply_id, true)
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook })
  }

  private async recoverReply(): Promise<void> {
    const fresh = await this.refreshCase(true)
    if (!fresh) return
    const replyId = fresh.latest_reply?.reply_id
    if (replyId) {
      this.state.replyId = replyId
      await this.fetchReply(replyId, true)
      this.state.screen = 'status'
      this.render()
      return
    }
    this.state.message = 'No reply is listed yet. If approval timed out, retry the same approval with the same key.'
    this.render()
  }

  private async openLatestReply(): Promise<void> {
    const fresh = await this.refreshCase()
    const replyId = fresh?.latest_reply?.reply_id
    if (!replyId) {
      this.state.message = 'No reply is recorded for this case.'
      this.render()
      return
    }
    this.state.replyId = replyId
    await this.fetchReply(replyId, true)
    this.state.screen = 'status'
    this.render()
  }

  private async checkReplyStatus(): Promise<void> {
    const replyId = this.state.replyId ?? this.state.caseData?.latest_reply?.reply_id
    if (!replyId) return this.recoverReply()
    await this.fetchReply(replyId, true)
  }

  private async fetchReply(replyId: string, schedule: boolean): Promise<void> {
    this.clearReplyTimer()
    try {
      const reply = await this.api.getReply(replyId)
      this.state.reply = reply
      this.state.replyId = reply.reply_id
      if (this.state.caseData?.case_id === reply.case_id && this.state.caseData.latest_reply?.reply_id === reply.reply_id) {
        this.state.caseData = {
          ...this.state.caseData,
          latest_reply: {
            reply_id: reply.reply_id,
            state: reply.state,
            delivery: reply.delivery,
            error_category: reply.error_category,
            updated_at: reply.updated_at,
            submitted_at: reply.submitted_at,
            delivered_at: reply.delivered_at,
          },
        }
      }
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      if (shouldPollReply(reply.state) && schedule && this.state.autoPolls < 5) {
        const delay = replyPollDelay(this.state.autoPolls)
        this.state.autoPolls += 1
        this.replyTimer = window.setTimeout(() => {
          if (this.foreground && document.visibilityState === 'visible' && this.state.screen === 'status') {
            void this.fetchReply(replyId, true)
          }
        }, delay)
      } else if (shouldPollReply(reply.state) && this.state.autoPolls >= 5) {
        this.state.message = 'Automatic status checks paused. Select Check status when you are ready.'
      } else if (reply.state === 'submitted' && reply.delivery !== 'confirmed' && this.state.caseData?.channel === 'telegram') {
        this.state.message = 'Telegram accepted the message. Delivery is not confirmed.'
      }
      this.render()
    } catch (error) {
      this.state.connection = 'offline'
      this.captureError(error)
      this.handleLostSession(error)
      this.render()
    }
  }

  private async resolveCase(): Promise<void> {
    const current = this.state.caseData
    if (!current || this.state.busy || current.status === 'resolved') return
    const fresh = await this.refreshCase()
    if (!fresh) return
    if (fresh.version !== current.version) {
      this.state.stale = true
      this.state.message = 'The case changed. Review the updated context before resolving.'
      this.render()
      return
    }
    const unknown = fresh.latest_reply?.state === 'unknown'
    if (unknown && !this.state.acknowledgedUnknown) {
      this.failLocal('Confirm the uncertainty warning before resolving.', 'acknowledgement_required')
      return
    }
    const body: ResolveRequest = {
      expected_version: fresh.version,
      reason: this.state.resolveReason,
      acknowledge_unknown_reply: unknown && this.state.acknowledgedUnknown,
    }
    if (this.state.resolveReason === 'other' && this.state.resolveNote.trim()) {
      try {
        body.note = normalizeOwnerText(this.state.resolveNote, 200)
      } catch (error) {
        this.failLocal(error instanceof Error ? error.message : 'Check the note text.', 'invalid_text')
        return
      }
    }
    await this.withBusy('resolve', async () => {
      const result = await this.api.resolveCase(fresh.case_id, body)
      const latestReply = fresh.latest_reply && result.cancelled_reply_ids.includes(fresh.latest_reply.reply_id)
        ? { ...fresh.latest_reply, state: 'cancelled' as const, updated_at: new Date().toISOString() }
        : fresh.latest_reply
      this.state.caseData = { ...fresh, status: 'resolved', version: result.version, latest_reply: latestReply }
      this.state.screen = 'case'
      this.state.acknowledgedUnknown = false
      let feedback: string
      if (result.cancelled_reply_ids.length) {
        feedback = 'Case resolved. The queued reply was cancelled before dispatch and was not sent.'
      } else if (result.unknown_reply_acknowledged) {
        feedback = 'Case resolved with your uncertainty acknowledgement. The customer may or may not have received the reply.'
      } else {
        feedback = 'Case marked resolved. This does not change payment state.'
      }
      await this.loadInbox()
      this.state.message = feedback
      this.render()
    })
  }

  private async revokeCurrentDevice(): Promise<void> {
    if (this.state.fixtureMode) {
      this.stopDemo()
      return
    }
    if (!this.sessions.load()) return
    await this.withBusy('revoke-session', async () => {
      await this.clearVoiceWorkflow('')
      await this.liveApi.revokeCurrentSession()
      this.keys.clear()
      this.voiceKeys.clear()
      this.voiceDerivedDraftIds.clear()
      this.state.sessionPresent = false
      this.state.screen = 'pair'
      this.state.salonName = ''
      this.state.inbox = null
      this.state.caseData = null
      this.state.draft = null
      this.state.reply = null
      this.state.replyId = null
      this.state.message = 'This device session was revoked. For a lost device, revoke it from the Telegram owner chat.'
    })
  }

  private async retryUncertainAction(): Promise<void> {
    if (this.state.screen === 'voice' && this.state.caseData) {
      const caseId = this.state.caseData.case_id
      if (this.voiceKeys.has(`voice-manual:${caseId}`)) return this.useVoiceTranscriptAsReply()
      const draftId = this.state.draft?.draft_id
      if (draftId && this.voiceKeys.has(`voice-revise:${caseId}:${draftId}`)) return this.useVoiceTranscriptAsInstruction()
    }
    if (this.state.screen === 'approval') return this.approveExactText()
    if (this.state.screen === 'draft' && this.state.manualMode) return this.createManualDraft(this.state.editorText, Boolean(this.state.draft && this.voiceDerivedDraftIds.has(this.state.draft.draft_id)))
    if (this.state.screen === 'draft' && this.state.revisionInstruction) return this.reviseDraft()
    if (this.state.screen === 'case') return this.generateDraft()
  }

  private async withBusy(
    action: string,
    operation: () => Promise<void>,
    options: { keepKeyOnFailure?: boolean; keyScope?: string; keyBook?: IdempotencyKeyBook } = {},
  ): Promise<void> {
    if (this.state.busy) return
    this.state.busy = true
    this.state.busyAction = action
    const keyBook = options.keyBook ?? this.keys
    this.state.error = ''
    this.state.errorCode = null
    this.render()
    try {
      await operation()
    } catch (error) {
      this.captureError(error)
      if (error instanceof ApiError) {
        if (action === 'pair' && error.uncertain) {
          this.state.code = ''
          this.state.message = 'Pairing outcome is unclear. Request a fresh Telegram code and revoke any session from this attempt in the owner chat before pairing again.'
        }
        if (this.handleLostSession(error)) return
        const definitiveDraftFailure = ['draft_timeout', 'draft_unavailable'].includes(error.code)
        const retryableSameKey = (!definitiveDraftFailure && error.uncertain) || error.code === 'request_in_progress'
        if (options.keyScope && !retryableSameKey) keyBook.complete(options.keyScope)
        if (error.code === 'unresolved_reply_exists' || error.code === 'multiple_unresolved_replies') {
          const current = await this.refreshCase()
          if (current?.latest_reply?.reply_id) {
            this.state.replyId = current.latest_reply.reply_id
            await this.fetchReply(current.latest_reply.reply_id, true)
            this.state.screen = 'status'
            this.state.message = userMessageForError(error.code)
          }
        } else if (error.code === 'stale_case_version') {
          await this.refreshCase()
        }
      } else if (options.keyScope && !options.keepKeyOnFailure) {
        keyBook.complete(options.keyScope)
      }
    } finally {
      this.state.busy = false
      this.state.busyAction = ''
      this.render()
    }
  }

  private captureError(error: unknown): void {
    if (error instanceof ApiError) {
      this.state.error = userMessageForError(error.code)
      this.state.errorCode = error.code
      this.state.requestId = error.requestId
      this.state.retryAfter = error.retryAfterSeconds
      if (error.code === 'network_error' || error.code === 'request_timeout') this.state.connection = 'offline'
      return
    }
    this.state.error = error instanceof Error ? error.message : 'The action could not be completed.'
    this.state.errorCode = null
    this.state.requestId = null
    this.state.retryAfter = null
  }

  private failLocal(message: string, code: string): void {
    this.state.error = message
    this.state.errorCode = code
    this.state.requestId = null
    this.state.retryAfter = null
    this.render()
  }

  private clearError(): void {
    this.state.error = ''
    this.state.errorCode = null
    this.state.requestId = null
    this.state.retryAfter = null
  }

  private handleLostSession(error: unknown): boolean {
    if (!(error instanceof ApiError) || !['invalid_session', 'session_expired', 'session_revoked', 'owner_not_authorized'].includes(error.code)) return false
    if (!this.sessions.load()) {
      void this.clearVoiceWorkflow('')
      this.voiceDerivedDraftIds.clear()
      this.keys.clear()
      this.voiceKeys.clear()
      this.state.sessionPresent = false
      this.state.screen = 'pair'
      this.state.salonName = ''
      this.state.message = 'Session ended. Pair this device again through Telegram.'
      this.state.inbox = null
      this.state.caseData = null
      this.state.draft = null
      this.state.reply = null
      this.state.replyId = null
      this.render()
      return true
    }
    return false
  }

  private async onVisibilityChange(): Promise<void> {
    this.foreground = document.visibilityState === 'visible'
    if (this.foreground) await this.onForegroundResume()
    else {
      this.clearReplyTimer()
      await this.stopForBackground()
    }
  }

  private async onForegroundResume(): Promise<void> {
    if (!this.foreground || document.visibilityState === 'hidden') return
    const session = this.state.fixtureMode ? null : this.sessions.load()
    if (!this.state.fixtureMode && !session && this.state.sessionPresent) {
      this.state.sessionPresent = false
      this.state.screen = 'pair'
      this.state.message = 'Session expired. Pair this device again through Telegram.'
      await this.clearVoiceWorkflow('')
      this.voiceDerivedDraftIds.clear()
      this.render()
      return
    }
    if (this.state.screen === 'inbox') await this.loadInbox()
    else if (this.state.caseData && ['case', 'voice', 'draft', 'approval', 'resolve', 'status'].includes(this.state.screen)) {
      await this.refreshCaseStatus()
      if (this.state.screen === 'status' && this.state.replyId) await this.fetchReply(this.state.replyId, true)
    }
  }

  private async pollVisibleState(): Promise<void> {
    if (!this.foreground || document.visibilityState !== 'visible' || this.state.busy) return
    if (!this.state.fixtureMode && this.state.sessionPresent && !this.sessions.load()) {
      this.state.sessionPresent = false
      this.state.screen = 'pair'
      this.state.message = 'Session expired. Pair this device again through Telegram.'
      void this.clearVoiceWorkflow('')
      this.voiceDerivedDraftIds.clear()
      this.render()
      return
    }
    if (this.state.screen === 'inbox' && this.state.sessionPresent || this.state.screen === 'inbox' && this.state.fixtureMode) {
      await this.loadInbox()
    } else if (['case', 'voice', 'draft', 'approval', 'resolve', 'status'].includes(this.state.screen) && this.state.caseData) {
      await this.refreshCaseStatus()
    }
  }

  private async refreshCaseStatus(): Promise<void> {
    const current = this.state.caseData
    if (!current) return
    try {
      const status = await this.api.getCaseStatus(current.case_id)
      if (this.state.caseData?.case_id !== current.case_id) return
      if (status.version !== current.version || status.status !== current.status) {
        await this.refreshCase()
        if (this.state.screen === 'status' && this.state.replyId) await this.fetchReply(this.state.replyId, true)
        return
      }

      const previous = current.latest_reply
      const latest = status.latest_reply
      if (!latest) {
        if (previous) await this.refreshCase()
        return
      }
      if (previous && previous.reply_id === latest.reply_id && previous.state === latest.state &&
          previous.updated_at === latest.updated_at) return
      if (this.state.screen === 'status') {
        await this.fetchReply(latest.reply_id, true)
        return
      }

      const reply = await this.api.getReply(latest.reply_id)
      if (this.state.caseData?.case_id !== current.case_id) return
      this.state.reply = reply
      this.state.replyId = reply.reply_id
      this.state.caseData = {
        ...this.state.caseData,
        latest_reply: {
          reply_id: reply.reply_id,
          state: reply.state,
          delivery: reply.delivery,
          error_category: reply.error_category,
          updated_at: reply.updated_at,
          submitted_at: reply.submitted_at,
          delivered_at: reply.delivered_at,
        },
      }
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      this.render()
    } catch (error) {
      this.state.connection = 'offline'
      this.captureError(error)
      this.handleLostSession(error)
      this.render()
    }
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) window.clearTimeout(this.replyTimer)
    this.replyTimer = null
  }

  private async activateGlassAction(): Promise<void> {
    const selected = this.state.focusedAction
    switch (this.state.screen) {
      case 'inbox': return this.openCase(this.state.inbox?.items[this.state.selectedIndex]?.case_id ?? '')
      case 'case':
        if (this.state.caseData?.status === 'resolved') {
          if (selected === 0 && this.state.caseData.latest_reply) return this.openLatestReply()
          if (selected === 1 || !this.state.caseData.latest_reply) { this.state.screen = 'inbox'; this.render(); return }
          return
        }
        if (selected === 0) return this.generateDraft()
        if (selected === 1) return this.beginManualDraft()
        if (selected === 2) return this.state.fixtureMode ? this.beginDemoRecording() : this.beginVoiceCapture()
        if (selected === 3) return this.openLatestReply()
        if (selected === 4) { this.state.screen = 'resolve'; this.render(); return }
        if (selected === 5) { this.state.screen = 'inbox'; this.render(); return }
        break
      case 'voice':
        if (this.state.voicePhase === 'recording') {
          if (selected === 0) return this.state.voiceSimulation ? this.stopDemoRecording() : this.stopAndTranscribe('owner')
          if (selected === 1) {
            await this.clearVoiceWorkflow('Voice recording cancelled. Audio was cleared from memory.')
            this.state.screen = 'case'
            this.render()
          }
        } else if (this.state.voicePhase === 'transcript_ready') {
          if (selected === 0) this.state.message = 'Choose Use as reply or Use as instruction on the phone.'
          else this.state.message = 'The full transcript is shown on the paired phone.'
          this.render()
        } else if (this.state.voicePhase === 'error' || this.state.voicePhase === 'idle') {
          if (selected === 0) return this.beginVoiceCapture()
          if (selected === 1) {
            await this.clearVoiceWorkflow('Voice workflow closed.')
            this.state.screen = 'case'
            this.render()
          }
        }
        break
      case 'draft':
        if (selected === 0) return this.openApproval()
        if (selected === 1) { this.state.screen = 'case'; this.render(); return }
        break
      case 'approval':
        if (selected === 0) return this.approveExactText()
        if (selected === 1) { this.state.screen = 'draft'; this.render(); return }
        break
      case 'status':
        if (selected === 0) return this.checkReplyStatus()
        if (selected === 1) { this.state.screen = 'resolve'; this.render(); return }
        if (selected === 2) { this.state.screen = 'inbox'; this.render(); return }
        break
      case 'resolve':
        if (selected === 0) return this.resolveCase()
        if (selected === 1) { this.state.screen = 'case'; this.render(); return }
        break
      case 'pair': return
    }
  }

  private nextActionIndex(delta: number): number {
    const counts: Record<GlanceScreen, number> = { pair: 1, inbox: 1, case: 6, voice: 2, draft: 2, approval: 2, status: 3, resolve: 2 }
    const count = this.state.screen === 'case' && this.state.caseData?.status === 'resolved'
      ? 2
      : counts[this.state.screen]
    return (this.state.focusedAction + delta + count) % count
  }

  private render(): void {
    const previousScreen = this.renderedScreen
    this.renderedScreen = this.state.screen
    if (previousScreen === 'voice' && this.state.screen !== 'voice') void this.clearVoiceWorkflow('')
    this.root.innerHTML = this.renderScreen()
    this.updateGlasses()
  }

  private renderScreen(): string {
    const fixtureBanner = this.state.fixtureMode
      ? '<div class="fixture-banner" role="note"><strong>DEVELOPMENT FIXTURES · SYNTHETIC ONLY</strong><span>No backend request · no customer message can be sent</span></div>'
      : ''
    const header = `<header class="topbar"><div class="brand"><span class="brand-mark">R</span><span><strong>RemboAI</strong><small>GLANCE</small></span></div><div class="top-meta"><span class="connection ${escapeHtml(this.state.connection)}">${escapeHtml(this.connectionLabel())}</span>${this.state.sessionPresent || this.state.fixtureMode ? `<span class="salon-name">${escapeHtml(this.state.salonName)}</span>` : ''}</div></header>`
    const footer = `<footer class="app-footer"><span>${this.state.glassesAvailable ? 'G2 connected · 576 × 288' : escapeHtml(this.state.glassesStatus)}</span>${this.state.sessionPresent && !this.state.fixtureMode ? button('Revoke this device', 'revoke') : this.state.fixtureMode ? button('Exit demo', 'leave-demo') : ''}</footer>`
    const error = this.state.error ? `<div class="error-card" role="alert"><strong>${escapeHtml(this.state.error)}</strong>${this.state.requestId ? `<small>Request ID: ${escapeHtml(this.state.requestId)}</small>` : ''}${this.state.retryAfter !== null ? `<small>Retry after ${this.state.retryAfter}s</small>` : ''}${this.canRetrySameAction() ? button('Retry the same request', 'retry-write', { primary: true }) : ''}</div>` : ''
    const message = formMessage(this.state.message)
    const screen = this.state.screen === 'pair' ? this.renderPair() :
      this.state.screen === 'inbox' ? this.renderInbox() :
      this.state.screen === 'case' ? this.renderCase() :
      this.state.screen === 'voice' ? this.renderVoice() :
      this.state.screen === 'draft' ? this.renderDraft() :
      this.state.screen === 'approval' ? this.renderApproval() :
      this.state.screen === 'status' ? this.renderStatus() : this.renderResolve()
    return `${fixtureBanner}${header}<main class="layout"><section class="phone-shell"><div class="phone-screen">${screen}${error}${message}</div></section><aside class="glance-hint"><p class="eyebrow">ON YOUR G2</p><h2>One decision at a glance.</h2><p>Use scroll to move through cases or message chunks. Click changes the highlighted action; double-click opens it.</p><div class="control-key"><span>SCROLL</span><b>Choose / page</b></div><div class="control-key"><span>CLICK</span><b>Focus action</b></div><div class="control-key"><span>DOUBLE</span><b>Activate action</b></div><p class="hint-small">Full text, forms, and exact approval review stay on the paired phone.</p></aside></main>${footer}`
  }

  private renderPair(): string {
    const allowFixtures = DEMO_FIXTURES_ENABLED
    return `<section class="panel pair-panel"><p class="eyebrow">OWNER ESCALATION DESK</p><h1>Pair your Glance</h1><p class="lead">Open the RemboAI Glance pairing message in your authenticated Telegram owner chat, then enter its 12-character code here.</p><p class="bridge-notice">${this.state.glassesAvailable ? 'Even Hub display connected · 576 × 288' : escapeHtml(this.state.glassesStatus)}</p><form data-form="pair" class="stack"><label for="pair-code">One-time pairing code</label><input id="pair-code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" maxlength="12" placeholder="0123456789AB" value="${escapeHtml(this.state.code)}" data-field="code" aria-describedby="pair-help" required><small id="pair-help">Letters use Crockford Base32. Spaces and hyphens are ignored. The code expires in five minutes.</small><button class="button primary wide" type="submit" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Pairing…' : 'Pair this device'}</button></form><div class="privacy-note"><strong>Revocable bearer session</strong><span>The session token is stored in browser localStorage. Revoke it here or from the Telegram owner chat. Do not share this device.</span></div>${allowFixtures ? `<div class="demo-entry"><span>For layout and workflow review only</span>${button('Open synthetic development demo', 'start-demo')}</div>` : ''}</section>`
  }

  private renderInbox(): string {
    const inbox = this.state.inbox
    const items = inbox?.items ?? []
    const stale = this.state.inboxStale ? '<div class="stale-strip">Offline · showing stale in-memory cases</div>' : ''
    const list = items.length ? `<div class="case-list">${items.map((item, index) => `<article class="case-row ${index === this.state.selectedIndex ? 'selected' : ''}"><button class="case-open" data-action="open-case" data-case-id="${escapeHtml(item.case_id)}"><span class="customer">${escapeHtml(item.customer_label)}</span><span class="case-age">${escapeHtml(this.age(item.created_at))}</span><span class="case-category">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.channel.toUpperCase())}</span><span class="preview">${escapeHtml(item.preview)}</span><span class="open-chevron">Open →</span></button></article>`).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">✓</div><h2>${this.state.connection === 'loading' ? 'Loading your inbox' : 'You are all caught up'}</h2><p>${this.state.connection === 'loading' ? 'Checking for open owner escalations.' : 'No open cases need your attention right now.'}</p></div>`
    const count = inbox ? inbox.open_count : '—'
    const more = inbox?.has_more ? `<p class="more-note">Showing ${items.length} oldest open cases · ${moreCaseCount(inbox.open_count, items.length)} more not shown.</p>` : ''
    return `<section class="panel inbox-panel"><div class="section-heading"><div><p class="eyebrow">${this.state.fixtureMode ? 'SYNTHETIC INBOX' : 'OWNER INBOX'}</p><h1>Open cases</h1></div><div class="count-pill"><strong>${escapeHtml(count)}</strong><span>open</span></div></div>${stale}${list}${more}<div class="button-row">${button('Refresh', 'refresh-inbox')}${items.length ? button('Open selected case', 'open-selected', { primary: true }) : ''}</div><p class="poll-note">Inbox refreshes every five seconds while this screen is visible. New cases may take time to appear.</p></section>`
  }

  private renderCase(): string {
    const item = this.state.caseData
    if (!item) return this.renderLoading('Loading case')
    const events = messagePage(item.context, this.state.messagePage, 3)
    const pages = Math.max(1, Math.ceil(item.context.length / 3))
    const latest = item.latest_reply ? `<div class="latest-reply"><span class="eyebrow">LATEST REPLY</span><strong>${escapeHtml(presentReplyState(item.latest_reply.state, item.channel).label)}</strong><button class="text-button" data-action="open-latest-reply">Inspect status →</button></div>` : ''
    const stale = this.state.stale ? '<div class="stale-strip">Case changed · refresh and create a current draft before approval.</div>' : ''
    const thread = events.map((event) => `<article class="message ${escapeHtml(event.actor)}"><div class="message-meta"><strong>${escapeHtml(event.actor === 'customer' ? item.customer_label : event.actor === 'assistant' ? 'RemboAI' : 'Owner')}</strong><time>${escapeHtml(dateTime(event.created_at))}</time></div><p>${escapeHtml(event.text)}</p></article>`).join('')
    const voiceAction = this.state.fixtureMode
      ? button('Start simulated capture', 'start-demo-recording', { disabled: item.status !== 'open' || this.state.busy })
      : button('Record voice correction', 'start-voice', { disabled: item.status !== 'open' || this.state.busy || !this.state.sessionPresent || !this.state.glassesAvailable })
    return `<section class="panel case-panel"><button class="text-button back-link" data-action="back-inbox">← Inbox</button><div class="section-heading"><div><p class="eyebrow">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.channel.toUpperCase())}</p><h1>${escapeHtml(item.customer_label)}</h1></div><span class="status-tag ${item.status === 'resolved' ? 'resolved' : ''}">${escapeHtml(caseStatusText(item.status))} · v${item.version}</span></div>${stale}<p class="issue-summary">${escapeHtml(this.caseSummary(item))}</p><div class="context-label"><span>Customer-visible conversation</span>${item.has_earlier ? '<strong>Earlier messages omitted</strong>' : ''}</div><div class="thread-chunk">${thread || '<p class="subtle">No visible conversation is available.</p>'}</div><div class="chunk-nav">${button('Previous messages', 'page-back', { disabled: this.state.messagePage <= 0 })}<span>Chunk ${this.state.messagePage + 1} of ${pages}</span>${button('Next messages', 'page-next', { disabled: this.state.messagePage >= pages - 1 })}</div>${latest}<div class="button-row wrap">${button('Generate AI suggestion', 'generate-draft', { primary: true, disabled: item.status !== 'open' || this.state.busy })}${button('Write a reply', 'write-manually', { disabled: item.status !== 'open' || this.state.busy })}${voiceAction}${button('Resolve case', 'resolve', { disabled: item.status !== 'open' || this.state.busy })}${button('Refresh context', 'refresh-case')}</div><p class="poll-note">${this.state.fixtureMode ? 'SIMULATED TRANSCRIPT · fixture only; no microphone, ASR, backend, or message send.' : 'Voice recording starts only after your action. Drafts remain unsent until you approve exact text.'}</p></section>`
  }

  private renderVoice(): string {
    const phase = this.state.voicePhase
    const item = this.state.caseData
    if (!item) return this.renderLoading('Loading case')
    const duration = this.formatDuration(this.state.voiceDurationMs)
    if (phase === 'recording') {
      const simulated = this.state.voiceSimulation
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="cancel-voice">← Cancel voice workflow</button><p class="eyebrow">${simulated ? 'SIMULATED CAPTURE · MIC OFF' : 'G2 MICROPHONE ACTIVE'}</p><h1>${simulated ? 'Capture preview' : 'Recording'}</h1><div class="recording-indicator ${simulated ? 'simulated-recording' : ''}"><span class="recording-dot"></span><strong>${simulated ? 'Simulation only' : 'Microphone on'}</strong><span class="voice-duration">${duration}</span></div><p class="lead">${simulated ? 'Fixture-only display preview. No microphone or ASR is running.' : 'Speak a short message. Stop when you are done. The recording stays in memory and is not saved.'}</p><div class="button-row">${button(simulated ? 'Finish simulated capture' : 'Stop and transcribe', 'stop-voice', { primary: true })}${button('Cancel', 'cancel-voice')}</div><small>${simulated ? 'Synthetic fixture · no audio is captured' : 'Maximum 40 seconds · G2 microphone only'}</small></section>`
    }
    if (phase === 'transcript_ready') {
      const draft = this.state.draft
      const canInstruction = canUseTranscriptAsInstruction(item, draft, this.state.stale, this.state.editorText, this.state.voiceTranscript)
      const instructionWhy = !draft || draft.source !== 'ai'
        ? 'To use this as an instruction, first create an AI suggestion for this case.'
        : [...this.state.voiceTranscript].length > 300
          ? 'Instructions are limited to 300 characters. Record a shorter instruction.'
          : !canInstruction
            ? 'Refresh the case and keep a current, unedited AI suggestion before using an instruction.'
            : 'This will revise the current AI suggestion only. The transcript is not a customer reply.'
      const transcriptLabel = this.state.voiceSimulation ? 'SIMULATED TRANSCRIPT · FIXTURE ONLY' : 'TRANSCRIPT · NOT SENT'
      const transcriptNote = this.state.voiceSimulation ? '<p class="warning-card">Synthetic walkthrough text · no microphone or ASR was used. This demo cannot contact customers.</p>' : ''
      const againAction = this.state.voiceSimulation ? 'start-demo-recording' : 'start-voice'
      const againLabel = this.state.voiceSimulation ? 'Start simulated capture again' : 'Record again'
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="voice-back-case">← Case</button><p class="eyebrow">${transcriptLabel}</p><h1>Choose what you meant</h1>${transcriptNote}<div class="voice-facts"><span>Captured ${duration}</span><span>${this.state.voiceSimulation ? 'Simulated' : 'Transcription'} ${this.state.voiceTranscriptionDurationMs ?? 0} ms</span></div><label for="voice-transcript">${this.state.voiceSimulation ? 'Synthetic words' : 'Recognized words'}</label><textarea id="voice-transcript" class="transcript-text" rows="6" readonly>${escapeHtml(this.state.voiceTranscript)}</textarea><div class="intent-cards"><div><h2>Use as reply</h2><p>Create an owner-authored draft from these words. You can edit the full reply before approval.</p>${button('Use as reply', 'use-transcript-reply', { primary: true, disabled: this.state.busy || item.status !== 'open' })}</div><div><h2>Use as instruction</h2><p>${escapeHtml(instructionWhy)}</p>${button('Use as instruction', 'use-transcript-instruction', { disabled: this.state.busy || !canInstruction })}</div></div><p class="subtle">Neither choice sends a message. Exact outgoing text still requires your separate approval.</p>${button(againLabel, againAction)}</section>`
    }
    if (phase === 'starting' || phase === 'stopping' || phase === 'transcribing') {
      const label = phase === 'starting' ? 'Starting microphone' : phase === 'stopping' ? 'Stopping microphone' : 'Transcribing'
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="cancel-voice">← Cancel</button><div class="spinner" aria-hidden="true"></div><p class="eyebrow">${phase === 'transcribing' ? 'AUDIO IN MEMORY ONLY' : 'G2 MICROPHONE'}</p><h1>${label}</h1><p class="subtle">${phase === 'transcribing' ? 'No automatic retry. The audio buffer is cleared when this request ends.' : 'Glance will not start recording in the background.'}</p></section>`
    }
    if (phase === 'error') {
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="voice-back-case">← Case</button><p class="eyebrow">VOICE CAPTURE</p><h1>Recording stopped</h1><div class="warning-card">${escapeHtml(this.state.voiceError || 'Voice capture could not continue.')}${this.state.requestId ? `<small>Request ID: ${escapeHtml(this.state.requestId)}</small>` : ''}${this.state.retryAfter !== null ? `<small>Try again after ${this.state.retryAfter}s.</small>` : ''}</div><p class="subtle">No recording is retained. Start a new recording to try again.</p>${button('Record again', 'start-voice', { primary: true, disabled: this.state.busy || !this.state.glassesAvailable })}</section>`
    }
    return `<section class="panel voice-panel"><button class="text-button back-link" data-action="voice-back-case">← Case</button><p class="eyebrow">OWNER-STARTED VOICE</p><h1>Ready to record</h1><p class="lead">The G2 microphone opens only after you choose Record. Speak briefly, stop, then review the transcript on your phone.</p>${button('Start G2 recording', 'start-voice', { primary: true, disabled: this.state.busy || !this.state.glassesAvailable || this.state.fixtureMode })}</section>`
  }

  private renderDraft(): string {
    const draft = this.state.draft
    if (!this.state.caseData) return this.renderLoading('Loading case')
    if (this.state.manualMode && !draft) {
      return `<section class="panel editor-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">OWNER-AUTHORED REPLY</p><h1>Write a reply</h1><p class="lead">This text will be saved as a manual draft. It will not be sent until you inspect and approve the exact text.</p><form data-form="manual-draft" class="stack"><label for="reply-editor">Customer-facing text <span class="counter">${[...this.state.editorText].length}/700</span></label><textarea id="reply-editor" data-field="editorText" maxlength="700" rows="8" placeholder="Write the reply you want the customer to receive.">${escapeHtml(this.state.editorText)}</textarea><button class="button primary wide" type="submit" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Saving draft…' : 'Save manual draft'}</button></form>${this.uncertainNote('manual-draft')}</section>`
    }
    if (!draft) return this.renderLoading(this.state.busy ? 'Creating AI suggestion' : 'No saved draft')
    const expiry = new Date(draft.expires_at)
    const isExpired = !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()
    const source = this.state.fixtureMode ? 'SYNTHETIC PREVIEW — NOT AI / NOT SENT' : draft.source === 'ai' ? 'AI SUGGESTION — NOT SENT' : 'OWNER-AUTHORED DRAFT — NOT SENT'
    const revision = draft.source === 'ai' ? `<form data-form="revise" class="stack revision-form"><label for="revision">Owner correction instruction <span class="counter">${[...this.state.revisionInstruction].length}/300</span></label><textarea id="revision" data-field="revisionInstruction" maxlength="300" rows="3" placeholder="Tell the assistant what to change. This instruction is not the customer reply.">${escapeHtml(this.state.revisionInstruction)}</textarea><button class="button" type="submit" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Revising…' : 'Create revised draft'}</button></form>` : ''
    return `<section class="panel editor-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">${source}</p><h1>Review your draft</h1><div class="draft-meta"><span>Case version ${draft.based_on_version}</span><span>${isExpired ? 'Expired' : `Expires ${escapeHtml(dateTime(draft.expires_at))}`}</span></div>${this.state.stale || draft.based_on_version !== this.state.caseData.version ? '<div class="stale-strip">This draft is stale. Refresh context and create a new draft before approval.</div>' : ''}<label for="draft-editor">Full customer-facing reply <span class="counter">${[...this.state.editorText].length}/700</span></label><textarea id="draft-editor" data-field="editorText" maxlength="700" rows="9" ${isExpired ? 'disabled' : ''}>${escapeHtml(this.state.editorText)}</textarea><p class="subtle">Editing this text changes only the proposed reply. Nothing is sent automatically.</p>${revision}<div class="button-row wrap">${button('Review exact text', 'open-approval', { primary: true, disabled: isExpired || this.state.stale || this.state.busy })}${draft.source === 'ai' ? button('Save as owner-authored draft', 'save-owner-copy', { disabled: isExpired || this.state.busy }) : ''}${button('Back to case', 'back-case')}</div>${this.uncertainNote(draft.source === 'ai' ? 'ai-draft' : 'manual-draft')}</section>`
  }

  private renderApproval(): string {
    const draft = this.state.draft
    if (!draft) return this.renderLoading('No persisted draft')
    const unresolvedWarning = this.state.caseData?.latest_reply && ['queued', 'sending', 'unknown'].includes(this.state.caseData.latest_reply.state)
      ? '<div class="warning-card"><strong>Existing reply needs attention.</strong><span>Inspect its status before approving another message.</span></div>' : ''
    return `<section class="panel approval-panel"><button class="text-button back-link" data-action="back-draft">← Draft</button><p class="eyebrow">EXACT TEXT · NOT SENT</p><h1>Inspect the full reply</h1><p class="lead">Read every line below. This exact text will be queued if you approve.</p><label for="approval-editor">Customer-facing message</label><textarea id="approval-editor" data-field="approvalText" maxlength="1000" rows="12">${escapeHtml(this.state.approvalText)}</textarea><label class="check-row"><input type="checkbox" data-field="reviewedExactText" ${this.state.reviewedExactText ? 'checked' : ''}><span>I reviewed the complete exact customer message above.</span></label>${unresolvedWarning}<div class="button-row">${button('Approve and queue', 'approve', { primary: true, disabled: !this.state.reviewedExactText || this.state.busy || Boolean(unresolvedWarning) })}${button('Cancel', 'cancel-approval')}</div><p class="subtle">Approval creates a queued reply. It does not confirm provider acceptance or customer delivery.</p>${this.uncertainNote('approval')}${button('Check if a reply was already queued', 'recover-reply')}</section>`
  }

  private renderStatus(): string {
    const reply = this.state.reply
    const latest = this.state.caseData?.latest_reply
    const channel = this.state.caseData?.channel ?? 'telegram'
    if (!reply && latest) return `<section class="panel status-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">REPLY RECOVERY</p><h1>Checking latest reply</h1><p class="lead">The case shows a reply. Fetching its current status.</p>${button('Check status', 'open-latest-reply', { primary: true })}</section>`
    if (!reply) return `<section class="panel status-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">REPLY STATUS</p><h1>No reply status loaded</h1>${button('Recover from case', 'recover-reply', { primary: true })}</section>`
    const presentation = presentReplyState(reply.state, channel)
    const statusClass = reply.state === 'failed' || reply.state === 'unknown' ? 'danger' : reply.state === 'delivered' ? 'success' : ''
    const action = shouldPollReply(reply.state) ? 'Sending is still in progress. Status checks slow down and stop automatically.' : 'No automatic delivery claim is made.'
    return `<section class="panel status-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">${this.state.fixtureMode ? 'SYNTHETIC REPLY' : 'OUTBOUND REPLY'}</p><h1>Reply status</h1><div class="reply-state ${statusClass}"><span class="state-dot"></span><strong>${escapeHtml(presentation.label)}</strong></div><p class="lead">${escapeHtml(presentation.detail)}</p><dl class="status-facts"><div><dt>Updated</dt><dd>${escapeHtml(dateTime(reply.updated_at))}</dd></div><div><dt>Reply ID</dt><dd class="id-value">${escapeHtml(reply.reply_id)}</dd></div>${reply.error_category ? `<div><dt>Issue</dt><dd>${escapeHtml(reply.error_category.replaceAll('_', ' '))}</dd></div>` : ''}</dl><p class="subtle">${escapeHtml(action)}</p><div class="button-row wrap">${button('Check status', 'check-status', { primary: true })}${button('Resolve case', 'resolve', { disabled: this.state.caseData?.status === 'resolved' })}${button('Inbox', 'back-inbox')}</div></section>`
  }

  private renderResolve(): string {
    const item = this.state.caseData
    if (!item) return this.renderLoading('Loading case')
    const unknown = item.latest_reply?.state === 'unknown'
    const warning = unknown ? `<div class="warning-card strong-warning"><strong>The customer may or may not have received this reply.</strong><span>It will not be resent automatically. Acknowledge this uncertainty only if you want to resolve anyway.</span><label class="check-row"><input type="checkbox" data-field="acknowledgedUnknown" ${this.state.acknowledgedUnknown ? 'checked' : ''}><span>I understand and acknowledge the uncertain send.</span></label></div>` : ''
    const queued = item.latest_reply?.state === 'queued' ? '<p class="subtle">Resolving will cancel the queued reply before dispatch. It will not be sent.</p>' : ''
    const sending = item.latest_reply?.state === 'sending' ? '<div class="warning-card"><strong>Reply is sending.</strong><span>Wait for its outcome before resolving.</span></div>' : ''
    const resolved = item.status === 'resolved'
    return `<section class="panel resolve-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">OWNER ACTION</p><h1>${resolved ? 'Case resolved' : 'Resolve this case?'}</h1><p class="lead">Resolving records that you have closed this escalation. Sending a reply and resolving the case are separate actions.</p>${warning}${queued}${sending}${resolved ? '<div class="success-card">This case is marked resolved. Payment status is unchanged.</div>' : `<form data-form="resolve" class="stack"><label for="resolve-reason">Reason</label><select id="resolve-reason" data-field="resolveReason">${REASONS.map((reason) => `<option value="${reason.value}" ${reason.value === this.state.resolveReason ? 'selected' : ''}>${reason.label}</option>`).join('')}</select>${this.state.resolveReason === 'other' ? `<label for="resolve-note">Short note (optional)</label><textarea id="resolve-note" data-field="resolveNote" maxlength="200" rows="3">${escapeHtml(this.state.resolveNote)}</textarea>` : ''}<div class="button-row"><button class="button primary" type="submit" ${this.state.busy || Boolean(sending) || (unknown && !this.state.acknowledgedUnknown) ? 'disabled' : ''}>${this.state.busy ? 'Resolving…' : 'Confirm resolution'}</button>${button('Cancel', 'cancel-resolve')}</div></form>`}</section>`
  }

  private renderLoading(title: string): string {
    return `<section class="panel loading-panel"><div class="spinner" aria-hidden="true"></div><h1>${escapeHtml(title)}</h1><p class="subtle">Waiting for the backend response.</p>${this.state.busy ? '' : button('Back to case', 'back-case')}</section>`
  }

  private connectionLabel(): string {
    if (this.state.fixtureMode) return 'Development fixture mode'
    if (!this.state.sessionPresent) return 'Not paired'
    if (this.state.connection === 'connected') return 'Connected'
    if (this.state.connection === 'offline') return 'Offline'
    if (this.state.connection === 'loading') return 'Connecting'
    if (this.state.connection === 'reconnecting') return 'Reconnecting'
    return this.state.sessionPresent ? 'Ready' : 'Not paired'
  }

  private age(iso: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m`
    if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`
    return `${Math.floor(minutes / 1_440)}d`
  }

  private caseSummary(item: CaseData): string {
    const lastCustomer = [...item.context].reverse().find((message) => message.actor === 'customer')
    return lastCustomer?.text ?? 'A customer request needs your attention.'
  }

  private uncertainNote(scope: string, voiceDerived = false): string {
    if (!(voiceDerived ? this.voiceKeys : this.keys).has(scope)) return ''
    return '<p class="warning-inline">The request outcome is uncertain. Keep the same text and retry with the same action key.</p>'
  }

  private canRetrySameAction(): boolean {
    if (!['request_in_progress', 'request_timeout', 'network_error', 'reply_unavailable'].includes(this.state.errorCode ?? '')) return false
    const draftIsVoiceDerived = Boolean(this.state.draft && this.voiceDerivedDraftIds.has(this.state.draft.draft_id))
    const retryKeys = draftIsVoiceDerived ? this.voiceKeys : this.keys
    if (this.state.screen === 'voice' && this.state.caseData) {
      const caseId = this.state.caseData.case_id
      if (this.voiceKeys.has(`voice-manual:${caseId}`)) return true
      const draftId = this.state.draft?.draft_id
      if (draftId && this.voiceKeys.has(`voice-revise:${caseId}:${draftId}`)) return true
    }
    if (this.state.screen === 'approval' && retryKeys.has(`approve:${this.state.caseData?.case_id}`)) return true
    if (this.state.screen === 'draft' && this.state.manualMode && retryKeys.has(`${draftIsVoiceDerived ? 'voice-manual' : 'manual-draft'}:${this.state.caseData?.case_id}`)) return true
    if (this.state.screen === 'draft' && this.state.draft && retryKeys.has(`${draftIsVoiceDerived ? 'voice-revise' : 'revise'}:${this.state.caseData?.case_id}:${this.state.draft.draft_id}`)) return true
    if (this.state.screen === 'case' && this.state.caseData && this.keys.has(`ai-draft:${this.state.caseData.case_id}`)) return true
    return false
  }

  private updateGlasses(): void {
    const text = this.buildGlassesText()
    this.lastRenderedGlasses = text
    this.glassesWriter?.(text)
  }

  private buildGlassesText(): string {
    const state = this.state
    const badge = state.fixtureMode ? 'GLANCE · SYNTHETIC' : 'REMBOAI GLANCE'
    const lines: string[] = []
    const item = state.caseData
    // SDK 0.0.16 exposes a fixed firmware text style and left alignment only.
    // The full 576 px canvas fits about 56 average-width glyphs at the native
    // font; keep a little safety margin for wide letters and the 12 px inset.
    const width = 56
    const add = (text: string, maxLines = 1) => lines.push(...this.wrapText(text, width, maxLines))
    const actionLabel = (labels: string[]) => add(`› ${labels[state.focusedAction % labels.length]} · DOUBLE-CLICK`)
    // Firmware renders text at a fixed size. A short ASCII rule creates a
    // stable section break without the unexpectedly wide box-drawing glyphs.
    const divider = () => add('--------------------------------')
    const finish = () => lines.slice(0, 9).join('\n')

    if (state.screen === 'pair') {
      add(`${badge} · PAIRING`)
      add('OWNER SETUP · PAIRED PHONE')
      divider()
      add('Pairing code arrives in Telegram.')
      add('Enter it in the paired phone WebView.')
      add('One-time code · expires in 5 minutes.')
      add('The code is never shown on G2.')
      return finish()
    }
    if (state.screen === 'inbox') {
      const items = state.inbox?.items ?? []
      const selected = items[state.selectedIndex]
      if (!selected) {
        add(`${badge} · INBOX`)
        add(`${state.inbox?.open_count ?? 0} OPEN CASES`)
        divider()
        add(state.connection === 'loading' ? 'Checking for owner escalations…' : state.connection === 'offline' ? 'Inbox is unavailable offline.' : 'You are all caught up.')
        add(state.connection === 'offline' ? 'Reconnect from the paired phone.' : 'Refresh from the paired phone.')
        return finish()
      }
      const position = `CASE ${state.selectedIndex + 1}/${items.length}${state.inbox?.has_more ? '+' : ''}`
      const channel = selected.channel === 'telegram' ? 'TELEGRAM' : 'WHATSAPP'
      add(`${badge} · INBOX${state.inboxStale ? ' · STALE' : ''}`)
      add(`${state.inbox?.open_count ?? items.length} OPEN · ${position}`)
      divider()
      add(`SELECTED · ${selected.customer_label} / ${channel}`)
      add(`${categoryLabel(selected.category).toUpperCase()} · ${this.age(selected.created_at)} WAITING`)
      add(`LATEST · ${selected.preview}`)
      if (items.length > 1) {
        const next = items[(state.selectedIndex + 1) % items.length]
        add(`NEXT · ${next.customer_label} / ${categoryLabel(next.category).toUpperCase()}`)
        add(`LATEST · ${next.preview}`)
      }
      add('SCROLL CASES · DOUBLE-CLICK OPEN')
      return finish()
    }
    if (!item) return `${badge}\nLOADING CASE…`

    if (state.screen === 'case') {
      const channel = item.channel === 'telegram' ? 'TG' : 'WA'
      add(`${badge} · CASE DETAIL`)
      add(`${item.customer_label} · ${categoryLabel(item.category).toUpperCase()}`)
      add(`${item.status.toUpperCase()} · ${channel} · VERSION ${item.version}`)
      divider()
      if (item.status === 'resolved') {
        add(`LATEST REPLY · ${item.latest_reply ? presentReplyState(item.latest_reply.state, item.channel).label.toUpperCase() : 'NONE'}`)
        actionLabel(item.latest_reply ? ['CHECK REPLY STATUS', 'BACK TO INBOX'] : ['BACK TO INBOX', 'BACK TO INBOX'])
        add('CLICK · CHANGE ACTION  DOUBLE-CLICK · OPEN')
        return finish()
      }
      const chunk = messagePage(item.context, state.messagePage, 3)
      const pages = Math.max(1, Math.ceil(item.context.length / 3))
      add(`CONVERSATION · ${state.messagePage + 1}/${pages}${item.has_earlier ? ' · EARLIER OMITTED' : ''}`)
      if (chunk.length) {
        for (const message of chunk) {
          const actor = message.actor === 'customer' ? 'CUST' : message.actor === 'assistant' ? 'AI' : 'OWNER'
          add(`${actor} · ${message.text}`)
        }
      } else add(`LATEST · ${this.caseSummary(item)}`)
      actionLabel(['GENERATE AI DRAFT', 'WRITE REPLY', 'VOICE CAPTURE', 'CHECK REPLY', 'RESOLVE CASE', 'BACK TO INBOX'])
      return finish()
    }
    if (state.screen === 'voice') {
      add(`${badge} · VOICE CAPTURE`)
      divider()
      if (state.voicePhase === 'recording') {
        add(state.voiceSimulation ? 'SIMULATION · MICROPHONE OFF' : '● G2 MICROPHONE ACTIVE')
        add(`DURATION · ${this.formatDuration(state.voiceDurationMs)} / 0:40`)
        add(state.voiceSimulation ? 'NO AUDIO CAPTURED · NO ASR' : 'PCM · MEMORY ONLY')
        const actions = [state.voiceSimulation ? 'FINISH PREVIEW' : 'STOP & TRANSCRIBE', 'CANCEL']
        actionLabel(actions)
        add(`NEXT · ${actions[(state.focusedAction + 1) % actions.length]}`)
        add('CLICK · NEXT ACTION  DOUBLE-CLICK · SELECT')
      } else if (state.voicePhase === 'transcript_ready') {
        add(state.voiceSimulation ? 'SIMULATED · NOT SENT · NO ASR' : 'TRANSCRIPT · NOT SENT')
        add(`CAPTURED ${this.formatDuration(state.voiceDurationMs)} · ASR ${state.voiceTranscriptionDurationMs ?? 0}MS`)
        add('TRANSCRIPT PREVIEW')
        add(state.voiceTranscript, 2)
        add('PHONE · CHOOSE REPLY OR INSTRUCTION')
        actionLabel(['OPEN PHONE REVIEW', 'BACK TO CASE'])
      } else if (state.voicePhase === 'error') {
        add('CAPTURE STOPPED · NO AUDIO RETAINED')
        add(state.voiceError || 'TRY AGAIN ON PHONE', 2)
        actionLabel(['RECORD AGAIN', 'BACK TO CASE'])
      } else {
        const phaseLabel = state.voicePhase === 'starting' ? 'MICROPHONE STARTING' : state.voicePhase === 'stopping' ? 'STOPPING MICROPHONE' : state.voicePhase === 'transcribing' ? 'TRANSCRIBING' : 'READY · OWNER STARTED'
        add(phaseLabel)
        add(state.voicePhase === 'transcribing' ? `RECORDING · ${this.formatDuration(state.voiceDurationMs)} · MEMORY ONLY` : 'G2 MICROPHONE · EXPLICIT START')
        add(state.voicePhase === 'transcribing' ? 'WAITING FOR TRANSCRIPT' : 'FULL TRANSCRIPT ON PHONE')
        if (state.voicePhase === 'idle') actionLabel(['START RECORDING', 'BACK TO CASE'])
      }
      return finish()
    }
    if (state.screen === 'draft') {
      add(`${state.fixtureMode ? 'SYNTHETIC PREVIEW · NOT AI' : state.draft?.source === 'owner' ? 'OWNER DRAFT · NOT SENT' : 'AI SUGGESTION · NOT SENT'}`)
      add('DRAFT · OWNER REVIEW REQUIRED')
      divider()
      add(`CASE v${item.version} · DRAFT BASE v${state.draft?.based_on_version ?? item.version}`)
      add('CUSTOMER REPLY · PREVIEW')
      add(state.editorText || state.draft?.text || 'Write a reply on your phone.', 2)
      add('PHONE · EDIT COMPLETE CUSTOMER TEXT')
      actionLabel(['REVIEW EXACT TEXT', 'BACK TO CASE'])
      return finish()
    }
    if (state.screen === 'approval') {
      add('FINAL REVIEW · EXACT CUSTOMER TEXT')
      add('OWNER INSPECTED FULL TEXT ON PHONE')
      divider()
      add('MESSAGE PREVIEW · NOT YET QUEUED')
      add(state.approvalText, 3)
      add('QUEUE ≠ DELIVERY CONFIRMATION')
      actionLabel(['APPROVE & QUEUE', 'CANCEL'])
      return finish()
    }
    if (state.screen === 'status') {
      const reply = state.reply
      add(`${badge} · REPLY STATUS`)
      add(item.latest_reply ? `CASE · ${item.customer_label} · ${item.status.toUpperCase()}` : `CASE · ${item.customer_label}`)
      divider()
      if (reply) {
        const presentation = presentReplyState(reply.state, item.channel)
        add(presentation.label.toUpperCase())
        add(`CHANNEL · ${item.channel.toUpperCase()}`)
        add(presentation.detail, 2)
      } else add('CHECKING LATEST REPLY…')
      actionLabel(['CHECK STATUS', 'RESOLVE CASE', 'BACK TO INBOX'])
      return finish()
    }
    if (state.screen === 'resolve') {
      add(`${badge} · RESOLVE CASE`)
      add(`${item.customer_label} · ${item.status.toUpperCase()} · v${item.version}`)
      divider()
      add(`REASON · ${state.resolveReason.replaceAll('_', ' ').toUpperCase()}`)
      if (item.latest_reply?.state === 'unknown') add('UNCERTAIN · CUSTOMER MAY HAVE RECEIVED', 2)
      else if (item.latest_reply?.state === 'queued') add('QUEUED REPLY · WILL CANCEL BEFORE RESOLVE')
      else if (item.latest_reply?.state === 'sending') add('REPLY SENDING · WAIT BEFORE RESOLVE')
      const actions = item.latest_reply?.state === 'unknown' && !state.acknowledgedUnknown
        ? ['ACKNOWLEDGE & RESOLVE', 'CANCEL']
        : ['RESOLVE CASE', 'CANCEL']
      actionLabel(actions)
      add(`NEXT · ${actions[(state.focusedAction + 1) % actions.length]}`)
      add('CLICK · NEXT ACTION  DOUBLE-CLICK · SELECT')
      return finish()
    }
    add(badge)
    return finish()
  }

  private wrapText(value: string, width: number, maxLines: number): string[] {
    const words = value.replace(/\s+/g, ' ').trim().split(' ').flatMap((word) => {
      const chars = [...word]
      if (chars.length <= width) return [word]
      const pieces: string[] = []
      for (let offset = 0; offset < chars.length; offset += width) pieces.push(chars.slice(offset, offset + width).join(''))
      return pieces
    })
    const output: string[] = []
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if ([...next].length > width && line) {
        output.push(line)
        line = word
      } else line = next
    }
    if (line) output.push(line)
    if (output.length > maxLines) {
      output.length = maxLines
      output[maxLines - 1] = `${[...output[maxLines - 1]].slice(0, width - 1).join('')}…`
    }
    return output
  }
}
