import { app } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import type { Account, Service, Settings } from '../shared'

interface Schema {
  accounts: Account[]
  activeId: string | null
  bounds: { x?: number; y?: number; width: number; height: number } | null
  settings: Settings
  httpAuth: Record<string, { username: string; password: string }>
}

// Must run before the store resolves its file: the self-test keeps ALL its data in a throwaway dir.
if (process.env.MAILWRAP_SELFTEST) app.setPath('userData', `${app.getPath('temp')}/mailwrap-selftest`)

export const store = new Store<Schema>({
  defaults: {
    accounts: [],
    activeId: null,
    bounds: null,
    settings: { startMinimized: false, autostart: false },
    httpAuth: {}
  }
})

export function partitionFor(id: string): string {
  return `persist:acct-${id}`
}

export function addAccount(service: Service, label: string, url?: string): Account {
  const acct: Account = { id: randomUUID(), service, label, ...(url ? { url } : {}) }
  store.set('accounts', [...store.get('accounts'), acct])
  return acct
}

export function removeAccount(id: string): void {
  store.set('accounts', store.get('accounts').filter((a) => a.id !== id))
  if (store.get('activeId') === id) store.set('activeId', store.get('accounts')[0]?.id ?? null)
}

export function renameAccount(id: string, label: string): void {
  store.set('accounts', store.get('accounts').map((a) => (a.id === id ? { ...a, label } : a)))
}

export function moveAccount(id: string, dir: -1 | 1): void {
  const list = [...store.get('accounts')]
  const i = list.findIndex((a) => a.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  store.set('accounts', list)
}
