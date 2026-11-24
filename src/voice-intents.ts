import type { GlanceApi } from './client.ts'
import type { CaseData, DraftData } from './types.ts'

export type VoiceIntent = 'reply' | 'instruction'

export function canUseTranscriptAsInstruction(
  caseData: CaseData | null,
  draft: DraftData | null,
  stale: boolean,
  editorText: string,
  transcript: string,
  now = Date.now(),
): boolean {
  if (!caseData || caseData.status !== 'open' || !draft || draft.source !== 'ai' || stale) return false
  if (draft.based_on_version !== caseData.version || Date.parse(draft.expires_at) <= now) return false
  if (editorText !== draft.text) return false
  const length = [...transcript.trim()].length
  return length > 0 && length <= 300 && !/[\u0000-\u001f\u007f]/.test(transcript)
}

/** An explicit owner choice creates an owner-authored draft; it never approves or sends. */
export function useTranscriptAsReply(
  api: GlanceApi,
  caseId: string,
  expectedVersion: number,
  transcript: string,
  idempotencyKey: string,
): Promise<DraftData> {
  return api.createManualDraft(caseId, expectedVersion, transcript, idempotencyKey)
}

/** An explicit owner choice revises the supplied current AI draft; it never sends. */
export function useTranscriptAsInstruction(
  api: GlanceApi,
  caseId: string,
  draftId: string,
  expectedVersion: number,
  transcript: string,
  idempotencyKey: string,
): Promise<DraftData> {
  return api.reviseDraft(caseId, draftId, expectedVersion, transcript, idempotencyKey)
}
