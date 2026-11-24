import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestOnlyDisplayWriter } from '../src/display-writer.ts'
import { runtimeMetrics } from '../src/runtime-metrics.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

test('G2 bridge updates serialize and replace stale queued pages with the latest state', async () => {
  runtimeMetrics.reset()
  const firstWrite = deferred<void>()
  const written: string[] = []
  const writer = new LatestOnlyDisplayWriter<string>(async (value) => {
    written.push(value)
    if (value === 'inbox') await firstWrite.promise
  }, (left, right) => left === right, (error) => { throw error }, 'initial')

  writer.enqueue('inbox')
  writer.enqueue('case')
  writer.enqueue('draft')
  const idle = writer.idle()
  firstWrite.resolve()
  await idle

  assert.deepEqual(written, ['inbox', 'draft'])
  const metrics = runtimeMetrics.snapshot()
  assert.equal(metrics.maxQueuedBridgeWrites, 1)
  assert.equal(metrics.bridgeUpdatesCoalesced, 1)

  writer.enqueue('draft')
  await writer.idle()
  assert.deepEqual(written, ['inbox', 'draft'])
  assert.equal(runtimeMetrics.snapshot().duplicateUpdatesSkipped, 1)
})

test('G2 bridge writer can recover after a transient rejected write', async () => {
  const written: string[] = []
  let fail = true
  const writer = new LatestOnlyDisplayWriter<string>(async (value) => {
    written.push(value)
    if (fail) throw new Error('bridge unavailable')
  }, (left, right) => left === right, () => {}, 'initial')

  writer.enqueue('failed page')
  await writer.idle()
  fail = false
  writer.recover()
  writer.enqueue('reconnected page')
  await writer.idle()
  assert.deepEqual(written, ['failed page', 'reconnected page'])
})
