import { ipcRenderer, webFrame } from 'electron'
import type { NotifyPayload } from '../shared'

// --- Notification shim -----------------------------------------------------
// Runs in the page's main world so Gmail/Outlook's `new Notification(...)` reaches us.
// We relay to the main process which shows a native notification and sends click/close back.

ipcRenderer.on('notify-click', (_e, nid: number) => {
  webFrame.executeJavaScript(`window.__mailwrapNotify && window.__mailwrapNotify.click(${nid})`).catch(() => undefined)
})
ipcRenderer.on('notify-close', (_e, nid: number) => {
  webFrame.executeJavaScript(`window.__mailwrapNotify && window.__mailwrapNotify.close(${nid})`).catch(() => undefined)
})

const shim = `(() => {
  if (window.__mailwrapNotify) return;
  const live = new Map();
  let seq = 0;
  class MailwrapNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = title;
      this.body = options.body;
      this.icon = options.icon;
      this.tag = options.tag;
      this.data = options.data;
      this.onclick = null; this.onclose = null; this.onshow = null; this.onerror = null;
      this._nid = ++seq;
      live.set(this._nid, this);
      window.postMessage({ __mailwrap: 'notify', nid: this._nid, title, body: options.body, icon: options.icon, tag: options.tag }, '*');
      setTimeout(() => { const ev = new Event('show'); this.onshow && this.onshow(ev); this.dispatchEvent(ev); }, 0);
    }
    close() { live.delete(this._nid); }
    static get permission() { return 'granted'; }
    static requestPermission(cb) { const p = Promise.resolve('granted'); if (cb) p.then(cb); return p; }
    static get maxActions() { return 0; }
  }
  window.Notification = MailwrapNotification;
  // Persistent notifications (registration.showNotification) are not displayed by Electron; route
  // page-side calls through the same shim.
  if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype.showNotification) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      new MailwrapNotification(title, options);
      return Promise.resolve();
    };
  }
  window.__mailwrapNotify = {
    click(nid) { const n = live.get(nid); if (!n) return; window.focus(); const ev = new Event('click'); n.onclick && n.onclick(ev); n.dispatchEvent(ev); live.delete(nid); },
    close(nid) { const n = live.get(nid); if (!n) return; const ev = new Event('close'); n.onclose && n.onclose(ev); n.dispatchEvent(ev); live.delete(nid); }
  };
})();`

webFrame.executeJavaScript(shim).catch(() => undefined)

window.addEventListener('message', (ev) => {
  const d = ev.data
  if (ev.source !== window || !d) return
  if (d.__mailwrap !== 'notify') return
  const p: NotifyPayload = { nid: d.nid, title: String(d.title ?? ''), body: d.body, icon: d.icon, tag: d.tag }
  ipcRenderer.send('notify', p)
})

// --- Unread count from <title> --------------------------------------------
// Gmail: "Inbox (12) - user@gmail.com - Gmail"; Outlook: "(12) Mail - user - Outlook"
function parseUnread(title: string): number {
  const m = title.match(/\((\d+)\)/)
  return m ? Number(m[1]) : 0
}
let last = -1
function report(): void {
  const n = parseUnread(document.title)
  if (n !== last) {
    last = n
    ipcRenderer.send('unread', n)
  }
}

// --- Outlook: synthesize notifications ------------------------------------
// New Outlook delivers new-mail notifications through a Web Push service worker (sw_webpush.js),
// which has no push service in Electron, so it never notifies. Instead, when the unread count
// rises we read the newest unread rows from the message list and raise notifications ourselves.
const isOutlook =
  /(^|\.)(outlook\.(live|office|office365)\.com|outlook\.cloud\.microsoft)$/i.test(location.hostname) ||
  process.argv.includes('--mailwrap-fake-outlook')
const DEBUG = process.argv.includes('--mailwrap-debug')
const seenConv = new Set<string>()
const unreadState = new Map<string, boolean>()
const synthetic = new Map<number, string>() // nid -> convid
let synthSeq = -1000000
let primed = false

function listRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-convid], [data-item-id]'))
}
function rowId(el: HTMLElement): string {
  return el.getAttribute('data-convid') ?? el.getAttribute('data-item-id') ?? ''
}
function rowIsUnread(el: HTMLElement): boolean {
  const label = (el.getAttribute('aria-label') ?? '').trim()
  if (/^(unread|nieprzeczytane|ungelesen|non lu|no le[ií]d)/i.test(label)) return true
  // fallback: OWA marks unread rows with a bold subject / an "unread" class somewhere inside
  return !!el.querySelector('[class*="nread" i], [class*="Unread"]')
}
const STATUS_WORD =
  /^(unread|nieprzeczytane|ungelesen|non lu|no le[ií]d[oa]s?|przypięte|pinned|ma załączniki|has attachments|przesłane dalej|forwarded|odpowiedziano|replied|flagged|oflagowane|⚠.*)$/i
const TIME_LIKE = /^(\d{1,2}:\d{2}|\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?|wczoraj|yesterday|[a-ząćęłńóśźż]{2,3}\.?)$/i

const DATE_TITLE = /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}/

/** Sender and subject of a message row. Sender = element whose tooltip is an e-mail address;
 *  time cell = element whose tooltip is a full date; subject = first remaining text after the sender. */
function rowParts(el: HTMLElement): { sender: string; subject: string } {
  const leaves: { text: string; el: Element }[] = []
  const walk = (n: Element): void => {
    if (n.getAttribute('aria-hidden') === 'true') return
    if (!n.children.length) {
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (t) leaves.push({ text: t, el: n })
      return
    }
    for (const c of Array.from(n.children)) walk(c)
  }
  walk(el)
  if (DEBUG) {
    const titles = Array.from(el.querySelectorAll<HTMLElement>('[title]')).map((e) => `${e.getAttribute('title')}=>"${(e.textContent ?? '').trim().slice(0, 40)}"`)
    ipcRenderer.send('debug', `row leaves: ${JSON.stringify(leaves.map((l) => l.text))} titles: ${titles.join(' | ')}`)
  }
  const titledAncestor = (n: Element, re: RegExp): boolean => {
    for (let c: Element | null = n; c && c !== el; c = c.parentElement) {
      const t = c.getAttribute('title')
      if (t && re.test(t)) return true
    }
    return false
  }
  const senderEl = el.querySelector<HTMLElement>('[title*="@"]')
  let sender = senderEl ? (senderEl.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
  const hasDateCell = leaves.some((l) => titledAncestor(l.el, DATE_TITLE))
  const rest = leaves.filter((l) => {
    if (STATUS_WORD.test(l.text) || l.text.length <= 1) return false
    if (titledAncestor(l.el, /@/)) return false
    if (hasDateCell ? titledAncestor(l.el, DATE_TITLE) : TIME_LIKE.test(l.text)) return false
    return true
  })
  if (!sender) sender = rest.shift()?.text ?? ''
  const subject = rest[0]?.text ?? ''
  if (!sender && !subject) {
    const label = (el.getAttribute('aria-label') ?? '').replace(/^(unread|nieprzeczytane)[\s,.:-]*/i, '').trim()
    sender = label.slice(0, 80)
  }
  return { sender: sender.slice(0, 120), subject: subject.slice(0, 200) }
}
const notifiedSig = new Set<string>()
/** Full date from the time cell's tooltip (e.g. "So, 14.11.2026 00:48"), '' when absent. */
function rowDate(el: HTMLElement): string {
  for (const e of Array.from(el.querySelectorAll<HTMLElement>('[title]'))) {
    const t = e.getAttribute('title') ?? ''
    if (DATE_TITLE.test(t)) return t
  }
  return ''
}
function primeSeen(): void {
  for (const r of listRows()) {
    const id = rowId(r)
    if (!id) continue
    seenConv.add(id)
    unreadState.set(id, rowIsUnread(r))
  }
  primed = true
}
function inNotifiableFolder(): boolean {
  return !/\/(sentitems|drafts|deleteditems|junkemail|archive|notes|outbox)\b/i.test(location.pathname)
}
let scanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScan(): void {
  if (scanTimer) return
  scanTimer = setTimeout(() => {
    scanTimer = null
    outlookScan()
    checkInboxCounter()
  }, 700)
}
function outlookScan(): void {
  const rows = listRows()
  if (!rows.length) return
  if (!primed) {
    primeSeen()
    return
  }
  const ids = rows.map(rowId)
  // Pinned rows stay on top regardless of date, so they must not count as "known rows above".
  const pinned = rows.map((r) => /(^|\s)(Przypięte|Pinned|Angeheftet|Épinglé|Anclado|Fissato)(\s|$)/i.test(r.getAttribute('aria-label') ?? ''))
  const firstSeen = ids.findIndex((id, i) => id && !pinned[i] && seenConv.has(id))
  const fresh = rows.filter((r, i) => ids[i] && !seenConv.has(ids[i]) && !pinned[i] && (firstSeen < 0 || i < firstSeen))
  const anyNew = rows.filter((_r, i) => ids[i] && !seenConv.has(ids[i]))
  // Folder switch / search / full re-render: most rows are new -> re-prime silently.
  if (anyNew.length > Math.max(5, rows.length / 2) || firstSeen < 0) {
    for (const id of ids) if (id) seenConv.add(id)
    return
  }
  for (const id of ids) if (id) seenConv.add(id)
  // Known conversations that just turned unread (a reply arrived in an existing thread).
  const flipped: HTMLElement[] = []
  rows.forEach((r, i) => {
    const id = ids[i]
    if (!id) return
    const u = rowIsUnread(r)
    const was = unreadState.get(id)
    if (was === false && u && i < 8 && !fresh.includes(r)) flipped.push(r)
    unreadState.set(id, u)
  })
  if (!inNotifiableFolder()) return
  for (const r of [...fresh, ...flipped]) {
    if (!rowIsUnread(r)) continue
    const { sender, subject } = rowParts(r)
    // One notification per message: the same row can look "new" again (re-render with a different
    // id, unread flag flickering while the list refreshes), so key on what the user would see.
    const sig = `${sender}|${subject}|${rowDate(r)}`
    if (DEBUG) ipcRenderer.send('debug', `row ${fresh.includes(r) ? 'fresh' : 'flipped'} id=${rowId(r)} sig=${sig} dup=${notifiedSig.has(sig)}`)
    lastRowNotify = Date.now()
    if (notifiedSig.has(sig)) continue
    notifiedSig.add(sig)
    if (notifiedSig.size > 500) notifiedSig.delete(notifiedSig.values().next().value as string)
    const nid = synthSeq++
    synthetic.set(nid, rowId(r))
    ipcRenderer.send('notify', { nid, title: sender || 'New mail', body: subject, synthetic: true } as NotifyPayload)
  }
}
// Fallback: Inbox unread counter in the folder pane. Covers mail that lands in a tab we do not
// watch (Focused Inbox "Other") or arrives while the list is not rendered.
let inboxUnread = -1
let lastRowNotify = 0
function inboxCounter(): number {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  for (const it of items) {
    const title = it.getAttribute('title') ?? ''
    if (!/(Skrzynka odbiorcza|Inbox|Posteingang|Boîte de réception|Bandeja de entrada)/i.test(title)) continue
    // "Elementy: Skrzynka odbiorcza – 8377 (nieprzeczytane: 5202)" / "Inbox – 8377 (unread: 5202)"
    const m = title.match(/(nieprzeczytane|nieprzeczytanych|unread|ungelesen|non lus?|no le[ií]d[oa]s?)\D{0,3}(\d+)/i)
    if (m) return Number(m[2])
    const t = (it.textContent ?? '').match(/(\d+)\s*[—-]/)
    return t ? Number(t[1]) : 0
  }
  return -1
}
function checkInboxCounter(): void {
  const n = inboxCounter()
  if (n < 0) return
  if (inboxUnread < 0) {
    inboxUnread = n
    return
  }
  if (n > inboxUnread) {
    const delta = n - inboxUnread
    // If the row watcher just notified, assume it covered this increase.
    if (Date.now() - lastRowNotify > 5000) {
      const nid = synthSeq++
      ipcRenderer.send('notify', { nid, title: 'New mail', body: `${delta} new message${delta > 1 ? 's' : ''}` } as NotifyPayload)
    }
  }
  inboxUnread = n
}
ipcRenderer.on('notify-click', (_e, nid: number) => {
  const conv = synthetic.get(nid)
  if (!conv) return
  synthetic.delete(nid)
  const el = listRows().find((r) => rowId(r) === conv)
  el?.click()
})

window.addEventListener('DOMContentLoaded', () => {
  if (isOutlook) {
    // Prime the seen-set once the list has rendered so existing mail never notifies,
    // then watch the DOM for rows inserted above the known ones.
    new MutationObserver(() => scheduleScan()).observe(document.documentElement, { childList: true, subtree: true })
    setTimeout(() => outlookScan(), 500)
    setInterval(() => {
      outlookScan()
      checkInboxCounter()
    }, 20000)
  }
  report()
  const t = document.querySelector('title')
  if (t) new MutationObserver(report).observe(t, { childList: true, characterData: true, subtree: true })
  const h = document.querySelector('head')
  if (h) new MutationObserver(report).observe(h, { childList: true })
  setInterval(report, 15000)
})
