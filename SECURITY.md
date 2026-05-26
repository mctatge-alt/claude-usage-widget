# Security

## Reporting vulnerabilities

If you find a security issue, please open a [private security advisory](https://github.com/mctatge-alt/claude-usage-widget/security/advisories/new) on GitHub (preferred) or email the maintainer listed in the repository profile. Do not open a public issue for undisclosed vulnerabilities.

## What this app stores (on your Mac only)

| Data | Location | Notes |
|------|----------|--------|
| Claude `sessionKey` | macOS Keychain (via Electron `safeStorage`) | Equivalent to a logged-in browser session |
| Organization ID | Local app settings | Used for API calls |
| Usage history snapshots | `~/Library/Application Support/claude-usage-widget/` | Percentages over time, not message content |
| Preferences | Same app support folder | Theme, thresholds, window position, etc. |

The app does **not** send credentials or usage data to any third-party server. Network traffic is limited to **claude.ai** (and OAuth providers during login).

## Verifying downloads

1. Download only from the official [GitHub Releases](https://github.com/mctatge-alt/claude-usage-widget/releases) page.
2. Prefer **signed and notarized** DMGs built by the project’s release workflow.
3. Compare the DMG **SHA-256** checksum against the value published on the release (when provided).
4. On first launch, if macOS blocks the app, use **Right-click → Open** on the signed build from the official release — do not disable Gatekeeper globally.

## Unofficial client

This project is **not affiliated with Anthropic**. You are granting a local app access to your Claude session; only install builds you trust.

## Maintainers

- Never commit `.env`, `.p12`, `developer_id_base64.txt`, or other signing material.
- Set `APPLE_TEAM_ID` via environment variables or CI secrets — do not hardcode Team IDs in `package.json`.
- If signing material was ever committed to git history, **revoke the certificate with Apple**, rotate secrets, and purge history before making the repository public.

See [MACOS_CODE_SIGNING.md](MACOS_CODE_SIGNING.md) for release signing setup.
