import { app, BrowserWindow, ipcMain, globalShortcut, Menu, dialog } from 'electron'
import { join } from 'node:path'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { SERVICE_NAME, normalizeWebmailUrl, type Service, type Settings } from '../shared'
import * as acc from './accounts'
import { installNotifications } from './notifications'
import { installHttpAuth, forgetAllCreds } from './httpauth'
import * as st from './store'
import { createTray, updateTray } from './tray'
import { createWindow, mainWindow, setQuitting, showWindow } from './window'

app.setName('Mailwrap')
if (process.platform === 'win32') app.setAppUserModelId('fun.integra.mailwrap')
if (process.platform === 'linux') app.commandLine.appendSwitch('class', 'mailwrap')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(main)
}

function broadcast(channel: string, ...args: unknown[]): void {
  mainWindow()?.webContents.send(channel, ...args)
}

function refresh(): void {
  const accounts = st.store.get('accounts')
  broadcast('accounts', accounts)
  broadcast('active', acc.getActive())
  for (const [id, n] of acc.unreadMap()) broadcast('unread', id, n)
  updateTray(accounts, acc.unreadMap(), (id) => acc.setActive(id))
}

async function applyAutostart(enabled: boolean): Promise<void> {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    return
  }
  const dir = join(app.getPath('home'), '.config', 'autostart')
  const file = join(dir, 'mailwrap.desktop')
  if (!enabled) {
    await unlink(file).catch(() => undefined)
    return
  }
  const exec = process.env.APPIMAGE ?? process.execPath
  await mkdir(dir, { recursive: true })
  await writeFile(
    file,
    `[Desktop Entry]\nType=Application\nName=Mailwrap\nExec="${exec}" --hidden\nIcon=mailwrap\nX-GNOME-Autostart-enabled=true\n`
  )
}

function main(): void {
  const hidden = process.argv.includes('--hidden') || st.store.get('settings').startMinimized
  const win = createWindow(!hidden)
  createTray()
  installNotifications()
  installHttpAuth()
  acc.onChange(refresh)
  acc.attach(win)
  win.webContents.on('did-finish-load', refresh)

  ipcMain.handle('accounts:list', () => st.store.get('accounts'))
  ipcMain.handle('accounts:active', () => acc.getActive())
  ipcMain.handle('accounts:add', (_e, service: Service, label: string, url?: string) => {
    if (!Object.hasOwn(SERVICE_NAME, service)) throw new Error(`unknown service ${service}`)
    let webmail: string | undefined
    if (service === 'roundcube') {
      webmail = normalizeWebmailUrl(url ?? '') ?? undefined
      if (!webmail) throw new Error('invalid webmail address')
    }
    const a = st.addAccount(service, label, webmail)
    acc.ensureView(a)
    acc.setActive(a.id)
    refresh()
    return a
  })
  ipcMain.handle('accounts:remove', (_e, id: string) => {
    acc.destroyView(id)
    st.removeAccount(id)
    refresh()
  })
  ipcMain.handle('accounts:rename', (_e, id: string, label: string) => {
    st.renameAccount(id, label)
    refresh()
  })
  ipcMain.handle('accounts:move', (_e, id: string, dir: -1 | 1) => {
    st.moveAccount(id, dir)
    refresh()
  })
  ipcMain.handle('accounts:setActive', (_e, id: string) => acc.setActive(id))
  ipcMain.handle('accounts:reload', (_e, id: string) => acc.reload(id))
  ipcMain.handle('settings:get', () => st.store.get('settings'))
  ipcMain.handle('settings:set', async (_e, s: Partial<Settings>) => {
    const merged = { ...st.store.get('settings'), ...s }
    st.store.set('settings', merged)
    if (s.autostart !== undefined) await applyAutostart(s.autostart)
    return merged
  })
  ipcMain.handle('auth:forget', () => forgetAllCreds())
  ipcMain.on('overlay', (_e, open: boolean) => acc.setOverlay(open))
  ipcMain.on('accounts:ctx', (_e, id: string, x: number, y: number) => {
    const a = st.store.get('accounts').find((x) => x.id === id)
    if (!a) return
    const menu = Menu.buildFromTemplate([
      { label: 'Reload', click: () => acc.reload(id) },
      { label: 'Rename…', click: () => broadcast('rename', id) },
      { label: 'Developer tools', click: () => acc.openDevTools(id) },
      { type: 'separator' },
      { label: 'Move up', click: () => { st.moveAccount(id, -1); refresh() } },
      { label: 'Move down', click: () => { st.moveAccount(id, 1); refresh() } },
      { type: 'separator' },
      {
        label: 'Remove account',
        click: async () => {
          const r = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Remove', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: `Remove account "${a.label}"?`,
            detail: 'Its login session will be deleted.'
          })
          if (r.response === 0) {
            acc.destroyView(id)
            st.removeAccount(id)
            refresh()
          }
        }
      }
    ])
    menu.popup({ window: win, x, y })
  })
  ipcMain.on('debug', (e, msg: string) => {
    if (!process.env.MAILWRAP_DEBUG) return
    const id = acc.accountForContents(e.sender.id)
    const label = st.store.get('accounts').find((a) => a.id === id)?.label ?? '?'
    console.log(`[mailwrap] ${label}: ${msg}`)
  })
  ipcMain.on('unread', (e, n: number) => {
    const id = acc.accountForContents(e.sender.id)
    if (id) acc.setUnread(id, n)
  })

  // Keyboard shortcuts scoped to the window (not global): handled via before-input-event on each view + shell.
  const handleKey = (input: Electron.Input, e: Electron.Event): void => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    if (!ctrl) return
    if (/^[1-9]$/.test(input.key)) {
      const a = st.store.get('accounts')[Number(input.key) - 1]
      if (a) acc.setActive(a.id)
      e.preventDefault()
    } else if (input.key === 'Tab') {
      acc.cycle(input.shift ? -1 : 1)
      e.preventDefault()
    } else if (input.key.toLowerCase() === 'q') {
      setQuitting(true)
      app.quit()
    }
  }
  win.webContents.on('before-input-event', (e, input) => handleKey(input, e))
  app.on('web-contents-created', (_e, wc) => {
    wc.on('before-input-event', (e, input) => handleKey(input, e))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(true)
    else showWindow()
  })
  app.on('before-quit', () => setQuitting(true))
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('window-all-closed', () => {
    /* keep running in tray */
  })

  if (process.env.MAILWRAP_SELFTEST) selfTest(win)
}

/** MAILWRAP_SELFTEST=1: exercise show → close(X) → hidden → tray restore → quit, print results. */
function selfTest(win: BrowserWindow): void {
  const logFile = join(app.getPath('userData'), 'selftest.log')
  const log = (m: string): void => {
    console.log(`[selftest] ${m}`)
    appendFileSync(logFile, `[selftest] ${m}\n`)
  }
  try {
    writeFileSync(logFile, '')
  } catch {
    /* ignore */
  }
  win.once('show', async () => {
    try {
      const a = st.addAccount('gmail', 'Test')
      const v = acc.ensureView(a)
      acc.setActive(a.id)
      await new Promise<void>((r) => v.webContents.once('did-finish-load', () => r()))
      log(`gmail view loaded: ${v.webContents.getURL()}`)
      log(`ua: ${v.webContents.getUserAgent()} (expect Electron/ token present)`)
      const perm = await v.webContents.executeJavaScript('Notification.permission + " " + Notification.name')
      log(`page Notification: ${perm} (expect "granted MailwrapNotification")`)
      const got = new Promise<string>((r) => ipcMain.once('notify', (_e, p) => r(p.title)))
      await v.webContents.executeJavaScript('new Notification("Mailwrap self-test", {body: "notify path works"}); 1')
      log(`notify IPC received: ${await Promise.race([got, new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 3000))])}`)
      const { accountIcon } = await import('./icons')
      const ic = await accountIcon(a)
      log(`account icon rendered: ${!ic.isEmpty()} ${ic.getSize().width}x${ic.getSize().height} (expect true 128x128)`)
      await v.webContents.executeJavaScript('document.title = "Inbox (7) - test - Gmail"; 1')
      await new Promise((r) => setTimeout(r, 500))
      log(`unread parsed: ${acc.unreadMap().get(a.id)} (expect 7)`)
      // Outlook-style synthetic notifications from a fake message list served locally.
      const page = `<!doctype html><title>(0) Mail - Outlook</title><div id="l">
        <div role="option" data-convid="p1" aria-label="Przypięte Boss Pinned subject">pinned</div>
        <div role="option" data-convid="a1" aria-label="Old Sender Old subject">old</div></div>
        <script>window.addNew = () => { const d = document.createElement('div'); d.setAttribute('role','option');
          d.setAttribute('data-convid','n1'); d.setAttribute('aria-label','Nieprzeczytane Jan Kowalski Test subject Preview text');
          d.innerHTML = '<span>Nieprzeczytane</span><span title="jan@example.com">Jan Kowalski</span><span>00:47</span><span title="So, 14.11.2026 00:48">00:48</span><span>Preview text</span>';
          document.getElementById('l').insertBefore(d, document.querySelector('[data-convid=a1]')); document.title = '(1) Mail - Outlook'; }</script>`
      const srv = createServer((_q, r) => r.end(page)).listen(0, '127.0.0.1')
      await new Promise((r) => srv.once('listening', r))
      const port = (srv.address() as { port: number }).port
      v.webContents.loadURL(`http://127.0.0.1:${port}/`)
      await new Promise<void>((r) => v.webContents.once('did-finish-load', () => r()))
      await new Promise((r) => setTimeout(r, 3000)) // let primeSeen run
      const synth = new Promise<string>((r) => ipcMain.once('notify', (_e, p) => r(`${p.title} / ${p.body}`)))
      await v.webContents.executeJavaScript('addNew(); 1')
      log(`outlook synthetic: ${await Promise.race([synth, new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 6000))])} (expect Jan Kowalski / 00:47)`)
      // Navigation policy: leaving the mail app goes to the system browser, the view stays put.
      const handed: string[] = []
      acc.setOpenExternal((u) => handed.push(u))
      const before = v.webContents.getURL()
      await v.webContents.executeJavaScript('window.open("https://docs.google.com/document/d/x"); 1')
      await v.webContents.executeJavaScript('location.href = "https://www.google.com/maps"; 1')
      await new Promise((r) => setTimeout(r, 2000))
      log(`external hand-offs: ${handed.length} (expect 2) -> ${handed.join(' , ')}`)
      log(`view stayed: ${v.webContents.getURL() === before} (expect true)`)
      srv.close()
      acc.extraInside.add('httpbin.org')
      // HTTP auth prompt: answer it from here as the user would.
      const promptSeen = new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), 15000)
        app.on('browser-window-created', (_e, w) => {
          if (w.getTitle() === 'Sign in') {
            clearTimeout(t)
            setTimeout(() => ipcMain.emit('auth:submit', {}, 'user', 'pass', false), 800)
            r(true)
          }
        })
      })
      v.webContents.loadURL('https://httpbin.org/basic-auth/user/pass')
      log(`auth prompt shown: ${await promptSeen} (expect true)`)
      await new Promise<void>((r) => v.webContents.once('did-finish-load', () => r()))
      const body = await v.webContents.executeJavaScript('document.body.innerText')
      log(`auth result: ${/authenticated.*true/.test(body)} (expect true) body=${body.slice(0, 120).replace(/\n/g, ' ')} url=${v.webContents.getURL()}`)
    } catch (e) {
      log(`ERROR ${e}`)
    }
    setTimeout(() => {
      log(`visible after start: ${win.isVisible()}`)
      win.close() // simulates the X button
      setTimeout(() => {
        log(`visible after close(): ${win.isVisible()} (expect false), destroyed: ${win.isDestroyed()} (expect false)`)
        showWindow()
        setTimeout(() => {
          log(`visible after tray restore: ${win.isVisible()} (expect true)`)
          setQuitting(true)
          app.quit()
        }, 500)
      }, 500)
    }, 1500)
  })
}
