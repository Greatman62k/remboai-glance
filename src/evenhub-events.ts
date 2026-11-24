import {
  AudioInputSource,
  evenHubEventFromJson,
  EventSourceType,
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

export type PressEnvelope = 'sysEvent' | 'textEvent' | 'listEvent'
type PressKind = 'click' | 'double_click' | 'scroll_up' | 'scroll_down'

export type GlanceInput =
  | {
    kind: PressKind
    source: EventSourceType | null
    envelope?: PressEnvelope
    selectedIndex?: number
    selectedItemName?: string
  }
  | { kind: 'foreground_enter' | 'foreground_exit' | 'system_exit' | 'abnormal_exit'; source: null }
  | { kind: 'menu'; itemId: number | null; source: null }
  | { kind: 'audio'; source: AudioInputSource | null; pcm: Uint8Array | null }

type EventCandidate = NonNullable<EvenHubEvent['sysEvent'] | EvenHubEvent['textEvent'] | EvenHubEvent['listEvent']>

function isConcreteEvent(envelope: PressEnvelope, candidate: EventCandidate): boolean {
  if (envelope === 'sysEvent') return 'eventSource' in candidate && candidate.eventSource !== undefined && candidate.eventSource !== null
  if (envelope === 'textEvent') {
    return ('containerID' in candidate && candidate.containerID !== undefined) ||
      ('containerName' in candidate && candidate.containerName !== undefined)
  }
  return ('containerID' in candidate && candidate.containerID !== undefined) ||
    ('containerName' in candidate && candidate.containerName !== undefined) ||
    ('currentSelectItemIndex' in candidate && candidate.currentSelectItemIndex !== undefined) ||
    ('currentSelectItemName' in candidate && candidate.currentSelectItemName !== undefined)
}

export function parseEvenHubEvent(input: unknown): GlanceInput | null {
  let envelope: EvenHubEvent
  try {
    const direct = input !== null && typeof input === 'object'
      ? input as EvenHubEvent
      : null
    envelope = direct && (
      direct.sysEvent || direct.textEvent || direct.listEvent || direct.audioEvent || direct.menuItemClickEvent
    ) ? direct : evenHubEventFromJson(input)
  } catch {
    return null
  }
  if (envelope.menuItemClickEvent) {
    return { kind: 'menu', itemId: envelope.menuItemClickEvent.itemID ?? null, source: null }
  }
  if (envelope.audioEvent) return {
    kind: 'audio',
    source: envelope.audioEvent.source ?? null,
    pcm: envelope.audioEvent.audioPcm instanceof Uint8Array ? envelope.audioEvent.audioPcm : null,
  }

  const candidates: Array<[PressEnvelope, EventCandidate | undefined]> = [
    ['sysEvent', envelope.sysEvent],
    ['textEvent', envelope.textEvent],
    ['listEvent', envelope.listEvent],
  ]
  for (const [eventEnvelope, candidate] of candidates) {
    if (!candidate) continue
    const source = eventEnvelope === 'sysEvent' && 'eventSource' in candidate
      ? (candidate.eventSource ?? null)
      : null
    const rawType: unknown = candidate.eventType
    // CLICK_EVENT is enum zero, so JSON encoders often omit it. Infer that
    // default only from a concrete native event, never from an empty envelope.
    const eventType = rawType === 0 || rawType === '0'
      ? OsEventTypeList.CLICK_EVENT
      : rawType === undefined || rawType === null
        ? (isConcreteEvent(eventEnvelope, candidate) ? OsEventTypeList.CLICK_EVENT : undefined)
        : OsEventTypeList.fromJson(rawType)
    if (eventType === undefined) continue
    if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) return { kind: 'foreground_enter', source: null }
    if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) return { kind: 'foreground_exit', source: null }
    if (eventType === OsEventTypeList.SYSTEM_EXIT_EVENT) return { kind: 'system_exit', source: null }
    if (eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) return { kind: 'abnormal_exit', source: null }

    let kind: PressKind | null = null
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) kind = 'double_click'
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) kind = 'scroll_up'
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) kind = 'scroll_down'
    if (eventType === OsEventTypeList.CLICK_EVENT) kind = 'click'
    if (!kind) continue

    // A native selection can accompany a sysEvent click in the same SDK
    // envelope. Preserve its index even though the system event carries the
    // actionable click/double-click type.
    const listEvent = envelope.listEvent
    const selectedIndex = listEvent && 'currentSelectItemIndex' in listEvent
      ? listEvent.currentSelectItemIndex
      : undefined
    const selectedItemName = listEvent && 'currentSelectItemName' in listEvent
      ? listEvent.currentSelectItemName
      : undefined
    return {
      kind,
      source,
      envelope: eventEnvelope,
      ...(selectedIndex === undefined ? {} : { selectedIndex }),
      ...(selectedItemName === undefined ? {} : { selectedItemName }),
    }
  }
  return null
}

/**
 * Some G2 builds report one physical press once from a text/list capture and
 * again from sysEvent. Suppress only the cross-envelope echo; repeated events
 * from the same envelope remain distinct user input.
 */
export class PhysicalPressDeduplicator {
  private readonly groups = new Map<PressKind, { startedAt: number; envelopes: Set<PressEnvelope> }>()
  private readonly windowMs: number

  constructor(windowMs = 1_200) {
    this.windowMs = windowMs
  }

  accept(input: GlanceInput, now = Date.now()): boolean {
    if (!['click', 'double_click'].includes(input.kind) || !('envelope' in input) || !input.envelope) return true
    const kind = input.kind as 'click' | 'double_click'
    const previous = this.groups.get(kind)
    if (!previous || now - previous.startedAt > this.windowMs || previous.envelopes.has(input.envelope)) {
      this.groups.set(kind, { startedAt: now, envelopes: new Set([input.envelope]) })
      return true
    }
    previous.envelopes.add(input.envelope)
    return false
  }

  clear(): void {
    this.groups.clear()
  }
}

export const RING_EVENT_SOURCE = EventSourceType.TOUCH_EVENT_FROM_RING
