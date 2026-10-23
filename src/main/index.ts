import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron'
import { toIsoDate } from '@shared/dates'
import { AuthManager, SessionManager, type AuthStore } from './auth'
import { SqliteAuthStore } from './auth/sqlite-store'
import { openAndMigrate, type Db } from './db'
import { ImportStore, type IpcContext } from './ipc/context'
import { readImportFile } from './ipc/import-file'
import { readSettings } from './ipc/handlers/settings'
import { createOptimizerRunner } from './ipc/optimizer-runner'
import { registerIpc } from './ipc/register'
import { resetDatabase } from './ipc/wipe'
import { describeUrl, isAllowedUrl, isAppFrameUrl } from './security'

// Dev and packaged builds must never share a data folder. The override is
// honoured only in unpackaged builds (tests, dev).
if (!app.isPackaged) {
  const override = process.env['FLUJO_USER_DATA_DIR']
  app.setPath('userData', override ? resolve(override) : join(app.getPath('appData'), 'Flujo-dev'))
}

// Per-userData lock: a second instance on the same data folder quits.
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let sessionManager: SessionManager | null = null
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

const unpacked = (p: string): string => p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')

/** Open DB, auth, session and IPC. Returns false (after telling the user) if the database cannot be used. */
function startBackend(): boolean {
  const dbPath = join(app.getPath('userData'), 'flujo.db')
  const retainDir = join(app.getPath('userData'), 'imports')
  let db: Db
  try {
    db = openAndMigrate(dbPath).db
  } catch (e) {
    console.error(`Database open failed: ${(e as { code?: string }).code ?? 'UNKNOWN'}`)
    dialog.showErrorBox('Flujo', 'The database could not be opened. No data was changed.')
    return false
  }

  // The store follows the current handle, which data wipes replace.
  const authStore: AuthStore = {
    get: () => new SqliteAuthStore(db).get(),
    set: (r) => new SqliteAuthStore(db).set(r)
  }
  const settings = readSettings(db)
  const session = new SessionManager({ idleTimeoutMs: settings.idleTimeoutMs, lockOnMinimize: settings.lockOnMinimize })
  sessionManager = session

  const ctx: IpcContext = {
    get db() {
      return db
    },
    auth: new AuthManager({ store: authStore }),
    session,
    imports: new ImportStore(),
    lastOptimizer: null,
    retainDir,
    runOptimizer: createOptimizerRunner(unpacked(join(__dirname, 'optimizer-worker.js'))),
    async pickImportFile() {
      const win = mainWindow
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        title: 'Import statement',
        properties: ['openFile'],
        filters: [{ name: 'Statements', extensions: ['pdf', 'csv', 'txt'] }]
      })
      const path = res.filePaths[0]
      if (res.canceled || !path) return null
      return readImportFile(path)
    },
    async chooseSavePath(defaultName) {
      const win = mainWindow
      if (!win) return null
      const res = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      return res.canceled || !res.filePath ? null : res.filePath
    },
    writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    resetDatabase() {
      resetDatabase({
        dbPath,
        retainDir,
        db,
        open: (p) => openAndMigrate(p).db,
        setDb(next) {
          db = next
          // The reopened database may hold different settings (a wipe resets them to defaults).
          const s = readSettings(db)
          session.configure({ idleTimeoutMs: s.idleTimeoutMs, lockOnMinimize: s.lockOnMinimize })
        },
        onFatal() {
          dialog.showErrorBox('Flujo', 'The database could not be reopened. Flujo will close.')
          app.quit()
        }
      })
    },
    today() {
      const d = new Date()
      return toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
    },
    getWebContents: () => mainWindow?.webContents ?? null,
    isAppUrl: (url) =>
      isAppFrameUrl(url, {
        indexFileUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).href,
        devUrl: process.env['ELECTRON_RENDERER_URL'],
        packaged: app.isPackaged
      }),
    emit(channel, payload) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    }
  }
  registerIpc(ipcMain, ctx)
  return true
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
  win.on('minimize', () => sessionManager?.notifyMinimize())
  // Idle timer is driven by real user input in the window (keyboard, mouse, touch), never by IPC traffic.
  win.webContents.on('input-event', () => sessionManager?.activity())

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
  if (!gotInstanceLock) return
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
  if (!startBackend()) {
    app.quit()
    return
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
