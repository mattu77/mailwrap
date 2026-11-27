import { Notification, ipcMain, nativeImage } from 'electron'
import type { NotifyPayload } from '../shared'
import { accountForContents, setActive, viewFor } from './accounts'
import { showWindow } from './window'
import { store } from './store'
import { accountIcon } from './icons'

export function installNotifications(): void {
  ipcMain.on('notify', async (e, p: NotifyPayload) => {
    const acctId = accountForContents(e.sender.id)
    if (process.env.MAILWRAP_DEBUG) console.log(`[mailwrap] notify ${JSON.stringify(p)}`)
    if (!acctId || !Notification.isSupported()) return
    const acct = store.get('accounts').find((a) => a.id === acctId)
    const label = acct?.label
    let icon = acct ? await accountIcon(acct) : nativeImage.createEmpty()
    if (icon.isEmpty() && p.icon?.startsWith('data:')) icon = nativeImage.createFromDataURL(p.icon)
    const n = new Notification({
      title: p.title === 'New mail' && label ? `New mail – ${label}` : p.title,
      subtitle: p.synthetic && label ? label : undefined,
      body: p.body ?? '',
      icon: icon.isEmpty() ? undefined : icon,
      silent: false
    })
    n.on('click', () => {
      setActive(acctId)
      showWindow()
      viewFor(acctId)?.webContents.send('notify-click', p.nid)
    })
    n.on('close', () => viewFor(acctId)?.webContents.send('notify-close', p.nid))
    n.show()
  })
}
