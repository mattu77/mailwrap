import { BrowserWindow, WebContentsView, session, shell, app, Session, Menu, clipboard, type MenuItemConstructorOptions } from 'electron'

/** Indirection so the self-test can observe hand-offs to the system browser. */
export let openExternal: (url: string) => void = (url) => void shell.openExternal(url)
export function setOpenExternal(fn: (url: string) => void): void {
  openExternal = fn
}
/** Extra hosts treated as inside (self-test only). */
export const extraInside = new Set<string>()
const inside = (h: string): boolean => staysInside(h) || extraInside.has(h)
import { join } from 'node:path'
import { AUTH_HOST_RE, MAIL_HOST_RE, SERVICE_URL, staysInside, type Account } from '../shared'

// Pages that mean "session over": Microsoft/ADFS sign-out landings and OWA logoff.
const SIGNED_OUT_RE = /\/(logout|logoutsession|logoff\.owa|signout)(\?|\/|$)|wa=wsignout1\.0|\/logout\.srf/i
import { partitionFor, store } from './store'
import { SIDEBAR_WIDTH } from './window'

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
    // Background accounts stay visible *underneath* the active one: a view hidden with
    // setVisible(false) gets no animation frames, which stalls the mail apps' list updates and
    // with them new-mail notifications. Only shell dialogs hide the views.
    v.setVisible(!overlayOpen)
  }
  const top = activeId ? views.get(activeId) : undefined
  if (top && top !== raised) {
    host.contentView.addChildView(top) // re-adding moves it to the top of the stack
    raised = top
  }
}
let raised: WebContentsView | undefined

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
    if (MAIL_HOST_RE.test(h)) {
      // e.g. sign-in flow finishing with window.open(mail.google.com): show it in this view.
      v!.webContents.loadURL(url)
      return { action: 'deny' }
    }
    external(url, 'window.open')
    return { action: 'deny' }
  })
  // Auth popups: only sign-in hosts can open one, so the whole popup is a sign-in flow. Federated
  // identity providers (e.g. a corporate ADFS) live on arbitrary hosts, so every page stays in the
  // popup; only the mail app is folded back into the view.
  v.webContents.on('did-create-window', (popup) => {
    const route = (e: Electron.Event | null, url: string): void => {
      if (!MAIL_HOST_RE.test(hostOf(url))) return
      e?.preventDefault()
      v!.webContents.loadURL(url)
      popup.close()
    }
    popup.webContents.on('will-navigate', (e, url) => route(e, url))
    popup.webContents.on('did-navigate', (_e, url) => route(null, url))
    // A link the sign-in page opens in a new window (help, privacy statement) goes to the browser.
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) external(url, 'popup window.open')
      return { action: 'deny' }
    })
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
    if (!h || inside(h)) return
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
    else if (MAIL_HOST_RE.test(h)) inAuthChain = false
    if (!h || inside(h) || inAuthChain || h === '127.0.0.1' || h === 'localhost') return
    if (/^https?:/.test(url)) external(url, 'landed')
    if (v!.webContents.canGoBack()) v!.webContents.goBack()
    else v!.webContents.loadURL(SERVICE_URL[acct.service])
  })
  // Chromium shows no context menu of its own in Electron; build one for links, images and text.
  // (Where the mail app draws its own menu it cancels the event and this never fires.)
  v.webContents.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = []
    const sep = (): void => {
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
    }
    if (p.linkURL) {
      const mail = /^mailto:/i.test(p.linkURL)
      const link = mail ? decodeURIComponent(p.linkURL.replace(/^mailto:/i, '').split('?')[0]) : p.linkURL
      if (!mail && /^https?:/i.test(link)) items.push({ label: 'Open link in browser', click: () => external(link, 'menu') })
      items.push({ label: mail ? 'Copy email address' : 'Copy link address', click: () => clipboard.writeText(link) })
      if (p.linkText.trim()) items.push({ label: 'Copy link text', click: () => clipboard.writeText(p.linkText.trim()) })
    }
    if (p.mediaType === 'image' && p.srcURL) {
      sep()
      items.push({ label: 'Copy image', click: () => v!.webContents.copyImageAt(p.x, p.y) })
      if (/^https?:/i.test(p.srcURL)) {
        items.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) })
        items.push({ label: 'Save image…', click: () => v!.webContents.downloadURL(p.srcURL) })
      }
    }
    if (p.isEditable) {
      sep()
      for (const sug of p.dictionarySuggestions.slice(0, 5))
        items.push({ label: sug, click: () => v!.webContents.replaceMisspelling(sug) })
      sep()
      items.push(
        { role: 'undo', enabled: p.editFlags.canUndo },
        { role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: p.editFlags.canCut },
        { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste },
        { role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste },
        { role: 'selectAll', enabled: p.editFlags.canSelectAll }
      )
    } else if (p.selectionText.trim()) {
      sep()
      items.push({ role: 'copy' })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: host ?? undefined })
  })
  // Outlook ends an expired session on a "You've been signed out" page (login.microsoftonline.com
  // /logout, ADFS wsignout, owa/logoff) and stays there. Restarting the app fixes it, so do the
  // equivalent: once the sign-out has settled, load the mailbox again, which re-runs the sign-in
  // (saved HTTP credentials answer the federated WIA challenge without a prompt).
  let signedOutTimer: NodeJS.Timeout | undefined
  v.webContents.on('did-finish-load', () => {
    const url = v!.webContents.getURL()
    if (!SIGNED_OUT_RE.test(url)) return
    if (process.env.MAILWRAP_DEBUG) console.log(`[mailwrap] ${acct.label}: signed-out page, reloading mailbox`)
    clearTimeout(signedOutTimer)
    signedOutTimer = setTimeout(() => {
      if (v && SIGNED_OUT_RE.test(v.webContents.getURL())) v.webContents.loadURL(SERVICE_URL[acct.service])
    }, 2000)
  })
  v.webContents.on('render-process-gone', () => v?.webContents.reload())
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
  v.webContents.loadURL(SERVICE_URL[acct.service])
  host?.contentView.addChildView(v)
  raised = undefined // new view sits on top; let layout() restore the active one
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
