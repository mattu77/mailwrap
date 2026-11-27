export type Service = 'gmail' | 'outlook' | 'outlook365' | 'roundcube'

export interface Account {
  id: string
  service: Service
  label: string
  /** Self-hosted webmail address (Roundcube). */
  url?: string
}

export const SERVICE_URL: Record<Service, string> = {
  gmail: 'https://mail.google.com/mail/u/0/',
  outlook: 'https://outlook.live.com/mail/',
  outlook365: 'https://outlook.office.com/mail/',
  roundcube: ''
}

/** Start page of an account: the fixed service address, or the account's own (Roundcube). */
export function homeUrl(acct: Account): string {
  return acct.url || SERVICE_URL[acct.service]
}

/** Normalise a user-typed webmail address: add https:// when no scheme is given. */
export function normalizeUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses are supported')
  return u.toString()
}

export const SERVICE_NAME: Record<Service, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook.com',
  outlook365: 'Outlook 365',
  roundcube: 'Roundcube'
}

/** Sign-in hosts: allowed as popups and as in-view navigation. */
export const AUTH_HOST_RE =
  /(^|\.)(accounts\.google\.com|accounts\.youtube\.com|myaccount\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|account\.microsoft\.com|account\.live\.com|mysignins\.microsoft\.com|login\.windows\.net|device\.login\.microsoftonline\.com)$/i

/** Attachment download / preview hosts that must stay inside (they are navigations, not links). */
export const ATTACHMENT_HOST_RE =
  /(^|\.)(mail-attachment\.googleusercontent\.com|attachments\.office\.net|attachment\.outlook\.live\.net|outlook\.live\.net|res\.cdn\.office\.net|res-1\.cdn\.office\.net)$/i

/** Top-level navigation policy: only the mail app, sign-in and attachment hosts stay in the view.
 *  Everything else (Maps, Docs, Drive, Word, Excel, OneDrive, arbitrary links) opens in the system browser. */
export function staysInside(host: string): boolean {
  return MAIL_HOST_RE.test(host) || AUTH_HOST_RE.test(host) || ATTACHMENT_HOST_RE.test(host)
}

/** Hosts that are the mail apps themselves; must always render inside the account view. */
export const MAIL_HOST_RE = /^(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|outlook\.cloud\.microsoft)$/i

export interface NotifyPayload {
  nid: number
  title: string
  body?: string
  icon?: string
  tag?: string
  /** Produced by the app from the message list (Outlook), not by the page. */
  synthetic?: boolean
}

export interface Settings {
  startMinimized: boolean
  autostart: boolean
}

export interface ShellApi {
  getAccounts(): Promise<Account[]>
  getActive(): Promise<string | null>
  addAccount(service: Service, label: string, url?: string): Promise<Account>
  removeAccount(id: string): Promise<void>
  renameAccount(id: string, label: string): Promise<void>
  moveAccount(id: string, dir: -1 | 1): Promise<void>
  setActive(id: string): Promise<void>
  reloadAccount(id: string): Promise<void>
  contextMenu(id: string, x: number, y: number): void
  overlay(open: boolean): void
  forgetAuth(): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(s: Partial<Settings>): Promise<Settings>
  onAccounts(cb: (a: Account[]) => void): void
  onActive(cb: (id: string | null) => void): void
  onUnread(cb: (id: string, n: number) => void): void
  onSidebarVisible(cb: (visible: boolean) => void): void
  onRename(cb: (id: string) => void): void
}
