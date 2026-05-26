# Contributing to Claude Usage Widget

Thank you for contributing. This fork targets **macOS on Apple Silicon only**.

## Development setup

### Prerequisites

- Mac with Apple Silicon (M1/M2/M3/M4 or later)
- Node.js 18+
- npm
- Git

### Getting started

```bash
git clone https://github.com/mctatge-alt/claude-usage-widget.git
cd claude-usage-widget
npm install
npm start
```

Dev mode opens DevTools and logs to the terminal.

### First-run checklist

- [ ] Login flow captures session
- [ ] Usage data displays and refreshes
- [ ] Minimize to Dock and restore via Dock icon
- [ ] Menu bar stats (optional setting)
- [ ] Settings persist across restarts
- [ ] Logout clears session

## Project structure

```
claude-usage-widget/
├── main.js                 # Electron main process
├── preload.js              # IPC bridge
├── package.json            # Dependencies and macOS arm64 build config
├── src/
│   ├── fetch-via-window.js
│   └── renderer/
│       ├── index.html
│       ├── app.js
│       └── styles.css
├── assets/
│   ├── icon.icns
│   └── tray-icon-mac.png
└── .github/workflows/
    └── build-macos.yml
```

## Building

```bash
npm run build:mac
```

Output: `dist/Claude-Usage-Widget-{version}-macOS-arm64.dmg`

Code signing and notarization: see [MACOS_CODE_SIGNING.md](MACOS_CODE_SIGNING.md).

## Development tips

### Menu bar tray icons

Enable **Show tray stats** in Settings. Icons are generated in `main.js` via `generatePercentageIcon()`.

### Mock API data

For UI testing without live API calls, temporarily mock in `app.js` inside the fetch handler.

### Change refresh interval

Default is 5 minutes; adjust in Settings or `app.js` for testing.

## Code style

- `const` / `let`, not `var`
- Semicolons, 2-space indent
- Comments only for non-obvious logic
- `try/catch` for error paths

## Testing

Manual testing on Apple Silicon macOS:

- Clean DMG install
- Login, refresh, logout
- Dock minimize and restore
- Hide from Dock + menu bar stats coupling
- Settings persistence
- Compact mode and usage graph
- Organization selector (if applicable)

## Submitting changes

1. Branch from `main`: `git checkout -b feature/your-feature`
2. Test on Apple Silicon Mac
3. Open a PR with description and screenshots for UI changes
4. Note macOS version tested

### Commit prefixes

`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`

## Releases

Maintainers: see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## Questions

- [Discussions](https://github.com/mctatge-alt/claude-usage-widget/discussions)
- [Issues](https://github.com/mctatge-alt/claude-usage-widget/issues)

Signing and release security: [SECURITY.md](SECURITY.md), [MACOS_CODE_SIGNING.md](MACOS_CODE_SIGNING.md)
