import { runtimeMetrics } from './runtime-metrics.ts'

/** Keeps one write in flight and at most one replaceable pending page. */
export class LatestOnlyDisplayWriter<T> {
  private pending: T | null = null
  private active: T | null = null
  private lastWritten: T | null = null
  private draining = false
  private failure: unknown = null
  private idleWaiters: Array<() => void> = []
  private readonly write: (value: T) => Promise<void>
  private readonly equals: (left: T, right: T) => boolean
  private readonly onError: (error: unknown) => void

  constructor(
    write: (value: T) => Promise<void>,
    equals: (left: T, right: T) => boolean,
    onError: (error: unknown) => void,
    initialWritten?: T,
  ) {
    this.write = write
    this.equals = equals
    this.onError = onError
    this.lastWritten = initialWritten ?? null
  }

  invalidate(): void { this.lastWritten = null }

  /** Resume writes after a device reconnect or transient bridge failure. */
  recover(): void {
    this.failure = null
    this.lastWritten = null
    if (this.pending && !this.draining) void this.drain()
  }

  enqueue(value: T): void {
    if (this.failure !== null) return
    if (this.pending && this.equals(this.pending, value)) {
      runtimeMetrics.duplicateUpdate()
      return
    }
    if (!this.pending && this.lastWritten && this.equals(this.lastWritten, value)) {
      runtimeMetrics.duplicateUpdate()
      return
    }
    if (this.pending) runtimeMetrics.coalescedUpdate()
    else if (this.draining && this.active && this.equals(this.active, value)) {
      runtimeMetrics.duplicateUpdate()
      return
    }
    this.pending = value
    runtimeMetrics.queuedBridgeWrites(1)
    if (!this.draining) void this.drain()
  }

  async idle(): Promise<void> {
    if (!this.draining && !this.pending) return
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.pending && this.failure === null) {
        const value = this.pending
        this.pending = null
        if (this.lastWritten && this.equals(this.lastWritten, value)) {
          runtimeMetrics.duplicateUpdate()
          continue
        }
        this.active = value
        const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
        await this.write(value)
        const ended = typeof performance !== 'undefined' ? performance.now() : Date.now()
        runtimeMetrics.displayUpdate(ended - started)
        this.lastWritten = value
        this.active = null
      }
    } catch (error) {
      this.failure = error
      this.pending = null
      this.active = null
      this.onError(error)
    } finally {
      this.draining = false
      const waiters = this.idleWaiters.splice(0)
      for (const resolve of waiters) resolve()
      if (this.pending && this.failure === null) void this.drain()
    }
  }
}
