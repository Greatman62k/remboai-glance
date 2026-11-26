import {
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { AppStateView } from './state-view.ts'
import { caseAttentionLabel, caseAttentionTier, categoryLabel, channelLabel, CONTEXT_PAGE_SIZE, messagePage, presentReplyState } from './workflow.ts'
import { canUseTranscriptAsInstruction } from './voice-intents.ts'

export type GlassesScreenId =
  | 'pair' | 'inbox' | 'schedule' | 'case' | 'draft' | 'voice-ready' | 'voice-recording'
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
  /** Long-message chunk within the selected context event. */
  messageTextPage?: number
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
export const CHARS_PER_LINE = 52
export const HEADER_CHARS = 52
export const LIST_ROW_CHARS = 52
export const FOOT_LEFT_X = SAFE_X
export const FOOT_LEFT_WIDTH = 318
export const FOOT_LEFT_CHARS = 30
export const FOOT_RIGHT_X = 342
export const FOOT_RIGHT_WIDTH = 210
export const FOOT_RIGHT_CHARS = 20
export const REVIEW_LINES = 5
// Kept as an alias for the controller's existing display-pagination import.
export const BODY_LINES = REVIEW_LINES
export const APPROVAL_LINES_PER_PAGE = REVIEW_LINES
export const TEXT_HEADER = 3
export const TEXT_BODY = 4
export const TEXT_FOOTER = 2
export const BORDER_NORMAL = 8
export const BORDER_EMPHASIS = 12
// Keep custom UI marks to glyphs listed in Even's G2 design guidelines.
const G2_UI_GLYPHS = new Set('▲△▶▷▼▽◀◁●○■□★☆━─█▇▆▅▄▃▂▁')

const G2_MARK = {
  urgent: '!',
  sensitive: '☆',
  review: '○',
  selected: '▶',
  back: '◀',
  offline: '○',
  pending: '○',
  accepted: '●',
  customer: '●',
  assistant: '★',
  owner: '○',
  micOn: '●',
  micOff: '○',
  stop: '■',
  warning: '▲',
} as const

/**
 * Quick single-tap sending is intentionally disabled. Every reply still goes
 * through exact-text review and the separate final confirmation state.
 */
export const QUICK_TAP_ENABLED = false

export const G2_MENU = {
  inboxOpen: 1,
  scheduleToday: 2,
  schedulePrevious: 3,
  scheduleNext: 4,
  scheduleInbox: 5,
  aiDraft: 10,
  voiceReply: 11,
  replyStatus: 12,
  resolve: 13,
  inbox: 14,
  caseRefresh: 15,
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

function normalizedFirmwareText(value: string): string {
  return value.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
}

function firmwareText(value: string): string {
  return [...normalizedFirmwareText(value)].map((character) => {
    const code = character.codePointAt(0) ?? 0
    return character === '\n' || (code >= 0x20 && code <= 0x7e) || G2_UI_GLYPHS.has(character)
      ? character
      : '?'
  }).join('')
}

function asciiFirmwareText(value: string): string {
  return normalizedFirmwareText(value)
    .replace(/\u25cf/g, '*')
    .replace(/[^\x20-\x7e\n]/g, '?')
}

/** Returns the ASCII display copy used to check exact customer text for safe review. */
export function glassesReviewCopy(value: string): string {
  return asciiFirmwareText(value)
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

export function wrapGlassesPreview(value: string, maxLines = 3, lineChars = CHARS_PER_LINE): string {
  const normalized = asciiFirmwareText(value).replace(/\s+/g, ' ').trim()
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
export function paginateGlassesText(value: string, lineChars = CHARS_PER_LINE, linesPerPage = REVIEW_LINES): string[] {
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

/** Exact reply text gets the full body; page labels and progress stay in the footer. */
export function paginateGlassesApprovalText(value: string): string[] {
  return paginateGlassesText(value, CHARS_PER_LINE, APPROVAL_LINES_PER_PAGE)
}

export function paginateGlassesDisplayText(value: string, linesPerPage = REVIEW_LINES): string[] {
  return paginateGlassesText(asciiFirmwareText(value), CHARS_PER_LINE, linesPerPage)
}

export function fitDisplay(value: string, limit = CHARS_PER_LINE): string {
  const chars = [...firmwareText(value).replace(/\s+/g, ' ').trim()]
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, Math.max(0, limit - 3)).join('').trimEnd()}...`
}

export function actionFooter(index: number, total: number, label: string, hint = ''): string {
  const base = fitDisplay(`Action ${index + 1}/${total} > ${label}`)
  if (!hint) return base
  const withHint = `${base}  |  ${hint}`
  return [...firmwareText(withHint)].length <= CHARS_PER_LINE ? withHint : base
}

function compactLine(value: string, limit = CHARS_PER_LINE): string {
  const text = asciiFirmwareText(value).replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
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
  options: {
    capture?: boolean; textColor?: number; borderWidth?: number; borderColor?: number
    paddingLength?: number; x?: number; width?: number
  } = {},
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: options.x ?? SAFE_X,
    yPosition: y,
    width: options.width ?? SAFE_WIDTH,
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

function headerContainer(header: string): TextContainerProperty {
  return textContainer(1, 'g2-head', 12, 34, fitDisplay(header, HEADER_CHARS), { textColor: TEXT_HEADER })
}

function footerContainers(left: string, right: string, firstId = 3): TextContainerProperty[] {
  return [
    textContainer(firstId, 'g2-foot', 244, 32, fitDisplay(left, FOOT_LEFT_CHARS), {
      x: FOOT_LEFT_X, width: FOOT_LEFT_WIDTH, textColor: TEXT_FOOTER,
    }),
    textContainer(firstId + 1, 'g2-hint', 244, 32, fitDisplay(right, FOOT_RIGHT_CHARS), {
      x: FOOT_RIGHT_X, width: FOOT_RIGHT_WIDTH, textColor: TEXT_FOOTER,
    }),
  ]
}

/** Header + one body box + separately aligned status and gesture hint. */
function pageWithZones(
  screen: GlassesScreenId,
  header: string,
  body: string,
  footLeft: string,
  footRight: string,
  options: { recording?: boolean; emphasis?: boolean; menu?: readonly MenuEntry[]; key?: string } = {},
): GlassesPage {
  const textObject = [
    headerContainer(header),
    textContainer(2, 'g2-main', 54, 174, body, {
      capture: true,
      textColor: TEXT_BODY,
      borderWidth: options.recording || options.emphasis ? 2 : 1,
      borderColor: options.recording || options.emphasis ? BORDER_EMPHASIS : BORDER_NORMAL,
      paddingLength: 10,
    }),
    ...footerContainers(footLeft, footRight),
  ]
  const menu = menuObject(options.menu ?? [])
  return {
    screen,
    layoutKey: `text${options.recording ? '-recording' : ''}${options.emphasis ? '-emphasis' : ''}${options.key ? `-${options.key}` : ''}`,
    containerTotalNum: textObject.length,
    textObject,
    ...(menu ? { menuObject: menu } : {}),
  }
}

/** Compatibility helper for screens that still have a single footer label. */
function pageWithText(
  screen: GlassesScreenId,
  header: string,
  body: string,
  footer: string,
  options: { recording?: boolean; emphasis?: boolean; menu?: readonly MenuEntry[]; key?: string } = {},
): GlassesPage {
  return pageWithZones(screen, header, body, footer, '', options)
}

function pageWithList(
  screen: GlassesScreenId,
  header: string,
  items: string[],
  detail: string,
  footer: string,
  hint: string,
  menu: readonly MenuEntry[],
): GlassesPage {
  const textObject = [
    headerContainer(header),
    textContainer(3, 'g2-detail', 180, 60, detail, {
      textColor: TEXT_BODY, borderWidth: 1, borderColor: BORDER_NORMAL, paddingLength: 5,
    }),
    ...footerContainers(footer, hint, 4),
  ]
  const list = new ListContainerProperty({
    xPosition: SAFE_X,
    yPosition: 52,
    width: SAFE_WIDTH,
    height: 126,
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
    screen,
    layoutKey: screen === 'schedule' ? 'schedule-list' : 'inbox-list-detail',
    containerTotalNum: textObject.length + 1,
    textObject,
    listObject: [list],
    menuObject: menuObject(menu),
  }
}

function pageWithChoices(
  screen: GlassesScreenId,
  header: string,
  items: string[],
  footLeft: string,
  footRight: string,
  menu: readonly MenuEntry[],
  key: string,
  detail = '',
): GlassesPage {
  const textObject = [
    headerContainer(header),
    ...(detail ? [textContainer(5, 'g2-detail', 54, 44, detail, {
      textColor: TEXT_BODY, borderWidth: 1, borderColor: BORDER_NORMAL, paddingLength: 5,
    })] : []),
    ...footerContainers(footLeft, footRight),
  ]
  const builtMenu = menuObject(menu)
  const listTop = detail ? 104 : 54
  const listHeight = detail ? 124 : 174
  const list = new ListContainerProperty({
    xPosition: SAFE_X,
    yPosition: listTop,
    width: SAFE_WIDTH,
    height: listHeight,
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
    screen,
    layoutKey: `choices-${key}`,
    containerTotalNum: textObject.length + 1,
    textObject,
    listObject: [list],
    ...(builtMenu ? { menuObject: builtMenu } : {}),
  }
}

function ageLabel(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} hr`
  return `${Math.floor(minutes / 1_440)} d`
}

function inboxAgeLabel(iso: string): string {
  return ageLabel(iso).replace(' min', 'm').replace(' hr', 'h').replace(' d', 'd')
}

function appHeader(state: GlassesState, label: string, screenAlert = ''): string {
  const alert = screenAlert || (state.error ? 'Action needed' : state.connection === 'offline' ? 'Offline' : '')
  const mark = screenAlert || state.error ? G2_MARK.warning : state.connection === 'offline' ? G2_MARK.offline : ''
  const prefix = alert ? `${mark} ${alert} | ` : ''
  return fitDisplay(`${prefix}${label}`, HEADER_CHARS)
}

function attentionMark(category: string): string {
  switch (caseAttentionTier(category)) {
    case 'urgent': return G2_MARK.urgent
    case 'sensitive': return G2_MARK.sensitive
    default: return G2_MARK.review
  }
}

function inboxPage(state: GlassesState): GlassesPage {
  const items = (state.inbox?.items ?? []).slice(0, 20)
  const selectedIndex = items.length ? Math.min(Math.max(0, state.selectedIndex), items.length - 1) : 0
  const selected = items[selectedIndex]
  const count = state.inbox?.open_count ?? 0
  const stateLabel = state.inboxStale ? 'Stale' : state.connection === 'offline' ? 'Offline' :
    state.connection === 'loading' ? 'Syncing' : state.newCaseAvailable ? 'New case' : 'Open'
  const urgentCount = items.filter((item) => caseAttentionTier(item.category) === 'urgent').length
  const sensitiveCount = items.filter((item) => caseAttentionTier(item.category) === 'sensitive').length
  const visibleSuffix = state.inbox?.has_more ? ' shown' : ''
  const priority = urgentCount ? `${G2_MARK.urgent} ${urgentCount} urgent${visibleSuffix}` :
    sensitiveCount ? `${G2_MARK.sensitive} ${sensitiveCount} sensitive${visibleSuffix}` : ''
  const brand = state.fixtureMode ? 'Glance demo' : 'RemboAI Glance'
  const header = appHeader(state, `${brand} | ${count} ${stateLabel}${priority ? ` | ${priority}` : ''}`)
  if (items.length) {
    const rows = items.map((item) =>
      fitDisplay(`${attentionMark(item.category)} ${compactLine(
        `${item.customer_label} | ${categoryLabel(item.category)} | ${inboxAgeLabel(item.created_at)}`,
        LIST_ROW_CHARS - 2,
      )}`, LIST_ROW_CHARS),
    )
    const detail = selected
      ? `${fitDisplay(`${G2_MARK.selected} ${selectedIndex + 1}/${items.length} | ${caseAttentionLabel(selected.category)} | ${channelLabel(selected.channel)} | ${inboxAgeLabel(selected.created_at)}`, CHARS_PER_LINE)}\n${wrapGlassesPreview(selected.preview, 2, CHARS_PER_LINE)}`
      : 'No case selected'
    const footer = state.inboxStale ? 'Cached inbox' : `${count} open${state.inbox?.has_more ? ' | More' : ''}`
    return pageWithList('inbox', header, rows, detail, footer, 'Click to open', [
      [G2_MENU.inboxOpen, 'Open selected case'],
      [G2_MENU.scheduleToday, 'Show today schedule'],
    ])
  }
  const body = state.connection === 'loading'
    ? 'Checking open cases\nYour inbox will update when ready'
    : state.connection === 'offline'
      ? `${G2_MARK.offline} Inbox unavailable\nShowing no new data.`
      : `${G2_MARK.accepted} All caught up\nNo open escalations.`
  return pageWithZones('inbox', header, body, state.inboxStale ? 'Cached view' : '', 'Double tap to exit', {
    menu: [[G2_MENU.inboxOpen, 'Refresh inbox'], [G2_MENU.scheduleToday, 'Show today schedule']], key: 'home',
  })
}

function scheduleTime(iso: string, timezone: string): string {
  const value = new Date(iso)
  if (!Number.isFinite(value.getTime())) return '--:--'
  try {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
    }).format(value)
  } catch {
    return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
  }
}

function schedulePage(state: GlassesState): GlassesPage {
  const schedule = state.schedule
  const header = appHeader(state, schedule ? `Schedule | ${schedule.date}` : 'Schedule')
  const actions: Array<[number, string]> = []
  const labels: string[] = []
  if (schedule && state.scheduleOffset > 0) {
    actions.push([G2_MENU.schedulePrevious, 'Previous schedule page'])
    labels.push('Previous page')
  }
  if (schedule?.has_more) {
    actions.push([G2_MENU.scheduleNext, 'Next schedule page'])
    labels.push('Next page')
  }
  actions.push([G2_MENU.scheduleInbox, 'Back to inbox'])
  labels.push('Back to inbox')
  const selected = Math.min(Math.max(0, state.focusedAction), labels.length - 1)
  if (!schedule) return pageWithZones('schedule', header, 'Loading today\'s program', 'Please wait', '')
  if (!schedule.items.length) return pageWithZones(
    'schedule', header, 'No active bookings.\nYour program is clear.',
    actionFooter(selected, labels.length, labels[selected]), 'Hold for actions', { menu: actions, key: 'empty' },
  )
  const rows = schedule.items.map((item) => compactLine(
    `${scheduleTime(item.starts_at, schedule.timezone)}  ${item.customer_label}  |  ${item.service} - ${item.staff}`,
    CHARS_PER_LINE,
  ))
  const first = schedule.items[0]
  const last = schedule.items.at(-1)
  const summary = compactLine(
    `${schedule.count} shown${schedule.has_more ? '  |  More' : ''}  ${scheduleTime(first.starts_at, schedule.timezone)}-${scheduleTime(last?.ends_at ?? last?.starts_at ?? first.ends_at, schedule.timezone)}`,
    CHARS_PER_LINE,
  )
  return pageWithChoices('schedule', header, rows, summary, 'Hold for actions', actions, 'schedule')
}

function caseMenu(): MenuEntry[] {
  return [
    [G2_MENU.aiDraft, 'AI suggestion'],
    [G2_MENU.voiceReply, 'Dictate reply'],
    [G2_MENU.replyStatus, 'Reply status'],
    [G2_MENU.resolve, 'Resolve case'],
    [G2_MENU.inbox, 'Back to inbox'],
  ]
}

function casePage(state: GlassesState): GlassesPage {
  const item = state.caseData
  if (!item) return pageWithZones('loading', appHeader(state, 'Case'), 'Loading case details', 'Please wait', '')
  if (item.status === 'resolved') {
    const reply = item.latest_reply
      ? `Reply: ${presentReplyState(item.latest_reply.state, item.channel).label}`
      : 'No outbound reply.'
    return pageWithZones('case-resolved', appHeader(state, `${G2_MARK.accepted} Resolved | ${compactLine(item.customer_label, 18)}`),
      `Owner confirmed\nHandling complete.\n${reply}`, `Case v${item.version}`, 'Hold for actions', {
        menu: item.latest_reply
          ? [[G2_MENU.replyStatus, 'Reply status'], [G2_MENU.inbox, 'Back to inbox']]
          : [[G2_MENU.inbox, 'Back to inbox']],
        key: 'resolved',
      })
  }

  const name = compactLine(item.customer_label, 18)
  if (state.stale) {
    return pageWithZones('case', appHeader(state, `${G2_MARK.warning} Case updated | ${name}`),
      'Case changed on another device.\nRefresh before acting.', state.draft ? 'Draft not sent' : '', 'Hold for actions', {
        emphasis: true,
        menu: [[G2_MENU.caseRefresh, 'Refresh case'], [G2_MENU.inbox, 'Back to inbox']],
        key: 'stale',
      })
  }

  const pageCount = Math.ceil(item.context.length / CONTEXT_PAGE_SIZE)
  const pageIndex = pageCount > 0 ? Math.min(Math.max(0, Math.floor(state.messagePage) || 0), pageCount - 1) : 0
  const chronologicalPage = pageCount > 0 ? pageCount - 1 - pageIndex : 0
  const visible = messagePage(item.context, chronologicalPage, CONTEXT_PAGE_SIZE)
  const message = visible[0]
  const text = message
    ? message.actor === 'customer'
      ? message.text
      : `(${message.actor === 'assistant' ? 'RemboAI' : 'Owner'}) ${message.text}`
    : ''
  const pages = paginateGlassesText(asciiFirmwareText(text), CHARS_PER_LINE, REVIEW_LINES)
  const textPage = Math.min(Math.max(0, Math.floor(state.messageTextPage ?? 0), 0), pages.length - 1)
  const atOldest = pageCount > 0 && pageIndex === pageCount - 1
  const position = pageCount ? `Message ${pageIndex * CONTEXT_PAGE_SIZE + 1}/${item.context.length}` : 'No messages'
  const footLeft = state.busy
    ? `Working: ${state.busyAction.replaceAll('-', ' ')}`
    : `${position}${pages.length > 1 ? ` | Page ${textPage + 1}/${pages.length}` : atOldest && item.has_earlier ? ' | Earlier hidden' : ''}`
  const footRight = state.busy ? '' : pages.length > 1 && textPage < pages.length - 1 ? 'Swipe for more' : 'Hold for actions'
  const header = `${attentionMark(item.category)} ${caseAttentionLabel(item.category)} | ${name} | ${categoryLabel(item.category)} | ${channelLabel(item.channel)}`
  return pageWithZones('case', appHeader(state, header), pages[textPage] || 'No customer-visible messages.',
    footLeft, footRight, { emphasis: caseAttentionTier(item.category) === 'urgent', menu: caseMenu(), key: `open-${caseAttentionTier(item.category)}` })
}

function draftPage(state: GlassesState): GlassesPage {
  const sourceText = state.editorText || state.draft?.text || ''
  const text = asciiFirmwareText(sourceText)
  const canCreateSafeCopy = Boolean(sourceText && canCreateDisplaySafeCopy(sourceText))
  const pages = paginateGlassesText(text, CHARS_PER_LINE, REVIEW_LINES)
  const pageIndex = Math.min(Math.max(0, Math.floor(state.draftPage) || 0), pages.length - 1)
  const expired = Boolean(state.draft && Date.parse(state.draft.expires_at) <= Date.now())
  const owner = state.draft?.source === 'owner' || state.manualMode
  const source = owner ? `${G2_MARK.owner} Owner draft` : `${G2_MARK.assistant} AI draft`
  const safeCopyTooLong = Boolean(sourceText && needsGlassesReviewCopy(sourceText) && !canCreateSafeCopy)
  const warning = state.stale ? 'Case changed' : expired ? 'Draft expired' : safeCopyTooLong ? 'Display copy too long' : ''
  const header = state.stale ? 'Draft stale'
    : expired ? 'Not sent'
      : `${source}${pages.length > 1 ? ` ${pageIndex + 1}/${pages.length}` : ''} | Not sent`
  const footLeft = state.stale || expired ? 'Do not send'
    : safeCopyTooLong ? 'Display copy too long'
      : pages.length > 1 ? `Page ${pageIndex + 1}/${pages.length}` : 'Not sent'
  const footRight = pages.length > 1 && pageIndex < pages.length - 1 ? 'Swipe for more' : 'Hold for actions'
  return pageWithZones('draft', appHeader(state, header, warning),
    text ? pages[pageIndex] : 'No text saved.\nUse voice to dictate a reply.', footLeft, footRight, {
      menu: [
        [G2_MENU.draftReview, 'Review reply'],
        [G2_MENU.draftVoice, 'Dictate revision'],
        [G2_MENU.draftCase, 'Back to case'],
        ...(canCreateSafeCopy ? [[G2_MENU.draftSafeCopy, 'ASCII copy'] as const] : []),
      ], key: `draft-${Boolean(state.stale)}-${expired}`,
    })
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.min(40, Math.max(0, Math.floor(milliseconds / 1_000)))
  return `00:${String(seconds).padStart(2, '0')}`
}

const METER_LEVELS = '▁▂▃▄▅▆▇█'

function levelMeter(milliseconds: number, width = 24): string {
  const t = milliseconds / 140
  return Array.from({ length: width }, (_, index) => {
    const level = Math.abs(Math.sin(t + index * 0.55) * Math.cos(t * 0.37 + index * 0.21))
    return METER_LEVELS[Math.min(7, Math.floor(level * 8))]
  }).join('')
}

function progressBar(ratio: number, width = 26): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return `${'━'.repeat(filled)}${'─'.repeat(width - filled)}`
}

function voicePage(state: GlassesState): GlassesPage {
  const phase = state.voicePhase
  if (phase === 'transcript_ready') {
    const pages = paginateGlassesText(asciiFirmwareText(state.voiceTranscript), CHARS_PER_LINE, REVIEW_LINES)
    const page = Math.min(Math.max(0, Math.floor(state.transcriptPage) || 0), pages.length - 1)
    const canRevise = Boolean(state.caseData && state.draft && canUseTranscriptAsInstruction(
      state.caseData, state.draft, state.stale, state.editorText, state.voiceTranscript,
    ))
    const menu: MenuEntry[] = [
      [G2_MENU.transcriptReply, 'Use as reply'],
      [G2_MENU.transcriptInstruction, canRevise ? 'Use as instruction' : 'Draft needed'],
      [G2_MENU.voiceCancel, 'Cancel'],
    ]
    return pageWithZones('transcript-preview', appHeader(state, `Transcript | ${state.voiceSimulation ? 'Simulated' : 'Not sent'}`),
      pages[page], pages.length > 1 ? `Page ${page + 1}/${pages.length}` : 'Not sent', 'Use menu to choose', {
        menu, key: canRevise ? 'transcript-ai' : 'transcript-manual',
      })
  }
  if (phase === 'recording') {
    const body = state.voiceSimulation
      ? `${formatDuration(state.voiceDurationMs)} / 00:40\nSimulation only\n${progressBar(state.voiceDurationMs / 40_000)}`
      : `${formatDuration(state.voiceDurationMs)} / 00:40\n${levelMeter(state.voiceDurationMs)}\n${progressBar(state.voiceDurationMs / 40_000)}`
    return pageWithZones('voice-recording', appHeader(state, `Voice input | ${state.voiceSimulation ? `${G2_MARK.micOff} Simulation` : `${G2_MARK.micOn} Recording`}`),
      body, state.voiceSimulation ? 'No audio buffered' : 'Audio stays in memory', 'Use menu to stop', {
        recording: true,
        menu: [[G2_MENU.voiceStop, 'Stop and review'], [G2_MENU.voiceCancel, 'Cancel recording']], key: 'recording',
      })
  }
  if (phase === 'starting' || phase === 'stopping' || phase === 'transcribing') {
    const label = phase === 'starting' ? 'Starting microphone' : phase === 'stopping' ? 'Stopping microphone' : 'Transcribing'
    return pageWithZones('voice-ready', appHeader(state, `Voice input | ${label}`),
      `${label}\n${'○ ● ○'}`, 'Audio is not saved', 'Please wait', { key: phase })
  }
  if (phase === 'error') {
    return pageWithZones('voice-ready', appHeader(state, `${G2_MARK.warning} Voice stopped | Mic off`),
      wrapGlassesPreview(state.voiceError || 'Voice input stopped', REVIEW_LINES - 2), 'Mic off', 'Use menu to retry', {
        menu: [[G2_MENU.voiceStart, 'Start again'], [G2_MENU.voiceCancel, 'Back to case']], key: 'error',
      })
  }
  return pageWithZones('voice-ready', appHeader(state, `Voice input | ${G2_MARK.micOff} Mic off`),
    `${state.voiceSimulation ? 'Simulation only\n' : ''}Ready to dictate.\nUp to 40 seconds.`, 'Audio stays in memory', 'Use menu to start', {
      menu: [[G2_MENU.voiceStart, 'Start recording'], [G2_MENU.voiceCancel, 'Back to case']],
      key: 'ready',
    })
}

const APPROVAL_ACTIONS = ['Approve & queue', 'Cancel']

function approvalPage(state: GlassesState): GlassesPage {
  const pages = paginateGlassesApprovalText(state.approvalText)
  if (state.approvalStage === 'confirm') {
    const draft = state.draft
    const item = state.caseData
    const name = item ? compactLine(item.customer_label, 18) : 'customer'
    const waiting = state.busy && state.busyAction === 'approve'
    const uncertain = hasUncertainApproval(state)
    const asciiSafe = /^[\x20-\x7e\n]+$/.test(state.approvalText)
    const expired = Boolean(draft && Date.parse(draft.expires_at) <= Date.now())
    const current = Boolean(draft && item && item.status === 'open' && !state.stale && draft.based_on_version === item.version)

    if (waiting) return pageWithZones('draft', appHeader(state, `Sending | ${name}`),
      `Approval request in flight.\n${'○ ● ○'}`, 'Not sent yet', 'Wait for result', { key: 'approval-wait' })

    if (uncertain) {
      const labels = ['Check status', 'Retry same key', 'Leave review']
      const menu: MenuEntry[] = [
        [G2_MENU.approvalStatus, 'Check status'],
        [G2_MENU.approvalRetry, 'Retry same key'],
        [G2_MENU.approvalCancel, 'Leave review'],
      ]
      return pageWithChoices('draft', appHeader(state, `${G2_MARK.warning} Outcome uncertain | ${name}`), labels,
        compactLine(state.error || 'Not confirmed', FOOT_LEFT_CHARS), 'Double press to choose', menu, 'approval-uncertain')
    }

    if (!current || !asciiSafe || expired) {
      const reason = !asciiSafe ? 'Unsupported display characters.\nRephrase before approval.'
        : expired ? 'Draft expired.\nCreate a new draft.'
          : 'Case or draft changed.\nRefresh before approval.'
      return pageWithZones('draft', appHeader(state, `${G2_MARK.warning} Cannot send | ${name}`),
        reason, 'Not sent', 'Use menu to cancel', {
          emphasis: true, menu: [[G2_MENU.approvalCancel, 'Cancel review']], key: 'approval-blocked',
        })
    }

    return pageWithChoices('draft', appHeader(state, `Send to ${name}? | Not sent yet`),
      [...APPROVAL_ACTIONS], 'Not sent', 'Double press to choose', [
        [G2_MENU.approvalConfirm, 'Approve & queue'],
        [G2_MENU.approvalCancel, 'Cancel'],
      ], 'approval-confirm')
  }

  const page = Math.min(Math.max(0, Math.floor(state.approvalPage) || 0), pages.length - 1)
  const reviewedPages = Math.min(pages.length, Math.max(0, Math.floor(state.approvalProgress) || 0))
  const stale = state.stale || !state.draft || !state.caseData || state.draft.based_on_version !== state.caseData.version
  const supported = /^[\x20-\x7e\n]+$/.test(state.approvalText)
  const alert = stale ? 'Stop review'
    : !supported ? 'Review unavailable'
      : `Exact reply ${page + 1}/${pages.length} | Not sent`
  return pageWithZones('draft', appHeader(state, alert, stale ? 'Case changed' : !supported ? 'Unsupported characters' : ''), pages[page],
    `Reviewed ${reviewedPages}/${pages.length} pages`,
    page + 1 < pages.length ? 'Swipe to continue' : 'Swipe to confirm', {
      menu: [
        ...(page > 0 ? [[G2_MENU.approvalPrevious, 'Previous page'] as const] : []),
        ...(page + 1 < pages.length ? [[G2_MENU.approvalNext, 'Next page'] as const] : []),
        [G2_MENU.approvalCancel, 'Cancel review'],
      ], key: `approval-review-${pages.length}-${stale ? 'stale' : 'fresh'}`,
    })
}

function replyPage(state: GlassesState): GlassesPage {
  const item = state.caseData
  const reply = state.reply
  if (!reply || !item) return pageWithText('reply-status', appHeader(state, 'Reply status'),
    'Checking reply status\n\nNo delivery claim is made', 'Wait for backend status')
  const presentation = presentReplyState(reply.state, item.channel)
  const label: Record<string, string> = {
    queued: 'Queued\nWaiting for dispatch\nNot sent yet',
    sending: 'Sending\nProvider request in progress',
    submitted: `Submitted to ${channelLabel(item.channel)}\nDelivery not confirmed`,
    delivered: 'Delivery receipt confirmed',
    failed: 'Failed to send',
    unknown: 'Status uncertain',
    cancelled: 'Cancelled before dispatch\nNot sent',
  }
  const statusMark = reply.state === 'queued' ? G2_MARK.pending :
    reply.state === 'sending' ? G2_MARK.selected :
      reply.state === 'failed' || reply.state === 'unknown' || (item.channel === 'telegram' && reply.state === 'delivered')
        ? G2_MARK.warning : reply.state === 'cancelled' ? G2_MARK.stop : G2_MARK.accepted
  const statusLabel = item.channel === 'telegram' && reply.state === 'delivered'
    ? 'Delivery unverifiable\nTelegram receipts not supported'
    : label[reply.state]
  return pageWithZones('reply-status', appHeader(state, `Reply outcome | ${compactLine(item.customer_label, 18)}`),
    `${statusMark} ${statusLabel}\n${wrapGlassesPreview(presentation.detail, 2, CHARS_PER_LINE - 4)}`,
    `Case v${item.version}`, 'Use menu for actions', {
      menu: [[G2_MENU.statusCheck, 'Check status'], [G2_MENU.statusResolve, 'Resolve case'], [G2_MENU.statusCase, 'Back to case']],
      key: `status-${reply.state}`,
    })
}

const RESOLVE_REASONS = [
  ['handled_in_person', 'Handled in person', G2_MENU.reasonHandled],
  ['customer_updated', 'Customer updated', G2_MENU.reasonUpdated],
  ['no_action_needed', 'No action needed', G2_MENU.reasonNoAction],
  ['other', 'Other', G2_MENU.reasonOther],
] as const

function resolvePage(state: GlassesState): GlassesPage {
  const item = state.caseData
  if (!item) return pageWithZones('resolve', appHeader(state, 'Resolve'), 'No case selected.', '', 'Use menu to go back', {
    menu: [[G2_MENU.resolveCancel, 'Cancel']], key: 'none',
  })
  const reasonIndex = Math.max(0, RESOLVE_REASONS.findIndex(([value]) => value === state.resolveReason))
  const unknown = item.latest_reply?.state === 'unknown'
  const name = compactLine(item.customer_label, 18)
  const replyState = item.latest_reply?.state
  const needsAck = unknown && !state.acknowledgedUnknown
  const warning = unknown ? state.acknowledgedUnknown ? 'Unknown reply acknowledged' : 'Delivery unknown'
    : replyState === 'queued' ? 'Queued reply cancels'
      : replyState === 'sending' ? 'Reply is sending' : ''
  const header = `${warning ? `${G2_MARK.warning} ${warning} | ` : ''}Resolve ${name}?`
  if (needsAck) return pageWithZones('resolve', appHeader(state, 'Resolve case?', 'Reply outcome uncertain'),
    'Customer may or may not have received it.\nDo not retry the reply.',
    `Case v${item.version}`, 'Menu: acknowledge', {
      emphasis: true,
      menu: [[G2_MENU.resolveAcknowledge, 'Acknowledge uncertainty'], [G2_MENU.resolveCancel, 'Cancel']],
      key: 'resolve-unknown-ack',
    })

  const menu: MenuEntry[] = RESOLVE_REASONS.map(([, label, id]) => [id, label])
  menu.push([G2_MENU.resolveConfirm, 'Confirm resolve'])
  menu.push([G2_MENU.resolveCancel, 'Cancel'])
  const warningDetail = state.acknowledgedUnknown ? 'Uncertainty acknowledged. The customer may have received the reply.'
    : replyState === 'queued' ? 'Queued reply will be cancelled and not sent.'
      : replyState === 'sending' ? 'Reply is sending. Wait before resolving.' : ''
  return pageWithChoices('resolve', appHeader(state, header), RESOLVE_REASONS.map(([, label]) => label),
    `Reason ${reasonIndex + 1}/${RESOLVE_REASONS.length}${state.resolveReason === 'other' && state.resolveNote ? ` | ${compactLine(state.resolveNote, 12)}` : ''}`,
    'Use menu to confirm', menu, `resolve-${warning ? 'warn' : 'ok'}-ack-${state.acknowledgedUnknown}`, warningDetail)
}

export function buildGlassesPage(state: GlassesState): GlassesPage {
  if (state.screen === 'pair') return pageWithText('pair', appHeader(state, 'Pair'),
    'Owner session required\n\nPair this device with Telegram\non the companion app', 'Pairing is not available here')
  if (state.screen === 'inbox') return inboxPage(state)
  if (state.screen === 'schedule') return schedulePage(state)
  if (state.screen === 'case') return casePage(state)
  if (state.screen === 'voice') return voicePage(state)
  if (state.screen === 'draft') return draftPage(state)
  if (state.screen === 'approval') return approvalPage(state)
  if (state.screen === 'status') return replyPage(state)
  if (state.screen === 'resolve') return resolvePage(state)
  return pageWithText('loading', appHeader(state, 'Glance'), 'Loading', 'Please wait')
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
  if (!left.listObject && !right.listObject) return true
  if (!left.listObject || !right.listObject) return false
  const leftItems = left.listObject?.[0]?.itemContainer?.itemName ?? []
  const rightItems = right.listObject?.[0]?.itemContainer?.itemName ?? []
  return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index])
}
