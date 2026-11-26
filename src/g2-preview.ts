import { FIXTURE_CASE_ID } from './demo-fixtures.ts'
import type { GlanceAppController } from './app.ts'
import type { ReplyData } from './types.ts'
import { CONTEXT_PAGE_SIZE } from './workflow.ts'
import { paginateGlassesApprovalText } from './glasses-ui.ts'

export type G2PreviewName =
  | 'inbox'
  | 'schedule'
  | 'case'
  | 'case-older'
  | 'draft'
  | 'voice-ready'
  | 'voice-recording'
  | 'transcript-preview'
  | 'approval-review'
  | 'approval-confirm'
  | 'reply-status'
  | 'resolve'
  | 'case-resolved'

const ROUTES: G2PreviewName[] = [
  'inbox',
  'schedule',
  'case',
  'case-older',
  'draft',
  'voice-ready',
  'voice-recording',
  'transcript-preview',
  'approval-review',
  'approval-confirm',
  'reply-status',
  'resolve',
  'case-resolved',
]

export function readG2PreviewName(search: string): G2PreviewName | null {
  const value = new URLSearchParams(search).get('g2-preview')
  return ROUTES.includes(value as G2PreviewName) ? value as G2PreviewName : null
}

/** Load synthetic-only content before app.start so no saved live session is read. */
export async function prepareG2Preview(app: GlanceAppController, route: G2PreviewName): Promise<void> {
  app.enableSyntheticPreview()
  app.state.connection = 'development-fixtures'
  app.state.sessionPresent = false
  app.state.salonName = 'Synthetic cases'
  app.state.inbox = await app.fixtures.getInbox()
  app.state.schedule = await app.fixtures.getSchedule()
  app.state.scheduleOffset = 0
  app.state.inboxStale = false
  app.state.selectedIndex = 0
  app.state.caseData = await app.fixtures.getCase(FIXTURE_CASE_ID)
  app.state.stale = false
  app.state.messagePage = 0
  app.state.messageTextPage = 0
  app.state.focusedAction = 0
  app.state.draft = null
  app.state.editorText = ''
  app.state.approvalText = ''
  app.state.reply = null
  app.state.replyId = null
  app.state.voicePhase = 'idle'
  app.state.voiceDurationMs = 0
  app.state.voiceTranscriptionDurationMs = null
  app.state.voiceTranscript = ''
  app.state.voiceSimulation = true
  app.state.voiceError = ''

  switch (route) {
    case 'inbox':
      app.state.screen = 'inbox'
      break
    case 'schedule':
      app.state.screen = 'schedule'
      break
    case 'case':
      app.state.screen = 'case'
      break
    case 'case-older':
      app.state.screen = 'case'
      app.state.messagePage = Math.max(0, Math.ceil(app.state.caseData.context.length / CONTEXT_PAGE_SIZE) - 1)
      break
    case 'draft':
      app.state.draft = await app.fixtures.createDraft(
        FIXTURE_CASE_ID,
        app.state.caseData.version,
        'g2-native-preview',
      )
      app.state.screen = 'draft'
      break
    case 'approval-review':
    case 'approval-confirm': {
      app.state.draft = await app.fixtures.createDraft(
        FIXTURE_CASE_ID,
        app.state.caseData.version,
        'g2-approval-preview',
      )
      app.state.editorText = "Yes, walk-ins are accepted until 5:00 p.m. this afternoon. Please come before then and our team will help you as soon as a chair is available. There may be a short wait while we finish with the clients already here. If you can share your expected arrival time, we can let the team know and be ready to assist. We look forward to seeing you and will confirm any changes as soon as possible."
      app.state.approvalText = app.state.editorText
      app.state.screen = 'approval'
      app.state.approvalStage = route === 'approval-confirm' ? 'confirm' : 'review'
      app.state.approvalProgress = route === 'approval-confirm'
        ? paginateGlassesApprovalText(app.state.approvalText).length - 1
        : 0
      app.state.approvalPage = 0
      // The direct preview route represents a review that has already been
      // persisted. Seed the controller's private review snapshot so the final
      // confirmation action exercises the same approval guard as the live flow.
      ;(app as unknown as { approvalSnapshot: string; approvalDraftSnapshot: string }).approvalSnapshot = app.state.approvalText
      ;(app as unknown as { approvalSnapshot: string; approvalDraftSnapshot: string }).approvalDraftSnapshot = app.state.draft.draft_id
      break
    }
    case 'voice-ready':
      app.state.screen = 'voice'
      break
    case 'voice-recording':
      app.state.voicePhase = 'recording'
      app.state.voiceDurationMs = 8_000
      app.state.screen = 'voice'
      break
    case 'transcript-preview':
      app.state.voicePhase = 'transcript_ready'
      app.state.voiceTranscript = 'Shorten it and mention walk-ins are accepted until five.'
      app.state.voiceDurationMs = 8_000
      app.state.screen = 'voice'
      break
    case 'reply-status': {
      const selected = app.state.inbox.items[1]
      const caseData = await app.fixtures.getCase(selected.case_id)
      app.state.caseData = caseData
      app.state.reply = {
        reply_id: caseData.latest_reply!.reply_id,
        case_id: caseData.case_id,
        state: 'queued',
        delivery: 'unconfirmed',
        error_category: null,
        created_at: caseData.latest_reply!.updated_at,
        updated_at: caseData.latest_reply!.updated_at,
        submitted_at: null,
        delivered_at: null,
        failed_at: null,
      } satisfies ReplyData
      app.state.replyId = app.state.reply.reply_id
      app.state.screen = 'status'
      break
    }
    case 'resolve':
      app.state.screen = 'resolve'
      app.state.focusedAction = 0
      app.state.acknowledgedUnknown = false
      break
    case 'case-resolved':
      await app.fixtures.resolveCase(FIXTURE_CASE_ID, {
        expected_version: app.state.caseData.version,
        reason: 'handled_in_person',
        acknowledge_unknown_reply: false,
      })
      app.state.caseData = await app.fixtures.getCase(FIXTURE_CASE_ID)
      app.state.screen = 'case'
      break
  }
}
