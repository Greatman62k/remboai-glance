import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceStore, WORKSPACE_STORAGE_KEY } from '../src/workspace.ts'
import type { DraftData } from '../src/types.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

test('cold resume persists the case and persisted draft but excludes context, audio and unselected transcripts', () => {
  const storage = new MemoryStorage()
  const workspace = new WorkspaceStore(storage)
  const draft: DraftData = {
    draft_id: 'draft-safe-id', based_on_version: 9, text: 'Owner-approved draft text is recoverable.', source: 'owner',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }
  workspace.save('case-safe-id', draft, 'draft')
  const raw = storage.getItem(WORKSPACE_STORAGE_KEY) ?? ''
  assert.match(raw, /case-safe-id/)
  assert.match(raw, /Owner-approved draft text is recoverable/)
  assert.doesNotMatch(raw, /private context event|unselected spoken transcript|audioPcm|Uint8Array/)
  assert.deepEqual(workspace.load(), { case_id: 'case-safe-id', draft, view: 'draft' })
})

test('workspace clears after leaving the case and rejects malformed snapshots', () => {
  const storage = new MemoryStorage()
  const workspace = new WorkspaceStore(storage)
  workspace.save('case-a', null, 'case')
  workspace.clear()
  assert.equal(workspace.load(), null)
  storage.setItem(WORKSPACE_STORAGE_KEY, '{broken')
  assert.equal(workspace.load(), null)
  assert.equal(storage.getItem(WORKSPACE_STORAGE_KEY), null)
})
