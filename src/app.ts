import { EventSourceType } from '@evenrealities/even_hub_sdk'
import { GlanceApiClient, ApiError, userMessageForError, type GlanceApi } from './client.ts'
import { DEMO_FIXTURES_ENABLED } from './config.ts'
import { DemoFixtures } from './demo-fixtures.ts'
import { PhysicalPressDeduplicator, RING_EVENT_SOURCE, type GlanceInput } from './evenhub-events.ts'
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
import { BODY_LINES, buildGlassesPage, canCreateDisplaySafeCopy, glassesPageText, G2_MENU, glassesReviewCopy, hasUncertainApproval, needsGlassesReviewCopy, paginateGlassesApprovalText, paginateGlassesDisplayText, type GlassesPage } from './glasses-ui.ts'
import { runtimeMetrics } from './runtime-metrics.ts'
import { WorkspaceStore, type WorkspaceView } from './workspace.ts'
import {
  IdempotencyKeyBook,
  caseAttentionCounts,
  caseAttentionLabel,
  caseAttentionTier,
  categoryLabel,
  channelLabel,
  CONTEXT_PAGE_SIZE,
  messagePage,
  moreCaseCount,
  normalizeOwnerText,
  prioritizedCaseIndex,
  presentReplyState,
  replyPollDelay,
  shouldPollReply,
  sortInboxOldestFirst,
} from './workflow.ts'

interface AppState extends AppStateView {
  code: string
  manualMode: boolean
  inboxStale: boolean
  newCaseAvailable: boolean
  busyAction: string
  replyId: string | null
  autoPolls: number
  acknowledgedUnknown: boolean
  reviewedExactText: boolean
  approvalPage: number
  approvalProgress: number
  approvalStage: 'review' | 'confirm'
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
  schedule: null,
  scheduleOffset: 0,
  inboxStale: false,
  newCaseAvailable: false,
  selectedIndex: 0,
  caseData: null,
  stale: false,
  messagePage: 0,
  messageTextPage: 0,
  draft: null,
  editorText: '',
  revisionInstruction: '',
  approvalText: '',
  reviewedExactText: false,
  approvalPage: 0,
  approvalProgress: 0,
  approvalStage: 'review',
  draftPage: 0,
  transcriptPage: 0,
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

const SINGLE_CLICK_SETTLE_MS = 280

export class GlanceAppController {
  readonly state: AppState = structuredClone(EMPTY_STATE)
  readonly sessions: SessionStore
  readonly liveApi: GlanceApiClient
  readonly fixtures = new DemoFixtures()
  private api: GlanceApi
  private readonly keys = new IdempotencyKeyBook()
  // Explicitly selected voice actions use the same durable, payload-bound keys
  // as other writes so an Android WebView restart cannot mint a second action.
  private readonly voiceKeys = this.keys
  private readonly workspace = new WorkspaceStore()
  private readonly voiceCapture = new G2PcmCapture()
  private readonly root: HTMLElement
  private glassesWriter: ((page: GlassesPage) => void) | null = null
  private readonly physicalPresses = new PhysicalPressDeduplicator()
  private audioControl: AudioInputControl | null = null
  private pageShutdownControl: ((exitMode: number) => Promise<boolean>) | null = null
  private replyTimer: number | null = null
  private pollTimer: number | null = null
  private foreground = true
  private pollController: AbortController | null = null
  private statusController: AbortController | null = null
  private replyController: AbortController | null = null
  private replyControllerId: string | null = null
  private pendingReplyFetch: { replyId: string; schedule: boolean; polling: boolean } | null = null
  private pendingSingleClickTimer: ReturnType<typeof setTimeout> | null = null
  private pollInProgress = false
  private foregroundRefreshInProgress = false
  private statusRefreshInProgress = false
  private approvalSnapshot = ''
  private approvalDraftSnapshot = ''
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

    if (this.state.fixtureMode) {
      this.render()
      return
    }
    // The inbox is the MVP's foreground discovery mechanism. Keep the
    // interval aligned with the backend workflow contract while still
    // pausing all work when the app is backgrounded.
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
    await this.restoreWorkspace()
  }

  setGlassesWriter(writer: (page: GlassesPage) => void): void {
    this.glassesWriter = writer
    this.updateGlasses()
  }

  setPageShutdownControl(shutdown: ((exitMode: number) => Promise<boolean>) | null): void {
    this.pageShutdownControl = shutdown
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

  enableSyntheticPreview(): void {
    this.fixtures.startDemo()
    this.api = this.fixtures
    this.state.fixtureMode = true
    this.state.sessionPresent = false
  }

  async dispose(): Promise<void> {
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pollController?.abort()
    this.statusController?.abort()
    this.replyController?.abort()
    this.pendingReplyFetch = null
    this.cancelPendingSingleClick()
    this.transcriptionController?.abort()
    await this.clearVoiceWorkflow('')
    this.voiceDerivedDraftIds.clear()
    this.physicalPresses.clear()
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

  getRuntimeMetrics() { return runtimeMetrics.snapshot() }

  private enterVoiceReady(): void {
    const item = this.state.caseData
    if (!item || item.status !== 'open' || this.state.busy) return
    this.state.focusedAction = 0
    this.state.voicePhase = 'idle'
    this.state.voiceDurationMs = 0
    this.state.voiceTranscriptionDurationMs = null
    this.state.voiceTranscript = ''
    this.state.voiceSimulation = this.state.fixtureMode
    this.state.voiceError = ''
    this.state.screen = 'voice'
    this.state.message = 'Microphone is off. Choose Start when you are ready.'
    this.render()
  }

  private async beginVoiceCapture(): Promise<void> {
    const item = this.state.caseData
    if (this.state.busy || this.state.voicePhase === 'starting' || this.state.voicePhase === 'recording' ||
        this.state.voicePhase === 'stopping' || this.state.voicePhase === 'transcribing') return
    if (!item || item.status !== 'open' || this.state.screen !== 'voice' ||
        !['idle', 'error'].includes(this.state.voicePhase)) return
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
    const scope = `voice-manual:${current.case_id}`
    const pending = this.voiceKeys.get(scope)
    const pendingPayload = pending?.payload as { expected_version?: unknown; text?: unknown } | undefined
    if (pending && (pendingPayload?.text !== transcript || typeof pendingPayload.expected_version !== 'number')) {
      this.failLocal('A different dictated reply has an uncertain outcome. Retry that exact action first.', 'uncertain_action')
      return
    }
    const fresh = pending ? current : await this.refreshCase()
    if (!fresh || (!pending && (fresh.status !== 'open' || fresh.version !== current.version))) {
      this.state.stale = true
      this.state.message = 'The case changed. Refresh its context before using this transcript.'
      this.render()
      return
    }
    const expectedVersion = pending ? pendingPayload!.expected_version as number : fresh.version
    let key: string
    try { key = this.voiceKeys.acquire(scope, { expected_version: expectedVersion, text: transcript }) } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the same voice action.', 'uncertain_action')
      return
    }
    await this.withBusy('voice-manual-draft', async () => {
      const draft = await useTranscriptAsReply(this.api, fresh.case_id, expectedVersion, transcript, key)
      this.voiceKeys.complete(scope)
      this.voiceDerivedDraftIds.add(draft.draft_id)
      await this.clearVoiceWorkflow('')
      this.acceptDraft(draft, true)
      this.state.message = 'Owner-authored draft saved. Review every exact-text page on G2 before approval.'
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook: this.voiceKeys })
  }

  /** Synthetic-only voice walkthrough. It never opens the microphone or calls the backend. */
  private showDemoTranscript(): void {
    if (!this.state.fixtureMode || !this.state.caseData || this.state.caseData.status !== 'open') return
    this.clearDemoCaptureTimer()
    this.state.voicePhase = 'transcript_ready'
    this.state.focusedAction = 0
    this.state.transcriptPage = 0
    this.state.voiceDurationMs = 6_400
    this.state.voiceTranscriptionDurationMs = 240
    this.state.voiceTranscript = 'Shorten it and mention walk-ins are accepted until five.'
    this.state.voiceSimulation = true
    this.state.voiceError = ''
    this.state.message = 'Simulated transcript · no microphone, ASR, backend, or customer message was used.'
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
    this.state.message = 'Simulated capture · microphone and ASR are off.'
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
    this.state.focusedAction = 0
    this.state.transcriptPage = 0
    this.state.voiceTranscriptionDurationMs = null
    this.state.voiceTranscript = 'Shorten it and mention walk-ins are accepted until five.'
    this.state.voiceSimulation = true
    this.state.voiceError = ''
    this.state.message = 'Simulated transcript · no microphone, ASR, backend, or customer message was used.'
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
    if (!current || this.state.busy || !transcript) return
    if (!draft) {
      this.state.message = 'Create an AI suggestion for this case before using an instruction.'
      this.render()
      return
    }
    const scope = `voice-revise:${current.case_id}:${draft.draft_id}`
    const pending = this.voiceKeys.get(scope)
    const pendingPayload = pending?.payload as { expected_version?: unknown; instruction?: unknown } | undefined
    const replay = Boolean(pending && pendingPayload?.instruction === transcript &&
      typeof pendingPayload.expected_version === 'number')
    if (!replay && !canUseTranscriptAsInstruction(current, draft, this.state.stale, this.state.editorText, transcript)) {
      this.failLocal('Use as instruction requires an unexpired, current AI draft with no unsaved edits and a transcript of 300 characters or fewer.', 'draft_unavailable')
      return
    }
    const fresh = replay ? current : await this.refreshCase()
    if (!fresh || (!replay && !canUseTranscriptAsInstruction(fresh, draft, this.state.stale, this.state.editorText, transcript))) {
      this.state.stale = true
      this.state.message = 'Refresh the case or create a current AI suggestion before using a voice instruction.'
      this.render()
      return
    }
    const expectedVersion = replay ? pendingPayload!.expected_version as number : fresh.version
    let key: string
    try { key = this.voiceKeys.acquire(scope, { expected_version: expectedVersion, instruction: transcript }) } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the same voice action.', 'uncertain_action')
      return
    }
    await this.withBusy('voice-revise', async () => {
      const next = await useTranscriptAsInstruction(this.api, fresh.case_id, draft.draft_id, expectedVersion, transcript, key)
      this.voiceKeys.complete(scope)
      this.voiceDerivedDraftIds.add(next.draft_id)
      await this.clearVoiceWorkflow('')
      this.acceptDraft(next, false)
      this.state.message = 'Revised AI draft saved. Review every exact-text page on G2 before approval.'
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
      // The SDK uses this event to close its contextual menu as well as to
      // report app exits. Browser visibility is the reliable background signal.
      if (document.visibilityState === 'hidden') {
        this.foreground = false
        this.cancelPendingSingleClick()
        this.clearReplyTimer()
        await this.stopForBackground()
      }
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
      this.cancelPendingSingleClick()
      await this.clearVoiceWorkflow('')
      return
    }
    if (input.kind === 'menu') {
      this.cancelPendingSingleClick()
      if (input.itemId !== null) await this.activateGlassMenuItem(input.itemId)
      return
    }
    if (input.kind === 'long_press' || input.kind === 'long_press_release') {
      // The OS owns long-press contextual-menu navigation. Never bind a
      // safety-critical action to an unverified sustained-press gesture.
      this.cancelPendingSingleClick()
      return
    }
    if (input.source !== null && input.source !== RING_EVENT_SOURCE &&
        input.source !== EventSourceType.TOUCH_EVENT_FROM_GLASSES_R &&
        input.source !== EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) return
    if (!this.physicalPresses.accept(input)) return
    if (input.kind === 'scroll_up' || input.kind === 'scroll_down') this.cancelPendingSingleClick()

    if (this.state.screen === 'inbox' && 'selectedIndex' in input && input.selectedIndex !== undefined) {
      const count = this.state.inbox?.items.length ?? 0
      if (count > 0 && Number.isInteger(input.selectedIndex) && input.selectedIndex >= 0 && input.selectedIndex < count) {
        this.state.selectedIndex = input.selectedIndex
      }
    } else if (this.state.screen === 'inbox' && 'selectedItemName' in input && input.selectedItemName) {
      const items = this.state.inbox?.items ?? []
      const index = items.findIndex((item) => input.selectedItemName?.startsWith(item.customer_label))
      if (index >= 0) this.state.selectedIndex = index
    }

    if (input.kind === 'scroll_up' || input.kind === 'scroll_down') {
      const delta = input.kind === 'scroll_down' ? 1 : -1
      if (this.state.screen === 'inbox') {
        const count = this.state.inbox?.items.length ?? 0
        if (count && (!('selectedIndex' in input) || input.selectedIndex === undefined)) {
          this.state.selectedIndex = (this.state.selectedIndex + delta + count) % count
        }
      } else if (this.state.screen === 'case' && this.state.caseData) {
        const context = this.state.caseData.context
        const pageCount = Math.ceil(context.length / CONTEXT_PAGE_SIZE)
        const lastPage = Math.max(0, pageCount - 1)
        const currentPage = Math.min(lastPage, Math.max(0, Math.floor(this.state.messagePage) || 0))
        const chronologicalPage = pageCount > 0 ? pageCount - 1 - currentPage : 0
        const currentMessage = messagePage(context, chronologicalPage, CONTEXT_PAGE_SIZE)[0]
        const messageText = currentMessage
          ? currentMessage.actor === 'customer' ? currentMessage.text
            : `(${currentMessage.actor === 'assistant' ? 'RemboAI' : 'Owner'}) ${currentMessage.text}`
          : ''
        const textPages = paginateGlassesDisplayText(messageText)
        const lastTextPage = Math.max(0, textPages.length - 1)
        const currentTextPage = Math.min(lastTextPage, Math.max(0, Math.floor(this.state.messageTextPage ?? 0)))
        if (input.kind === 'scroll_up') {
          if (currentTextPage < lastTextPage) this.state.messageTextPage = currentTextPage + 1
          else if (currentPage < lastPage) {
            this.state.messagePage = currentPage + 1
            this.state.messageTextPage = 0
          }
        } else if (currentTextPage > 0) {
          this.state.messageTextPage = currentTextPage - 1
        } else if (currentPage > 0) {
          this.state.messagePage = currentPage - 1
          this.state.messageTextPage = 0
        }
      } else if (this.state.screen === 'draft') {
        const pages = paginateGlassesDisplayText(this.state.editorText || this.state.draft?.text || '', BODY_LINES)
        const delta = input.kind === 'scroll_down' ? 1 : -1
        this.state.draftPage = Math.min(pages.length - 1, Math.max(0, this.state.draftPage + delta))
      } else if (this.state.screen === 'voice' && this.state.voicePhase === 'transcript_ready') {
        const pages = paginateGlassesDisplayText(this.state.voiceTranscript, BODY_LINES)
        const delta = input.kind === 'scroll_down' ? 1 : -1
        this.state.transcriptPage = Math.min(pages.length - 1, Math.max(0, this.state.transcriptPage + delta))
      } else if (this.state.screen === 'approval') {
        if (this.state.approvalStage === 'review') {
          if (input.kind === 'scroll_up') {
            this.state.approvalPage = Math.max(0, this.state.approvalPage - 1)
          } else {
            this.advanceApprovalReview()
          }
        } else if (input.kind === 'scroll_up') {
          const pages = paginateGlassesApprovalText(this.state.approvalText)
          this.state.approvalStage = 'review'
          this.state.approvalPage = pages.length - 1
        }
      } else if (this.state.screen === 'resolve') {
        const current = Math.max(0, REASONS.findIndex((reason) => reason.value === this.state.resolveReason))
        const delta = input.kind === 'scroll_down' ? 1 : -1
        this.state.resolveReason = REASONS[(current + delta + REASONS.length) % REASONS.length].value
      } else {
        this.state.focusedAction = this.nextActionIndex(delta)
      }
      this.render()
      return
    }
    if (input.kind === 'click') {
      // Some hosts (including Simulator 0.9.5) report the first tap of a
      // double-click as a separate click. Defer single-click navigation so
      // the following double-click can cancel it and activate exactly once.
      this.scheduleSingleClick(this.state.screen)
      return
    }
    if (input.kind === 'double_click') {
      this.cancelPendingSingleClick()
      await this.activateGlassAction()
    }
  }

  private scheduleSingleClick(screen: GlanceScreen): void {
    this.cancelPendingSingleClick()
    this.pendingSingleClickTimer = setTimeout(() => {
      this.pendingSingleClickTimer = null
      if (this.state.screen !== screen) return
      if (screen === 'inbox') {
        void this.openSelectedInboxCase()
        return
      }
      if (screen === 'approval' && this.state.approvalStage === 'review') {
        this.state.message = 'Read each reply page in order. Scroll down to continue.'
        this.render()
        return
      }
      this.state.focusedAction = this.nextActionIndex(1)
      this.render()
    }, SINGLE_CLICK_SETTLE_MS)
  }

  private cancelPendingSingleClick(): void {
    if (this.pendingSingleClickTimer !== null) clearTimeout(this.pendingSingleClickTimer)
    this.pendingSingleClickTimer = null
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
    if (action === 'start-demo-recording') {
      if (this.state.screen === 'case') return this.enterVoiceReady()
      return this.beginDemoRecording()
    }
    if (action === 'pair') return this.pair()
    if (action === 'refresh-inbox') return this.loadInbox()
    if (action === 'show-schedule' || action === 'refresh-schedule') return this.loadSchedule(0)
    if (action === 'schedule-next') {
      const next = this.state.schedule?.next_offset
      if (next !== null && next !== undefined) return this.loadSchedule(next)
      return
    }
    if (action === 'schedule-previous') return this.loadSchedule(Math.max(0, this.state.scheduleOffset - 20))
    if (action === 'open-case') return this.openCase(target.dataset.caseId ?? '')
    if (action === 'open-selected') {
      const item = this.state.inbox?.items[this.state.selectedIndex]
      if (item) return this.openCase(item.case_id)
    }
    if (action === 'refresh-case') { await this.refreshCase(true); return }
    if (action === 'open-voice-ready') return this.enterVoiceReady()
    if (action === 'start-voice') {
      if (this.state.screen === 'case') return this.enterVoiceReady()
      return this.beginVoiceCapture()
    }
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
    if (action === 'g2-safe-copy') return this.createDisplaySafeCopy()
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
      this.enterResolveScreen()
      return
    }
    if (action === 'cancel-resolve') {
      this.cancelResolve()
      return
    }
    if (action === 'back-case') {
      this.state.screen = 'case'
      this.render()
      return
    }
    if (action === 'back-inbox') {
      this.returnToInbox()
      return
    }
    if (action === 'back-draft') {
      this.state.screen = 'draft'
      this.render()
      return
    }
    if (action === 'page-back') {
      const pages = Math.max(1, Math.ceil((this.state.caseData?.context.length ?? 0) / CONTEXT_PAGE_SIZE))
      this.state.messagePage = Math.min(pages - 1, Math.max(0, this.state.messagePage + 1))
      this.render()
      return
    }
    if (action === 'page-next') {
      this.state.messagePage = Math.max(0, this.state.messagePage - 1)
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
      this.resetApprovalReview()
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
      await this.restoreWorkspace()
    })
  }

  private async startDemo(): Promise<void> {
    if (!DEMO_FIXTURES_ENABLED) return
    await this.clearVoiceWorkflow('')
    this.sessions.clear()
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
    this.state.schedule = null
    this.state.scheduleOffset = 0
    this.state.caseData = null
    this.state.draft = null
    this.state.reply = null
    this.state.replyId = null
    await this.loadInbox()
  }

  private async stopDemo(): Promise<void> {
    await this.clearVoiceWorkflow('')
    this.api = this.liveApi
    this.state.fixtureMode = false
    this.state.sessionPresent = false
    this.state.salonName = ''
    this.state.inbox = null
    this.state.schedule = null
    this.state.scheduleOffset = 0
    this.state.caseData = null
    this.state.draft = null
    this.state.reply = null
    this.state.replyId = null
    this.state.screen = 'pair'
    this.state.connection = 'loading'
    this.state.message = 'Development fixtures closed. Pair through Telegram to use the live backend.'
    this.render()
  }

  private async loadInbox(polling = false): Promise<void> {
    this.pollController?.abort()
    const controller = new AbortController()
    this.pollController = controller
    if (!this.state.inbox) this.state.connection = 'loading'
    this.render()
    try {
      const inbox = await this.api.getInbox(controller.signal, polling)
      if (controller.signal.aborted) return
      const hadInbox = Boolean(this.state.inbox)
      const previousCaseIds = new Set(this.state.inbox?.items.map((item) => item.case_id) ?? [])
      const previousSelectedId = this.state.inbox?.items[this.state.selectedIndex]?.case_id
      const eligibleItems = sortInboxOldestFirst(inbox.items.filter((item) => item.status === 'open'))
      const hasNewVisibleCase = eligibleItems.some((item) => !previousCaseIds.has(item.case_id))
      inbox.items = eligibleItems.slice(0, 20)
      this.state.inbox = inbox
      this.state.inboxStale = false
      this.state.newCaseAvailable = this.state.newCaseAvailable || (hadInbox && hasNewVisibleCase)
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      const stillSelectedIndex = previousSelectedId
        ? inbox.items.findIndex((item) => item.case_id === previousSelectedId)
        : -1
      this.state.selectedIndex = stillSelectedIndex >= 0
        ? stillSelectedIndex
        : hadInbox
          ? Math.min(this.state.selectedIndex, Math.max(0, inbox.items.length - 1))
          : prioritizedCaseIndex(inbox.items)
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

  private async loadSchedule(offset = 0): Promise<void> {
    if (this.state.busy) return
    const requestedOffset = Math.max(0, Math.min(1000, Math.floor(offset)))
    await this.withBusy('schedule', async () => {
      const schedule = await this.api.getSchedule(20, requestedOffset)
      this.state.schedule = schedule
      this.state.scheduleOffset = requestedOffset
      this.state.screen = 'schedule'
      this.state.focusedAction = 0
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      this.clearError()
      this.state.message = this.state.fixtureMode
        ? 'Synthetic schedule · local demo only · no customer message is sent.'
        : ''
    })
  }

  private async restoreWorkspace(): Promise<void> {
    if (this.state.fixtureMode || !this.state.sessionPresent) return
    const saved = this.workspace.load()
    if (!saved) return
    try {
      const fresh = await this.api.getCase(saved.case_id)
      this.state.caseData = fresh
      this.state.messagePage = 0
      this.state.messageTextPage = 0
      this.state.draftPage = 0
      this.state.stale = Boolean(saved.draft && saved.draft.based_on_version !== fresh.version)
      // Expired drafts remain available for display and for replaying an
      // already-completed idempotent write; new approvals still fail closed.
      const validDraft = saved.draft
      this.state.draft = validDraft
      this.state.editorText = validDraft?.text ?? ''
      this.state.replyId = fresh.latest_reply?.reply_id ?? null
      this.state.reply = null
      this.state.focusedAction = 0

      const pendingApproval = this.keys.get(`approve:${fresh.case_id}`)
      const approvalPayload = pendingApproval?.payload as { draft_id?: unknown; text?: unknown } | undefined
      const pendingManual = this.keys.get(`manual-draft:${fresh.case_id}`)
      const pendingManualPayload = pendingManual?.payload as { text?: unknown } | undefined
      const pendingRevision = validDraft ? this.keys.get(`revise:${fresh.case_id}:${validDraft.draft_id}`) : null
      const pendingRevisionPayload = pendingRevision?.payload as { instruction?: unknown } | undefined
      const voiceManual = this.voiceKeys.get(`voice-manual:${fresh.case_id}`)
      const manualPayload = voiceManual?.payload as { text?: unknown } | undefined
      const voiceRevision = this.voiceKeys.entries().find((entry) => entry.scope.startsWith(`voice-revise:${fresh.case_id}:`))
      const revisionPayload = voiceRevision?.payload as { instruction?: unknown } | undefined

      if (typeof manualPayload?.text === 'string') {
        this.state.voicePhase = 'transcript_ready'
        this.state.voiceTranscript = manualPayload.text
        this.state.transcriptPage = 0
        this.state.voiceSimulation = false
        this.state.screen = 'voice'
        this.state.message = 'A dictated reply request may have completed. Select Use as reply to retry the same request safely.'
      } else if (typeof revisionPayload?.instruction === 'string') {
        this.state.voicePhase = 'transcript_ready'
        this.state.voiceTranscript = revisionPayload.instruction
        this.state.transcriptPage = 0
        this.state.voiceSimulation = false
        this.state.screen = 'voice'
        this.state.message = 'A revision request may have completed. Select Use as instruction to retry the same request safely.'
      } else if (pendingApproval && typeof approvalPayload?.text === 'string' && validDraft &&
                 approvalPayload.draft_id === validDraft.draft_id) {
        this.state.approvalText = approvalPayload.text
        this.state.screen = 'approval'
        this.resetApprovalReview()
        this.state.message = 'Approval outcome uncertain. Review every page; retry will reuse the original action key.'
      } else if (pendingManual && typeof pendingManualPayload?.text === 'string') {
        this.state.manualMode = true
        this.state.editorText = pendingManualPayload.text
        this.state.screen = 'draft'
        this.state.message = 'A manual draft request may have completed. Save again to replay the same request safely.'
      } else if (pendingRevision && typeof pendingRevisionPayload?.instruction === 'string') {
        this.state.revisionInstruction = pendingRevisionPayload.instruction
        this.state.screen = 'draft'
        this.state.message = 'A revision may have completed. Retrying uses the same action key and instruction.'
      } else if (saved.view === 'status' && fresh.latest_reply) {
        this.state.screen = 'status'
      } else {
        this.state.screen = validDraft ? 'draft' : 'case'
        if (saved.draft && Date.parse(saved.draft.expires_at) <= Date.now()) this.state.message = 'The saved draft expired. Create a new draft before replying.'
        else if (this.state.stale) this.state.message = 'The case changed while Glance was inactive. Refresh context before using the saved draft.'
      }
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      this.render()
    if (this.state.screen === 'status' && fresh.latest_reply) await this.fetchReply(fresh.latest_reply.reply_id, true, true)
    } catch (error) {
      if (this.handleLostSession(error)) return
      this.workspace.clear()
      this.captureError(error)
      this.state.screen = 'inbox'
      this.state.caseData = null
      this.state.draft = null
      this.render()
    }
  }

  private persistWorkspace(): void {
    if (this.state.fixtureMode || !this.state.sessionPresent || !this.state.caseData) return
    if (this.state.caseData.status === 'resolved') {
      this.workspace.clear()
      return
    }
    const saved = this.workspace.load()
    let view: WorkspaceView
    if (this.state.screen === 'status') view = 'status'
    else if (this.state.screen === 'draft' || this.state.screen === 'approval') view = 'draft'
    else if (this.state.screen === 'voice' || this.state.screen === 'resolve') {
      view = saved?.case_id === this.state.caseData.case_id
        ? saved.view
        : this.state.draft ? 'draft' : 'case'
    } else view = 'case'
    this.workspace.save(this.state.caseData.case_id, this.state.draft, view)
  }

  private async openCase(caseId: string): Promise<void> {
    if (!caseId) return
    await this.withBusy('open-case', async () => {
      const data = await this.api.getCase(caseId)
      this.state.caseData = data
      this.state.newCaseAvailable = false
      this.state.messagePage = 0
      this.state.messageTextPage = 0
      this.state.draftPage = 0
      this.state.transcriptPage = 0
      this.state.stale = false
      this.state.draft = null
      this.state.editorText = ''
      this.state.reply = null
      this.state.replyId = data.latest_reply?.reply_id ?? null
      this.state.focusedAction = 0
      this.state.screen = 'case'
      this.state.connection = this.state.fixtureMode ? 'development-fixtures' : 'connected'
      this.clearError()
    })
  }

  private async openSelectedInboxCase(): Promise<void> {
    const items = this.state.inbox?.items ?? []
    if (!items.length) return
    const index = Number.isInteger(this.state.selectedIndex)
      ? Math.min(items.length - 1, Math.max(0, this.state.selectedIndex))
      : 0
    this.state.selectedIndex = index
    const selected = items[index]
    if (selected?.status === 'open') await this.openCase(selected.case_id)
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
      const lastPage = Math.max(0, Math.ceil(fresh.context.length / CONTEXT_PAGE_SIZE) - 1)
      const currentPage = Number.isFinite(this.state.messagePage) ? Math.floor(this.state.messagePage) : 0
      this.state.messagePage = Math.min(lastPage, Math.max(0, currentPage))
      this.state.replyId = fresh.latest_reply?.reply_id ?? this.state.replyId
      if (this.state.draft && this.state.draft.based_on_version === fresh.version && Date.parse(this.state.draft.expires_at) > Date.now()) {
        this.state.stale = false
      }
      if (changed && this.state.draft && this.state.draft.based_on_version !== fresh.version) {
        this.state.stale = true
        this.state.message = 'The case changed. Context refreshed; create a new draft before approving.'
        if (this.state.screen === 'approval') this.resetApprovalReview()
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

  private async createDisplaySafeCopy(): Promise<void> {
    const source = this.state.editorText || this.state.draft?.text || ''
    if (!source || !canCreateDisplaySafeCopy(source)) return
    const copy = glassesReviewCopy(source)
    if (!copy || copy === source) return
    await this.createManualDraft(copy)
    if (this.state.draft?.text === copy && this.state.draft.source === 'owner') {
      this.state.message = 'Display-safe owner copy saved. Review every exact page before approval.'
      this.render()
    }
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
    this.state.draftPage = 0
    this.state.focusedAction = 0
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
    this.state.approvalPage = 0
    this.state.approvalProgress = 0
    this.state.approvalStage = 'review'
    this.state.screen = 'approval'
    this.resetApprovalReview()
    this.render()
  }

  private async approveExactText(): Promise<void> {
    const current = this.state.caseData
    const draft = this.state.draft
    if (!current || !draft || !this.state.reviewedExactText || this.state.busy) {
      if (!this.state.reviewedExactText) this.failLocal('Review every exact-text page on G2 or use the optional companion editor.', 'review_required')
      return
    }
    let text: string
    try {
      text = normalizeOwnerText(this.state.approvalText, 1000)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Review the exact reply text.', 'invalid_text')
      return
    }
    if (this.approvalSnapshot !== text || this.approvalDraftSnapshot !== draft.draft_id) {
      this.resetApprovalReview()
      this.failLocal('The reply changed after review. Start the full review again.', 'review_required')
      return
    }
    const scope = `approve:${current.case_id}`
    const pending = this.keys.get(scope)
    const pendingPayload = pending?.payload as { expected_version?: unknown; draft_id?: unknown; text?: unknown } | undefined
    const isReplay = Boolean(pending && pendingPayload &&
      pendingPayload.draft_id === draft.draft_id && pendingPayload.text === text &&
      typeof pendingPayload.expected_version === 'number')
    if (pending && !isReplay) {
      this.failLocal('An earlier approval is uncertain. Reopen and review its exact text before retrying.', 'uncertain_action')
      return
    }
    // A matching durable key must be replayed before mutable case/draft checks:
    // the backend returns a completed result before validating current state.
    const fresh = isReplay ? current : await this.refreshCase()
    if (!fresh || (!isReplay && fresh.status !== 'open')) return
    if (!isReplay && (fresh.version !== current.version || fresh.version !== draft.based_on_version || this.state.stale)) {
      this.state.stale = true
      this.state.screen = 'case'
      this.state.message = 'Approval stopped because the case changed. Review the latest context and create a new draft.'
      this.render()
      return
    }
    const expectedVersion = isReplay ? pendingPayload!.expected_version as number : fresh.version
    const payload = { expected_version: expectedVersion, draft_id: draft.draft_id, text }
    let key: string
    try {
      key = this.keys.acquire(scope, payload)
    } catch (error) {
      this.failLocal(error instanceof Error ? error.message : 'Retry the original approval text.', 'uncertain_action')
      return
    }
    await this.withBusy('approve', async () => {
      const result = await this.api.approveReply(current.case_id, expectedVersion, draft.draft_id, text, key)
      this.keys.complete(scope)
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
      this.workspace.save(current.case_id, this.state.draft, 'status')
      this.state.autoPolls = 0
      this.state.message = 'Reply queued. It has not been confirmed delivered.'
      await this.refreshCase()
      await this.fetchReply(result.reply_id, true)
    }, { keepKeyOnFailure: true, keyScope: scope, keyBook: this.keys })
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

  private async fetchReply(replyId: string, schedule: boolean, polling = false): Promise<void> {
    if (this.replyController) {
      if (this.replyControllerId !== replyId) this.pendingReplyFetch = { replyId, schedule, polling }
      return
    }
    this.clearReplyTimer()
    const controller = new AbortController()
    this.replyController = controller
    this.replyControllerId = replyId
    try {
      const reply = await this.api.getReply(replyId, controller.signal, polling)
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
            void this.fetchReply(replyId, true, true)
          }
        }, delay)
      } else if (shouldPollReply(reply.state) && this.state.autoPolls >= 5) {
        this.state.message = 'Automatic status checks paused. Select Check status when you are ready.'
      } else if (reply.state === 'submitted' && reply.delivery !== 'confirmed' && this.state.caseData?.channel === 'telegram') {
        this.state.message = 'Telegram accepted the message. Delivery is not confirmed.'
      }
      this.render()
    } catch (error) {
      if (controller.signal.aborted) return
      this.state.connection = 'offline'
      this.captureError(error)
      this.handleLostSession(error)
      this.render()
    } finally {
      if (this.replyController === controller) {
        this.replyController = null
        this.replyControllerId = null
      }
      const pending = this.pendingReplyFetch
      this.pendingReplyFetch = null
      if (pending && this.foreground && document.visibilityState === 'visible') {
        void this.fetchReply(pending.replyId, pending.schedule, pending.polling)
      }
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
      this.workspace.clear()
      this.state.message = feedback
      this.render()
    })
  }

  private enterResolveScreen(): void {
    this.state.focusedAction = 0
    this.state.acknowledgedUnknown = false
    this.state.resolveReason = 'handled_in_person'
    this.state.screen = 'resolve'
    this.render()
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
      this.voiceDerivedDraftIds.clear()
      this.workspace.clear()
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
    this.sessions.clear()
    void this.clearVoiceWorkflow('')
    this.voiceDerivedDraftIds.clear()
    this.state.sessionPresent = false
    this.state.screen = 'pair'
    this.state.salonName = ''
    this.state.message = 'Session ended. Pair this device again through Telegram.'
    this.state.inbox = null
    this.state.schedule = null
    this.state.scheduleOffset = 0
    this.state.caseData = null
    this.state.draft = null
    this.state.editorText = ''
    this.state.reply = null
    this.state.replyId = null
    // Keep pending idempotency records so an uncertain write retains its
    // original key and payload for reconciliation after re-pairing.
    this.render()
    return true
  }

  private async onVisibilityChange(): Promise<void> {
    this.foreground = document.visibilityState === 'visible'
    if (this.foreground) await this.onForegroundResume()
    else {
      this.cancelPendingSingleClick()
      this.clearReplyTimer()
      this.pollController?.abort()
      this.statusController?.abort()
      this.replyController?.abort()
      this.pendingReplyFetch = null
      if (this.state.screen === 'approval') this.resetApprovalReview()
      await this.stopForBackground()
    }
  }

  private async onForegroundResume(): Promise<void> {
    if (!this.foreground || document.visibilityState === 'hidden' || this.foregroundRefreshInProgress) return
    this.foregroundRefreshInProgress = true
    try {
    const session = this.state.fixtureMode ? null : this.sessions.load()
    if (!this.state.fixtureMode && !session && this.state.sessionPresent) {
      this.expireLocalSession()
      return
    }
    this.restorePendingVoiceIntent()
    if (this.state.screen === 'inbox') await this.loadInbox()
    else if (this.state.screen === 'schedule') await this.loadSchedule(this.state.scheduleOffset)
    else if (this.state.caseData && ['case', 'voice', 'draft', 'approval', 'resolve', 'status'].includes(this.state.screen)) {
      await this.refreshCaseStatus()
      if (this.state.screen === 'status' && this.state.replyId) await this.fetchReply(this.state.replyId, true, true)
    }
    } finally {
      this.foregroundRefreshInProgress = false
    }
  }

  private restorePendingVoiceIntent(): void {
    if (this.state.busy || !this.state.caseData) return
    const caseId = this.state.caseData.case_id
    const manual = this.voiceKeys.get(`voice-manual:${caseId}`)?.payload as { text?: unknown } | undefined
    if (typeof manual?.text === 'string') {
      this.state.voicePhase = 'transcript_ready'
      this.state.voiceTranscript = manual.text
      this.state.transcriptPage = 0
      this.state.voiceSimulation = false
      this.state.screen = 'voice'
      this.state.message = 'A dictated reply request may have completed. Select Use as reply to retry the same request safely.'
      this.render()
      return
    }
    const revision = this.voiceKeys.entries().find((entry) => entry.scope.startsWith(`voice-revise:${caseId}:`))
    const instruction = (revision?.payload as { instruction?: unknown } | undefined)?.instruction
    if (typeof instruction === 'string') {
      this.state.voicePhase = 'transcript_ready'
      this.state.voiceTranscript = instruction
      this.state.transcriptPage = 0
      this.state.voiceSimulation = false
      this.state.screen = 'voice'
      this.state.message = 'A revision request may have completed. Select Use as instruction to replay it safely.'
      this.render()
    }
  }

  private expireLocalSession(): void {
    this.sessions.clear()
    void this.clearVoiceWorkflow('')
    this.voiceDerivedDraftIds.clear()
    this.state.sessionPresent = false
    this.state.screen = 'pair'
    this.state.salonName = ''
    this.state.message = 'Session expired. Pair this device again through Telegram.'
    this.state.inbox = null
    this.state.schedule = null
    this.state.scheduleOffset = 0
    this.state.caseData = null
    this.state.draft = null
    this.state.editorText = ''
    this.state.reply = null
    this.state.replyId = null
    this.render()
  }

  private async pollVisibleState(): Promise<void> {
    if (!this.foreground || document.visibilityState !== 'visible' || this.state.busy || this.pollInProgress || this.pollController) return
    this.pollInProgress = true
    try {
    if (!this.state.fixtureMode && this.state.sessionPresent && !this.sessions.load()) {
      this.expireLocalSession()
      return
    }
    if (this.state.screen === 'inbox' && this.state.sessionPresent || this.state.screen === 'inbox' && this.state.fixtureMode) {
      await this.loadInbox(true)
    } else if (['case', 'voice', 'draft', 'approval', 'resolve', 'status'].includes(this.state.screen) && this.state.caseData) {
      await this.refreshCaseStatus()
    }
    } finally {
      this.pollInProgress = false
    }
  }

  private async refreshCaseStatus(): Promise<void> {
    const current = this.state.caseData
    if (!current || this.statusRefreshInProgress) return
    this.statusRefreshInProgress = true
    const controller = new AbortController()
    this.statusController = controller
    try {
      const status = await this.api.getCaseStatus(current.case_id, controller.signal, true)
      if (this.state.caseData?.case_id !== current.case_id) return
      if (status.version !== current.version || status.status !== current.status) {
        await this.refreshCase()
        if (this.state.screen === 'status' && this.state.replyId) await this.fetchReply(this.state.replyId, true, true)
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
        await this.fetchReply(latest.reply_id, true, true)
        return
      }

      const reply = await this.api.getReply(latest.reply_id, controller.signal, true)
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
      if (controller.signal.aborted) return
      this.state.connection = 'offline'
      this.captureError(error)
      this.handleLostSession(error)
      this.render()
    } finally {
      if (this.statusController === controller) this.statusController = null
      this.statusRefreshInProgress = false
    }
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) window.clearTimeout(this.replyTimer)
    this.replyTimer = null
  }

  private async activateGlassAction(): Promise<void> {
    const actionCount = this.glassActionCount()
    const selected = Number.isInteger(this.state.focusedAction)
      ? Math.min(actionCount - 1, Math.max(0, this.state.focusedAction))
      : 0
    this.state.focusedAction = selected
    switch (this.state.screen) {
      // Inbox is the root page: single click opens the native selection and
      // double click must always invoke the Even Hub system exit confirmation.
      case 'inbox':
        if (this.pageShutdownControl) {
          try {
            await this.pageShutdownControl(1)
          } catch (error) {
            this.captureError(error)
          }
        }
        return
      case 'schedule': {
        const hasPrevious = this.state.scheduleOffset > 0
        const hasNext = Boolean(this.state.schedule?.has_more)
        if (hasPrevious && selected === 0) return this.loadSchedule(this.state.scheduleOffset - 20)
        const nextIndex = hasPrevious ? 1 : 0
        if (hasNext && selected === nextIndex) {
          const next = this.state.schedule?.next_offset
          if (next !== null && next !== undefined) return this.loadSchedule(next)
        }
        this.returnToInbox()
        return
      }
      case 'case':
        if (this.state.caseData?.status === 'resolved') {
          if (selected === 0 && this.state.caseData.latest_reply) return this.openLatestReply()
          if (selected === 1 || !this.state.caseData.latest_reply) { this.returnToInbox(); return }
          return
        }
        if (selected === 0) return this.generateDraft()
        if (selected === 1) return this.enterVoiceReady()
        if (selected === 2) return this.openLatestReply()
        if (selected === 3) { const fresh = await this.refreshCase(); if (fresh) this.enterResolveScreen(); return }
        if (selected === 4) { this.returnToInbox(); return }
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
          if (selected === 0) return this.useVoiceTranscriptAsReply()
          if (selected === 1) return this.useVoiceTranscriptAsInstruction()
          if (selected === 2) {
            await this.clearVoiceWorkflow('Transcript discarded. It was not saved or sent.')
            this.state.screen = 'case'
            this.render()
          }
        } else if (this.state.voicePhase === 'error' || this.state.voicePhase === 'idle') {
          if (selected === 0) return this.state.fixtureMode ? this.beginDemoRecording() : this.beginVoiceCapture()
          if (selected === 1) {
            await this.clearVoiceWorkflow('Voice workflow closed.')
            this.state.screen = 'case'
            this.render()
          }
        }
        break
      case 'draft':
        if (selected === 0) return this.openApproval()
        if (selected === 1) return this.enterVoiceReady()
        if (selected === 2) { this.state.screen = 'case'; this.render(); return }
        if (selected === 3) return this.createDisplaySafeCopy()
        break
      case 'approval':
        if (this.state.approvalStage === 'review') {
          this.state.message = 'Read the complete text in order. Swipe down to advance; approval is a separate step.'
          this.render()
          return
        }
        if (hasUncertainApproval(this.state)) {
          if (selected === 0) return this.recoverReply()
          if (selected === 1) return this.retryUncertainAction()
          this.returnToDraft()
          return
        }
        if (this.canApproveFromGlasses() && selected === 0) {
          this.state.reviewedExactText = true
          return this.approveExactText()
        }
        this.returnToDraft()
        break
      case 'status':
        if (selected === 0) return this.checkReplyStatus()
        if (selected === 1) { this.enterResolveScreen(); return }
        if (selected === 2) { this.state.screen = 'case'; this.render(); return }
        break
      case 'resolve':
        if (selected === 1) { this.cancelResolve(); return }
        if (this.state.caseData?.latest_reply?.state === 'unknown' && !this.state.acknowledgedUnknown) {
          this.state.acknowledgedUnknown = true
          this.state.focusedAction = 0
          this.state.message = 'Uncertainty acknowledged. Confirm resolution in a separate action.'
          this.render()
          return
        }
        if (selected === 0) return this.resolveCase()
        break
      case 'pair': return
    }
  }

  private nextActionIndex(delta: number): number {
    const count = this.glassActionCount()
    const current = Number.isInteger(this.state.focusedAction)
      ? Math.min(count - 1, Math.max(0, this.state.focusedAction))
      : 0
    return (current + delta + count) % count
  }

  private glassActionCount(): number {
    switch (this.state.screen) {
      case 'case': return this.state.caseData?.status === 'resolved' ? (this.state.caseData.latest_reply ? 2 : 1) : 5
      case 'voice': return this.state.voicePhase === 'transcript_ready' ? 3 : 2
      case 'draft': return needsGlassesReviewCopy(this.state.editorText || this.state.draft?.text || '') ? 4 : 3
      case 'approval': return this.state.approvalStage === 'review' ? 1 : hasUncertainApproval(this.state)
        ? 3 : (this.canApproveFromGlasses() ? 2 : 1)
      case 'status': return 3
      case 'resolve': return 2
      case 'schedule': return 1 + (this.state.scheduleOffset > 0 ? 1 : 0) + (this.state.schedule?.has_more ? 1 : 0)
      default: return 1
    }
  }

  private canApproveFromGlasses(): boolean {
    const item = this.state.caseData
    const draft = this.state.draft
    const pages = paginateGlassesApprovalText(this.state.approvalText)
    const pending = item ? this.keys.get(`approve:${item.case_id}`) : null
    const payload = pending?.payload as { expected_version?: unknown; draft_id?: unknown; text?: unknown } | undefined
    const replay = Boolean(payload && typeof payload.expected_version === 'number' &&
      payload.draft_id === draft?.draft_id && payload.text === this.state.approvalText)
    const currentDraft = Boolean(item && draft && item.status === 'open' && !this.state.stale &&
      draft.based_on_version === item.version && Date.parse(draft.expires_at) > Date.now())
    return this.state.screen === 'approval' && this.state.approvalStage === 'confirm' &&
      this.state.approvalProgress >= pages.length - 1 && Boolean(item && draft && (currentDraft || replay) &&
        /^[\x20-\x7e\n]+$/.test(this.state.approvalText) &&
        this.approvalSnapshot === this.state.approvalText && this.approvalDraftSnapshot === draft.draft_id)
  }

  private advanceApprovalReview(): void {
    const pages = paginateGlassesApprovalText(this.state.approvalText)
    const last = pages.length - 1
    if (this.state.approvalPage < last) {
      this.state.approvalPage += 1
      this.state.approvalProgress = Math.max(this.state.approvalProgress, this.state.approvalPage)
    } else if (this.state.approvalProgress >= last) {
      this.state.approvalStage = 'confirm'
      this.state.focusedAction = 0
      this.state.message = 'Review complete. Choose Approve & Queue, then confirm separately.'
    }
  }

  private resetApprovalReview(): void {
    this.state.approvalPage = 0
    this.state.approvalProgress = 0
    this.state.approvalStage = 'review'
    this.state.reviewedExactText = false
    this.approvalSnapshot = this.state.approvalText
    this.approvalDraftSnapshot = this.state.draft?.draft_id ?? ''
  }

  private returnToInbox(): void {
    this.state.screen = 'inbox'
    this.state.caseData = null
    this.state.draft = null
    this.state.editorText = ''
    this.state.reply = null
    this.state.replyId = null
    this.workspace.clear()
    this.render()
    void this.loadInbox()
  }

  private returnToDraft(): void {
    this.state.screen = 'draft'
    this.state.reviewedExactText = false
    this.state.approvalStage = 'review'
    this.render()
  }

  private cancelResolve(): void {
    this.state.acknowledgedUnknown = false
    this.state.screen = 'case'
    this.render()
  }

  private async activateGlassMenuItem(itemId: number): Promise<void> {
    if (itemId === G2_MENU.caseRefresh && this.state.screen === 'case') {
      await this.refreshCase(true)
      return
    }
    if (itemId === G2_MENU.scheduleToday && this.state.screen === 'inbox') return this.loadSchedule(0)
    if (itemId === G2_MENU.schedulePrevious && this.state.screen === 'schedule') {
      return this.loadSchedule(Math.max(0, this.state.scheduleOffset - 20))
    }
    if (itemId === G2_MENU.scheduleNext && this.state.screen === 'schedule') {
      const next = this.state.schedule?.next_offset
      if (next !== null && next !== undefined) return this.loadSchedule(next)
      return
    }
    if (itemId === G2_MENU.scheduleInbox && this.state.screen === 'schedule') return this.returnToInbox()
    if (itemId === G2_MENU.inboxOpen) {
      if (this.state.inbox?.items.length) await this.openSelectedInboxCase()
      else await this.loadInbox()
      return
    }
    if (itemId === G2_MENU.aiDraft && this.state.screen === 'case') return this.generateDraft()
    if (itemId === G2_MENU.voiceReply && this.state.screen === 'case') return this.enterVoiceReady()
    if (itemId === G2_MENU.replyStatus && ['case', 'draft'].includes(this.state.screen)) return this.openLatestReply()
    if (itemId === G2_MENU.resolve || itemId === G2_MENU.statusResolve) {
      const fresh = await this.refreshCase()
      if (fresh) this.enterResolveScreen()
      return
    }
    if (itemId === G2_MENU.inbox || itemId === G2_MENU.draftCase || itemId === G2_MENU.statusCase) {
      if (this.state.screen === 'case') this.returnToInbox()
      else { this.state.screen = 'case'; this.render() }
      return
    }
    if (itemId === G2_MENU.draftReview && this.state.screen === 'draft') return this.openApproval()
    if (itemId === G2_MENU.draftVoice && this.state.screen === 'draft') return this.enterVoiceReady()
    if (itemId === G2_MENU.draftSafeCopy && this.state.screen === 'draft') return this.createDisplaySafeCopy()
    if (itemId === G2_MENU.voiceStart && this.state.screen === 'voice') {
      if (this.state.voicePhase === 'error') { this.state.voicePhase = 'idle'; this.state.focusedAction = 0 }
      return this.state.voiceSimulation ? this.beginDemoRecording() : this.beginVoiceCapture()
    }
    if (itemId === G2_MENU.voiceStop && this.state.screen === 'voice') {
      return this.state.voiceSimulation ? this.stopDemoRecording() : this.stopAndTranscribe('owner')
    }
    if (itemId === G2_MENU.voiceCancel && this.state.screen === 'voice') {
      await this.clearVoiceWorkflow('Voice activity cancelled. Audio and unselected transcript were cleared.')
      this.state.screen = 'case'
      this.render()
      return
    }
    if (itemId === G2_MENU.transcriptReply && this.state.screen === 'voice') return this.useVoiceTranscriptAsReply()
    if (itemId === G2_MENU.transcriptInstruction && this.state.screen === 'voice') return this.useVoiceTranscriptAsInstruction()
    if (itemId === G2_MENU.approvalPrevious && this.state.screen === 'approval') {
      this.state.approvalPage = Math.max(0, this.state.approvalPage - 1)
      this.state.approvalStage = 'review'
      this.render()
      return
    }
    if (itemId === G2_MENU.approvalNext && this.state.screen === 'approval') {
      this.advanceApprovalReview()
      this.render()
      return
    }
    if (itemId === G2_MENU.approvalConfirm && this.canApproveFromGlasses()) {
      this.state.reviewedExactText = true
      return this.approveExactText()
    }
    if (itemId === G2_MENU.approvalStatus && this.state.screen === 'approval' && hasUncertainApproval(this.state)) return this.recoverReply()
    if (itemId === G2_MENU.approvalRetry && this.state.screen === 'approval' && hasUncertainApproval(this.state)) return this.retryUncertainAction()
    if (itemId === G2_MENU.approvalCancel && this.state.screen === 'approval') return this.returnToDraft()
    if (itemId === G2_MENU.statusCheck && this.state.screen === 'status') return this.checkReplyStatus()
    if (itemId === G2_MENU.reasonHandled) this.state.resolveReason = 'handled_in_person'
    else if (itemId === G2_MENU.reasonUpdated) this.state.resolveReason = 'customer_updated'
    else if (itemId === G2_MENU.reasonNoAction) this.state.resolveReason = 'no_action_needed'
    else if (itemId === G2_MENU.reasonOther) this.state.resolveReason = 'other'
    else if (itemId === G2_MENU.resolveAcknowledge && this.state.screen === 'resolve') {
      this.state.acknowledgedUnknown = true
      this.state.focusedAction = 0
      this.state.message = 'Uncertainty acknowledged. Confirm resolution in a separate action.'
    } else if (itemId === G2_MENU.resolveConfirm && this.state.screen === 'resolve') return this.resolveCase()
    else if (itemId === G2_MENU.resolveCancel && this.state.screen === 'resolve') return this.cancelResolve()
    else return
    this.render()
  }

  private render(): void {
    const previousScreen = this.renderedScreen
    this.renderedScreen = this.state.screen
    if (previousScreen === 'voice' && this.state.screen !== 'voice') void this.clearVoiceWorkflow('')
    this.root.innerHTML = this.renderScreen()
    this.persistWorkspace()
    this.updateGlasses()
  }

  private renderScreen(): string {
    const fixtureBanner = this.state.fixtureMode
      ? '<div class="fixture-banner" role="note"><strong>Development fixtures · synthetic only</strong><span>No backend request · no customer message can be sent</span></div>'
      : ''
    const header = `<header class="topbar"><div class="brand"><span class="brand-mark">R</span><span><strong>RemboAI</strong><small>Glance</small></span></div><div class="top-meta"><span class="connection ${escapeHtml(this.state.connection)}">${escapeHtml(this.connectionLabel())}</span>${this.state.sessionPresent || this.state.fixtureMode ? `<span class="salon-name">${escapeHtml(this.state.salonName)}</span>` : ''}</div></header>`
    const footer = `<footer class="app-footer"><span>${this.state.glassesAvailable ? 'G2 connected · 576 × 288' : escapeHtml(this.state.glassesStatus)}</span>${this.state.sessionPresent && !this.state.fixtureMode ? button('Revoke this device', 'revoke') : this.state.fixtureMode ? button('Exit demo', 'leave-demo') : ''}</footer>`
    const error = this.state.error ? `<div class="error-card" role="alert"><strong>${escapeHtml(this.state.error)}</strong>${this.state.requestId ? `<small>Request ID: ${escapeHtml(this.state.requestId)}</small>` : ''}${this.state.retryAfter !== null ? `<small>Retry after ${this.state.retryAfter}s</small>` : ''}${this.canRetrySameAction() ? button('Retry the same request', 'retry-write', { primary: true }) : ''}</div>` : ''
    const message = formMessage(this.state.message)
    const screen = this.state.screen === 'pair' ? this.renderPair() :
      this.state.screen === 'inbox' ? this.renderInbox() :
      this.state.screen === 'schedule' ? this.renderSchedule() :
      this.state.screen === 'case' ? this.renderCase() :
      this.state.screen === 'voice' ? this.renderVoice() :
      this.state.screen === 'draft' ? this.renderDraft() :
      this.state.screen === 'approval' ? this.renderApproval() :
      this.state.screen === 'status' ? this.renderStatus() : this.renderResolve()
    return `${fixtureBanner}${header}<main class="layout"><section class="phone-shell"><div class="phone-screen">${screen}${error}${message}</div></section><aside class="glance-hint"><p class="eyebrow">Glasses first</p><h2>Handle escalations on G2.</h2><p>Swipe to browse or page. Click highlights an action; double-click activates it. The inbox opens a selected case on one click.</p><div class="control-key"><span>Swipe</span><b>Browse / page</b></div><div class="control-key"><span>Click</span><b>Choose action</b></div><div class="control-key"><span>Double</span><b>Confirm action</b></div><p class="hint-small">Pairing, recovery and optional full-text editing are available here. The ordinary reply and approval flow stays on the glasses.</p></aside></main>${footer}`
  }

  private renderPair(): string {
    const allowFixtures = DEMO_FIXTURES_ENABLED
    return `<section class="panel pair-panel"><p class="eyebrow">Owner escalation desk</p><h1>Pair your Glance</h1><p class="lead">Open the RemboAI Glance pairing message in your authenticated Telegram owner chat, then enter its 12-character code here.</p><p class="bridge-notice">${this.state.glassesAvailable ? 'Even Hub display connected · 576 × 288' : escapeHtml(this.state.glassesStatus)}</p><form data-form="pair" class="stack"><label for="pair-code">One-time pairing code</label><input id="pair-code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" maxlength="12" placeholder="0123456789AB" value="${escapeHtml(this.state.code)}" data-field="code" aria-describedby="pair-help" required><small id="pair-help">Letters use Crockford Base32. Spaces and hyphens are ignored. The code expires in five minutes.</small><button class="button primary wide" type="submit" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Pairing…' : 'Pair this device'}</button></form><div class="privacy-note"><strong>Revocable bearer session</strong><span>The session token is stored in browser localStorage. Revoke it here or from the Telegram owner chat. Do not share this device.</span></div>${allowFixtures ? `<div class="demo-entry"><span>For layout and workflow review only</span>${button('Open synthetic development demo', 'start-demo')}</div>` : ''}</section>`
  }

  private renderInbox(): string {
    const inbox = this.state.inbox
    const items = inbox?.items ?? []
    const stale = this.state.inboxStale ? '<div class="stale-strip">Offline · showing stale in-memory cases</div>' : ''
    const list = items.length ? `<div class="case-list">${items.map((item, index) => {
      const tier = caseAttentionTier(item.category)
      return `<article class="case-row priority-${tier} ${index === this.state.selectedIndex ? 'selected' : ''}"><button class="case-open" data-action="open-case" data-case-id="${escapeHtml(item.case_id)}"><span class="case-main"><span class="customer">${escapeHtml(item.customer_label)}</span><span class="case-age">${escapeHtml(this.age(item.created_at))} waiting</span></span><span class="case-subtitle"><span class="priority-badge ${tier}">${escapeHtml(caseAttentionLabel(item.category))}</span><span class="case-category">${escapeHtml(categoryLabel(item.category))}</span><span class="case-channel">${escapeHtml(channelLabel(item.channel))}</span></span><span class="preview">${escapeHtml(item.preview)}</span><span class="open-chevron">Open case →</span></button></article>`
    }).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">✓</div><h2>${this.state.connection === 'loading' ? 'Loading your inbox' : 'You are all caught up'}</h2><p>${this.state.connection === 'loading' ? 'Checking for open owner escalations.' : 'No open cases need your attention right now.'}</p></div>`
    const attention = caseAttentionCounts(items)
    const reviewCount = attention.review ? `${attention.review} ${attention.review === 1 ? 'case needs' : 'cases need'} review` : ''
    const attentionSummary = items.length ? `<div class="case-priority-summary" aria-label="Case priority summary"><strong>Needs attention</strong>${attention.urgent ? `<span class="priority-badge urgent">${attention.urgent} urgent</span>` : ''}${attention.sensitive ? `<span class="priority-badge sensitive">${attention.sensitive} sensitive</span>` : ''}${reviewCount ? `<span class="priority-badge review">${reviewCount}</span>` : ''}<small>${inbox?.has_more ? 'among shown cases' : 'across open cases'}</small></div>` : ''
    const count = inbox ? inbox.open_count : '—'
    const more = inbox?.has_more ? `<p class="more-note">Showing ${items.length} oldest open cases · ${moreCaseCount(inbox.open_count, items.length)} more not shown.</p>` : ''
    return `<section class="panel inbox-panel"><div class="section-heading"><div><p class="eyebrow">${this.state.fixtureMode ? 'Synthetic inbox' : 'Owner inbox'}</p><h1>Open cases</h1></div><div class="count-pill"><strong>${escapeHtml(count)}</strong><span>open</span></div></div>${stale}${attentionSummary}${list}${more}<div class="button-row">${button('Refresh', 'refresh-inbox')}${button('Today\'s schedule', 'show-schedule')}${items.length ? button('Open selected case', 'open-selected', { primary: true }) : ''}</div><p class="poll-note">Inbox checks every 5 seconds while visible. New cases may take time to appear.</p></section>`
  }

  private renderSchedule(): string {
    const schedule = this.state.schedule
    if (!schedule) return this.renderLoading('Loading today\'s schedule')
    const items = schedule.items
    const format = (iso: string): string => {
      const value = new Date(iso)
      if (!Number.isFinite(value.getTime())) return '--:--'
      try {
        return new Intl.DateTimeFormat(undefined, {
          hour: '2-digit', minute: '2-digit', hour12: false, timeZone: schedule.timezone,
        }).format(value)
      } catch {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
      }
    }
    const rows = items.map((item) => `<article class="schedule-row"><div><strong>${escapeHtml(format(item.starts_at))} · ${escapeHtml(item.service)}</strong><span>${escapeHtml(item.staff)} · ${escapeHtml(item.customer_label)}</span></div><small>${escapeHtml(item.payment_state.replaceAll('_', ' '))}</small></article>`).join('')
    const page = `${this.state.scheduleOffset / 20 + 1}${schedule.has_more ? '+' : ''}`
    return `<section class="panel schedule-panel"><button class="text-button back-link" data-action="back-inbox">← Inbox</button><div class="section-heading"><div><p class="eyebrow">Owner program · ${escapeHtml(schedule.date)}</p><h1>Today\'s schedule</h1></div><div class="count-pill"><strong>${escapeHtml(schedule.count)}</strong><span>shown</span></div></div>${items.length ? `<div class="schedule-list">${rows}</div>` : '<div class="empty-state"><div class="empty-icon">✓</div><h2>No active bookings</h2><p>Your program is clear for this day.</p></div>'}<div class="button-row">${this.state.scheduleOffset > 0 ? button('Previous', 'schedule-previous') : ''}${schedule.has_more ? button('Next', 'schedule-next') : ''}${button('Back to inbox', 'back-inbox', { primary: true })}</div><p class="poll-note">Read-only schedule · page ${escapeHtml(page)} · payment labels never include amounts or evidence.</p></section>`
  }

  private renderCase(): string {
    const item = this.state.caseData
    if (!item) return this.renderLoading('Loading case')
    const pages = Math.max(1, Math.ceil(item.context.length / CONTEXT_PAGE_SIZE))
    const pageNumber = Number.isFinite(this.state.messagePage)
      ? Math.min(pages - 1, Math.max(0, Math.floor(this.state.messagePage)))
      : 0
    const events = messagePage(item.context, pages - 1 - pageNumber, CONTEXT_PAGE_SIZE)
    const latest = item.latest_reply ? `<div class="latest-reply"><span class="eyebrow">Latest reply</span><strong>${escapeHtml(presentReplyState(item.latest_reply.state, item.channel).label)}</strong><button class="text-button" data-action="open-latest-reply">Inspect status →</button></div>` : ''
    const stale = this.state.stale ? '<div class="stale-strip">Case changed · refresh and create a current draft before approval.</div>' : ''
    const thread = events.map((event) => `<article class="message ${escapeHtml(event.actor)}"><div class="message-meta"><strong>${escapeHtml(event.actor === 'customer' ? item.customer_label : event.actor === 'assistant' ? 'RemboAI' : 'Owner')}</strong><time>${escapeHtml(dateTime(event.created_at))}</time></div><p>${escapeHtml(event.text)}</p></article>`).join('')
    const voiceAction = this.state.fixtureMode
      ? button('Open simulated voice controls', 'open-voice-ready', { disabled: item.status !== 'open' || this.state.busy })
      : button('Record voice correction', 'start-voice', { disabled: item.status !== 'open' || this.state.busy || !this.state.sessionPresent || !this.state.glassesAvailable })
    return `<section class="panel case-panel"><button class="text-button back-link" data-action="back-inbox">← Inbox</button><div class="section-heading"><div><p class="eyebrow">${escapeHtml(caseAttentionLabel(item.category))} · ${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(channelLabel(item.channel))}</p><h1>${escapeHtml(item.customer_label)}</h1></div><span class="status-tag ${item.status === 'resolved' ? 'resolved' : ''}">${escapeHtml(caseStatusText(item.status))} · v${item.version}</span></div>${stale}<p class="issue-summary"><strong>Latest customer message</strong><span>${escapeHtml(this.caseSummary(item))}</span></p><div class="context-label"><span>Customer-visible conversation</span>${item.has_earlier ? '<strong>Earlier messages omitted</strong>' : ''}</div><div class="thread-chunk">${thread || '<p class="subtle">No visible conversation is available.</p>'}</div><div class="chunk-nav">${button('Previous messages', 'page-back', { disabled: pageNumber >= pages - 1 })}<span>Chunk ${pageNumber + 1} of ${pages} · newest first</span>${button('Next messages', 'page-next', { disabled: pageNumber <= 0 })}</div>${latest}<div class="button-row wrap">${button('Generate AI suggestion', 'generate-draft', { primary: true, disabled: item.status !== 'open' || this.state.busy })}${button('Write a reply', 'write-manually', { disabled: item.status !== 'open' || this.state.busy })}${voiceAction}${button('Resolve case', 'resolve', { disabled: item.status !== 'open' || this.state.busy })}${button('Refresh context', 'refresh-case')}</div><p class="poll-note">${this.state.fixtureMode ? 'Simulated transcript · fixture only; no microphone, ASR, backend, or message send.' : 'Voice recording starts only after your action. Drafts remain unsent until you approve exact text.'}</p></section>`
  }

  private renderVoice(): string {
    const phase = this.state.voicePhase
    const item = this.state.caseData
    if (!item) return this.renderLoading('Loading case')
    const duration = this.formatDuration(this.state.voiceDurationMs)
    if (phase === 'recording') {
      const simulated = this.state.voiceSimulation
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="cancel-voice">← Cancel voice workflow</button><p class="eyebrow">${simulated ? 'Simulated capture · mic off' : 'G2 microphone active'}</p><h1>${simulated ? 'Capture preview' : 'Recording'}</h1><div class="recording-indicator ${simulated ? 'simulated-recording' : ''}"><span class="recording-dot"></span><strong>${simulated ? 'Simulation only' : 'Microphone on'}</strong><span class="voice-duration">${duration}</span></div><p class="lead">${simulated ? 'Fixture-only display preview. No microphone or ASR is running.' : 'Speak a short message. Stop when you are done. The recording stays in memory and is not saved.'}</p><div class="button-row">${button(simulated ? 'Finish simulated capture' : 'Stop and transcribe', 'stop-voice', { primary: true })}${button('Cancel', 'cancel-voice')}</div><small>${simulated ? 'Synthetic fixture · no audio is captured' : 'Maximum 40 seconds · G2 microphone only'}</small></section>`
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
      const transcriptLabel = this.state.voiceSimulation ? 'Simulated transcript · fixture only' : 'Transcript · not sent'
      const transcriptNote = this.state.voiceSimulation ? '<p class="warning-card">Synthetic walkthrough text · no microphone or ASR was used. This demo cannot contact customers.</p>' : ''
      const againAction = this.state.voiceSimulation ? 'start-demo-recording' : 'start-voice'
      const againLabel = this.state.voiceSimulation ? 'Start simulated capture again' : 'Record again'
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="voice-back-case">← Case</button><p class="eyebrow">${transcriptLabel}</p><h1>Choose what you meant</h1>${transcriptNote}<div class="voice-facts"><span>Captured ${duration}</span><span>${this.state.voiceSimulation ? 'Simulated' : 'Transcription'} ${this.state.voiceTranscriptionDurationMs ?? 0} ms</span></div><label for="voice-transcript">${this.state.voiceSimulation ? 'Synthetic words' : 'Recognized words'}</label><textarea id="voice-transcript" class="transcript-text" rows="6" readonly>${escapeHtml(this.state.voiceTranscript)}</textarea><div class="intent-cards"><div><h2>Use as reply</h2><p>Create an owner-authored draft from these words. Review and approve it on G2; phone editing is optional.</p>${button('Use as reply', 'use-transcript-reply', { primary: true, disabled: this.state.busy || item.status !== 'open' })}</div><div><h2>Use as instruction</h2><p>${escapeHtml(instructionWhy)}</p>${button('Use as instruction', 'use-transcript-instruction', { disabled: this.state.busy || !canInstruction })}</div></div><p class="subtle">Neither choice sends a message. The G2 review and final approval are separate actions.</p>${button(againLabel, againAction)}</section>`
    }
    if (phase === 'starting' || phase === 'stopping' || phase === 'transcribing') {
      const label = phase === 'starting' ? 'Starting microphone' : phase === 'stopping' ? 'Stopping microphone' : 'Transcribing'
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="cancel-voice">← Cancel</button><div class="spinner" aria-hidden="true"></div><p class="eyebrow">${phase === 'transcribing' ? 'Audio in memory only' : 'G2 microphone'}</p><h1>${label}</h1><p class="subtle">${phase === 'transcribing' ? 'No automatic retry. The audio buffer is cleared when this request ends.' : 'Glance will not start recording in the background.'}</p></section>`
    }
    if (phase === 'error') {
      const retryAction = this.state.voiceSimulation ? 'start-demo-recording' : 'start-voice'
      const retryLabel = this.state.voiceSimulation ? 'Preview recording again' : 'Record again'
      return `<section class="panel voice-panel"><button class="text-button back-link" data-action="voice-back-case">← Case</button><p class="eyebrow">Voice capture · microphone off</p><h1>Recording stopped</h1><div class="warning-card">${escapeHtml(this.state.voiceError || 'Voice capture could not continue.')}${this.state.requestId ? `<small>Request ID: ${escapeHtml(this.state.requestId)}</small>` : ''}${this.state.retryAfter !== null ? `<small>Try again after ${this.state.retryAfter}s.</small>` : ''}</div><p class="subtle">No recording is retained. You can try again explicitly.</p>${button(retryLabel, retryAction, { primary: true, disabled: this.state.busy || (!this.state.voiceSimulation && !this.state.glassesAvailable) })}</section>`
    }
    const startAction = this.state.voiceSimulation ? 'start-demo-recording' : 'start-voice'
    const startLabel = this.state.voiceSimulation ? 'Start simulated capture' : 'Start G2 recording'
    return `<section class="panel voice-panel"><button class="text-button back-link" data-action="voice-back-case">← Case</button><p class="eyebrow">${this.state.voiceSimulation ? 'Simulated voice preview' : 'Owner-started voice'}</p><h1>Ready to record</h1><p class="lead">${this.state.voiceSimulation ? 'Preview only. No microphone or ASR will run.' : 'The G2 microphone stays off until you choose Start. Speak briefly, stop, then choose a reply or revision instruction on the glasses.'}</p>${button(startLabel, startAction, { primary: true, disabled: this.state.busy || (!this.state.voiceSimulation && !this.state.glassesAvailable) })}</section>`
  }

  private renderDraft(): string {
    const draft = this.state.draft
    if (!this.state.caseData) return this.renderLoading('Loading case')
    if (this.state.manualMode && !draft) {
      return `<section class="panel editor-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">Owner-authored reply</p><h1>Write a reply</h1><p class="lead">This text will be saved as a manual draft. It will not be sent until you inspect and approve the exact text.</p><form data-form="manual-draft" class="stack"><label for="reply-editor">Customer-facing text <span class="counter">${[...this.state.editorText].length}/700</span></label><textarea id="reply-editor" data-field="editorText" maxlength="700" rows="8" placeholder="Write the reply you want the customer to receive.">${escapeHtml(this.state.editorText)}</textarea><button class="button primary wide" type="submit" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Saving draft…' : 'Save manual draft'}</button></form>${this.uncertainNote('manual-draft')}</section>`
    }
    if (!draft) return this.renderLoading(this.state.busy ? 'Creating AI suggestion' : 'No saved draft')
    const expiry = new Date(draft.expires_at)
    const isExpired = !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()
    const source = this.state.fixtureMode ? 'Synthetic preview — not AI / not sent' : draft.source === 'ai' ? 'AI suggestion — not sent' : 'Owner-authored draft — not sent'
    const revision = draft.source === 'ai' ? `<form data-form="revise" class="stack revision-form"><label for="revision">Owner correction instruction <span class="counter">${[...this.state.revisionInstruction].length}/300</span></label><textarea id="revision" data-field="revisionInstruction" maxlength="300" rows="3" placeholder="Tell the assistant what to change. This instruction is not the customer reply.">${escapeHtml(this.state.revisionInstruction)}</textarea><button class="button" type="submit" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Revising…' : 'Create revised draft'}</button></form>` : ''
    return `<section class="panel editor-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">${source}</p><h1>Review your draft</h1><div class="draft-meta"><span>Case version ${draft.based_on_version}</span><span>${isExpired ? 'Expired' : `Expires ${escapeHtml(dateTime(draft.expires_at))}`}</span></div>${this.state.stale || draft.based_on_version !== this.state.caseData.version ? '<div class="stale-strip">This draft is stale. Refresh context and create a new draft before approval.</div>' : ''}<label for="draft-editor">Full customer-facing reply <span class="counter">${[...this.state.editorText].length}/700</span></label><textarea id="draft-editor" data-field="editorText" maxlength="700" rows="9" ${isExpired ? 'disabled' : ''}>${escapeHtml(this.state.editorText)}</textarea><p class="subtle">Editing this text changes only the proposed reply. Nothing is sent automatically.</p>${revision}<div class="button-row wrap">${button('Review exact text', 'open-approval', { primary: true, disabled: isExpired || this.state.stale || this.state.busy })}${draft.source === 'ai' ? button('Save as owner-authored draft', 'save-owner-copy', { disabled: isExpired || this.state.busy }) : ''}${button('Back to case', 'back-case')}</div>${this.uncertainNote(draft.source === 'ai' ? 'ai-draft' : 'manual-draft')}</section>`
  }

  private renderApproval(): string {
    const draft = this.state.draft
    if (!draft) return this.renderLoading('No persisted draft')
    const unresolvedWarning = this.state.caseData?.latest_reply && ['queued', 'sending', 'unknown'].includes(this.state.caseData.latest_reply.state)
      ? '<div class="warning-card"><strong>Existing reply needs attention.</strong><span>Inspect its status before approving another message.</span></div>' : ''
    return `<section class="panel approval-panel"><button class="text-button back-link" data-action="back-draft">← Draft</button><p class="eyebrow">Exact text · not sent</p><h1>Inspect the full reply</h1><p class="lead">Read every line below. This exact text will be queued if you approve.</p><label for="approval-editor">Customer-facing message</label><textarea id="approval-editor" data-field="approvalText" maxlength="1000" rows="12">${escapeHtml(this.state.approvalText)}</textarea><label class="check-row"><input type="checkbox" data-field="reviewedExactText" ${this.state.reviewedExactText ? 'checked' : ''}><span>I reviewed the complete exact customer message above.</span></label>${unresolvedWarning}<div class="button-row">${button('Approve and queue', 'approve', { primary: true, disabled: !this.state.reviewedExactText || this.state.busy || Boolean(unresolvedWarning) })}${button('Cancel', 'cancel-approval')}</div><p class="subtle">Approval creates a queued reply. It does not confirm provider acceptance or customer delivery.</p>${this.uncertainNote('approval')}${button('Check if a reply was already queued', 'recover-reply')}</section>`
  }

  private renderStatus(): string {
    const reply = this.state.reply
    const latest = this.state.caseData?.latest_reply
    const channel = this.state.caseData?.channel ?? 'telegram'
    if (!reply && latest) return `<section class="panel status-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">Reply recovery</p><h1>Checking latest reply</h1><p class="lead">The case shows a reply. Fetching its current status.</p>${button('Check status', 'open-latest-reply', { primary: true })}</section>`
    if (!reply) return `<section class="panel status-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">Reply status</p><h1>No reply status loaded</h1>${button('Recover from case', 'recover-reply', { primary: true })}</section>`
    const presentation = presentReplyState(reply.state, channel)
    const statusClass = reply.state === 'failed' || reply.state === 'unknown' ? 'danger' : reply.state === 'delivered' ? 'success' : ''
    const action = shouldPollReply(reply.state) ? 'Sending is still in progress. Status checks slow down and stop automatically.' : 'No automatic delivery claim is made.'
    return `<section class="panel status-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">${this.state.fixtureMode ? 'Synthetic reply' : 'Outbound reply'}</p><h1>Reply status</h1><div class="reply-state ${statusClass}"><span class="state-dot"></span><strong>${escapeHtml(presentation.label)}</strong></div><p class="lead">${escapeHtml(presentation.detail)}</p><dl class="status-facts"><div><dt>Updated</dt><dd>${escapeHtml(dateTime(reply.updated_at))}</dd></div><div><dt>Reply ID</dt><dd class="id-value">${escapeHtml(reply.reply_id)}</dd></div>${reply.error_category ? `<div><dt>Issue</dt><dd>${escapeHtml(reply.error_category.replaceAll('_', ' '))}</dd></div>` : ''}</dl><p class="subtle">${escapeHtml(action)}</p><div class="button-row wrap">${button('Check status', 'check-status', { primary: true })}${button('Resolve case', 'resolve', { disabled: this.state.caseData?.status === 'resolved' })}${button('Inbox', 'back-inbox')}</div></section>`
  }

  private renderResolve(): string {
    const item = this.state.caseData
    if (!item) return this.renderLoading('Loading case')
    const unknown = item.latest_reply?.state === 'unknown'
    const warning = unknown ? `<div class="warning-card strong-warning"><strong>The customer may or may not have received this reply.</strong><span>It will not be resent automatically. Acknowledge this uncertainty only if you want to resolve anyway.</span><label class="check-row"><input type="checkbox" data-field="acknowledgedUnknown" ${this.state.acknowledgedUnknown ? 'checked' : ''}><span>I understand and acknowledge the uncertain send.</span></label></div>` : ''
    const queued = item.latest_reply?.state === 'queued' ? '<p class="subtle">Resolving will cancel the queued reply before dispatch. It will not be sent.</p>' : ''
    const sending = item.latest_reply?.state === 'sending' ? '<div class="warning-card"><strong>Reply is sending.</strong><span>Wait for its outcome before resolving.</span></div>' : ''
    const resolved = item.status === 'resolved'
    return `<section class="panel resolve-panel"><button class="text-button back-link" data-action="back-case">← Case</button><p class="eyebrow">Owner action</p><h1>${resolved ? 'Case resolved' : 'Resolve this case?'}</h1><p class="lead">Resolving records that you have closed this escalation. Sending a reply and resolving the case are separate actions.</p>${warning}${queued}${sending}${resolved ? '<div class="success-card">This case is marked resolved. Payment status is unchanged.</div>' : `<form data-form="resolve" class="stack"><label for="resolve-reason">Reason</label><select id="resolve-reason" data-field="resolveReason">${REASONS.map((reason) => `<option value="${reason.value}" ${reason.value === this.state.resolveReason ? 'selected' : ''}>${reason.label}</option>`).join('')}</select>${this.state.resolveReason === 'other' ? `<label for="resolve-note">Short note (optional)</label><textarea id="resolve-note" data-field="resolveNote" maxlength="200" rows="3">${escapeHtml(this.state.resolveNote)}</textarea>` : ''}<div class="button-row"><button class="button primary" type="submit" ${this.state.busy || Boolean(sending) || (unknown && !this.state.acknowledgedUnknown) ? 'disabled' : ''}>${this.state.busy ? 'Resolving…' : 'Confirm resolution'}</button>${button('Cancel', 'cancel-resolve')}</div></form>`}</section>`
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

  getGlassesPage(): GlassesPage {
    return buildGlassesPage(this.state)
  }

  private updateGlasses(): void {
    const page = this.getGlassesPage()
    this.lastRenderedGlasses = glassesPageText(page)
    this.glassesWriter?.(page)
  }
}
