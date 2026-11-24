import type { StorageLike } from './session.ts'
import type { DraftData } from './types.ts'

export const WORKSPACE_STORAGE_KEY = 'remboai-glance.workspace.v1'
export type WorkspaceView = 'case' | 'draft' | 'status'

export interface WorkspaceSnapshot {
  case_id: string
  draft: DraftData | null
  view: WorkspaceView
}

function browserStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage }
  catch { return null }
}

/** Persists only what a cold WebView needs to resume an authorized case and persisted draft. */
export class WorkspaceStore {
  private readonly storage: StorageLike | null
  private readonly key: string

  constructor(storage: StorageLike | null = browserStorage(), key = WORKSPACE_STORAGE_KEY) {
    this.storage = storage
    this.key = key
  }

  load(): WorkspaceSnapshot | null {
    if (!this.storage) return null
    try {
      const value = JSON.parse(this.storage.getItem(this.key) ?? 'null') as Partial<WorkspaceSnapshot> | null
      if (!value || typeof value.case_id !== 'string' || !value.case_id ||
          !['case', 'draft', 'status'].includes(value.view ?? '')) return null
      let draft: DraftData | null = null
      if (value.draft && typeof value.draft === 'object') {
        const candidate = value.draft as DraftData
        if (typeof candidate.draft_id === 'string' && typeof candidate.text === 'string' &&
            typeof candidate.based_on_version === 'number' &&
            (candidate.source === 'ai' || candidate.source === 'owner') &&
            Number.isFinite(Date.parse(candidate.expires_at))) draft = candidate
      }
      return { case_id: value.case_id, draft, view: value.view as WorkspaceView }
    } catch {
      this.clear()
      return null
    }
  }

  save(caseId: string, draft: DraftData | null, view: WorkspaceView): void {
    if (!this.storage || !caseId) return
    const snapshot: WorkspaceSnapshot = { case_id: caseId, draft, view }
    try {
      const value = JSON.stringify(snapshot)
      if (this.storage.getItem(this.key) !== value) this.storage.setItem(this.key, value)
    } catch { /* The active workflow remains in memory if local storage is unavailable. */ }
  }

  clear(): void {
    try { this.storage?.removeItem(this.key) } catch { /* Ignore unavailable local storage. */ }
  }
}
