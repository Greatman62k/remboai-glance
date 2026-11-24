import {
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { AppStateView } from './state-view.ts'
import { categoryLabel, CONTEXT_PAGE_SIZE, messagePage, presentReplyState } from './workflow.ts'
import { canUseTranscriptAsInstruction } from './voice-intents.ts'

export type GlassesScreenId =
  | 'pair' | 'inbox' | 'case' | 'draft' | 'voice-ready' | 'voice-recording'
  | 'transcript-preview' | 'reply-status' | 'case-resolved' | 'resolve' | 'loading'

export interface GlassesState extends AppStateView {
  manualMode: boolean
  voicePhase: 'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing' | 'transcript_ready' | 'error'
  voiceDurationMs: number
  voiceTranscriptionDurationMs: number | null
  voiceTranscript: string
  voiceSimulation: boolean
  voiceError: string
  glassesAvailable: boolean
  glassesStatus: string
  busyAction: string
  acknowledgedUnknown: boolean
}

export interface GlassesPage {
  screen: GlassesScreenId
  layoutKey: string
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  menuObject?: MenuContainerProperty
}

const SAFE_X = 24
const SAFE_WIDTH = 528
const LINE_CHARS = 52
const REVIEW_LINES = 5
export const APPROVAL_LINES_PER_PAGE = 3

export const G2_MENU = {
  inboxOpen: 1,
  aiDraft: 10,
  voiceReply: 11,
  replyStatus: 12,
  resolve: 13,
  inbox: 14,
  draftReview: 20,
  draftVoice: 21,
  draftCase: 22,
  draftSafeCopy: 23,
  voiceStart: 30,
  voiceStop: 31,
  voiceCancel: 32,
  transcriptReply: 33,
  transcriptInstruction: 34,
  approvalPrevious: 40,
  approvalNext: 41,
  approvalConfirm: 42,
  approvalCancel: 43,
  approvalStatus: 44,
  approvalRetry: 45,
  statusCheck: 50,
  statusResolve: 51,
  statusCase: 52,
  reasonHandled: 60,
  reasonUpdated: 61,
  reasonNoAction: 62,
  reasonOther: 63,
  resolveAcknowledge: 64,
  resolveConfirm: 65,
  resolveCancel: 66,
} as const

function firmwareText(value: string): string {
  return value.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u25cf]/g, '*')
    .replace(/[^\x20-\x7e\n]/g, '?')
}

/** Returns the exact ASCII string the native G2 display can show without glyph substitution. */
export function glassesReviewCopy(value: string): string {
  return firmwareText(value)
}

export function needsGlassesReviewCopy(value: string): boolean {
  return glassesReviewCopy(value) !== value
}

export function canCreateDisplaySafeCopy(value: string): boolean {
  const copy = glassesReviewCopy(value)
  return copy !== value && [...copy].length <= 700
}

export function hasUncertainApproval(state: Pick<GlassesState, 'errorCode' | 'busy'>): boolean {
  return !state.busy && ['network_error', 'request_timeout', 'request_in_progress'].includes(state.errorCode ?? '')
}

export function wrapGlassesPreview(value: string, maxLines = 3, lineChars = LINE_CHARS): string {
  const normalized = firmwareText(value).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const width = Math.max(4, lineChars)
  const lines: string[] = []
  let remaining = normalized
  while (remaining && lines.length < maxLines) {
    if (remaining.length <= width) {
      lines.push(remaining)
      remaining = ''
      break
    }
    let splitAt = remaining.lastIndexOf(' ', width)
    if (splitAt < 1) splitAt = width
    lines.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining && lines.length) {
    const last = lines.length - 1
    lines[last] = `${lines[last].slice(0, width - 3).trimEnd()}...`
  }
  return lines.join('\n')
}

/** Wraps every character in order; the returned pages are the text shown for exact review. */
export function paginateGlassesText(value: string, lineChars = LINE_CHARS, linesPerPage = REVIEW_LINES): string[] {
  const source = value.replace(/\r\n?/g, '\n')
  const lines: string[] = []
  for (const paragraph of source.split('\n')) {
    let rest = paragraph
    if (!rest) { lines.push(''); continue }
    while (rest.length > lineChars) {
      let splitAt = rest.lastIndexOf(' ', lineChars)
      if (splitAt < 1) splitAt = lineChars
      lines.push(rest.slice(0, splitAt))
      rest = rest.slice(splitAt).replace(/^ /, '')
    }
    lines.push(rest)
  }
  const pages: string[] = []
  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage).join('\n'))
  }
  return pages.length ? pages : ['']
}

/** Keep approval content to three wrapped lines so labels and progress fit the native canvas. */
export function paginateGlassesApprovalText(value: string): string[] {
  return paginateGlassesText(value, LINE_CHARS, APPROVAL_LINES_PER_PAGE)
}

function compactLine(value: string, limit = 64): string {
  const text = firmwareText(value).replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

function finalWordSuffix(value: string, limit: number): string {
  const words = value.replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean)
  const suffix: string[] = []
  let length = 0
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const nextLength = length + words[index].length + (suffix.length ? 1 : 0)
    if (nextLength > limit) break
    suffix.unshift(words[index])
    length = nextLength
  }
  return `${suffix.length < words.length ? '... ' : ''}${suffix.join(' ')}`
}

type MenuEntry = readonly [number, string]

function menuObject(entries: readonly MenuEntry[]): MenuContainerProperty | undefined {
  if (!entries.length) return undefined
  return new MenuContainerProperty({
    menuItems: entries.map(([itemID, itemName]) => new MenuItemProperty({ itemID, itemName })),
  })
}

function textContainer(
  id: number,
  name: string,
  y: number,
  height: number,
  content: string,
  options: { capture?: boolean; textColor?: number; borderWidth?: number; borderColor?: number; paddingLength?: number } = {},
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: SAFE_X,
    yPosition: y,
    width: SAFE_WIDTH,
    height,
    containerID: id,
    containerName: name,
    isEventCapture: options.capture ? 1 : 0,
    content: firmwareText(content),
    textColor: options.textColor ?? 4,
    ...(options.borderWidth === undefined ? {} : { borderWidth: options.borderWidth }),
    ...(options.borderColor === undefined ? {} : { borderColor: options.borderColor }),
    ...(options.paddingLength === undefined ? {} : { paddingLength: options.paddingLength }),
  })
}

function pageWithText(
  screen: GlassesScreenId,
  header: string,
  body: string,
  footer: string,
  options: { recording?: boolean; menu?: readonly MenuEntry[]; key?: string } = {},
): GlassesPage {
  const textObject = [
    textContainer(1, 'g2-head', 12, 34, header, { textColor: 3 }),
    textContainer(2, 'g2-main', 54, 174, body, {
      capture: true,
      textColor: 4,
      borderWidth: options.recording ? 2 : 1,
      borderColor: options.recording ? 12 : 8,
      paddingLength: 10,
    }),
    textContainer(3, 'g2-foot', 244, 32, footer, { textColor: 2 }),
  ]
  const menu = menuObject(options.menu ?? [])
  return {
    screen,
    layoutKey: `text${options.recording ? '-recording' : ''}${options.key ? `-${options.key}` : ''}`,
    containerTotalNum: textObject.length,
    textObject,
    ...(menu ? { menuObject: menu } : {}),
  }
}

function pageWithList(header: string, items: string[], summary: string, menu: readonly MenuEntry[]): GlassesPage {
  const textObject = [
    textContainer(1, 'g2-head', 12, 34, header, { textColor: 3 }),
    textContainer(3, 'g2-foot', 218, 58, summary, { textColor: 4, borderWidth: 1, borderColor: 8, paddingLength: 7 }),
  ]
  const list = new ListContainerProperty({
    xPosition: SAFE_X,
    yPosition: 52,
    width: SAFE_WIDTH,
    height: 158,
    containerID: 2,
    containerName: 'g2-list',
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: SAFE_WIDTH - 12,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
  })
  return {
    screen: 'inbox',
    layoutKey: 'list',
    containerTotalNum: textObject.length + 1,
    textObject,
    listObject: [list],
    menuObject: menuObject(menu),
  }
}

function ageLabel(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return 'NOW'
  if (minutes < 60) return `${minutes}M`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}H`
  return `${Math.floor(minutes / 1_440)}D`
}

function appHeader(state: GlassesState, label: string): string {
  const attention = state.error ? '  |  ACTION NEEDED' : state.connection === 'offline' ? '  |  OFFLINE' : ''
  return `${state.fixtureMode ? 'GLANCE DEMO' : 'REMBOAI / GLANCE'}  |  ${label}${attention}`
}

function inboxPage(state: GlassesState): GlassesPage {
  const items = (state.inbox?.items ?? []).slice(0, 20)
  const selectedIndex = items.length ? Math.min(Math.max(0, state.selectedIndex), items.length - 1) : 0
  const selected = items[selectedIndex]
  const count = state.inbox?.open_count ?? 0
  const stateLabel = state.inboxStale ? 'STALE' : state.connection === 'offline' ? 'OFFLINE' :
    state.connection === 'loading' ? 'SYNC' : state.newCaseAvailable ? 'NEW CASE' : 'OPEN'
  const header = appHeader(state, `${count} ${stateLabel}`)
  if (items.length) {
    const rows = items.map((item) => compactLine(
      `${item.customer_label}  |  ${item.channel.toUpperCase()}  |  ${categoryLabel(item.category).toUpperCase()}  |  ${ageLabel(item.created_at)}`,
      64,
    ))
    const summary = selected
      ? `${compactLine(`${selected.customer_label.toUpperCase()}  ${selectedIndex + 1}/${items.length}  TAP TO OPEN${state.inbox?.has_more ? '  |  MORE CASES' : ''}`, 64)}\n${compactLine(selected.preview, 64)}`
      : 'NO CASE SELECTED'
    return pageWithList(header, rows, summary, [[G2_MENU.inboxOpen, 'Open selected case']])
  }
  const body = state.connection === 'loading'
    ? 'CHECKING OPEN ESCALATIONS\nYOUR INBOX WILL UPDATE WHEN READY'
    : state.connection === 'offline'
      ? 'GLANCE IS ACTIVE\nINBOX CONNECTION UNAVAILABLE\nSHOWING NO NEW DATA'
      : 'GLANCE IS ACTIVE\nNO OPEN ESCALATIONS\nYOU ARE ALL CAUGHT UP'
  return pageWithText('inbox', header, body, state.inboxStale ? 'CACHED VIEW  |  SWIPE TO RETRY' : 'DOUBLE TAP TO EXIT', {
    menu: [[G2_MENU.inboxOpen, 'Refresh inbox']], key: 'home',
  })
}

const CASE_ACTIONS = ['AI SUGGESTION', 'VOICE REPLY', 'REPLY STATUS', 'RESOLVE', 'INBOX']

function casePage(state: GlassesState): GlassesPage {
  const item = state.caseData
  if (!item) return pageWithText('loading', appHeader(state, 'CASE'), 'LOADING CASE DETAILS', 'PLEASE WAIT')
  if (item.status === 'resolved') {
    const actions = item.latest_reply ? ['CHECK REPLY STATUS', 'BACK TO INBOX'] : ['BACK TO INBOX']
    const selected = Math.min(state.focusedAction, actions.length - 1)
    const action = actions[selected]
    return pageWithText(
      'case-resolved', appHeader(state, 'RESOLVED'),
      `${compactLine(item.customer_label.toUpperCase(), 42)}\nOWNER CONFIRMED\nHANDLING COMPLETE\n${item.latest_reply ? `REPLY  ${presentReplyState(item.latest_reply.state, item.channel).label.toUpperCase()}` : 'NO OUTBOUND REPLY'}`,
      `ACTION  ${selected + 1}/${actions.length}  > ${action}  |  DOUBLE SELECT`,
      { menu: item.latest_reply ? [[G2_MENU.replyStatus, 'Check reply status'], [G2_MENU.inbox, 'Back to inbox']] : [[G2_MENU.inbox, 'Back to inbox']] },
    )
  }

  const pageCount = Math.ceil(item.context.length / CONTEXT_PAGE_SIZE)
  const pageIndex = pageCount > 0 ? Math.min(Math.max(0, Math.floor(state.messagePage) || 0), pageCount - 1) : 0
  const chronologicalPage = pageCount > 0 ? pageCount - 1 - pageIndex : 0
  const visible = messagePage(item.context, chronologicalPage, CONTEXT_PAGE_SIZE)
  const context = visible.map((message) => {
    const actor = message.actor === 'customer' ? 'CUSTOMER' : message.actor === 'assistant' ? 'REMBOAI' : 'OWNER'
    return `${actor}: ${wrapGlassesPreview(message.text, 2, 43)}`
  }).join('\n')
  const history = pageIndex === pageCount - 1 && item.has_earlier ? 'EARLIER HISTORY OMITTED' : ''
  const action = CASE_ACTIONS[Math.min(state.focusedAction, CASE_ACTIONS.length - 1)]
  const body = [
    `${compactLine(item.customer_label.toUpperCase(), 34)}  |  OPEN  |  V${item.version}`,
    `${categoryLabel(item.category).toUpperCase()}  |  ${item.channel.toUpperCase()}`,
    pageCount ? `MSG ${pageIndex + 1}/${pageCount}  |  ${item.context.length} VISIBLE` : 'MSG 0/0',
    context || 'NO CUSTOMER-VISIBLE MESSAGES',
    history,
    state.stale ? 'CASE UPDATED  |  REFRESH BEFORE ACTING' : '',
  ].filter(Boolean).join('\n')
  const menu: MenuEntry[] = [
    [G2_MENU.aiDraft, 'Generate AI suggestion'],
    [G2_MENU.voiceReply, 'Dictate a reply'],
    [G2_MENU.replyStatus, 'Check reply status'],
    [G2_MENU.resolve, 'Resolve case'],
    [G2_MENU.inbox, 'Back to inbox'],
  ]
  const footer = state.busy
    ? `WORKING  |  ${state.busyAction.replaceAll('-', ' ').toUpperCase()}`
    : `ACTION  ${Math.min(state.focusedAction, CASE_ACTIONS.length - 1) + 1}/${CASE_ACTIONS.length}  > ${action}  |  SWIPE MSG`
  return pageWithText('case', appHeader(state, 'CASE'), body, footer, { menu })
}

const DRAFT_ACTIONS = ['REVIEW EXACT REPLY', 'DICTATE REVISION', 'BACK TO CASE']

function draftPage(state: GlassesState): GlassesPage {
  const text = state.editorText || state.draft?.text || ''
  const canCreateSafeCopy = Boolean(text && canCreateDisplaySafeCopy(text))
  const actions = canCreateSafeCopy ? [...DRAFT_ACTIONS, 'CREATE ASCII COPY'] : DRAFT_ACTIONS
  const pages = paginateGlassesText(text)
  const pageIndex = Math.min(Math.max(0, Math.floor(state.draftPage) || 0), pages.length - 1)
  const expired = Boolean(state.draft && Date.parse(state.draft.expires_at) <= Date.now())
  const source = state.draft?.source === 'owner' || state.manualMode ? 'OWNER DRAFT' : 'AI SUGGESTION'
  const safeCopyTooLong = Boolean(text && needsGlassesReviewCopy(text) && !canCreateSafeCopy)
  const selected = actions[Math.min(state.focusedAction, actions.length - 1)]
  const body = text
    ? `${state.stale ? 'CASE CHANGED  |  DRAFT STALE\n' : ''}${expired ? 'DRAFT EXPIRED\n' : ''}${pages[pageIndex]}\n\n${pageIndex + 1}/${pages.length}  |  ${source}  |  NOT SENT${safeCopyTooLong ? '\nDISPLAY COPY EXCEEDS 700 CHARS' : ''}`
    : `${source}\nNO TEXT SAVED\nUSE VOICE INPUT TO DICTATE A CUSTOMER REPLY`
  return pageWithText('draft', appHeader(state, `${source} · ${pageIndex + 1}/${pages.length}`), body,
    `ACTION  ${Math.min(state.focusedAction, actions.length - 1) + 1}/${actions.length}  > ${selected}  |  SWIPE TEXT`, {
      menu: [
        [G2_MENU.draftReview, 'Review exact reply'],
        [G2_MENU.draftVoice, 'Dictate revision'],
        [G2_MENU.draftCase, 'Back to case'],
        ...(canCreateSafeCopy ? [[G2_MENU.draftSafeCopy, 'Create display-safe copy'] as const] : []),
      ], key: `draft-${Boolean(state.stale)}-${expired}`,
    })
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.min(40, Math.max(0, Math.floor(milliseconds / 1_000)))
  return `00:${String(seconds).padStart(2, '0')}`
}

function voicePage(state: GlassesState): GlassesPage {
  const phase = state.voicePhase
  if (phase === 'transcript_ready') {
    const pages = paginateGlassesText(state.voiceTranscript, 46, 3)
    const page = Math.min(Math.max(0, Math.floor(state.transcriptPage) || 0), pages.length - 1)
    const canRevise = Boolean(state.caseData && state.draft && canUseTranscriptAsInstruction(
      state.caseData, state.draft, state.stale, state.editorText, state.voiceTranscript,
    ))
    const actions = ['USE AS REPLY', canRevise ? 'USE AS INSTRUCTION' : 'AI DRAFT NEEDED', 'CANCEL']
    const selected = Math.min(state.focusedAction, actions.length - 1)
    const body = `${state.voiceSimulation ? 'SIMULATED TRANSCRIPT\n' : ''}NOT SENT  |  ${page + 1}/${pages.length}\n${pages[page]}\n\nCAPTURE ${formatDuration(state.voiceDurationMs)}  |  TRANSCRIBED`
    const intentBody = canRevise ? body : `${body}\nAI DRAFT NEEDED BEFORE REVISION`
    const menu: MenuEntry[] = [
      [G2_MENU.transcriptReply, 'Use as reply'],
      [G2_MENU.transcriptInstruction, canRevise ? 'Use as instruction' : 'AI draft required'],
      [G2_MENU.voiceCancel, 'Cancel transcript'],
    ]
    return pageWithText('transcript-preview', appHeader(state, 'TRANSCRIPT'), intentBody,
      `ACTION  ${selected + 1}/3  > ${actions[selected]}  |  DOUBLE SELECT`, { menu, key: canRevise ? 'transcript-ai' : 'transcript-manual' })
  }
  if (phase === 'recording') {
    const selected = Math.min(state.focusedAction, 1)
    const action = selected === 0 ? 'STOP AND REVIEW' : 'CANCEL'
    return pageWithText('voice-recording', appHeader(state, 'VOICE INPUT'),
      `${state.voiceSimulation ? 'SIMULATION  |  MIC OFF' : 'RECORDING  |  G2 MIC ACTIVE'}\nELAPSED  ${formatDuration(state.voiceDurationMs)} / 00:40\n${state.voiceSimulation ? 'NO AUDIO BUFFERED' : 'AUDIO IN MEMORY ONLY'}\n\n${action}`,
      `ACTION  ${selected + 1}/2  > ${action}  |  ${selected === 0 ? 'CANCEL' : 'STOP'}`, {
        recording: true,
        menu: [[G2_MENU.voiceStop, 'Stop and review'], [G2_MENU.voiceCancel, 'Cancel recording']],
      })
  }
  if (phase === 'starting' || phase === 'stopping' || phase === 'transcribing') {
    const label = phase === 'starting' ? 'STARTING G2 MICROPHONE' : phase === 'stopping' ? 'STOPPING MICROPHONE' : 'TRANSCRIBING AUDIO'
    return pageWithText('voice-ready', appHeader(state, 'VOICE INPUT'),
      `${label}\n\nWAIT FOR CONFIRMATION\nAUDIO IS NOT SAVED`, 'NO ACTION UNTIL COMPLETE', { key: phase })
  }
  if (phase === 'error') {
    const selected = Math.min(state.focusedAction, 1)
    const action = selected === 0 ? 'RETRY' : 'BACK TO CASE'
    return pageWithText('voice-ready', appHeader(state, 'VOICE STOPPED'),
      `MICROPHONE OFF\n${wrapGlassesPreview(state.voiceError || 'VOICE INPUT STOPPED', 3, 44)}\n\n${action}`,
      `ACTION  ${selected + 1}/2  |  DOUBLE SELECT`, {
        menu: [[G2_MENU.voiceStart, 'Start again'], [G2_MENU.voiceCancel, 'Back to case']],
      })
  }
  const selected = Math.min(state.focusedAction, 1)
  return pageWithText('voice-ready', appHeader(state, 'VOICE INPUT'),
    `${state.voiceSimulation ? 'SIMULATION ONLY\n' : ''}MICROPHONE OFF\nSTART WHEN READY\nMAXIMUM 40 SECONDS\n\n${selected === 0 ? '> START  |  BACK' : 'START  |  > BACK'}`,
    'CLICK TO CHOOSE  |  DOUBLE SELECT', {
      menu: [[G2_MENU.voiceStart, 'Start recording'], [G2_MENU.voiceCancel, 'Back to case']],
    })
}

const APPROVAL_ACTIONS = ['APPROVE & QUEUE', 'CANCEL']

function approvalPage(state: GlassesState): GlassesPage {
  if (state.approvalStage === 'confirm') {
    const selected = Math.min(state.focusedAction, 1)
    const draft = state.draft
    const waiting = state.busy && state.busyAction === 'approve'
    const uncertain = hasUncertainApproval(state)
    const asciiSafe = /^[\x20-\x7e\n]+$/.test(state.approvalText)
    const canApprove = Boolean(draft && state.caseData?.status === 'open' && !state.stale && asciiSafe &&
      Date.parse(draft.expires_at) > Date.now() && draft.based_on_version === state.caseData.version)
    const options: MenuEntry[] = waiting ? [] : uncertain
      ? [[G2_MENU.approvalStatus, 'Check reply status'], [G2_MENU.approvalRetry, 'Retry same approval key'], [G2_MENU.approvalCancel, 'Leave review']]
      : canApprove
      ? [[G2_MENU.approvalConfirm, 'Approve and queue'], [G2_MENU.approvalCancel, 'Cancel review']]
      : [[G2_MENU.approvalCancel, 'Cancel review']]
    const actions = waiting ? ['WAIT FOR RESULT'] : uncertain
      ? ['CHECK STATUS', 'RETRY SAME KEY', 'LEAVE REVIEW']
      : canApprove ? APPROVAL_ACTIONS : ['CANCEL']
    const visibleSelected = Math.min(Math.max(0, selected), actions.length - 1)
    const pages = paginateGlassesApprovalText(state.approvalText)
    const tail = finalWordSuffix(pages.at(-1) ?? '', 58)
    const warning = !asciiSafe ? 'UNSUPPORTED DISPLAY CHARACTERS\nREPHRASE BEFORE APPROVAL' :
      state.stale || !draft || !state.caseData || draft.based_on_version !== state.caseData.version ? 'CASE OR DRAFT CHANGED\nREFRESH BEFORE APPROVAL' :
        draft && Date.parse(draft.expires_at) <= Date.now() ? 'DRAFT EXPIRED\nCREATE A NEW DRAFT' : ''
    const outcome = waiting ? 'APPROVAL REQUEST IN FLIGHT' : uncertain
      ? state.errorCode === 'request_in_progress' ? 'REQUEST STILL PROCESSING' : 'OUTCOME UNCERTAIN | CHECK STATUS'
      : 'NOT SENT'
    const errorDetail = uncertain ? `\n${compactLine(state.error.toUpperCase(), 44)}` : ''
    return pageWithText('draft', appHeader(state, 'FINAL CONFIRMATION'),
      `${warning ? `${warning}\n` : ''}REVIEWED ${pages.length}/${pages.length} PAGES\nFINAL WORDS: ${wrapGlassesPreview(tail, 2, 46)}\n${outcome}${errorDetail}`,
      waiting ? 'WAIT FOR BACKEND RESULT' : `ACTION  ${visibleSelected + 1}/${actions.length}  > ${actions[visibleSelected]}  |  DOUBLE SELECT`, {
        menu: options, key: 'approval-confirm',
      })
  }

  const pages = paginateGlassesApprovalText(state.approvalText)
  const page = Math.min(Math.max(0, Math.floor(state.approvalPage) || 0), pages.length - 1)
  const reviewedPages = Math.min(pages.length, Math.max(0, Math.floor(state.approvalProgress) || 0))
  const body = `${state.stale ? 'CASE CHANGED  |  STOP REVIEW\n' : ''}REPLY ${page + 1}/${pages.length}  |  EXACT FINAL TEXT\n${pages[page]}\n\nPROGRESS ${reviewedPages}/${pages.length} PAGES COMPLETE`
  return pageWithText('draft', appHeader(state, `EXACT REPLY ${page + 1}/${pages.length}`), body,
    page + 1 < pages.length ? 'SWIPE DOWN TO CONTINUE REVIEW' : 'SWIPE DOWN FOR FINAL CONFIRMATION', {
      menu: [
        ...(page > 0 ? [[G2_MENU.approvalPrevious, 'Previous text page'] as const] : []),
        ...(page + 1 < pages.length ? [[G2_MENU.approvalNext, 'Next text page'] as const] : []),
        [G2_MENU.approvalCancel, 'Cancel review'],
      ], key: `approval-review-${pages.length}`,
    })
}

function replyPage(state: GlassesState): GlassesPage {
  const item = state.caseData
  const reply = state.reply
  if (!reply || !item) return pageWithText('reply-status', appHeader(state, 'REPLY STATUS'),
    'CHECKING REPLY STATUS\n\nNO DELIVERY CLAIM IS MADE', 'WAIT FOR BACKEND STATUS')
  const presentation = presentReplyState(reply.state, item.channel)
  const label: Record<string, string> = {
    queued: 'QUEUED\nWAITING FOR DISPATCH\nNOT SENT YET',
    sending: 'SENDING\nPROVIDER REQUEST IN PROGRESS',
    submitted: `SUBMITTED TO ${item.channel.toUpperCase()}\nDELIVERY NOT CONFIRMED`,
    delivered: 'DELIVERY RECEIPT CONFIRMED',
    failed: 'FAILED TO SEND',
    unknown: 'STATUS UNCERTAIN\nCUSTOMER MAY HAVE RECEIVED IT\nDO NOT RETRY',
    cancelled: 'CANCELLED BEFORE DISPATCH\nNOT SENT',
  }
  const statusLabel = item.channel === 'telegram' && reply.state === 'delivered'
    ? 'DELIVERY UNVERIFIABLE\nTELEGRAM RECEIPTS NOT SUPPORTED'
    : label[reply.state]
  const actions = ['CHECK STATUS', 'RESOLVE CASE', 'BACK TO CASE']
  const selected = Math.min(state.focusedAction, actions.length - 1)
  return pageWithText('reply-status', appHeader(state, 'REPLY OUTCOME'),
    `${statusLabel}\n\n${wrapGlassesPreview(presentation.detail.toUpperCase(), 2, 48)}\nCASE ${item.version}  |  ${reply.reply_id.slice(0, 8).toUpperCase()}`,
    `ACTION  ${selected + 1}/${actions.length}  > ${actions[selected]}  |  DOUBLE SELECT`, {
      menu: [[G2_MENU.statusCheck, 'Check status'], [G2_MENU.statusResolve, 'Resolve case'], [G2_MENU.statusCase, 'Back to case']],
    })
}

const RESOLVE_REASONS = [
  ['handled_in_person', 'HANDLED IN PERSON', G2_MENU.reasonHandled],
  ['customer_updated', 'CUSTOMER UPDATED', G2_MENU.reasonUpdated],
  ['no_action_needed', 'NO ACTION NEEDED', G2_MENU.reasonNoAction],
  ['other', 'OTHER', G2_MENU.reasonOther],
] as const

function resolvePage(state: GlassesState): GlassesPage {
  const item = state.caseData
  if (!item) return pageWithText('resolve', appHeader(state, 'RESOLVE'), 'NO CASE SELECTED', 'BACK TO CASE')
  const reasonIndex = Math.max(0, RESOLVE_REASONS.findIndex(([value]) => value === state.resolveReason))
  const unknown = item.latest_reply?.state === 'unknown'
  const actions = unknown && !state.acknowledgedUnknown
    ? ['ACKNOWLEDGE UNCERTAINTY', 'CANCEL']
    : ['CONFIRM RESOLVE', 'CANCEL']
  const selected = Math.min(state.focusedAction, actions.length - 1)
  const warning = unknown
    ? `UNKNOWN REPLY\nCUSTOMER MAY OR MAY NOT HAVE RECEIVED IT${state.acknowledgedUnknown ? '\nACKNOWLEDGED' : ''}`
    : item.latest_reply?.state === 'queued'
      ? 'QUEUED REPLY WILL BE CANCELLED\nIT WILL NOT BE SENT'
      : item.latest_reply?.state === 'sending'
        ? 'REPLY IS SENDING\nRESOLUTION WILL BE REJECTED'
        : ''
  const menu: MenuEntry[] = RESOLVE_REASONS.map(([, label, id]) => [id, label])
  if (unknown && !state.acknowledgedUnknown) menu.push([G2_MENU.resolveAcknowledge, 'Acknowledge uncertainty'])
  else menu.push([G2_MENU.resolveConfirm, 'Confirm resolution'])
  menu.push([G2_MENU.resolveCancel, 'Cancel'])
  return pageWithText('resolve', appHeader(state, 'RESOLVE CASE'),
    `${compactLine(item.customer_label.toUpperCase(), 40)}  |  V${item.version}\nREASON ${reasonIndex + 1}/4\n${RESOLVE_REASONS[reasonIndex][1]}${warning ? `\n\n${warning}` : ''}`,
    `ACTION  ${selected + 1}/${actions.length}  > ${actions[selected]}  |  SWIPE REASON`, { menu })
}

export function buildGlassesPage(state: GlassesState): GlassesPage {
  if (state.screen === 'pair') return pageWithText('pair', appHeader(state, 'PAIR'),
    'OWNER SESSION REQUIRED\n\nPAIR THIS DEVICE WITH TELEGRAM\nON THE COMPANION APP', 'PAIRING IS NOT AVAILABLE HERE')
  if (state.screen === 'inbox') return inboxPage(state)
  if (state.screen === 'case') return casePage(state)
  if (state.screen === 'voice') return voicePage(state)
  if (state.screen === 'draft') return draftPage(state)
  if (state.screen === 'approval') return approvalPage(state)
  if (state.screen === 'status') return replyPage(state)
  if (state.screen === 'resolve') return resolvePage(state)
  return pageWithText('loading', appHeader(state, 'GLANCE'), 'LOADING', 'PLEASE WAIT')
}

export function glassesPageText(page: GlassesPage): string {
  const text = page.textObject.map((container) => container.content ?? '')
  const lists = (page.listObject ?? []).flatMap((container) => container.itemContainer?.itemName ?? [])
  return [...text, ...lists].filter(Boolean).join('\n')
}

export function glassesPageToPayload(page: GlassesPage): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  menuObject?: MenuContainerProperty
} {
  return {
    containerTotalNum: page.containerTotalNum,
    textObject: page.textObject,
    ...(page.listObject ? { listObject: page.listObject } : {}),
    ...(page.menuObject ? { menuObject: page.menuObject } : {}),
  }
}

export function glassesPagesHaveSameLayout(left: GlassesPage, right: GlassesPage): boolean {
  if (left.layoutKey !== right.layoutKey) return false
  if (JSON.stringify(left.menuObject?.menuItems ?? []) !== JSON.stringify(right.menuObject?.menuItems ?? [])) return false
  if (left.layoutKey !== 'list') return true
  const leftItems = left.listObject?.[0]?.itemContainer?.itemName ?? []
  const rightItems = right.listObject?.[0]?.itemContainer?.itemName ?? []
  return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index])
}
