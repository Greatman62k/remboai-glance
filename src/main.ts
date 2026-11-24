import {
  AudioInputSource,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { API_BASE } from './config.ts'
import { GlanceAppController } from './app.ts'
import { parseEvenHubEvent } from './evenhub-events.ts'
import './style.css'

const appElement = document.querySelector<HTMLElement>('#app')
if (!appElement) throw new Error('Glance app root is missing.')

const app = new GlanceAppController(appElement, API_BASE)
void app.start()

async function connectGlasses(): Promise<void> {
  app.setGlassesStatus('Waiting for Even Hub bridge…')
  try {
    const bridge = await waitForEvenAppBridge()
    app.setGlassesStatus('Even Hub bridge ready · creating G2 display…')
    const initialText = app.getGlassText() || 'REMBOAI GLANCE'
    const container = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      containerID: 2,
      containerName: 'text-1',
      borderWidth: 1,
      borderColor: 8,
      borderRadius: 2,
      paddingLength: 12,
      isEventCapture: 1,
      content: initialText,
    })
    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [container] }),
    )
    let pageReady = StartUpPageCreateResult.normalize(result) === StartUpPageCreateResult.success
    if (!pageReady && StartUpPageCreateResult.normalize(result) === StartUpPageCreateResult.invalid) {
      // A WebView reload can retain the native Even Hub page. Rebuild it in
      // place when create reports "invalid"; malformed layouts still fail here.
      pageReady = await bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: 1, textObject: [container] }),
      )
    }
    if (!pageReady) {
      app.setGlassesStatus(`G2 display was rejected by SDK (${String(result)}).`)
      app.setGlassesAvailable(false)
      return
    }
    app.setAudioControl((open, source) => open
      ? bridge.audioControl(true, source ?? AudioInputSource.Glasses)
      : bridge.audioControl(false))
    app.setGlassesAvailable(true)
    app.setGlassesWriter((content) => {
      void bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: 2,
        containerName: 'text-1',
        content,
      })).then((success) => {
        if (!success) {
          app.setGlassesStatus('G2 text update was not accepted by Even Hub.')
          app.setGlassesAvailable(false)
        }
      }).catch(() => {
        app.setGlassesStatus('G2 text update failed.')
        app.setGlassesAvailable(false)
      })
    })
    const unsubscribe = bridge.onEvenHubEvent((event) => {
      const parsed = parseEvenHubEvent(event)
      if (parsed) void app.handleGlassesInput(parsed)
    })
    window.addEventListener('pagehide', () => {
      unsubscribe()
      void app.dispose()
    }, { once: true })
  } catch (error) {
    const detail = error instanceof Error ? error.name : 'bridge error'
    app.setGlassesStatus(`Even Hub display unavailable (${detail}).`)
    app.setGlassesAvailable(false)
  }
}

void connectGlasses()
