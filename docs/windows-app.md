# Windows app

RF Ranger for Windows comes as an installer, `RF-Ranger-<version>-Windows-Setup.exe`, and as a portable `RF-Ranger-<version>-Windows-portable.zip`. Both are for 64-bit Windows 10 or 11 and need no Node.js install. GitHub Actions builds them for every release tag (`.github/workflows/windows-app.yml`).

## Installing

- **Installer (no admin needed):** run the Setup file. By default it installs for you only, into `%LOCALAPPDATA%\Programs\RF Ranger`, and adds RF Ranger to the Start menu (and the desktop, if you tick the box). An administrator can pick **Install for all users** instead. That also adds a Windows Firewall rule (see below).
- **Portable:** unzip anywhere, such as a USB stick, and double-click `rf-ranger.exe`. Keep the `web` folder next to it.
- **"Windows protected your PC":** the app isn't code-signed yet, so SmartScreen warns the first time. Click **More info → Run anyway**. You only need to do this once per version.
- **Updating:** run the new Setup. It stops a running RF Ranger first (switching receiver metering off), then replaces it.
- **Uninstalling:** use Settings → Apps → RF Ranger. It stops RF Ranger first. Your settings in `%APPDATA%\RF Ranger` are kept.

## Using it

- **Open:** start RF Ranger from the Start menu. It runs in the background, with no window of its own, and opens your browser at `http://localhost:8058`. If that port is taken, it uses the next free one. Opening it again while it's running just reopens the browser.
- **Quit:** use the **Quit RF Ranger** button at the bottom of the launch screen on this PC. Signing out also stops it.
- **Firewall:** the first time RF Ranger runs, Windows may ask whether to allow it on the network. Click **Allow**, which needs an administrator. Without it, RF Ranger can still connect *out* to receivers. But automatic discovery of receivers and the Pickup view on other screens (TVs, tablets) need incoming connections. If you aren't an admin, ask one to approve the prompt, or to install for all users, which adds the rule (private and domain networks). On a venue network that Windows calls *Public*, set it to *Private* in Settings → Network.
- **Live mode by default:** with no config file, RF Ranger discovers Shure devices and names slots from channel names. To run a configured show, put `rf-ranger.config.json` (and its `photos` folder) in `%APPDATA%\RF Ranger\` and reopen RF Ranger.
- **Files:** settings and show presets are in `%APPDATA%\RF Ranger\` and `%USERPROFILE%\.rf-ranger\`. The log is `%APPDATA%\RF Ranger\logs\rf-ranger.log`.

## How it's built

`packaging/windows/build.sh` runs in Git Bash on a Windows runner:

1. Builds the web UI and bundles the server into one file. This step is shared with macOS (`server/scripts/bundle-app.mjs`).
2. Downloads the official `win-x64/node.exe` and verifies its checksum. Node's own signature is removed, because the next steps change the file and would break it (`pe.mjs unsign`). rcedit then sets the icon, which is rendered from `web/public/icon.svg`, and the "RF Ranger" name and version. postject injects the app.
3. Marks the exe as a windowed program (`pe.mjs gui`) so no console window opens.
4. Smoke test (`smoke.mjs`): the exe has to find a stand-in RF Ranger, ask it to quit, and exit cleanly. That proves the bundled app runs.
5. Packs the portable `.zip`. Inno Setup (`rf-ranger.iss`) builds the installer.

Run it locally the same way: `bash packaging/windows/build.sh`. Without Inno Setup installed, it stops after the `.zip`.

**Code signing** isn't set up. Signing would remove the SmartScreen warning. It needs a Windows code-signing certificate (for example Azure Trusted Signing) and a `signtool` step after step 3, applied to both the exe and the installer.
