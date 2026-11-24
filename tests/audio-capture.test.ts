import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import {
  AUDIO_STREAM_IDLE_MS,
  AudioCaptureError,
  G2PcmCapture,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_MS,
  type CaptureScheduler,
  type CaptureStopRequest,
} from '../src/audio-capture.ts'

class FakeScheduler implements CaptureScheduler {
  private next = 1
  private time = 0
  private readonly timers = new Map<number, { callback: () => void; delay: number }>()
  now(): number { return this.time }
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = this.next++
    this.timers.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(Number(handle))
  }
  advance(milliseconds: number): void {
    this.time += milliseconds
    for (const [id, timer] of [...this.timers]) {
      if (timer.delay <= milliseconds) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }
}

function makeControl(openResult = true) {
  const calls: Array<{ open: boolean; source?: AudioInputSource }> = []
  const control = async (open: boolean, source?: AudioInputSource): Promise<boolean> => {
    calls.push({ open, source })
    return open ? openResult : true
  }
  return { calls, control }
}

test('capture only accepts glasses PCM and copies chunks before retaining them', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  const { calls, control } = makeControl()
  const stops: CaptureStopRequest[] = []
  assert.equal(await capture.start(control, (reason) => stops.push(reason)), true)
  assert.deepEqual(calls[0], { open: true, source: AudioInputSource.Glasses })

  assert.deepEqual(capture.receive(AudioInputSource.Phone, new Uint8Array([9, 9])), { acceptedBytes: 0, ignored: true })
  const chunk = new Uint8Array([1, 2, 3, 4])
  assert.deepEqual(capture.receive(AudioInputSource.Glasses, chunk), { acceptedBytes: 4, ignored: false })
  chunk.fill(0)
  const result = await capture.stop()
  assert.deepEqual([...result!.pcm], [1, 2, 3, 4])
  assert.equal(result!.durationMs, 0)
  assert.deepEqual(stops, [])
  assert.equal(calls[1].open, false)
  result!.pcm.fill(0)
})

test('capture accepts exactly 1,280,000 bytes and truncates an oversized final chunk at the cap', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  const { control } = makeControl()
  const stops: CaptureStopRequest[] = []
  await capture.start(control, (reason) => stops.push(reason))
  const prefix = new Uint8Array([7, 8])
  capture.receive(AudioInputSource.Glasses, prefix)
  const oversized = new Uint8Array(MAX_CAPTURE_BYTES + 20).fill(5)
  const received = capture.receive(AudioInputSource.Glasses, oversized)
  assert.equal(received.acceptedBytes, MAX_CAPTURE_BYTES - 2)
  assert.equal(capture.byteLength, MAX_CAPTURE_BYTES)
  assert.equal(capture.durationMs, 40_000)
  assert.deepEqual(stops, ['size_limit'])
  const captured = await capture.stop('size_limit')
  assert.equal(captured?.pcm.byteLength, MAX_CAPTURE_BYTES)
  assert.equal(captured?.durationMs, 40_000)
  captured?.pcm.fill(0)
})

test('exact maximum-sized event is bounded and later events are ignored', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  const { control } = makeControl()
  const stops: CaptureStopRequest[] = []
  await capture.start(control, (reason) => stops.push(reason))
  const chunk = new Uint8Array(MAX_CAPTURE_BYTES).fill(4)
  assert.equal(capture.receive(AudioInputSource.Glasses, chunk).acceptedBytes, MAX_CAPTURE_BYTES)
  assert.deepEqual(stops, ['size_limit'])
  assert.equal(capture.receive(AudioInputSource.Glasses, new Uint8Array([1, 2])).ignored, true)
  const captured = await capture.stop('size_limit')
  assert.equal(captured?.pcm.byteLength, MAX_CAPTURE_BYTES)
  captured?.pcm.fill(0)
})

test('odd chunks stop as invalid audio without retaining partial PCM', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  const { control } = makeControl()
  const stops: CaptureStopRequest[] = []
  await capture.start(control, (reason) => stops.push(reason))
  capture.receive(AudioInputSource.Glasses, new Uint8Array([1, 2, 3]))
  assert.deepEqual(stops, ['invalid_audio'])
  assert.equal(capture.byteLength, 0)
  await capture.cancel()
  assert.equal(capture.phase, 'idle')
})

test('duration and interrupted-stream limits request stop and release capture on cancellation', async () => {
  const durationScheduler = new FakeScheduler()
  const durationCapture = new G2PcmCapture(durationScheduler)
  const durationStops: CaptureStopRequest[] = []
  const durationControl = makeControl()
  await durationCapture.start(durationControl.control, (reason) => durationStops.push(reason))
  durationCapture.receive(AudioInputSource.Glasses, new Uint8Array(32_000))
  durationScheduler.advance(MAX_CAPTURE_MS)
  assert.deepEqual(durationStops, ['duration_limit'])
  const durationResult = await durationCapture.stop('duration_limit')
  assert.equal(durationResult?.durationMs, 1_000)
  durationResult?.pcm.fill(0)

  const idleScheduler = new FakeScheduler()
  const idleCapture = new G2PcmCapture(idleScheduler)
  const idleStops: CaptureStopRequest[] = []
  const idleControl = makeControl()
  await idleCapture.start(idleControl.control, (reason) => idleStops.push(reason))
  idleScheduler.advance(AUDIO_STREAM_IDLE_MS)
  assert.deepEqual(idleStops, ['stream_interrupted'])
  await idleCapture.cancel()
  assert.equal(idleCapture.phase, 'idle')
  assert.equal(idleCapture.byteLength, 0)
  assert.equal(idleControl.calls.at(-1)?.open, false)
})

test('duplicate start is rejected and cancellation during startup closes a late-opened microphone', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  let resolveOpen!: (value: boolean) => void
  const calls: Array<{ open: boolean; source?: AudioInputSource }> = []
  const control = (open: boolean, source?: AudioInputSource) => {
    calls.push({ open, source })
    return open ? new Promise<boolean>((resolve) => { resolveOpen = resolve }) : Promise.resolve(true)
  }
  const first = capture.start(control, () => {})
  assert.equal(capture.phase, 'starting')
  assert.equal(await capture.start(control, () => {}), false)
  const cancelling = capture.cancel()
  resolveOpen(true)
  assert.equal(await first, false)
  await cancelling
  assert.equal(capture.phase, 'idle')
  assert.ok(calls.filter((call) => !call.open).length >= 1)
  assert.equal(capture.receive(AudioInputSource.Glasses, new Uint8Array([1, 2])).ignored, true)
})

test('concurrent stop requests close the microphone once and late events are ignored', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  let finishClose!: (value: boolean) => void
  let closes = 0
  const control = (open: boolean) => {
    if (open) return Promise.resolve(true)
    closes += 1
    return new Promise<boolean>((resolve) => { finishClose = resolve })
  }
  await capture.start(control, () => {})
  capture.receive(AudioInputSource.Glasses, new Uint8Array([11, 12]))
  const first = capture.stop()
  const second = capture.stop()
  assert.equal(closes, 1)
  finishClose(true)
  const [one, two] = await Promise.all([first, second])
  assert.equal(one, two)
  assert.equal(capture.receive(AudioInputSource.Glasses, new Uint8Array([2, 3])).ignored, true)
  one?.pcm.fill(0)
})

test('unconfirmed stop clears PCM, ignores later events, and retries microphone cleanup', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  let allowClose = false
  let closes = 0
  const control = async (open: boolean): Promise<boolean> => {
    if (open) return true
    closes += 1
    return allowClose
  }
  await capture.start(control, () => {})
  capture.receive(AudioInputSource.Glasses, new Uint8Array([1, 2]))

  await assert.rejects(capture.stop(), (error: unknown) => {
    assert.ok(error instanceof AudioCaptureError)
    assert.equal(error.code, 'microphone_stop_failed')
    return true
  })
  assert.equal(capture.phase, 'error')
  assert.equal(capture.byteLength, 0)
  assert.equal(capture.receive(AudioInputSource.Glasses, new Uint8Array([3, 4])).ignored, true)

  allowClose = true
  assert.equal(await capture.cancel(), true)
  assert.equal(capture.phase, 'idle')
  assert.equal(closes, 2)
})

test('failed microphone activation reports a bounded capture error', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  const { control } = makeControl(false)
  assert.equal(await capture.start(control, () => {}), false)
  assert.equal(capture.phase, 'idle')
  assert.equal(capture.byteLength, 0)

  await assert.rejects(capture.start(async () => { throw new Error('private SDK details') }, () => {}), (error: unknown) => {
    assert.ok(error instanceof AudioCaptureError)
    assert.equal(error.code, 'microphone_start_failed')
    assert.doesNotMatch(error.message, /private SDK details/)
    return true
  })
})

test('failed activation retains control after an unconfirmed shutdown and retries cleanup', async () => {
  const capture = new G2PcmCapture(new FakeScheduler())
  let closeCount = 0
  let allowClose = false
  const control = async (open: boolean): Promise<boolean> => {
    if (open) throw new Error('private SDK detail')
    closeCount += 1
    return allowClose
  }

  await assert.rejects(capture.start(control, () => {}), (error: unknown) => {
    assert.ok(error instanceof AudioCaptureError)
    assert.equal(error.code, 'microphone_start_failed')
    assert.doesNotMatch(error.message, /private SDK detail/)
    return true
  })
  assert.equal(capture.phase, 'error')
  assert.equal(await capture.cancel(), false)
  assert.equal(capture.phase, 'error')
  assert.equal(closeCount, 2)

  allowClose = true
  assert.equal(await capture.cancel(), true)
  assert.equal(capture.phase, 'idle')
  assert.equal(closeCount, 3)
})
