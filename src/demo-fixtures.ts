import { ApiError } from './client.ts'
import type {
  CaseData,
  CaseStatusData,
  DraftData,
  InboxData,
  InboxItem,
  ReplyData,
  ReplyResult,
  ResolveRequest,
  ResolveResult,
  SessionData,
  TranscriptionData,
} from './types.ts'
import { presentReplyState } from './workflow.ts'

export const FIXTURE_CASE_ID = 'd6e306ac-b222-46d5-bfc9-a54bcd6f24a1'
export const FIXTURE_UNKNOWN_CASE_ID = 'ca741c76-c7aa-4bd9-a03d-2df8f58c4010'
const DEPOSIT_CASE_ID = '68606ee1-a125-4c25-876a-75256809a134'
const QUEUED_REPLY_ID = 'b8f75848-2c60-42d3-947f-019f9a004c68'

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function makeMessage(sequence: number, actor: CaseData['context'][number]['actor'], text: string): CaseData['context'][number] {
  return { sequence, actor, text, created_at: minutesAgo(42 - sequence * 2) }
}

const baseContext: CaseData['context'] = [
  makeMessage(2, 'customer', 'Hello, I wanted to ask about coming in today.'),
  makeMessage(3, 'assistant', 'I can ask the owner to confirm today’s availability.'),
  makeMessage(4, 'customer', 'Are walk-ins still accepted this afternoon?'),
  makeMessage(5, 'assistant', 'I’ll pass that question to the owner.'),
  makeMessage(6, 'customer', 'I can come before five if that works.'),
  makeMessage(7, 'assistant', 'Thanks. The owner will review your request.'),
  makeMessage(8, 'customer', 'Please let me know when you can.'),
  makeMessage(9, 'assistant', 'I’ve shared the question with the owner.'),
  makeMessage(10, 'customer', 'I am nearby now.'),
  makeMessage(11, 'assistant', 'The owner is checking the request.'),
]

const baseCase = (caseId: string, version: number, category: string, customer: string): CaseData => ({
  case_id: caseId,
  version,
  status: 'open',
  category,
  channel: 'telegram',
  customer_label: customer,
  latest_reply: null,
  has_earlier: true,
  context: [...baseContext],
})

const fixtureItems: InboxItem[] = [
  {
    case_id: FIXTURE_CASE_ID,
    version: 3,
    status: 'open',
    category: 'human_request',
    created_at: minutesAgo(42),
    customer_label: 'Amina',
    channel: 'telegram',
    preview: 'Are walk-ins still accepted this afternoon?',
  },
  {
    case_id: DEPOSIT_CASE_ID,
    version: 2,
    status: 'open',
    category: 'deposit',
    created_at: minutesAgo(18),
    customer_label: 'Nia',
    channel: 'telegram',
    preview: 'Could the owner clarify the deposit policy?',
  },
  {
    case_id: FIXTURE_UNKNOWN_CASE_ID,
    version: 4,
    status: 'open',
    category: 'complaint',
    created_at: minutesAgo(7),
    customer_label: 'Kendi',
    channel: 'telegram',
    preview: 'I am not sure whether the last reply reached you.',
  },
]

const unknownReplyId = '0d3780c3-d5a2-4144-9425-d648049f11d9'

export class DemoFixtures {
  readonly mode = 'development-fixtures' as const
  private readonly cases = new Map<string, CaseData>()
  private readonly replies = new Map<string, ReplyData>()
  private readonly replyPolls = new Map<string, number>()
  private readonly drafts = new Map<string, DraftData>()
  private readonly consumedDrafts = new Set<string>()
  private readonly supersededDrafts = new Set<string>()
  private readonly idempotency = new Map<string, { payload: string; result: unknown }>()

  startDemo(): void {
    this.cases.clear()
    this.cases.set(FIXTURE_CASE_ID, baseCase(FIXTURE_CASE_ID, 3, 'human_request', 'Amina'))
    const queued = baseCase(DEPOSIT_CASE_ID, 2, 'deposit', 'Nia')
    queued.latest_reply = {
      reply_id: QUEUED_REPLY_ID,
      state: 'queued',
      updated_at: minutesAgo(1),
      delivery: 'unconfirmed',
      error_category: null,
      submitted_at: null,
      delivered_at: null,
    }
    this.cases.set(DEPOSIT_CASE_ID, queued)
    const unknown = baseCase(FIXTURE_UNKNOWN_CASE_ID, 4, 'complaint', 'Kendi')
    unknown.latest_reply = {
      reply_id: unknownReplyId,
      state: 'unknown',
      updated_at: minutesAgo(3),
      delivery: 'unconfirmed',
      error_category: 'provider_unavailable',
      submitted_at: null,
      delivered_at: null,
    }
    this.cases.set(FIXTURE_UNKNOWN_CASE_ID, unknown)
    this.replies.clear()
    this.replies.set(QUEUED_REPLY_ID, {
      reply_id: QUEUED_REPLY_ID,
      case_id: DEPOSIT_CASE_ID,
      state: 'queued',
      delivery: 'unconfirmed',
      error_category: null,
      created_at: minutesAgo(2),
      updated_at: minutesAgo(1),
      submitted_at: null,
      delivered_at: null,
      failed_at: null,
    })
    this.replies.set(unknownReplyId, {
      reply_id: unknownReplyId,
      case_id: FIXTURE_UNKNOWN_CASE_ID,
      state: 'unknown',
      delivery: 'unconfirmed',
      error_category: 'provider_unavailable',
      created_at: minutesAgo(4),
      updated_at: minutesAgo(3),
      submitted_at: null,
      delivered_at: null,
      failed_at: null,
    })
    this.replyPolls.clear()
    this.drafts.clear()
    this.consumedDrafts.clear()
    this.supersededDrafts.clear()
    this.idempotency.clear()
  }

  async exchangePairing(_code: string, _deviceLabel: string): Promise<SessionData> {
    throw new ApiError('demo_pairing_disabled', 400, 'Development fixtures do not create a live session.')
  }

  async revokeCurrentSession(): Promise<void> {
    // Fixture mode has no bearer session to revoke.
  }

  async getInbox(): Promise<InboxData> {
    const items = fixtureItems
      .filter((item) => this.cases.get(item.case_id)?.status === 'open')
      .map((item) => ({ ...item, version: this.cases.get(item.case_id)?.version ?? item.version }))
    return { items, open_count: items.length, has_more: false, next_cursor: null }
  }

  async getCase(caseId: string): Promise<CaseData> {
    const item = this.cases.get(caseId)
    if (!item) throw new ApiError('case_not_found', 404, 'Synthetic case not found.')
    return { ...item, context: [...item.context], latest_reply: item.latest_reply ? { ...item.latest_reply } : null }
  }

  async getCaseStatus(caseId: string): Promise<CaseStatusData> {
    const item = this.cases.get(caseId)
    if (!item) throw new ApiError('case_not_found', 404, 'Synthetic case not found.')
    return {
      case_id: item.case_id,
      status: item.status,
      version: item.version,
      latest_reply: item.latest_reply
        ? { reply_id: item.latest_reply.reply_id, state: item.latest_reply.state, updated_at: item.latest_reply.updated_at }
        : null,
      case_updated_at: item.context.at(-1)?.created_at ?? new Date().toISOString(),
    }
  }

  async transcribeAudio(_pcm: Uint8Array): Promise<TranscriptionData> {
    throw new ApiError('transcription_disabled', 503, 'Live transcription is disabled in development fixtures.')
  }

  async createDraft(caseId: string, expectedVersion: number, key: string): Promise<DraftData> {
    return this.once(`draft:${caseId}`, key, { expectedVersion }, async () => {
      const current = await this.requireCurrentCase(caseId, expectedVersion)
      const draft: DraftData = {
        draft_id: crypto.randomUUID(),
        based_on_version: current.version,
        text: 'Thanks for checking. I’m confirming today’s availability and will get back to you shortly.',
        source: 'ai',
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }
      this.drafts.set(draft.draft_id, draft)
      return draft
    })
  }

  async createManualDraft(caseId: string, expectedVersion: number, text: string, key: string): Promise<DraftData> {
    return this.once(`manual:${caseId}`, key, { expectedVersion, text }, async () => {
      const current = await this.requireCurrentCase(caseId, expectedVersion)
      const draft: DraftData = {
        draft_id: crypto.randomUUID(),
        based_on_version: current.version,
        text,
        source: 'owner',
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }
      this.drafts.set(draft.draft_id, draft)
      return draft
    })
  }

  async reviseDraft(caseId: string, draftId: string, expectedVersion: number, instruction: string, key: string): Promise<DraftData> {
    return this.once(`revise:${caseId}:${draftId}`, key, { expectedVersion, instruction }, async () => {
      const previous = this.drafts.get(draftId)
      if (!previous || previous.source !== 'ai' || this.consumedDrafts.has(draftId) || this.supersededDrafts.has(draftId)) {
        throw new ApiError('draft_not_found', 404, 'Synthetic draft not found.')
      }
      const current = await this.requireCurrentCase(caseId, expectedVersion)
      const hasRequestedTime = /\b(5|five|17:00)\b/i.test(instruction)
      const text = hasRequestedTime
        ? 'I’m checking the current walk-in availability before confirming a time. I’ll update you shortly.'
        : 'Thanks for your message. I’m checking the details and will update you shortly.'
      const draft: DraftData = {
        draft_id: crypto.randomUUID(),
        based_on_version: current.version,
        text,
        source: 'ai',
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }
      this.drafts.set(draft.draft_id, draft)
      this.supersededDrafts.add(draftId)
      return draft
    })
  }

  async approveReply(caseId: string, expectedVersion: number, draftId: string, text: string, key: string): Promise<ReplyResult> {
    return this.once(`approve:${caseId}`, key, { expectedVersion, draftId, text }, async () => {
      const current = await this.requireCurrentCase(caseId, expectedVersion)
      if (current.latest_reply && ['queued', 'sending', 'unknown'].includes(current.latest_reply.state)) {
        throw new ApiError('unresolved_reply_exists', 409, 'A synthetic reply is unresolved.')
      }
      const draft = this.drafts.get(draftId)
      if (!draft || draft.based_on_version !== expectedVersion) throw new ApiError('draft_not_found', 404, 'Synthetic draft not found.')
      if (this.consumedDrafts.has(draftId)) throw new ApiError('draft_consumed', 409, 'Synthetic draft already used.')
      if (this.supersededDrafts.has(draftId)) throw new ApiError('draft_superseded', 409, 'Synthetic draft replaced.')
      if (Date.parse(draft.expires_at) <= Date.now()) throw new ApiError('draft_expired', 409, 'Synthetic draft expired.')
      const now = new Date().toISOString()
      const replyId = crypto.randomUUID()
      const response: ReplyResult = { reply_id: replyId, state: 'queued', case_version: expectedVersion + 1 }
      const reply: ReplyData = {
        reply_id: replyId,
        case_id: caseId,
        state: 'queued',
        delivery: 'unconfirmed',
        error_category: null,
        created_at: now,
        updated_at: now,
        submitted_at: null,
        delivered_at: null,
        failed_at: null,
      }
      this.replies.set(replyId, reply)
      this.replyPolls.set(replyId, 0)
      this.consumedDrafts.add(draftId)
      current.version = response.case_version
      current.latest_reply = {
        reply_id: replyId,
        state: 'queued',
        updated_at: now,
        delivery: 'unconfirmed',
        error_category: null,
        submitted_at: null,
        delivered_at: null,
      }
      return response
    })
  }

  async getReply(replyId: string): Promise<ReplyData> {
    const reply = this.replies.get(replyId)
    if (!reply) throw new ApiError('reply_not_found', 404, 'Synthetic reply not found.')
    const polls = (this.replyPolls.get(replyId) ?? 0) + 1
    this.replyPolls.set(replyId, polls)
    if (reply.state === 'queued' && polls === 1) {
      reply.state = 'sending'
    } else if (reply.state === 'sending' && polls >= 2) {
      reply.state = 'submitted'
      reply.submitted_at = new Date().toISOString()
    }
    reply.updated_at = new Date().toISOString()
    const current = this.cases.get(reply.case_id)
    if (current?.latest_reply?.reply_id === reply.reply_id) {
      current.latest_reply = { ...current.latest_reply, state: reply.state, updated_at: reply.updated_at }
    }
    return { ...reply }
  }

  async resolveCase(caseId: string, body: ResolveRequest): Promise<ResolveResult> {
    const current = this.cases.get(caseId)
    if (!current) throw new ApiError('case_not_found', 404, 'Synthetic case not found.')
    if (current.status === 'resolved') {
      return {
        case_id: caseId,
        status: 'resolved',
        resolved_at: null,
        version: current.version,
        unknown_reply_acknowledged: body.acknowledge_unknown_reply,
        cancelled_reply_ids: [],
      }
    }
    if (current.version !== body.expected_version) throw new ApiError('stale_case_version', 409, 'Synthetic case changed.')
    const latest = current.latest_reply
    if (latest?.state === 'sending') throw new ApiError('reply_still_sending', 409, 'Synthetic reply is still sending.')
    if (latest?.state === 'unknown' && !body.acknowledge_unknown_reply) {
      throw new ApiError('unknown_reply_requires_acknowledgement', 409, 'Explicit acknowledgement required.')
    }
    const cancelled = latest?.state === 'queued' ? [latest.reply_id] : []
    if (latest && cancelled.length) {
      latest.state = 'cancelled'
      const row = this.replies.get(latest.reply_id)
      if (row) row.state = 'cancelled'
    }
    current.status = 'resolved'
    current.version += 1
    return {
      case_id: caseId,
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      version: current.version,
      unknown_reply_acknowledged: body.acknowledge_unknown_reply,
      cancelled_reply_ids: cancelled,
    }
  }

  replyStateLabel(state: ReplyData['state'], channel: string): string {
    return presentReplyState(state, channel).label
  }

  private async requireCurrentCase(caseId: string, version: number): Promise<CaseData> {
    const current = this.cases.get(caseId)
    if (!current) throw new ApiError('case_not_found', 404, 'Synthetic case not found.')
    if (current.status !== 'open' || current.version !== version) throw new ApiError('stale_case_version', 409, 'Synthetic case changed.')
    return current
  }

  private async once<T>(scope: string, key: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const id = `${scope}:${key}`
    const encoded = JSON.stringify(payload)
    const previous = this.idempotency.get(id)
    if (previous) {
      if (previous.payload !== encoded) throw new ApiError('idempotency_conflict', 409, 'Synthetic idempotency conflict.')
      return previous.result as T
    }
    const result = await operation()
    this.idempotency.set(id, { payload: encoded, result })
    return result
  }
}
