import type { CaseData, InboxItem, ReplyState } from './types.ts'
import type { StorageLike } from './session.ts'

export const PENDING_IDEMPOTENCY_STORAGE_KEY = 'remboai-glance.pending-actions.v1'
// One customer-visible event per G2 page leaves room for wrapped text and the
// case/version labels without clipping the oldest-history indicator.
export const CONTEXT_PAGE_SIZE = 1

function browserLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function sortInboxOldestFirst(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((left, right) => {
    const byTime = Date.parse(left.created_at) - Date.parse(right.created_at)
    return Number.isFinite(byTime) && byTime !== 0
      ? byTime
      : left.case_id.localeCompare(right.case_id)
  })
}

export function moreCaseCount(openCount: number, visibleCount: number): number {
  return Math.max(0, openCount - visibleCount)
}

export function caseIsStale(current: CaseData, serverVersion: number): boolean {
  return current.version !== serverVersion
}

export function normalizeOwnerText(value: string, maxLength: number): string {
  const text = value.normalize('NFC').trim()
  if (!text || [...text].length > maxLength) throw new Error(`Text must contain 1 to ${maxLength} characters.`)
  if ([...text].some((char) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(char))) {
    throw new Error('Text contains a control character that cannot be sent.')
  }
  return text
}

export function createUuidV4(cryptoSource: Crypto = globalThis.crypto): string {
  if (typeof cryptoSource.randomUUID === 'function') return cryptoSource.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoSource.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class IdempotencyKeyBook {
  private readonly pending = new Map<string, { key: string; payload: string }>()
  private readonly storage: StorageLike | null
  private readonly storageKey: string

  constructor(storage: StorageLike | null = browserLocalStorage(), storageKey = PENDING_IDEMPOTENCY_STORAGE_KEY) {
    this.storage = storage
    this.storageKey = storageKey
    this.restore()
  }

  acquire(scope: string, payload: unknown, makeKey: () => string = () => createUuidV4()): string {
    const canonicalPayload = JSON.stringify(payload)
    const existing = this.pending.get(scope)
    if (existing) {
      if (existing.payload !== canonicalPayload) {
        throw new Error('An earlier request has an uncertain outcome. Retry that exact request before changing it.')
      }
      return existing.key
    }
    const key = makeKey()
    this.pending.set(scope, { key, payload: canonicalPayload })
    this.persist()
    return key
  }

  complete(scope: string): void {
    this.pending.delete(scope)
    this.persist()
  }

  clear(): void {
    this.pending.clear()
    try {
      this.storage?.removeItem(this.storageKey)
    } catch {
      // The in-memory keys are still cleared if browser storage is unavailable.
    }
  }

  has(scope: string): boolean {
    return this.pending.has(scope)
  }

  get(scope: string): { key: string; payload: unknown } | null {
    const value = this.pending.get(scope)
    if (!value) return null
    try { return { key: value.key, payload: JSON.parse(value.payload) as unknown } }
    catch { return null }
  }

  entries(): Array<{ scope: string; key: string; payload: unknown }> {
    return [...this.pending].flatMap(([scope, value]) => {
      try { return [{ scope, key: value.key, payload: JSON.parse(value.payload) as unknown }] }
      catch { return [] }
    })
  }

  private restore(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(this.storageKey)
      if (!raw) return
      const entries = JSON.parse(raw) as unknown
      if (!Array.isArray(entries)) throw new Error('Invalid pending action store')
      for (const entry of entries) {
        if (
          entry && typeof entry === 'object' &&
          typeof entry.scope === 'string' && typeof entry.key === 'string' &&
          typeof entry.payload === 'string'
        ) {
          this.pending.set(entry.scope, { key: entry.key, payload: entry.payload })
        }
      }
    } catch {
      try { this.storage.removeItem(this.storageKey) } catch { /* ignore unavailable storage */ }
    }
  }

  private persist(): void {
    if (!this.storage) return
    try {
      const entries = [...this.pending].map(([scope, value]) => ({ scope, ...value }))
      if (entries.length) this.storage.setItem(this.storageKey, JSON.stringify(entries))
      else this.storage.removeItem(this.storageKey)
    } catch {
      // Requests can still retry in this app instance when tab storage is unavailable.
    }
  }
}

export interface ReplyPresentation {
  label: string
  detail: string
  terminal: boolean
}

export function presentReplyState(state: ReplyState, channel: string): ReplyPresentation {
  switch (state) {
    case 'queued': return { label: 'Queued', detail: 'Waiting for dispatch.', terminal: false }
    case 'sending': return { label: 'Sending', detail: 'The provider call is in progress.', terminal: false }
    case 'submitted':
      return channel === 'telegram'
        ? { label: 'Sent to Telegram — delivery not confirmed', detail: 'Telegram accepted the message; it provides no delivery receipt.', terminal: true }
        : { label: 'Sent — delivery not confirmed', detail: 'The provider accepted the message; no receipt has arrived.', terminal: true }
    case 'delivered':
      return channel === 'telegram'
        ? { label: 'Sent to Telegram — delivery not confirmed', detail: 'Telegram delivery receipts are unsupported.', terminal: true }
        : { label: 'Delivered — receipt confirmed', detail: 'A delivery receipt was confirmed.', terminal: true }
    case 'failed': return { label: 'Failed to send', detail: 'The provider rejected or could not send the reply.', terminal: true }
    case 'unknown': return { label: 'Status uncertain — check before retrying', detail: 'The customer may already have received this reply. Glance will not resend it automatically.', terminal: true }
    case 'cancelled': return { label: 'Cancelled — not sent', detail: 'The queued reply was cancelled before dispatch.', terminal: true }
  }
}

export function replyPollDelay(index: number): number {
  return [1_000, 2_000, 4_000, 8_000, 15_000][Math.min(index, 4)]
}

export function shouldPollReply(state: ReplyState): boolean {
  return state === 'queued' || state === 'sending'
}

export function relativeAge(isoTime: string, now = Date.now()): string {
  const timestamp = Date.parse(isoTime)
  if (!Number.isFinite(timestamp)) return 'time unavailable'
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m waiting`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h waiting`
  return `${Math.floor(hours / 24)}d waiting`
}

export function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    human_request: 'Owner request',
    complaint: 'Complaint',
    deposit: 'Deposit question',
    payment_dispute: 'Payment question',
    emergency: 'Urgent request',
    legal: 'Sensitive request',
    medical: 'Sensitive request',
    harassment: 'Sensitive request',
    privacy: 'Privacy request',
  }
  return labels[category] ?? 'Needs owner'
}

export function summarizeCase(caseData: CaseData): string {
  const message = [...caseData.context].reverse().find((item) => item.actor === 'customer')
  if (!message) return 'A customer request needs your attention.'
  const normalized = message.text.replace(/\s+/g, ' ').trim()
  return normalized.length > 150 ? `${normalized.slice(0, 147).trimEnd()}…` : normalized
}

export function messagePage<T>(items: readonly T[], page: number, pageSize = CONTEXT_PAGE_SIZE): T[] {
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(Math.max(0, page), pages - 1)
  return items.slice(safePage * pageSize, (safePage + 1) * pageSize)
}
