# Mailwrap

Desktop wrapper for Gmail, Outlook (personal and Microsoft 365) and self-hosted
Roundcube webmail, with multiple accounts per service, native new-mail notifications and a tray icon. Closing the
window hides it to the tray; **Quit** in the tray menu exits.

Built with Electron + TypeScript. Linux first (KDE/GNOME), Windows and macOS from
the same source.

## How it works

- Each account runs in its own persistent session partition, so two Gmail
  accounts never share cookies.
- Notifications: the page's `window.Notification` is replaced by a shim that
  forwards to a native desktop notification. Clicking it focuses the right
  account and opens the message. You must enable **Desktop notifications** once
  in Gmail / Outlook settings.
- Roundcube: add the account with your webmail address (e.g. `mail.example.com`).
  Notifications need no setting: new rows that Roundcube adds on its periodic
  refresh are announced with sender and subject; mail arriving while another
  folder is open is announced from the Inbox unread count. The login survives
  app restarts while the server-side session is still valid.
- Unread count is parsed from the page title and shown as a badge in the sidebar
  and in the tray icon tooltip (icon gets a red dot when > 0).
- Links outside Google/Microsoft domains (or the account's own Roundcube host)
  open in the system browser.

Shortcuts: `Ctrl+1…9` switch account, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle,
`Ctrl+Q` quit. Right-click an account for reload / rename / reorder / remove.

## Development

```sh
npm install
npm run dev          # hot-reloading dev build
npm run typecheck
MAILWRAP_SELFTEST=1 npx electron out/main/index.js   # after `npm run build`: automated smoke test
```

## Packaging

```sh
npm run dist:linux   # AppImage, rpm, deb in dist/
npm run dist:win     # NSIS installer (run on Windows)
npm run dist:mac     # dmg (run on macOS)
```

Start hidden: `mailwrap --hidden` (also what the "Start on login" option uses).
Settings live in `~/.config/Mailwrap/config.json`.

## License

GPL-3.0-only. Copyright (C) 2026 Mateusz Ryczko. See [LICENSE](LICENSE).
