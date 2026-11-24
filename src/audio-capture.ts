import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { runtimeMetrics } from './runtime-metrics.ts'

export const PCM_SAMPLE_RATE = 16_000
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2
export const MAX_CAPTURE_MS = 40_000
export const MAX_CAPTURE_BYTES = 1_280_000
export const AUDIO_STREAM_IDLE_MS = 2_500

export type AudioInputControl = (open: boolean, source?: AudioInputSource) => Promise<boolean>
export type CaptureStopReason = 'owner' | 'size_limit' | 'duration_limit'
export type CaptureStopRequest = CaptureStopReason | 'stream_interrupted' | 'invalid_audio'

export interface CapturedAudio {
  pcm: Uint8Array
  durationMs: number
  reason: CaptureStopReason
}

export interface CaptureScheduler {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const defaultScheduler: CaptureScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
}

export class AudioCaptureError extends Error {
  readonly name = 'AudioCaptureError'
  readonly code: 'microphone_start_failed' | 'microphone_stop_failed'

  constructor(code: 'microphone_start_failed' | 'microphone_stop_failed') {
    super(code)
    this.code = code
  }
}

/** Bounded in-memory capture for the SDK's glasses-microphone PCM events. */
export class G2PcmCapture {
  private state: 'idle' | 'starting' | 'recording' | 'stopping' | 'error' = 'idle'
  private buffer: Uint8Array | null = null
  private length = 0
  private control: AudioInputControl | null = null
  private opening: Promise<boolean> | null = null
  private stopping: Promise<CapturedAudio | null> | null = null
  private cancelling: Promise<boolean> | null = null
  private generation = 0
  private stopRequested = false
  private durationTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onStopRequested: ((reason: CaptureStopRequest) => void) | null = null
  private onProgress: (() => void) | null = null

  private readonly scheduler: CaptureScheduler

  constructor(scheduler: CaptureScheduler = defaultScheduler) {
    this.scheduler = scheduler
  }

  get phase(): 'idle' | 'starting' | 'recording' | 'stopping' | 'error' {
    return this.state
  }

  get byteLength(): number {
    return this.length
  }

  get durationMs(): number {
    return Math.floor(this.length * 1000 / PCM_BYTES_PER_SECOND)
  }

  async start(control: AudioInputControl,
              onStopRequested: (reason: CaptureStopRequest) => void,
              onProgress?: () => void): Promise<boolean> {
    if (this.state !== 'idle' || this.cancelling) return false
    const generation = ++this.generation
    this.buffer = new Uint8Array(MAX_CAPTURE_BYTES)
    runtimeMetrics.audioBuffer(MAX_CAPTURE_BYTES)
    this.length = 0
    this.control = control
    this.onStopRequested = onStopRequested
    this.onProgress = onProgress ?? null
    this.stopRequested = false
    this.state = 'starting'

    const opening = (async () => {
      let opened: boolean
      try {
        opened = await control(true, AudioInputSource.Glasses)
      } catch {
        let closed = false
        if (generation === this.generation) {
          try { closed = await control(false) } catch { closed = false }
        }
        if (generation === this.generation) {
          this.releaseBuffer()
          this.control = closed ? null : control
          this.state = 'error'
        }
        throw new AudioCaptureError('microphone_start_failed')
      }

      if (generation !== this.generation) {
        if (opened) await Promise.resolve(control(false)).catch(() => false)
        return false
      }
      if (!opened) {
        this.releaseBuffer()
        this.control = null
        this.state = 'idle'
        return false
      }

      this.state = 'recording'
      this.durationTimer = this.scheduler.setTimeout(
        () => this.requestStop('duration_limit'), MAX_CAPTURE_MS,
      )
      this.armIdleTimer()
      return true
    })()
    this.opening = opening
    try {
      return await opening
    } finally {
      if (this.opening === opening) this.opening = null
    }
  }

  receive(source: AudioInputSource | null, pcm: Uint8Array | null): { acceptedBytes: number; ignored: boolean } {
    if (this.state !== 'recording' || this.stopRequested || source !== AudioInputSource.Glasses) {
      return { acceptedBytes: 0, ignored: true }
    }
    if (!(pcm instanceof Uint8Array) || pcm.byteLength % 2 !== 0) {
      this.requestStop('invalid_audio')
      return { acceptedBytes: 0, ignored: false }
    }
    if (pcm.byteLength === 0) return { acceptedBytes: 0, ignored: false }

    const remaining = MAX_CAPTURE_BYTES - this.length
    const acceptedBytes = Math.min(pcm.byteLength, remaining)
    if (acceptedBytes > 0 && this.buffer) {
      // Uint8Array#set copies the SDK event before the service retains its bytes.
      this.buffer.set(pcm.subarray(0, acceptedBytes), this.length)
      this.length += acceptedBytes
      this.armIdleTimer()
      try { this.onProgress?.() } catch { /* A display update cannot interrupt audio capture. */ }
    }

    if (this.length >= MAX_CAPTURE_BYTES) this.requestStop('size_limit')
    return { acceptedBytes, ignored: false }
  }

  async stop(reason: CaptureStopReason = 'owner'): Promise<CapturedAudio | null> {
    if (this.state === 'starting' && this.opening) {
      const opened = await this.opening
      if (!opened) return null
    }
    if (this.stopping) return this.stopping
    if (this.state !== 'recording') return null

    const generation = this.generation
    const control = this.control
    this.state = 'stopping'
    this.clearTimers()
    const stopping = (async (): Promise<CapturedAudio | null> => {
      let closed = false
      try {
        closed = control ? await control(false) : false
      } catch {
        closed = false
      }
      if (generation !== this.generation) return null
      if (!closed) {
        this.releaseBuffer()
        this.state = 'error'
        throw new AudioCaptureError('microphone_stop_failed')
      }

      const length = this.length - (this.length % 2)
      const pcm = this.buffer?.subarray(0, length) ?? new Uint8Array()
      const durationMs = Math.floor(length * 1000 / PCM_BYTES_PER_SECOND)
      this.buffer = null
      this.length = 0
      this.control = null
      this.onStopRequested = null
      this.onProgress = null
      this.state = 'idle'
      return { pcm, durationMs, reason }
    })()
    this.stopping = stopping
    try {
      return await stopping
    } finally {
      if (this.stopping === stopping) this.stopping = null
    }
  }

  async cancel(): Promise<boolean> {
    if (this.cancelling) return this.cancelling
    if (this.stopping) {
      const stopping = this.stopping
      this.cancelling = (async () => {
        let closed = false
        try {
          const captured = await stopping
          if (captured) {
            captured.pcm.fill(0)
            closed = true
          }
        } catch {
          // The SDK stop failed. Try closing the device once more below.
        }
        const control = this.control
        if (!closed && control) {
          try { closed = await control(false) } catch { closed = false }
        }
        this.releaseBuffer()
        this.control = closed ? null : control
        this.onStopRequested = null
        this.onProgress = null
        this.stopRequested = false
        this.state = closed ? 'idle' : 'error'
        this.stopping = null
        return closed
      })()
      try {
        return await this.cancelling
      } finally {
        this.cancelling = null
      }
    }
    if (this.state === 'idle' && !this.control) {
      this.releaseBuffer()
      return true
    }
    if (this.state === 'error' && !this.control) {
      this.releaseBuffer()
      this.state = 'idle'
      return true
    }

    ++this.generation
    this.state = 'stopping'
    this.clearTimers()
    this.releaseBuffer()
    const opening = this.opening
    const control = this.control
    let close: Promise<boolean>
    try {
      close = control ? Promise.resolve(control(false)).catch(() => false) : Promise.resolve(true)
    } catch {
      close = Promise.resolve(false)
    }
    this.cancelling = (async () => {
      let closed = await close
      if (opening) await Promise.allSettled([opening])
      this.control = closed ? null : control
      this.onStopRequested = null
      this.onProgress = null
      this.stopRequested = false
      this.state = closed ? 'idle' : 'error'
      if (closed) this.opening = null
      return closed
    })()
    try {
      return await this.cancelling
    } finally {
      this.cancelling = null
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) this.scheduler.clearTimeout(this.idleTimer)
    this.idleTimer = this.scheduler.setTimeout(
      () => this.requestStop('stream_interrupted'), AUDIO_STREAM_IDLE_MS,
    )
  }

  private requestStop(reason: CaptureStopRequest): void {
    if (this.state !== 'recording' || this.stopRequested) return
    this.stopRequested = true
    this.clearTimers()
    try {
      this.onStopRequested?.(reason)
    } catch {
      void this.cancel()
    }
  }

  private clearTimers(): void {
    if (this.durationTimer) this.scheduler.clearTimeout(this.durationTimer)
    if (this.idleTimer) this.scheduler.clearTimeout(this.idleTimer)
    this.durationTimer = null
    this.idleTimer = null
  }

  private releaseBuffer(): void {
    this.buffer?.fill(0)
    this.buffer = null
    this.length = 0
  }
}
