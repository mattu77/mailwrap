import { BrowserWindow, NativeImage, app, nativeImage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../shared'

/** Same look as the sidebar badge: rounded square in the service colour with the label's initials. */
const COLOR: Record<Account['service'], string> = { gmail: '#c5221f', outlook: '#0f6cbd', outlook365: '#0f6cbd', roundcube: '#2e7d32' }
const SIZE = 128
const cache = new Map<string, Promise<NativeImage>>()

export function initials(label: string): string {
  const parts = label.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : label.slice(0, 2)).toUpperCase()
}

export function accountIcon(acct: Account): Promise<NativeImage> {
  const key = `${acct.service}:${acct.label}`
  let p = cache.get(key)
  if (!p) {
    p = load(acct, key).catch(() => nativeImage.createEmpty())
    cache.set(key, p)
  }
  return p
}

async function load(acct: Account, key: string): Promise<NativeImage> {
  const dir = join(app.getPath('userData'), 'icons')
  const file = join(dir, `${Buffer.from(key).toString('base64url')}.png`)
  try {
    return nativeImage.createFromBuffer(await readFile(file))
  } catch {
    /* render below */
  }
  const png = await render(acct)
  await mkdir(dir, { recursive: true })
  await writeFile(file, png)
  return nativeImage.createFromBuffer(png)
}

function render(acct: Account): Promise<Buffer> {
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${SIZE}px;height:${SIZE}px;border-radius:${SIZE / 4}px;background:${COLOR[acct.service]};
      color:#fff;font:600 ${SIZE * 0.42}px system-ui,sans-serif;display:flex;align-items:center;justify-content:center">
      ${initials(acct.label).replace(/[<&]/g, '')}</div></body></html>`
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({
      show: false,
      width: SIZE,
      height: SIZE,
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    })
    let settled = false
    const done = (err?: Error, buf?: Buffer): void => {
      if (settled) return
      settled = true
      if (!w.isDestroyed()) w.destroy()
      err ? reject(err) : resolve(buf!)
    }
    // Offscreen windows deliver frames through 'paint'; capturePage() can return an empty image
    // on some platforms (seen on Windows), so prefer the painted frame and fall back to capture.
    w.webContents.setFrameRate(10)
    let loaded = false
    w.webContents.on('paint', (_e, _dirty, image) => {
      if (!loaded || image.isEmpty()) return
      const { width, height } = image.getSize()
      if (width >= SIZE && height >= SIZE) done(undefined, image.toPNG())
    })
    w.webContents.once('did-finish-load', () => {
      loaded = true
      w.webContents.invalidate()
      setTimeout(() => {
        if (settled) return
        w.webContents
          .capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
          .then((img) => (img.isEmpty() ? done(new Error('empty capture')) : done(undefined, img.toPNG())))
          .catch((e) => done(e))
      }, 2000)
    })
    w.webContents.once('did-fail-load', (_e, code, desc) => done(new Error(`${code} ${desc}`)))
    w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}
