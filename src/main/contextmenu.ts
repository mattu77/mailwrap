import { BrowserWindow, Menu, clipboard, type MenuItemConstructorOptions, type WebContents } from 'electron'

/**
 * Right-click menu for web pages. Electron shows none by default, so without this nothing happens
 * on a right-click unless the page draws its own menu (Gmail does in the message list, which is
 * why only the list seemed to work). Pages that draw their own menu cancel the event and never
 * reach this handler.
 *
 * Edit actions call the WebContents methods directly: menu roles act on the window's own
 * WebContents (the sidebar), not on the mail view that was clicked.
 */
export function installContextMenu(
  wc: WebContents,
  getWindow: () => BrowserWindow | null,
  openExternal: (url: string) => void
): void {
  wc.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = []
    const separator = (): void => {
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
    }

    if (p.isEditable && p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
      if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false })
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) })
      separator()
    }

    const link = p.linkURL
    if (/^https?:/i.test(link)) {
      items.push({ label: 'Open link in browser', click: () => openExternal(link) })
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(link) })
      separator()
    } else if (/^mailto:/i.test(link)) {
      const address = decodeURIComponent(link.slice('mailto:'.length).split('?')[0])
      items.push({ label: 'Copy email address', click: () => clipboard.writeText(address) })
      separator()
    }

    if (p.mediaType === 'image' && p.hasImageContents) {
      items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) })
      if (/^(https?|data|blob):/i.test(p.srcURL)) items.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) })
      if (/^https?:/i.test(p.srcURL)) items.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) })
      separator()
    }

    const f = p.editFlags
    if (p.isEditable) {
      items.push(
        { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
        { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
        { type: 'separator' },
        { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
        { label: 'Paste as plain text', enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
        { type: 'separator' },
        { label: 'Select all', enabled: f.canSelectAll, click: () => wc.selectAll() }
      )
    } else if (p.selectionText.trim()) {
      items.push({ label: 'Copy', enabled: f.canCopy, click: () => wc.copy() })
    }

    while (items.length && items[items.length - 1].type === 'separator') items.pop()
    if (process.env.MAILWRAP_DEBUG) console.log(`[mailwrap] context-menu at ${p.x},${p.y}: ${items.filter((i) => i.label).map((i) => i.label).join(' | ') || '(none)'}`)
    if (!items.length) return
    const win = getWindow() ?? BrowserWindow.fromWebContents(wc) ?? undefined
    Menu.buildFromTemplate(items).popup(win ? { window: win } : {})
  })
}
