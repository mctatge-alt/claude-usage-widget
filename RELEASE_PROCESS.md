# Release Process

## Pre-release testing (staging)

1. **Create a release candidate tag:**
   ```bash
   git tag v1.7.1-rc.1
   git push origin v1.7.1-rc.1
   ```

2. **GitHub Actions** builds the macOS Apple Silicon DMG automatically

3. **Mark the GitHub Release as "Pre-release"** so watchers are not notified

4. **Test the build** on an Apple Silicon Mac:
   - Install from DMG
   - Login, refresh, settings, menu bar stats
   - Verify code signing / notarization if applicable

5. **If issues are found:** fix, delete the RC tag and release, bump RC number, repeat

## Final release

1. After RC passes:
   ```bash
   git tag v1.7.1
   git push origin v1.7.1
   ```

2. Create the final GitHub Release (not pre-release), paste notes from CHANGELOG.md

## Notes

- Test locally with `npm start` before tagging
- Never delete and re-push final tags — use RC tags for iteration
- Artifact: `Claude-Usage-Widget-{version}-macOS-arm64.dmg`
