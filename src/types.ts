export type Channel = 'telegram' | 'whatsapp'

export type ReplyState =
  | 'queued'
  | 'sending'
  | 'submitted'
  | 'delivered'
  | 'failed'
  | 'unknown'
  | 'cancelled'

export type DeliveryState = 'unsupported' | 'unconfirmed' | 'confirmed'
export type DraftSource = 'ai' | 'owner'

export interface SessionData {
  access_token: string
  expires_at: string
  salon: { name: string }
}

export interface InboxItem {
  case_id: string
  version: number
  status: 'open' | 'resolved' | string
  category: string
  created_at: string
  customer_label: string
  channel: Channel
  preview: string
}

export interface InboxData {
  items: InboxItem[]
  open_count: number
  has_more: boolean
  next_cursor: null
}

export interface AttentionItem {
  attention_id: string
  kind: string
  priority: 'critical' | 'high' | 'normal' | 'low' | string
  state: string
  title: string
  summary: string
  created_at: string
  expires_at: string | null
  case_id: string | null
  resource_id: string | null
  action: string
}

export interface AttentionData {
  items: AttentionItem[]
  count: number
  has_more: boolean
  next_cursor: string | null
}

export type SchedulePaymentState = 'paid' | 'awaiting_deposit' | 'no_deposit_recorded'

export interface ScheduleItem {
  booking_id: string
  status: 'confirmed' | 'held' | string
  customer_label: string
  service: string
  staff: string
  starts_at: string
  ends_at: string
  payment_state: SchedulePaymentState | string
}

export interface ScheduleData {
  date: string
  timezone: string
  items: ScheduleItem[]
  count: number
  has_more: boolean
  next_offset: number | null
}

export interface LatestReply {
  reply_id: string
  state: ReplyState
  updated_at: string
  delivery: DeliveryState
  error_category: string | null
  submitted_at: string | null
  delivered_at: string | null
}

export interface CaseMessage {
  sequence: number
  actor: 'customer' | 'assistant' | 'owner'
  text: string
  created_at: string
}

export interface CaseData {
  case_id: string
  version: number
  status: 'open' | 'resolved' | string
  category: string
  channel: Channel
  customer_label: string
  latest_reply: LatestReply | null
  has_earlier: boolean
  context: CaseMessage[]
}

export interface CaseStatusReply {
  reply_id: string
  state: ReplyState
  updated_at: string
}

export interface CaseStatusData {
  case_id: string
  status: 'open' | 'resolved' | string
  version: number
  latest_reply: CaseStatusReply | null
  case_updated_at: string
}

export interface DraftData {
  draft_id: string
  based_on_version: number
  text: string
  source: DraftSource
  expires_at: string
}

export interface TranscriptionData {
  transcript: string
  duration_ms: number
}

export interface ReplyResult {
  reply_id: string
  state: 'queued'
  case_version: number
}

export interface ReplyData {
  reply_id: string
  case_id: string
  state: ReplyState
  delivery: DeliveryState
  error_category: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
  delivered_at: string | null
  failed_at: string | null
}

export type ResolveReason =
  | 'handled_in_person'
  | 'customer_updated'
  | 'no_action_needed'
  | 'other'

export interface ResolveResult {
  case_id: string
  status: 'resolved'
  resolved_at: string | null
  version: number
  unknown_reply_acknowledged: boolean
  cancelled_reply_ids: string[]
}

export interface ApiEnvelope<T> {
  data: T
}

export interface ApiErrorEnvelope {
  error?: { code?: string; message?: string }
  request_id?: string
}

export interface ResolveRequest {
  expected_version: number
  reason: ResolveReason
  acknowledge_unknown_reply: boolean
  note?: string
}
