import type { SessionData } from './types.ts'

export const SESSION_STORAGE_KEY = 'remboai-glance.session.v1'
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const DEVICE_LABEL = 'RemboAI Glance G2'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface StoredSession extends SessionData {}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '')
}

export function isValidPairingCode(value: string): boolean {
  const normalized = normalizePairingCode(value)
  return normalized.length === 12 && [...normalized].every((char) => PAIRING_ALPHABET.includes(char))
}

export class SessionStore {
  private readonly storage: StorageLike | null
  private readonly now: () => number

  constructor(
    storage: StorageLike | null = browserStorage(),
    now: () => number = Date.now,
  ) {
    this.storage = storage
    this.now = now
  }

  load(): StoredSession | null {
    if (!this.storage) return null
    try {
      const raw = this.storage.getItem(SESSION_STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<StoredSession>
      if (
        typeof parsed.access_token !== 'string' ||
        !parsed.access_token ||
        typeof parsed.expires_at !== 'string' ||
        !Number.isFinite(Date.parse(parsed.expires_at)) ||
        !parsed.salon ||
        typeof parsed.salon.name !== 'string'
      ) {
        this.clear()
        return null
      }
      if (Date.parse(parsed.expires_at) <= this.now()) {
        this.clear()
        return null
      }
      return parsed as StoredSession
    } catch {
      this.clear()
      return null
    }
  }

  assertCanPersist(): void {
    if (!this.storage) throw new Error('Browser storage is unavailable. Pairing cannot be saved on this device.')
    const probe = `${SESSION_STORAGE_KEY}.probe`
    try {
      this.storage.setItem(probe, '1')
      this.storage.removeItem(probe)
    } catch {
      throw new Error('Browser storage is unavailable. Pairing cannot be saved on this device.')
    }
  }

  save(session: SessionData): void {
    if (!session.access_token || !Number.isFinite(Date.parse(session.expires_at))) {
      throw new Error('The backend returned an invalid session.')
    }
    if (!this.storage) throw new Error('Browser storage is unavailable. Pairing cannot be saved on this device.')
    this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  }

  clear(): void {
    this.storage?.removeItem(SESSION_STORAGE_KEY)
  }
}
