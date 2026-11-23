# Releasing Aonimark

The maintainer runbook for cutting a release with auto-update enabled. Updates go through [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/). The updater endpoint in `src-tauri/tauri.conf.json` points at **`jabrugger/Aonimark`**: the app checks its `releases/latest/download/latest.json` and verifies each download against the public key compiled into the binary.

## One-time setup

### 1. Generate the signing keypair

```bash
npm run tauri signer generate -- -w ~/.tauri/aonimark-updater.key
```

Pick a strong password and keep it, with the private key, in a password manager. The command writes:

- `~/.tauri/aonimark-updater.key` — **private**. Never commit or share it.
- `~/.tauri/aonimark-updater.key.pub` — **public**. Its single-line content goes into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.

### 2. Add the secrets

Repository settings → Secrets and variables → Actions:

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | full content of `~/.tauri/aonimark-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |

The build workflow reads both on the macOS, Windows and Linux runners.

### 3. The public key is permanent

Once a release ships with the public key embedded it cannot be rotated: every existing install would reject later updates and its user would have to reinstall by hand. If the private key is lost, the same applies. Never edit `plugins.updater.pubkey` once a release has shipped.

### 4. Optional: macOS signing and notarization

With these secrets set, the macOS job signs with a Developer ID certificate and notarizes; with none of them it ships an unsigned app. Setting any of them requires all six, and missing or invalid credentials stop the release.

| Name | Value |
|---|---|
| `APPLE_DEVELOPER_ID_P12` | base64 of the Developer ID Application certificate and key, exported as PKCS#12 |
| `APPLE_DEVELOPER_ID_PASSWORD` | the PKCS#12 export password |
| `APPLE_DEVELOPER_ID_SHA1` | the certificate's 40-character SHA-1 fingerprint |
| `APPLE_ID` | the Apple account email authorized for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for that account |
| `APPLE_TEAM_ID` | the certificate's 10-character team ID |

Without those, the workflow falls back to an older self-signed path that reads `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD` and `MACOS_SIGNING_IDENTITY` (all three or none). See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

## Per-release workflow

The workflow installs with `npm ci`, so the dependency graph is exactly the committed lockfile. Do not replace it with `npm install`.

1. **Bump the version:**
   ```bash
   npm run release X.Y.Z
   ```
   It writes the three places the version lives — `package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` — and checks they agree.
2. **Commit and push** to `master`.
3. **Run the `Build` workflow** from the Actions tab. It builds Windows (x64 and ARM64), macOS (universal) and Linux, and creates a **draft** release.
4. **Open the draft** on the Releases page and check the assets:
   - Windows: `Aonimark_<version>_x64.exe` (portable), `*_x64-setup.exe` (installer) and the matching `.sig`, and the same for `arm64`
   - macOS: `Aonimark_<version>_universal.dmg`
   - Linux: `.AppImage`, `.deb`, `.rpm`
   - `latest.json`
5. **Publish the release.** This is the gate: publishing activates auto-update for every installed copy.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The workflow stops saying the tag is already released | That version already has a release. Bump the version. |
| The updater says no update is available | The release is still a draft, or `latest.json` is missing from its assets. |
| Installed copies reject an update | The signing key does not match the embedded public key. |
