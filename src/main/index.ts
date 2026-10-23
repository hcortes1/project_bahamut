import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { describeUrl, isAllowedUrl } from './security'

// Dev and packaged builds must never share a data folder. The override is
// honoured only in unpackaged builds (tests, dev).
if (!app.isPackaged) {
  const override = process.env['FLUJO_USER_DATA_DIR']
  app.setPath('userData', override ? resolve(override) : join(app.getPath('appData'), 'Flujo-dev'))
}

// Per-userData lock: a second instance on the same data folder quits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
const reportedHosts = new Set<string>()

function policy(): { packaged: boolean; devUrl: string | undefined } {
  return { packaged: app.isPackaged, devUrl: process.env['ELECTRON_RENDERER_URL'] }
}

function reportBlocked(url: string): void {
  const target = describeUrl(url)
  console.error(`Blocked non-local request: ${target}`)
  if (!app.isPackaged && process.env['FLUJO_SUPPRESS_DIALOGS'] !== '1' && !reportedHosts.has(target)) {
    reportedHosts.add(target)
    dialog.showErrorBox('Flujo: blocked request (dev)', `A non-local request was blocked: ${target}`)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  })
  mainWindow = win
  win.on('closed', () => {
    mainWindow = null
  })
  win.once('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null)

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedUrl(details.url, policy())) {
      callback({})
    } else {
      reportBlocked(details.url)
      callback({ cancel: true })
    }
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
