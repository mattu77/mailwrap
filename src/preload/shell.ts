import { contextBridge, ipcRenderer } from 'electron'
import type { ShellApi } from '../shared'

const api: ShellApi = {
  getAccounts: () => ipcRenderer.invoke('accounts:list'),
  getActive: () => ipcRenderer.invoke('accounts:active'),
  addAccount: (service, label, url) => ipcRenderer.invoke('accounts:add', service, label, url),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  renameAccount: (id, label) => ipcRenderer.invoke('accounts:rename', id, label),
  moveAccount: (id, dir) => ipcRenderer.invoke('accounts:move', id, dir),
  setActive: (id) => ipcRenderer.invoke('accounts:setActive', id),
  reloadAccount: (id) => ipcRenderer.invoke('accounts:reload', id),
  contextMenu: (id, x, y) => ipcRenderer.send('accounts:ctx', id, x, y),
  overlay: (open) => ipcRenderer.send('overlay', open),
  forgetAuth: () => ipcRenderer.invoke('auth:forget'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  onAccounts: (cb) => ipcRenderer.on('accounts', (_e, a) => cb(a)),
  onActive: (cb) => ipcRenderer.on('active', (_e, id) => cb(id)),
  onUnread: (cb) => ipcRenderer.on('unread', (_e, id, n) => cb(id, n)),
  onSidebarVisible: (cb) => ipcRenderer.on('sidebar', (_e, v) => cb(v)),
  onRename: (cb) => ipcRenderer.on('rename', (_e, id) => cb(id))
}
contextBridge.exposeInMainWorld('mailwrap', api)
