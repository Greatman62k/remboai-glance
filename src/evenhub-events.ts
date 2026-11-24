import {
  AudioInputSource,
  evenHubEventFromJson,
  EventSourceType,
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

export type GlanceInput =
  | { kind: 'click' | 'double_click' | 'scroll_up' | 'scroll_down'; source: EventSourceType | null }
  | { kind: 'foreground_enter' | 'foreground_exit' | 'system_exit' | 'abnormal_exit'; source: null }
  | { kind: 'menu'; itemId: number | null; source: null }
  | { kind: 'audio'; source: AudioInputSource | null; pcm: Uint8Array | null }

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

  const candidates = [envelope.sysEvent, envelope.textEvent, envelope.listEvent]
  for (const candidate of candidates) {
    if (!candidate) continue
    const source = 'eventSource' in candidate
      ? (candidate.eventSource ?? null)
      : null
    // The SDK/simulator omit protobuf's default enum value (CLICK=0).
    // A concrete sys/text/list event with an event source and no type is that default click.
    const rawType = candidate.eventType
    const eventType = rawType === undefined || rawType === null
      ? (source === null ? undefined : OsEventTypeList.CLICK_EVENT)
      : OsEventTypeList.fromJson(rawType)
    if (eventType === undefined) continue
    if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) return { kind: 'foreground_enter', source: null }
    if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) return { kind: 'foreground_exit', source: null }
    if (eventType === OsEventTypeList.SYSTEM_EXIT_EVENT) return { kind: 'system_exit', source: null }
    if (eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) return { kind: 'abnormal_exit', source: null }
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) return { kind: 'double_click', source }
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) return { kind: 'scroll_up', source }
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) return { kind: 'scroll_down', source }
    if (eventType === OsEventTypeList.CLICK_EVENT) return { kind: 'click', source }
  }
  return null
}

export const RING_EVENT_SOURCE = EventSourceType.TOUCH_EVENT_FROM_RING
