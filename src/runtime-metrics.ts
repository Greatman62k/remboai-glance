export interface GlanceRuntimeMetricsSnapshot {
  apiRequests: number
  apiLatencyTotalMs: number
  apiLatencyMaxMs: number
  pollingRequests: number
  pageCreations: number
  pageRebuilds: number
  textUpdates: number
  duplicateUpdatesSkipped: number
  bridgeUpdatesCoalesced: number
  maxQueuedBridgeWrites: number
  displayLatencyTotalMs: number
  displayLatencyMaxMs: number
  peakAudioBufferBytes: number
}

const EMPTY: GlanceRuntimeMetricsSnapshot = {
  apiRequests: 0,
  apiLatencyTotalMs: 0,
  apiLatencyMaxMs: 0,
  pollingRequests: 0,
  pageCreations: 0,
  pageRebuilds: 0,
  textUpdates: 0,
  duplicateUpdatesSkipped: 0,
  bridgeUpdatesCoalesced: 0,
  maxQueuedBridgeWrites: 0,
  displayLatencyTotalMs: 0,
  displayLatencyMaxMs: 0,
  peakAudioBufferBytes: 0,
}

/** In-memory counters only. No request content, transcript, identifier or token is recorded. */
class RuntimeMetrics {
  private values: GlanceRuntimeMetricsSnapshot = { ...EMPTY }

  snapshot(): GlanceRuntimeMetricsSnapshot { return { ...this.values } }
  reset(): void { this.values = { ...EMPTY } }
  apiRequest(milliseconds: number, polling = false): void {
    this.values.apiRequests += 1
    this.values.apiLatencyTotalMs += Math.max(0, milliseconds)
    this.values.apiLatencyMaxMs = Math.max(this.values.apiLatencyMaxMs, milliseconds)
    if (polling) this.values.pollingRequests += 1
  }
  pageCreate(milliseconds: number): void {
    this.values.pageCreations += 1
    this.displayUpdate(milliseconds)
  }
  pageRebuild(): void { this.values.pageRebuilds += 1 }
  textUpdate(): void { this.values.textUpdates += 1 }
  duplicateUpdate(): void { this.values.duplicateUpdatesSkipped += 1 }
  coalescedUpdate(): void { this.values.bridgeUpdatesCoalesced += 1 }
  queuedBridgeWrites(count: number): void { this.values.maxQueuedBridgeWrites = Math.max(this.values.maxQueuedBridgeWrites, count) }
  displayUpdate(milliseconds: number): void {
    this.values.displayLatencyTotalMs += Math.max(0, milliseconds)
    this.values.displayLatencyMaxMs = Math.max(this.values.displayLatencyMaxMs, milliseconds)
  }
  audioBuffer(bytes: number): void { this.values.peakAudioBufferBytes = Math.max(this.values.peakAudioBufferBytes, bytes) }
}

export const runtimeMetrics = new RuntimeMetrics()
