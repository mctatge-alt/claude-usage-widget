# Installation — macOS Apple Silicon

## Download

1. Download the latest `*-macOS-arm64.dmg` from [Releases](https://github.com/mctatge-alt/claude-usage-widget/releases)
2. Open the DMG
3. Drag **Claude Usage Widget** to **Applications**
4. Launch from Applications

## System requirements

- Mac with Apple Silicon (M1, M2, M3, M4, or later)
- macOS 11 (Big Sur) or later recommended
- ~200 MB RAM while running
- Internet connection for Claude.ai API

## Gatekeeper

Signed, notarized builds should open normally. If macOS shows an unidentified-developer warning:

1. **Right-click** the app in Applications → **Open**
2. Confirm **Open** in the dialog

Only do this for builds downloaded from the [official Releases](https://github.com/mctatge-alt/claude-usage-widget/releases) page.

## What gets installed

| Item | Location |
|------|----------|
| Application | `/Applications/Claude Usage Widget.app` |
| Settings | `~/Library/Application Support/claude-usage-widget/` |

## First launch

1. Widget window appears
2. Click **Login to Claude**
3. Sign in at claude.ai in the login window
4. Usage displays automatically
5. Use **−** to minimize to the Dock (or hide Dock icon in Settings)

## Build from source

On your Apple Silicon Mac:

```bash
git clone https://github.com/mctatge-alt/claude-usage-widget.git
cd claude-usage-widget
npm install
npm start          # development
npm run build:mac  # DMG in dist/ (requires signing — see MACOS_CODE_SIGNING.md)
```

## Uninstall

1. Quit the app (menu bar → Quit)
2. Drag **Claude Usage Widget** from Applications to Trash
3. Optional — remove settings: `rm -rf ~/Library/Application\ Support/claude-usage-widget`

See [SECURITY.md](SECURITY.md) for what data the app stores locally.
