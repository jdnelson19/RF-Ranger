# macOS app

RF Ranger ships as **RF Ranger.app** in a `.dmg`. It's a universal app (Apple Silicon and Intel) for macOS 11 or later, and needs no Node.js install. GitHub Actions builds it (`.github/workflows/macos-app.yml`), and it can be signed with a Developer ID and notarized by Apple so it opens without warnings.

## Using the app

- **Open:** double-click RF Ranger. It starts in the background and opens your browser at `http://localhost:8058`. If that port is taken, it uses the next free one. Opening it again while it's running just reopens the browser.
- **First run:** macOS asks to let RF Ranger **find devices on your local network**. Click **Allow**, or it can't see the receivers. If you clicked Don't Allow, turn it back on in System Settings → Privacy & Security → Local Network. Allow incoming connections too if the firewall asks, so TVs and tablets can open the Pickup view.
- **Quit:** use the **Quit RF Ranger** button at the bottom of the launch screen. It only appears on the Mac running RF Ranger. Logging out also stops it cleanly, and receiver metering is switched off either way.
- **Live mode by default:** with no config file, it discovers Shure devices and names slots from channel names. To run a configured show, put `rf-ranger.config.json` (and its `photos` folder) in `~/Library/Application Support/RF Ranger/` and reopen the app.
- **Log:** `~/Library/Logs/RF Ranger/rf-ranger.log`. Console.app shows it too.

The command-line tools (`discover`, `probe`, `pco`) are not in the app yet. Run them from a checkout with Node installed, as in [hardware-validation.md](hardware-validation.md).

## Builds

| Trigger | Result |
|---|---|
| Push a tag like `v0.2.0` | Signed, notarized `.dmg` published as a GitHub release |
| Push that changes packaging files, or **Run workflow** in the Actions tab | `.dmg` as a downloadable build artifact |

With none of the signing secrets set, the build is **ad-hoc signed**. It works, but other Macs show "can't be verified": right-click the app → **Open**, or allow it in System Settings → Privacy & Security.

## Signing and notarization setup (once)

You need the **Account Holder** role on the Apple Developer account to create a Developer ID certificate.

1. **Create a "Developer ID Application" certificate.** In Xcode: Settings → Accounts → your team → Manage Certificates → **+** → *Developer ID Application*. Or create it at <https://developer.apple.com/account/resources/certificates>. It has to be *Developer ID Application*; *Apple Development* and *Mac App Distribution* certificates won't work.
2. **Export it** from Keychain Access (My Certificates → right-click the certificate → Export, as `.p12`) with a strong password. Then copy it as base64:
   ```
   base64 -i DeveloperID.p12 | pbcopy
   ```
3. **Create an app-specific password** for notarization at <https://account.apple.com> → Sign-In and Security → App-Specific Passwords.
4. **Find your Team ID** at <https://developer.apple.com/account> → Membership details. It's 10 characters.
5. **Add repository secrets** under GitHub → RF-Ranger → Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `MACOS_CERT_P12` | the base64 text from step 2 |
   | `MACOS_CERT_PASSWORD` | the `.p12` password |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_TEAM_ID` | the Team ID |
   | `APPLE_APP_PASSWORD` | the app-specific password |

   Optional *variable* (not secret) `MACOS_BUNDLE_ID`. It defaults to `io.github.jdnelson19.rfranger`. Choose it once and keep it: macOS ties the Local Network permission to it.
6. **Release:** bump `version` in `server/package.json`, then
   ```
   git tag v0.2.0 && git push origin v0.2.0
   ```

Delete the local `.p12` once it's stored in GitHub.

## How it's built

`packaging/macos/build.sh`, on a macOS runner:

1. Builds the web UI. esbuild bundles the server into one file (`server/scripts/bundle-app.mjs`).
2. Turns that into a Node [single executable application](https://nodejs.org/api/single-executable-applications.html) blob. The blob is injected into the official arm64 and x64 Node binaries (checksums verified), and the two are merged with `lipo`.
3. Assembles `RF Ranger.app`. The web UI goes in `Contents/Resources/web`, and the icon is rendered from `web/public/icon.svg`.
4. Signs with hardened runtime. The only exceptions are the two V8 needs to compile JavaScript (`entitlements.plist`).
5. Notarizes and staples the app and the `.dmg`. Both are stapled so the app opens on offline production Macs.

The app entry point is `server/src/app/main.ts`. Double-clicking runs a short-lived launcher, which starts the server as a background process and records its port in `~/Library/Application Support/RF Ranger/server.json`. The launcher then opens the browser and exits.
