import {
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { AppStateView } from './state-view.ts'
import { categoryLabel, presentReplyState, relativeAge } from './workflow.ts'

export type GlassesScreenId =
  | 'pair'
  | 'inbox'
  | 'case'
  | 'draft'
  | 'voice-ready'
  | 'voice-recording'
  | 'transcript-preview'
  | 'reply-status'
  | 'case-resolved'
  | 'resolve'
  | 'loading'

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
}

export interface GlassesPage {
  screen: GlassesScreenId
  layoutKey: 'text' | 'text-recording' | 'list'
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
}

const CANVAS_WIDTH = 576
const SAFE_X = 24
const SAFE_WIDTH = CANVAS_WIDTH - SAFE_X * 2
const MAIN_LINE_CHARS = 48

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

export function wrapGlassesPreview(value: string, maxLines = 3, lineChars = MAIN_LINE_CHARS): string {
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

function compactLine(value: string, limit = 64): string {
  const text = firmwareText(value).replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
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

function pageWithText(screen: GlassesScreenId, header: string, body: string, footer: string, recording = false): GlassesPage {
  const textObject = [
    textContainer(1, 'g2-head', 14, 30, header, { textColor: 3 }),
    textContainer(2, 'g2-main', 60, 166, body, {
      capture: true,
      textColor: 4,
      borderWidth: recording ? 2 : 1,
      borderColor: recording ? 12 : 8,
      paddingLength: 10,
    }),
    textContainer(3, 'g2-foot', 248, 28, footer, { textColor: 2 }),
  ]
  return {
    screen,
    layoutKey: recording ? 'text-recording' : 'text',
    containerTotalNum: textObject.length,
    textObject,
  }
}

function pageWithList(header: string, items: string[], footer: string): GlassesPage {
  const textObject = [
    textContainer(1, 'g2-head', 14, 30, header, { textColor: 3 }),
    textContainer(3, 'g2-foot', 248, 28, footer, { textColor: 2 }),
  ]
  const list = new ListContainerProperty({
    xPosition: SAFE_X,
    yPosition: 58,
    width: SAFE_WIDTH,
    height: 174,
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
  }
}

function currentCustomerMessage(state: GlassesState): string {
  const item = state.caseData
  if (!item) return 'A customer request needs your attention.'
  return [...item.context].reverse().find((message) => message.actor === 'customer')?.text
    ?? 'A customer request needs your attention.'
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.min(40, Math.max(0, Math.floor(milliseconds / 1_000)))
  return `00:${String(seconds).padStart(2, '0')}`
}

function appHeader(state: GlassesState, label: string): string {
  const brand = state.fixtureMode ? 'GLANCE DEMO' : 'REMBOAI / GLANCE'
  return `${brand}  |  ${label}`
}

function inboxPage(state: GlassesState): GlassesPage {
  const items = state.inbox?.items ?? []
  const header = appHeader(state, state.inboxStale ? 'INBOX STALE' : 'INBOX')
  if (items.length) {
    const names = items.slice(0, 20).map((item) => compactLine(
      `${item.customer_label}  |  ${categoryLabel(item.category).toUpperCase()}`,
      64,
    ))
    return pageWithList(header, names, 'SCROLL TO SELECT  |  DOUBLE TAP OPEN')
  }

  const body = state.connection === 'loading'
    ? 'CHECKING OPEN CASES\n\nYOUR INBOX IS LOADING'
    : state.connection === 'offline'
      ? 'INBOX UNAVAILABLE\n\nRECONNECT FROM THE PAIRED PHONE'
      : 'NO OPEN CASES\n\nYOU ARE ALL CAUGHT UP'
  return pageWithText('inbox', header, body, 'OPEN CASES APPEAR HERE')
}

function casePage(state: GlassesState): GlassesPage {
  const item = state.caseData
  if (!item) return pageWithText('loading', appHeader(state, 'CASE'), 'LOADING CASE DETAILS', 'PLEASE WAIT')
  if (item.status === 'resolved') {
    const actions = item.latest_reply ? ['CHECK REPLY STATUS', 'BACK TO INBOX'] : ['BACK TO INBOX']
    const selected = state.focusedAction % actions.length
    const actionText = actions.length === 2
      ? (selected === 0 ? '> CHECK REPLY STATUS  |  BACK TO INBOX' : 'CHECK REPLY STATUS  |  > BACK TO INBOX')
      : '> BACK TO INBOX'
    return pageWithText(
      'case-resolved',
      appHeader(state, 'CASE RESOLVED'),
      `${item.customer_label.toUpperCase()}\nOWNER CONFIRMED\nHANDLING COMPLETE\n${item.latest_reply ? `REPLY: ${presentReplyState(item.latest_reply.state, item.channel).label.toUpperCase()}\n` : ''}${actionText}`,
      'CLICK NEXT ACTION  |  DOUBLE TAP OPEN',
    )
  }

  const channel = item.channel === 'telegram' ? 'TELEGRAM' : 'WHATSAPP'
  const customer = compactLine(item.customer_label.toUpperCase(), 40)
  const category = compactLine(categoryLabel(item.category).toUpperCase(), 40)
  const message = wrapGlassesPreview(currentCustomerMessage(state), 2, 46)
  const actions = ['GENERATE AI DRAFT', 'WRITE REPLY ON PHONE', 'VOICE INPUT', 'CHECK REPLY STATUS', 'RESOLVE CASE', 'BACK TO INBOX']
  const selected = actions[state.focusedAction % actions.length]
  const age = item.context.length ? relativeAge(item.context.at(-1)!.created_at).toUpperCase() : ''
  const body = [
    `${customer}  |  OPEN`,
    `${category}  |  ${channel}`,
    age ? `UPDATED  ${firmwareText(age)}` : '',
    'LATEST CUSTOMER MESSAGE',
    `"${message}"`,
    state.stale ? 'CONTEXT MAY BE STALE' : '',
    `ACTION  > ${selected}`,
  ].filter(Boolean).join('\n')
  return pageWithText('case', appHeader(state, 'CASE DETAIL'), body, 'CLICK NEXT ACTION  |  DOUBLE TAP OPEN')
}

function draftPage(state: GlassesState, exactApproval = false): GlassesPage {
  if (exactApproval) {
    return pageWithText(
      'draft',
      appHeader(state, 'DRAFT REVIEW'),
      'EXACT CUSTOMER TEXT\n\nOPEN THE PHONE TO REVIEW\nAND APPROVE\n\nNOT QUEUED',
      'PHONE CONTROLS EXACT APPROVAL',
    )
  }

  const source = state.fixtureMode
    ? 'SYNTHETIC DRAFT'
    : state.draft?.source === 'owner' || state.manualMode ? 'OWNER DRAFT' : 'AI DRAFT'
  const preview = state.editorText || state.draft?.text || ''
  const body = [
    `${source}  |  NOT SENT`,
    preview ? `"${wrapGlassesPreview(preview, 3, 46)}"` : 'WRITE THE COMPLETE REPLY\nON THE PAIRED PHONE',
    'FULL TEXT AND APPROVAL ON PHONE',
    state.focusedAction % 2 === 0 ? '> PHONE REVIEW  |  BACK TO CASE' : 'PHONE REVIEW  |  > BACK TO CASE',
  ].join('\n')
  return pageWithText('draft', appHeader(state, 'DRAFT PREVIEW'), body, 'CLICK TO CHOOSE  |  DOUBLE TAP SELECT')
}

function voicePage(state: GlassesState): GlassesPage {
  const phase = state.voicePhase
  if (phase === 'transcript_ready') {
    const preview = wrapGlassesPreview(state.voiceTranscript, 3, 46)
    return pageWithText(
      'transcript-preview',
      appHeader(state, 'TRANSCRIPT READY'),
      `${state.voiceSimulation ? 'SIMULATION  |  NO ASR\n' : ''}TRANSCRIPT  |  NOT SENT\n"${preview}"\nFULL TRANSCRIPT ON PHONE`,
      'PHONE: CHOOSE REPLY OR INSTRUCTION',
    )
  }
  if (phase === 'recording') {
    const indicator = state.voiceSimulation ? 'SIMULATION  |  MIC OFF' : 'RECORDING  |  MIC ACTIVE'
    const bufferStatus = state.voiceSimulation ? 'NO AUDIO CAPTURED' : 'AUDIO BUFFERED IN MEMORY'
    const action = state.focusedAction === 0
      ? '> STOP AND REVIEW  |  CANCEL'
      : 'STOP AND REVIEW  |  > CANCEL'
    return pageWithText(
      'voice-recording',
      appHeader(state, 'VOICE INPUT'),
      `${indicator}\n${formatDuration(state.voiceDurationMs)}  /  00:40\n${bufferStatus}\n${action}`,
      'CLICK TO CHOOSE  |  DOUBLE TAP SELECT',
      true,
    )
  }
  if (phase === 'error') {
    return pageWithText(
      'voice-ready',
      appHeader(state, 'VOICE INPUT'),
      `CAPTURE STOPPED\n\n${wrapGlassesPreview(state.voiceError || 'NO AUDIO RETAINED', 2)}`,
      'RETURN TO CASE TO RECORD AGAIN',
    )
  }
  if (phase === 'starting' || phase === 'stopping' || phase === 'transcribing') {
    const label = phase === 'starting' ? 'MICROPHONE STARTING' : phase === 'stopping' ? 'MICROPHONE STOPPING' : 'TRANSCRIBING'
    return pageWithText(
      'voice-ready',
      appHeader(state, 'VOICE INPUT'),
      `${label}\n\nMICROPHONE OFF\n\nAUDIO IS NOT SAVED`,
      'PLEASE WAIT',
    )
  }
  const actions = ['START RECORDING', 'BACK TO CASE']
  const action = state.focusedAction % actions.length === 0
    ? `> ${actions[0]}  |  ${actions[1]}`
    : `${actions[0]}  |  > ${actions[1]}`
  return pageWithText(
    'voice-ready',
    appHeader(state, 'VOICE INPUT'),
    `MICROPHONE OFF\nREADY WHEN YOU ARE\nMAX 40 SECONDS\n${action}`,
    'CLICK TO CHOOSE  |  DOUBLE TAP SELECT',
  )
}

function replyPage(state: GlassesState): GlassesPage {
  const item = state.caseData
  const reply = state.reply
  if (!reply || !item) {
    return pageWithText('reply-status', appHeader(state, 'REPLY STATUS'), 'CHECKING REPLY STATUS', 'DELIVERY IS NOT CONFIRMED')
  }
  const presentation = presentReplyState(reply.state, item.channel)
  let status: string
  switch (reply.state) {
    case 'queued': status = 'OUTBOX: QUEUED\nWAITING FOR DISPATCH\nDELIVERY NOT CONFIRMED'; break
    case 'sending': status = 'OUTBOX: SENDING\nPROVIDER REQUEST IN PROGRESS\nDELIVERY NOT CONFIRMED'; break
    case 'submitted': status = `SUBMITTED TO ${item.channel.toUpperCase()}\nDELIVERY NOT CONFIRMED`; break
    case 'delivered': status = wrapGlassesPreview(presentation.label.toUpperCase(), 2); break
    case 'failed': status = 'REPLY FAILED TO SEND'; break
    case 'unknown': status = 'STATUS UNCERTAIN\nTHE CUSTOMER MAY HAVE RECEIVED IT\nDO NOT RETRY AUTOMATICALLY'; break
    case 'cancelled': status = 'CANCELLED BEFORE DISPATCH\nNOT SENT'; break
  }
  const detail = ['delivered', 'failed', 'cancelled'].includes(reply.state)
    ? wrapGlassesPreview(presentation.detail.toUpperCase(), 1)
    : ''
  const actions = ['CHECK STATUS', 'RESOLVE CASE', 'BACK TO INBOX']
  const action = actions[state.focusedAction % actions.length]
  return pageWithText(
    'reply-status',
    appHeader(state, 'REPLY STATUS'),
    `${status}${detail ? `\n${detail}` : ''}\nACTION  > ${action}`,
    'CLICK NEXT ACTION  |  DOUBLE TAP OPEN',
  )
}

function resolvePage(state: GlassesState): GlassesPage {
  const item = state.caseData
  if (!item) return pageWithText('resolve', appHeader(state, 'RESOLVE CASE'), 'NO CASE SELECTED', 'BACK TO INBOX')
  const reason = state.resolveReason.replaceAll('_', ' ').toUpperCase()
  const warning = item.latest_reply?.state === 'unknown'
    ? 'STATUS UNCERTAIN\nACKNOWLEDGEMENT REQUIRED'
    : item.latest_reply?.state === 'queued'
      ? 'QUEUED REPLY CANCELS BEFORE RESOLVE'
      : item.latest_reply?.state === 'sending'
        ? 'REPLY SENDING  |  WAIT BEFORE RESOLVE'
        : ''
  const action = state.focusedAction === 0 ? '> RESOLVE CASE' : '> CANCEL'
  return pageWithText(
    'resolve',
    appHeader(state, 'RESOLVE CASE'),
    `${item.customer_label.toUpperCase()}  |  OPEN\nREASON  ${reason}${warning ? `\n\n${warning}` : ''}\n\n${action}`,
    'OWNER ACTION REQUIRED  |  DOUBLE TAP SELECT',
  )
}

export function buildGlassesPage(state: GlassesState): GlassesPage {
  if (state.screen === 'pair') {
    return pageWithText(
      'pair',
      appHeader(state, 'PAIRING'),
      'NOT PAIRED\n\nPAIR AND REVIEW ON PHONE\n\nNO CUSTOMER DATA SHOWN',
      'ONE-TIME PAIRING STAYS ON PHONE',
    )
  }
  if (state.screen === 'inbox') return inboxPage(state)
  if (state.screen === 'case') return casePage(state)
  if (state.screen === 'voice') return voicePage(state)
  if (state.screen === 'draft') return draftPage(state)
  if (state.screen === 'approval') return draftPage(state, true)
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
} {
  return {
    containerTotalNum: page.containerTotalNum,
    textObject: page.textObject,
    ...(page.listObject ? { listObject: page.listObject } : {}),
  }
}

export function glassesPagesHaveSameLayout(left: GlassesPage, right: GlassesPage): boolean {
  if (left.layoutKey !== right.layoutKey) return false
  if (left.layoutKey !== 'list') return true
  const leftItems = left.listObject?.[0]?.itemContainer?.itemName ?? []
  const rightItems = right.listObject?.[0]?.itemContainer?.itemName ?? []
  return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index])
}
