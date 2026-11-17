import { BrowserWindow, WebContentsView, session, shell, app, Session } from 'electron'

/** Indirection so the self-test can observe hand-offs to the system browser. */
export let openExternal: (url: string) => void = (url) => void shell.openExternal(url)
export function setOpenExternal(fn: (url: string) => void): void {
  openExternal = fn
}
/** Extra hosts treated as inside (self-test only). */
export const extraInside = new Set<string>()
const inside = (h: string): boolean => staysInside(h) || extraInside.has(h)
import { join } from 'node:path'
import { AUTH_HOST_RE, MAIL_HOST_RE, ownHost, startUrl, staysInside, type Account } from '../shared'
import { installContextMenu } from './contextmenu'
import { partitionFor, store } from './store'
import { SIDEBAR_WIDTH } from './window'

const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 30000

const views = new Map<string, WebContentsView>()
const unread = new Map<string, number>()
let activeId: string | null = null
let overlayOpen = false
let host: BrowserWindow | null = null

export type Listener = () => void
const listeners = new Set<Listener>()
export function onChange(l: Listener): void {
  listeners.add(l)
}
function emit(): void {
  listeners.forEach((l) => l())
}

/**
 * User agent: left as Electron's default on purpose. Google's "This browser or app may not be
 * secure" check (2026) rejects a UA that is rewritten to look like plain Chrome while client hints
 * and navigator.userAgentData still say Electron; the honest `Chrome/… Electron/… Safari/…` UA
 * passes. See stablyai/orca#11518 and #36519.
 */
export function userAgent(): string {
  return session.defaultSession.getUserAgent()
}

function configureSession(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'notifications' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
  })
  s.setPermissionCheckHandler((_wc, permission) => permission === 'notifications' || permission === 'clipboard-sanitized-write')
  s.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
  })
}

export function attach(window: BrowserWindow): void {
  host = window
  window.on('resize', layout)
  window.on('maximize', layout)
  window.on('unmaximize', layout)
  window.on('enter-full-screen', layout)
  window.on('leave-full-screen', layout)
  for (const a of store.get('accounts')) ensureView(a)
  const saved = store.get('activeId')
  const first = store.get('accounts')[0]?.id ?? null
  setActive(saved && views.has(saved) ? saved : first)
}

function layout(): void {
  if (!host) return
  const [w, h] = host.getContentSize()
  for (const [id, v] of views) {
    v.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, w - SIDEBAR_WIDTH), height: h })
    v.setVisible(id === activeId && !overlayOpen)
  }
}

export function ensureView(acct: Account): WebContentsView {
  let v = views.get(acct.id)
  if (v) return v
  const s = session.fromPartition(partitionFor(acct.id))
  configureSession(s)
  v = new WebContentsView({
    webPreferences: {
      session: s,
      preload: join(__dirname, '../preload/mail.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
      additionalArguments: [`--mailwrap-account=${acct.id}`, ...(process.env.MAILWRAP_SELFTEST ? ['--mailwrap-fake-outlook'] : []), ...(process.env.MAILWRAP_DEBUG ? ['--mailwrap-debug'] : [])]
    }
  })
  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  }
  // A self-hosted webmail (Roundcube) is this account's mail app: its host stays inside this view.
  // It opens messages, compose and attachment previews in windows of its own, kept in this session.
  const own = ownHost(acct)
  const ownWindow = {
    action: 'allow' as const,
    overrideBrowserWindowOptions: { webPreferences: { session: s, sandbox: true, contextIsolation: true }, autoHideMenuBar: true }
  }
  const isMail = (h: string): boolean => MAIL_HOST_RE.test(h) || (!!own && h === own)
  const insideView = (h: string): boolean => inside(h) || isMail(h)
  installContextMenu(v.webContents, () => host, (url) => openExternal(url))
  // Sign-in chain: entered when the view reaches a sign-in host, left when it is back on the mail app.
  // Federated identity providers (e.g. a corporate ADFS) live on arbitrary hosts in between.
  let inAuthChain = false
  const onAuthHost = (): boolean => inAuthChain || AUTH_HOST_RE.test(hostOf(v!.webContents.getURL()))
  const external = (url: string, via: string): void => {
    if (process.env.MAILWRAP_DEBUG) console.log(`[mailwrap] external (${via}) from ${v!.webContents.getURL()} -> ${url}`)
    openExternal(url)
  }
  v.webContents.setWindowOpenHandler(({ url }) => {
    const h = hostOf(url)
    if (!h) return { action: 'deny' } // about:blank etc.
    if (AUTH_HOST_RE.test(h)) {
      // OAuth / account-chooser popups must stay inside the same session.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: { session: s, sandbox: true, contextIsolation: true },
          autoHideMenuBar: true
        }
      }
    }
    if (own && h === own) return ownWindow // Roundcube: message, compose, attachment windows
    if (MAIL_HOST_RE.test(h)) {
      // e.g. sign-in flow finishing with window.open(mail.google.com): show it in this view.
      load(url)
      return { action: 'deny' }
    }
    external(url, 'window.open')
    return { action: 'deny' }
  })
  // Auth popups: fold the mail app back into the view; anything else leaving the sign-in hosts goes external.
  v.webContents.on('did-create-window', (popup, details) => {
    installContextMenu(popup.webContents, () => popup, (url) => openExternal(url))
    if (own && hostOf(details.url) === own) {
      // Roundcube's own window: stays open on its host; links elsewhere go to the system browser.
      popup.webContents.setWindowOpenHandler(({ url }) => {
        if (hostOf(url) === own) return ownWindow
        if (/^https?:/.test(url)) external(url, 'window.open')
        return { action: 'deny' }
      })
      popup.webContents.on('will-navigate', (e, url) => {
        if (hostOf(url) === own) return
        e.preventDefault()
        if (/^https?:/.test(url)) external(url, 'navigate')
      })
      return
    }
    const route = (e: Electron.Event | null, url: string): void => {
      const h = hostOf(url)
      if (MAIL_HOST_RE.test(h)) {
        e?.preventDefault()
        load(url)
        popup.close()
      } else if (h && !AUTH_HOST_RE.test(h) && !AUTH_HOST_RE.test(hostOf(popup.webContents.getURL()))) {
        e?.preventDefault()
        external(url, 'popup')
        popup.close()
      }
    }
    popup.webContents.on('will-navigate', (e, url) => route(e, url))
    popup.webContents.on('did-navigate', (_e, url) => route(null, url))
  })
  // The chain must start when a navigation *towards* a sign-in host begins: Microsoft's authorize
  // endpoint answers with a 302 straight to the federated IdP, so the view never "lands" on it.
  const noteAuth = (url: string): void => {
    if (AUTH_HOST_RE.test(hostOf(url))) inAuthChain = true
  }
  v.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) noteAuth(details.url)
  })
  v.webContents.on('did-redirect-navigation', (details) => {
    if (details.isMainFrame) noteAuth(details.url)
  })
  v.webContents.on('will-navigate', (e, url) => {
    const h = hostOf(url)
    noteAuth(url)
    if (!h || insideView(h)) return
    // Never break a sign-in flow: while the view sits on an auth host, let any redirect through
    // (federated IdPs such as a corporate ADFS live on arbitrary hosts).
    if (onAuthHost()) return
    e.preventDefault()
    external(url, 'navigate')
  })
  // A redirect chain can land on a foreign host without a will-navigate we could veto (e.g. a mail link
  // resolved server-side). If the view ends up outside the allowed hosts, hand it over and go back.
  v.webContents.on('did-navigate', (_e, url) => {
    const h = hostOf(url)
    if (AUTH_HOST_RE.test(h)) inAuthChain = true
    else if (isMail(h)) inAuthChain = false
    if (!h || insideView(h) || inAuthChain || h === '127.0.0.1' || h === 'localhost') return
    if (/^https?:/.test(url)) external(url, 'landed')
    if (v!.webContents.canGoBack()) v!.webContents.goBack()
    else load(startUrl(acct))
  })
  v.webContents.on('render-process-gone', () => v?.webContents.reload())
  // A main-frame load that fails (typically: started at login before the network is up) leaves a
  // blank white page and nothing tries again. Retry with backoff until a page actually loads.
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelay = RETRY_MIN_MS
  v.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 ERR_ABORTED: superseded by another navigation, or turned into a download. Not a failure.
    if (!isMainFrame || code === -3 || retryTimer) return
    const target = /^https?:/.test(url) ? url : startUrl(acct)
    if (process.env.MAILWRAP_DEBUG) console.log(`[mailwrap] ${acct.label}: load failed (${code} ${desc}), retry in ${retryDelay} ms`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!v!.webContents.isDestroyed()) load(target)
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  })
  v.webContents.on('did-navigate', (_e, _url, httpResponseCode) => {
    if (httpResponseCode > 0) retryDelay = RETRY_MIN_MS // a real response arrived: back to quick retries
  })
  v.webContents.on('destroyed', () => {
    if (retryTimer) clearTimeout(retryTimer)
  })
  if (process.env.MAILWRAP_DEBUG) {
    const wc = v.webContents
    wc.on('did-navigate', (_e, url, code) => console.log(`[mailwrap] ${acct.label}: navigate ${code} ${url}`))
    wc.on('did-navigate-in-page', (_e, url) => console.log(`[mailwrap] ${acct.label}: in-page ${url}`))
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => console.log(`[mailwrap] ${acct.label}: FAIL ${code} ${desc} ${url} main=${isMain}`))
    wc.on('did-create-window', (w) => console.log(`[mailwrap] ${acct.label}: popup ${w.webContents.getURL()}`))
    wc.on('console-message', (ev) => {
      if (ev.level === 'error') console.log(`[mailwrap] ${acct.label}: console ${ev.message}`)
    })
  }
  // loadURL rejects when the load fails; did-fail-load above handles that, so the rejection is expected.
  const load = (url: string): void => void v!.webContents.loadURL(url).catch(() => undefined)
  load(startUrl(acct))
  host?.contentView.addChildView(v)
  views.set(acct.id, v)
  layout()
  return v
}

export function destroyView(id: string): void {
  const v = views.get(id)
  if (!v) return
  host?.contentView.removeChildView(v)
  v.webContents.close()
  views.delete(id)
  unread.delete(id)
  session.fromPartition(partitionFor(id)).clearStorageData().catch(() => undefined)
  if (activeId === id) setActive(store.get('accounts')[0]?.id ?? null)
  emit()
}

export function setActive(id: string | null): void {
  activeId = id && views.has(id) ? id : null
  store.set('activeId', activeId)
  layout()
  if (activeId) views.get(activeId)?.webContents.focus()
  emit()
}

export function getActive(): string | null {
  return activeId
}

export function viewFor(id: string): WebContentsView | undefined {
  return views.get(id)
}

export function accountForContents(wcId: number): string | null {
  for (const [id, v] of views) if (v.webContents.id === wcId) return id
  return null
}

export function setUnread(id: string, n: number): void {
  if (unread.get(id) === n) return
  unread.set(id, n)
  emit()
}

export function unreadMap(): Map<string, number> {
  return unread
}

/** While a shell dialog is open the native view must get out of the way (it is stacked above the page). */
export function setOverlay(open: boolean): void {
  overlayOpen = open
  layout()
  if (!open && activeId) views.get(activeId)?.webContents.focus()
}

export function openDevTools(id: string): void {
  views.get(id)?.webContents.openDevTools({ mode: 'detach' })
}

export function reload(id: string): void {
  views.get(id)?.webContents.reload()
}

export function cycle(dir: 1 | -1): void {
  const list = store.get('accounts')
  if (!list.length) return
  const i = list.findIndex((a) => a.id === activeId)
  setActive(list[(i + dir + list.length) % list.length].id)
}
