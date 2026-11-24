import {
  AudioInputSource,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  validateEvenHubPageContainer,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { API_BASE } from './config.ts'
import { GlanceAppController } from './app.ts'
import { LatestOnlyDisplayWriter } from './display-writer.ts'
import { parseEvenHubEvent } from './evenhub-events.ts'
import { glassesPageToPayload, glassesPagesHaveSameLayout, type GlassesPage } from './glasses-ui.ts'
import { runtimeMetrics } from './runtime-metrics.ts'
import './style.css'

const appElement = document.querySelector<HTMLElement>('#app')
if (!appElement) throw new Error('Glance app root is missing.')

const app = new GlanceAppController(appElement, API_BASE)
let performanceReportTimer: number | null = null

function schedulePerformanceReport(): void {
  if (!import.meta.env.DEV || performanceReportTimer !== null) return
  performanceReportTimer = window.setTimeout(() => {
    performanceReportTimer = null
    // Counters contain only aggregate numbers; never report page or request content.
    console.info('[Glance performance]', app.getRuntimeMetrics())
  }, 1_000)
}

function validatePage(page: GlassesPage): void {
  const payload = glassesPageToPayload(page)
  const text = payload.textObject ?? []
  const lists = payload.listObject ?? []
  const images = 0
  const total = text.length + lists.length + images
  const captureTargets = [
    ...text.map((container) => container.isEventCapture === 1),
    ...lists.map((container) => container.isEventCapture === 1),
  ].filter(Boolean).length
  const names = [
    ...text.map((container) => container.containerName ?? ''),
    ...lists.map((container) => container.containerName ?? ''),
  ]
  const ids = [
    ...text.map((container) => container.containerID),
    ...lists.map((container) => container.containerID),
  ]
  const validLists = lists.every((container) => {
    const itemContainer = container.itemContainer
    const itemNames = itemContainer?.itemName ?? []
    return itemContainer?.itemCount === itemNames.length && itemNames.length > 0 &&
      itemNames.length <= 20 && itemNames.every((name) => name.length <= 64) &&
      (itemContainer.itemWidth ?? 0) <= (container.width ?? 0)
  })
  const withinCanvas = [...text, ...lists].every((container) =>
    (container.xPosition ?? -1) >= 0 && (container.yPosition ?? -1) >= 0 &&
    (container.xPosition ?? 0) + (container.width ?? 0) <= 576 &&
    (container.yPosition ?? 0) + (container.height ?? 0) <= 288)
  if (payload.containerTotalNum !== total || total < 1 || total > 12 || text.length + lists.length > 8 ||
      images > 4 || !validLists || captureTargets !== 1 || !withinCanvas ||
      names.some((name) => !name || name.length > 16) || new Set(names).size !== names.length ||
      ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) {
    throw new Error('The G2 page does not meet native container constraints.')
  }
  const sdkValidation = validateEvenHubPageContainer(payload)
  if (!sdkValidation.valid) throw new Error(sdkValidation.message)
}

async function connectGlasses(): Promise<void> {
  app.setGlassesStatus('Waiting for Even Hub bridge…')
  try {
    const bridge = await waitForEvenAppBridge()
    app.setGlassesStatus('Even Hub bridge ready · creating G2 page…')

    const initialPage = app.getGlassesPage()
    validatePage(initialPage)
    const initialPayload = glassesPageToPayload(initialPage)
    const startupStarted = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const rawResult = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer(initialPayload),
    )
    const startupFinished = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const result = StartUpPageCreateResult.normalize(rawResult)
    if (result === StartUpPageCreateResult.success) runtimeMetrics.pageCreate(startupFinished - startupStarted)
    console.info('[G2] bridge ready; startup page result', result)

    let pageReady = result === StartUpPageCreateResult.success
    if (!pageReady && result === StartUpPageCreateResult.invalid) {
      // A WebView reload can retain a native page. Rebuild that page in place.
      pageReady = await bridge.rebuildPageContainer(new RebuildPageContainer(initialPayload))
      if (pageReady) runtimeMetrics.pageRebuild()
      console.info('[G2] retained startup page rebuild result', pageReady)
    }
    if (!pageReady) {
      app.setGlassesStatus(`G2 rejected the startup page (${result}).`)
      app.setGlassesAvailable(false)
      return
    }

    app.setPageShutdownControl((exitMode) => bridge.shutDownPageContainer(exitMode))

    let currentPage = initialPage
    let writeFailed = false
    let deviceConnected = true
    let rebuildRequested = false
    const failDisplay = (error: unknown) => {
      if (writeFailed) return
      writeFailed = true
      const detail = error instanceof Error ? error.name : 'bridge error'
      app.setGlassesAvailable(false)
      app.setGlassesStatus(`G2 display update failed (${detail}).`)
    }
    const displayWriter = new LatestOnlyDisplayWriter<GlassesPage>(async (page) => {
      if (writeFailed || !deviceConnected) return
      validatePage(page)
      if (rebuildRequested || !glassesPagesHaveSameLayout(currentPage, page)) {
        const updated = await bridge.rebuildPageContainer(new RebuildPageContainer(glassesPageToPayload(page)))
        if (!updated) throw new Error('G2 page rebuild was rejected.')
        runtimeMetrics.pageRebuild()
        rebuildRequested = false
      } else {
        for (const container of page.textObject) {
          const previous = currentPage.textObject.find((candidate) =>
            candidate.containerID === container.containerID && candidate.containerName === container.containerName)
          if (previous && previous.content === container.content && previous.textColor === container.textColor) continue
          const updated = await bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: container.containerID,
            containerName: container.containerName,
            content: container.content ?? '',
            textColor: container.textColor,
          }))
          if (!updated) throw new Error('G2 text update was rejected.')
          runtimeMetrics.textUpdate()
        }
      }
      currentPage = page
      schedulePerformanceReport()
    }, (left, right) => {
      if (!glassesPagesHaveSameLayout(left, right)) return false
      return JSON.stringify({
        text: left.textObject.map((entry) => [entry.containerID, entry.content, entry.textColor]),
        list: (left.listObject ?? []).map((entry) => entry.itemContainer?.itemName ?? []),
        menu: left.menuObject?.menuItems ?? [],
      }) === JSON.stringify({
        text: right.textObject.map((entry) => [entry.containerID, entry.content, entry.textColor]),
        list: (right.listObject ?? []).map((entry) => entry.itemContainer?.itemName ?? []),
        menu: right.menuObject?.menuItems ?? [],
      })
    }, failDisplay, initialPage)
    const writePage = (page: GlassesPage) => displayWriter.enqueue(page)

    app.setAudioControl((open, source) => open
      ? bridge.audioControl(true, source ?? AudioInputSource.Glasses)
      : bridge.audioControl(false))
    app.setGlassesAvailable(true)
    app.setGlassesWriter(writePage)
    schedulePerformanceReport()

    const unsubscribeDeviceStatus = bridge.onDeviceStatusChanged((status) => {
      if (status.isDisconnected() || status.isConnectionFailed()) {
        deviceConnected = false
        rebuildRequested = true
        displayWriter.invalidate()
        app.setGlassesAvailable(false)
        app.setGlassesStatus('G2 disconnected. Reconnect the glasses to continue.')
        return
      }
      if (status.isConnected() && !deviceConnected) {
        deviceConnected = true
        writeFailed = false
        rebuildRequested = true
        displayWriter.recover()
        app.setGlassesAvailable(true)
        app.setGlassesStatus('G2 reconnected; restoring the display…')
        app.setGlassesWriter(writePage)
      }
    })

    // Keep one shared handler for sys/text/list/audio events. The parser
    // handles omitted CLICK_EVENT=0 and the controller deduplicates echoes.
    const unsubscribe = bridge.onEvenHubEvent((event) => {
      const parsed = parseEvenHubEvent(event)
      if (parsed) void app.handleGlassesInput(parsed)
    })
    window.addEventListener('pagehide', () => {
      if (performanceReportTimer !== null) window.clearTimeout(performanceReportTimer)
      performanceReportTimer = null
      unsubscribe()
      unsubscribeDeviceStatus()
      void app.dispose()
    }, { once: true })
  } catch (error) {
    const detail = error instanceof Error ? error.name : 'bridge error'
    app.setGlassesStatus(`Even Hub display unavailable (${detail}).`)
    app.setGlassesAvailable(false)
  }
}

async function start(): Promise<void> {
  if (import.meta.env.DEV) {
    const preview = await import('./g2-preview.ts')
    const route = preview.readG2PreviewName(window.location.search)
    if (route) {
      await preview.prepareG2Preview(app, route)
      await app.start()
      await connectGlasses()
      return
    }
  }
  void app.start()
  await connectGlasses()
}

void start()
