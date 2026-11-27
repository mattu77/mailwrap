import type { Account, Service, ShellApi } from '../shared'

declare global {
  interface Window { mailwrap: ShellApi }
}
const api = window.mailwrap

let accounts: Account[] = []
let activeId: string | null = null
const unread = new Map<string, number>()

const $accounts = document.getElementById('accounts')!
const $empty = document.getElementById('empty')!
const $addDialog = document.getElementById('add-dialog') as HTMLDialogElement
const $settingsDialog = document.getElementById('settings-dialog') as HTMLDialogElement
// Dialogs: the mail view is a native layer above this page, so hide it while a dialog is open.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('close', () => api.overlay(false))
}
const open = (d: HTMLDialogElement): void => {
  api.overlay(true)
  d.showModal()
}
const $renameDialog = document.getElementById('rename-dialog') as HTMLDialogElement
let renameTarget: string | null = null
$renameDialog.querySelector('.cancel')!.addEventListener('click', () => $renameDialog.close('cancel'))
$renameDialog.addEventListener('close', () => {
  const v = ($renameDialog.querySelector('[name=label]') as HTMLInputElement).value.trim()
  if ($renameDialog.returnValue === 'ok' && renameTarget && v) api.renameAccount(renameTarget, v)
})

function initials(label: string): string {
  const parts = label.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : label.slice(0, 2)).toUpperCase()
}

function render(): void {
  $accounts.replaceChildren(
    ...accounts.map((a, i) => {
      const b = document.createElement('button')
      b.className = `acct ${a.service}${a.id === activeId ? ' active' : ''}`
      b.textContent = initials(a.label)
      b.title = `${a.label}  (Ctrl+${i + 1})`
      const n = unread.get(a.id) ?? 0
      if (n > 0) {
        const s = document.createElement('span')
        s.className = 'badge'
        s.textContent = n > 99 ? '99+' : String(n)
        b.append(s)
      }
      b.onclick = () => api.setActive(a.id)
      b.oncontextmenu = (e) => {
        e.preventDefault()
        api.contextMenu(a.id, e.clientX, e.clientY)
      }
      return b
    })
  )
  $empty.hidden = accounts.length > 0
}

api.onRename((id) => {
  const a = accounts.find((x) => x.id === id)
  const inp = $renameDialog.querySelector('[name=label]') as HTMLInputElement
  inp.value = a?.label ?? ''
  renameTarget = id
  open($renameDialog)
})

const $addForm = document.getElementById('add-form') as HTMLFormElement
const $service = $addForm.elements.namedItem('service') as HTMLSelectElement
const $url = $addForm.elements.namedItem('url') as HTMLInputElement
const $urlRow = document.getElementById('url-row')!
const $addError = document.getElementById('add-error')!
const syncService = (): void => {
  const rc = $service.value === 'roundcube'
  $urlRow.hidden = !rc
  $url.required = rc
}
$service.addEventListener('change', syncService)
document.getElementById('add')!.onclick = () => {
  ;($addDialog.querySelector('[name=label]') as HTMLInputElement).value = ''
  $url.value = ''
  $addError.hidden = true
  syncService()
  open($addDialog)
}
$addDialog.querySelector('.cancel')!.addEventListener('click', () => $addDialog.close('cancel'))
// Submit validates first (a bad address keeps the dialog open with a message).
$addForm.addEventListener('submit', (e) => {
  const fd = new FormData($addForm)
  const service = fd.get('service') as Service
  const url = service === 'roundcube' ? String(fd.get('url') ?? '').trim() : undefined
  if (url !== undefined) {
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`)
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error()
    } catch {
      e.preventDefault()
      $addError.textContent = 'Enter the address of your Roundcube, e.g. mail.example.com'
      $addError.hidden = false
      return
    }
  }
  e.preventDefault()
  $addDialog.close('ok')
  api.addAccount(service, String(fd.get('label')), url)
})

document.getElementById('settings')!.onclick = async () => {
  const s = await api.getSettings()
  const f = $settingsDialog.querySelector('form')!
  ;(f.elements.namedItem('startMinimized') as HTMLInputElement).checked = s.startMinimized
  ;(f.elements.namedItem('autostart') as HTMLInputElement).checked = s.autostart
  open($settingsDialog)
}
document.getElementById('forget-auth')!.onclick = () => api.forgetAuth()
$settingsDialog.querySelector('form')!.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement
  api.setSettings({ [t.name]: t.checked })
})

api.onAccounts((a) => {
  accounts = a
  render()
})
api.onActive((id) => {
  activeId = id
  render()
})
api.onUnread((id, n) => {
  unread.set(id, n)
  render()
})

Promise.all([api.getAccounts(), api.getActive()]).then(([a, id]) => {
  accounts = a
  activeId = id
  render()
})
