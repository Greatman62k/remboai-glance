import { SessionStore } from './session.ts'
import type {
  ApiEnvelope,
  ApiErrorEnvelope,
  CaseData,
  DraftData,
  InboxData,
  ReplyData,
  ReplyResult,
  ResolveRequest,
  ResolveResult,
  SessionData,
} from './types.ts'

export type FetchLike = typeof fetch

export interface RequestOptions {
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
  timeoutMs?: number
  authenticated?: boolean
}

export interface GlanceApi {
  exchangePairing(code: string, deviceLabel: string, signal?: AbortSignal): Promise<SessionData>
  revokeCurrentSession(signal?: AbortSignal): Promise<void>
  getInbox(signal?: AbortSignal): Promise<InboxData>
  getCase(caseId: string, signal?: AbortSignal): Promise<CaseData>
  createDraft(caseId: string, expectedVersion: number, key: string, signal?: AbortSignal): Promise<DraftData>
  createManualDraft(caseId: string, expectedVersion: number, text: string, key: string, signal?: AbortSignal): Promise<DraftData>
  reviseDraft(caseId: string, draftId: string, expectedVersion: number, instruction: string, key: string, signal?: AbortSignal): Promise<DraftData>
  approveReply(caseId: string, expectedVersion: number, draftId: string, text: string, key: string, signal?: AbortSignal): Promise<ReplyResult>
  getReply(replyId: string, signal?: AbortSignal): Promise<ReplyData>
  resolveCase(caseId: string, body: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult>
}

const ERROR_COPY: Record<string, string> = {
  invalid_pairing_code: 'That code is invalid, expired, or already used. Request a fresh code in Telegram.',
  rate_limited: 'Too many requests. Wait briefly, then try again.',
  invalid_session: 'Your session is no longer valid. Pair this device again.',
  session_expired: 'Your session expired. Pair this device again.',
  session_revoked: 'This device was revoked. Pair it again if you still have access.',
  owner_not_authorized: 'The owner no longer has access to this salon. Contact the owner or pair again.',
  case_not_found: 'This case is unavailable. Refresh the inbox.',
  reply_not_found: 'This reply is unavailable. Refresh the case.',
  stale_case_version: 'The case changed. Refresh its context before continuing.',
  draft_expired: 'This draft expired. Review the current case and save a new draft.',
  draft_consumed: 'This draft has already been approved.',
  draft_superseded: 'A newer draft replaced this one.',
  draft_rejected: 'The suggestion could not pass safety checks. Write a manual reply instead.',
  draft_timeout: 'The suggestion took too long. You can start a new attempt or write a reply manually.',
  instruction_conflicts_with_record: 'That instruction conflicts with a recorded business fact. Review the case and try a different instruction.',
  invalid_text: 'Check the text length and remove unsupported control characters.',
  invalid_request: 'The request could not be validated. Review the fields and try again.',
  idempotency_conflict: 'This action key was already used for different content. Do not submit a second reply.',
  request_in_progress: 'This action is still processing. Wait, then retry the same action.',
  unresolved_reply_exists: 'A reply is already queued or unresolved for this case. Inspect its status before taking another action.',
  multiple_unresolved_replies: 'The case has conflicting reply records and needs owner review.',
  reply_still_sending: 'The reply is still being submitted. Wait for its outcome before resolving.',
  unknown_reply_requires_acknowledgement: 'The customer may already have received this reply. Review the warning and acknowledge explicitly before resolving.',
  no_unknown_reply: 'There is no uncertain reply to acknowledge. Refresh the case.',
  owner_channel_required: 'Pairing and device revocation are managed through the authenticated Telegram owner channel.',
  not_found: 'This Glance route is currently unavailable.',
  draft_unavailable: 'Draft generation is temporarily unavailable. Your current draft is still available.',
  reply_unavailable: 'The reply was not confirmed. Check the case status before retrying.',
}

export class ApiError extends Error {
  readonly name = 'ApiError'
  readonly code: string
  readonly status: number
  readonly requestId: string | null
  readonly retryAfterSeconds: number | null
  readonly uncertain: boolean

  constructor(
    code: string,
    status: number,
    message: string,
    requestId: string | null = null,
    retryAfterSeconds: number | null = null,
    uncertain = false,
  ) {
    super(message)
    this.code = code
    this.status = status
    this.requestId = requestId
    this.retryAfterSeconds = retryAfterSeconds
    this.uncertain = uncertain
  }
}

export function userMessageForError(code: string): string {
  return ERROR_COPY[code] ?? 'The request could not be completed. Use the request ID if you need support.'
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : null
}

function requestIdFrom(body: ApiErrorEnvelope | null, header: string | null): string | null {
  const value = header || body?.request_id
  return typeof value === 'string' && value.length <= 100 ? value : null
}

export class GlanceApiClient {
  private readonly baseUrl: string
  private readonly sessions: SessionStore
  private readonly fetcher: FetchLike
  private readonly defaultTimeoutMs: number

  constructor(
    baseUrl: string,
    sessions: SessionStore,
    fetcher: FetchLike = fetch,
    defaultTimeoutMs = 8_000,
  ) {
    this.baseUrl = baseUrl
    this.sessions = sessions
    this.fetcher = fetcher
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  exchangePairing(code: string, deviceLabel: string, signal?: AbortSignal): Promise<SessionData> {
    return this.request<SessionData>('POST', '/pairing/exchange', {
      body: { code, device_label: deviceLabel },
      authenticated: false,
      signal,
    })
  }

  async revokeCurrentSession(signal?: AbortSignal): Promise<void> {
    await this.request<void>('DELETE', '/sessions/current', { signal })
    this.sessions.clear()
  }

  getInbox(signal?: AbortSignal): Promise<InboxData> {
    return this.request<InboxData>('GET', '/inbox?limit=20', { signal })
  }

  getCase(caseId: string, signal?: AbortSignal): Promise<CaseData> {
    return this.request<CaseData>(
      'GET',
      `/cases/${encodeURIComponent(caseId)}`,
      { signal },
    )
  }

  createDraft(caseId: string, expectedVersion: number, key: string, signal?: AbortSignal): Promise<DraftData> {
    return this.request<DraftData>('POST', `/cases/${encodeURIComponent(caseId)}/drafts`, {
      body: { expected_version: expectedVersion },
      idempotencyKey: key,
      timeoutMs: 15_000,
      signal,
    })
  }

  createManualDraft(caseId: string, expectedVersion: number, text: string, key: string, signal?: AbortSignal): Promise<DraftData> {
    return this.request<DraftData>('POST', `/cases/${encodeURIComponent(caseId)}/drafts/manual`, {
      body: { expected_version: expectedVersion, text },
      idempotencyKey: key,
      signal,
    })
  }

  reviseDraft(caseId: string, draftId: string, expectedVersion: number, instruction: string, key: string, signal?: AbortSignal): Promise<DraftData> {
    return this.request<DraftData>(
      'POST',
      `/cases/${encodeURIComponent(caseId)}/drafts/${encodeURIComponent(draftId)}/revise`,
      {
        body: { expected_version: expectedVersion, instruction },
        idempotencyKey: key,
        timeoutMs: 15_000,
        signal,
      },
    )
  }

  approveReply(caseId: string, expectedVersion: number, draftId: string, text: string, key: string, signal?: AbortSignal): Promise<ReplyResult> {
    return this.request<ReplyResult>('POST', `/cases/${encodeURIComponent(caseId)}/replies`, {
      body: { expected_version: expectedVersion, draft_id: draftId, text },
      idempotencyKey: key,
      signal,
    })
  }

  getReply(replyId: string, signal?: AbortSignal): Promise<ReplyData> {
    return this.request<ReplyData>('GET', `/replies/${encodeURIComponent(replyId)}`, { signal })
  }

  resolveCase(caseId: string, body: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult> {
    return this.request<ResolveResult>('POST', `/cases/${encodeURIComponent(caseId)}/resolve`, {
      body,
      signal,
    })
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const authenticated = options.authenticated !== false
    const session = authenticated ? this.sessions.load() : null
    if (authenticated && !session) {
      throw new ApiError('session_expired', 401, userMessageForError('session_expired'))
    }

    const headers = new Headers({ Accept: 'application/json' })
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey)
    if (session) headers.set('Authorization', `Bearer ${session.access_token}`)

    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortFromCaller = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      })
    } catch {
      if (timedOut) {
        throw new ApiError('request_timeout', 0, 'The request timed out. Check server state before repeating an action.', null, null, true)
      }
      if (options.signal?.aborted) {
        throw new ApiError('request_cancelled', 0, 'The request was cancelled.')
      }
      throw new ApiError('network_error', 0, 'Network unavailable. Your current view may be stale.', null, null, true)
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }

    const requestIdHeader = response.headers.get('X-Request-ID')
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
    let payload: ApiEnvelope<T> | ApiErrorEnvelope | null = null
    if (response.status !== 204) {
      try {
        payload = await response.json() as ApiEnvelope<T> | ApiErrorEnvelope
      } catch {
        payload = null
      }
    }

    if (!response.ok) {
      const errorPayload = payload as ApiErrorEnvelope | null
      const code = errorPayload?.error?.code || `http_${response.status}`
      if (authenticated && (response.status === 401 || response.status === 403)) this.sessions.clear()
      throw new ApiError(
        code,
        response.status,
        userMessageForError(code),
        requestIdFrom(errorPayload, requestIdHeader),
        retryAfter,
        response.status >= 500,
      )
    }
    if (response.status === 204) return undefined as T
    const envelope = payload as ApiEnvelope<T> | null
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      throw new ApiError('invalid_response', response.status, 'The server returned an unreadable response.', requestIdHeader)
    }
    return envelope.data
  }
}
