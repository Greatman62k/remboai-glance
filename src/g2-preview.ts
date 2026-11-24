import { FIXTURE_CASE_ID } from './demo-fixtures.ts'
import type { GlanceAppController } from './app.ts'
import type { ReplyData } from './types.ts'
import { CONTEXT_PAGE_SIZE } from './workflow.ts'
import { paginateGlassesApprovalText } from './glasses-ui.ts'

export type G2PreviewName =
  | 'inbox'
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
  app.state.inboxStale = false
  app.state.selectedIndex = 0
  app.state.caseData = await app.fixtures.getCase(FIXTURE_CASE_ID)
  app.state.stale = false
  app.state.messagePage = 0
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
      app.state.editorText = "Thanks for asking. I will check today's availability with the team and confirm what we can offer. I do not want to promise a time until they verify the current schedule. I will send you an update as soon as I have a reliable answer."
      app.state.approvalText = app.state.editorText
      app.state.screen = 'approval'
      app.state.approvalStage = route === 'approval-confirm' ? 'confirm' : 'review'
      app.state.approvalProgress = route === 'approval-confirm'
        ? paginateGlassesApprovalText(app.state.approvalText).length - 1
        : 0
      app.state.approvalPage = 0
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
      app.state.voiceTranscript = 'The owner can confirm whether walk-ins are available this afternoon.'
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
