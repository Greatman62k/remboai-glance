import assert from 'node:assert/strict'
import test from 'node:test'
import type { GlanceApi } from '../src/client.ts'
import type { CaseData, DraftData } from '../src/types.ts'
import {
  canUseTranscriptAsInstruction,
  useTranscriptAsInstruction,
  useTranscriptAsReply,
} from '../src/voice-intents.ts'

const caseData: CaseData = {
  case_id: 'case-a',
  version: 7,
  status: 'open',
  category: 'human_request',
  channel: 'telegram',
  customer_label: 'Synthetic customer',
  latest_reply: null,
  has_earlier: false,
  context: [],
}

const aiDraft: DraftData = {
  draft_id: 'draft-a',
  based_on_version: 7,
  text: 'I will check and update you shortly.',
  source: 'ai',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
}

test('instruction eligibility requires a current, unexpired, unedited AI draft and at most 300 characters', () => {
  assert.equal(canUseTranscriptAsInstruction(caseData, aiDraft, false, aiDraft.text, 'Make it shorter.'), true)
  assert.equal(canUseTranscriptAsInstruction(caseData, null, false, '', 'Make it shorter.'), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, { ...aiDraft, source: 'owner' }, false, aiDraft.text, 'Shorten'), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, { ...aiDraft, based_on_version: 6 }, false, aiDraft.text, 'Shorten'), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, { ...aiDraft, expires_at: new Date(0).toISOString() }, false, aiDraft.text, 'Shorten'), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, aiDraft, true, aiDraft.text, 'Shorten'), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, aiDraft, false, 'Unsaved owner edit.', 'Shorten'), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, aiDraft, false, aiDraft.text, 'x'.repeat(301)), false)
  assert.equal(canUseTranscriptAsInstruction(caseData, aiDraft, false, aiDraft.text, 'bad\u0000instruction'), false)
})

test('explicit Use as reply calls only manual-draft API and never approval or send', async () => {
  const calls: string[] = []
  const api = {
    createManualDraft: async (...args: unknown[]) => {
      calls.push(`manual:${String(args[0])}:${String(args[3])}`)
      return { ...aiDraft, draft_id: 'owner-draft', source: 'owner' as const }
    },
    reviseDraft: async () => { calls.push('revise'); return aiDraft },
    approveReply: async () => { calls.push('approve'); return { reply_id: 'reply', state: 'queued' as const, case_version: 8 } },
  } as unknown as GlanceApi

  const result = await useTranscriptAsReply(api, caseData.case_id, caseData.version, 'I can help you shortly.', 'voice-reply-key')
  assert.equal(result.source, 'owner')
  assert.deepEqual(calls, ['manual:case-a:voice-reply-key'])
})

test('explicit Use as instruction calls only revision for the supplied draft', async () => {
  const calls: string[] = []
  const api = {
    createManualDraft: async () => { calls.push('manual'); return aiDraft },
    reviseDraft: async (...args: unknown[]) => {
      calls.push(`revise:${String(args[0])}:${String(args[1])}:${String(args[3])}`)
      return { ...aiDraft, draft_id: 'revised-draft' }
    },
    approveReply: async () => { calls.push('approve'); return { reply_id: 'reply', state: 'queued' as const, case_version: 8 } },
  } as unknown as GlanceApi

  const result = await useTranscriptAsInstruction(api, caseData.case_id, aiDraft.draft_id, caseData.version, 'Make it shorter.', 'voice-instruction-key')
  assert.equal(result.draft_id, 'revised-draft')
  assert.deepEqual(calls, ['revise:case-a:draft-a:Make it shorter.'])
})
