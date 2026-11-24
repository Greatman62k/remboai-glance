import type { CaseData, DraftData, InboxData, ReplyData, ResolveReason } from './types.ts'

export type GlanceScreen = 'pair' | 'inbox' | 'case' | 'voice' | 'draft' | 'approval' | 'status' | 'resolve'
export type ConnectionState = 'loading' | 'connected' | 'reconnecting' | 'offline' | 'error' | 'development-fixtures'

export interface AppStateView {
  screen: GlanceScreen
  fixtureMode: boolean
  connection: ConnectionState
  sessionPresent: boolean
  salonName: string
  inbox: InboxData | null
  inboxStale: boolean
  newCaseAvailable: boolean
  selectedIndex: number
  caseData: CaseData | null
  stale: boolean
  messagePage: number
  draftPage: number
  transcriptPage: number
  draft: DraftData | null
  editorText: string
  revisionInstruction: string
  approvalText: string
  reviewedExactText: boolean
  approvalPage: number
  approvalProgress: number
  approvalStage: 'review' | 'confirm'
  reply: ReplyData | null
  busy: boolean
  busyAction: string
  error: string
  requestId: string | null
  retryAfter: number | null
  errorCode: string | null
  message: string
  resolveReason: ResolveReason
  resolveNote: string
  acknowledgedUnknown: boolean
  focusedAction: number
}
