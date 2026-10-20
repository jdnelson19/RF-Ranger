# RF Ranger

**Your wireless. Under control.**

RF Ranger monitors wireless microphone systems for live production. It has two views that share the same live data:

- **Pickup View:** a full-screen display at the RF table. Artists find their assigned mic or bodypack by name and photo, along with a simple readiness label.
- **Engineer View:** a dense dashboard showing battery, RF, audio, frequency, and connection status for every channel, plus a view of the channels that need attention.

Shure is the first supported hardware ecosystem. Sennheiser is planned next.

> **Status:** Early development. The Shure adapter (ULX-D, Axient Digital, SLX-D, SBC220/SBC240 chargers, and provisional PSM 1000 in-ear monitor support), readiness rules, and the Engineer and Pickup UIs run end-to-end against simulated hardware. Validation against real receivers is next.

## Docs

- [Micboard audit](docs/micboard-audit.md): license, architecture, defects, what to keep
- [Architecture](docs/architecture.md): data model, readings, readiness rules
- [Shure protocol notes](docs/shure-protocol.md): per-family fields, units, sentinels
- [Hardware validation](docs/hardware-validation.md): how to test against real receivers
- [Device reports](docs/device-reports.md): help add support for hardware you have
- [macOS app](docs/macos-app.md): using the app, and how it's built, signed and notarized
- [Windows app](docs/windows-app.md): installing and using RF Ranger on Windows, and how it's built
- [Planning Center](docs/planning-center.md): link your church's account (Engineer → Planning Center); scheduled people and live timers

## Try it

**On a Mac:** download `RF-Ranger-<version>.dmg` from [Releases](https://github.com/jdnelson19/RF-Ranger/releases), drag RF Ranger to Applications, and open it. It starts in live mode and opens in your browser.

**On Windows:** download `RF-Ranger-<version>-Windows-Setup.exe` from [Releases](https://github.com/jdnelson19/RF-Ranger/releases) and run it. You don't need to be an administrator. Then open RF Ranger from the Start menu. There's also a portable `.zip` that needs no installing. See [docs/windows-app.md](docs/windows-app.md) for the first-run SmartScreen and firewall prompts.

**From source:** requires Node.js 20 or newer, on macOS or Windows.

```
cd web && npm install && npm run build
cd ../server && npm install
npm run demo                 # simulated receivers and charger -> http://localhost:8058
```

Opening the app shows a launch screen with two choices: **Artist Pickup** (the TV display at the RF table) or **Engineer**. Every view has its own URL, so a backstage TV can be bookmarked straight to `#/pickup?group=Vocals`.

**With real hardware, no setup:** run `npm run live` in `server/`. It finds Shure receivers and networked chargers on the network, identifies them, and names slots from the receivers' channel names, the way Micboard does. You can also add devices by address: `npm run live -- --receiver 10.0.1.20`. Run `npm run discover` to list what's on the network.

**Configured show:** copy `server/rf-ranger.config.example.json` to `server/rf-ranger.config.json`, set up artists, groups, and charger bays, then run `npm start`.

**UI development:** run `npm run demo` in `server/` and `npm run dev` in `web/` (Vite on :5173, with proxying to the server).

**Hardware check:** `npm run probe -- ulxd <receiver-ip>` (see [docs/hardware-validation.md](docs/hardware-validation.md)).

**Show presets:** in the Engineer view, pick **Show → New preset** to save a named, ordered set of channels for one part of a service (e.g. "Worship" for the vocal mics, "Message" for the pastor and announcements). Presets are saved on the RF Ranger computer and shared live with every engineer screen. A screen can be bookmarked to one (`#/engineer?show=<id>`). The Attention tab always covers every channel. In the preset editor, each channel can have a **nickname** for that show (RF-4 is "Sam" this week), which replaces the channel name on its tile. Each channel can also have a **waveform**: the last 5 seconds of audio, with an RF strip underneath. If audio drops out together with RF, it's an RF problem. If audio spikes while RF stays steady, someone bumped the mic. Clicking any mic tile shows a larger waveform. **Display ▾** picks which details each mic tile shows (battery, runtime, RF, audio, frequency, link quality, transmitter line, alert line); that setting is saved per screen.

**Pickup display for a preset:** on the start screen, pick a preset under **Pickup display for a show preset**, or use the engineer view's **Pickup view ↗** while a preset is selected. It's also bookmarkable (`#/pickup?show=<id>`). The TV then shows only that preset's channels, in its order, with its nicknames. On a shared network, that keeps other rooms' receivers off the screen. Cards fill each column top to bottom, like mics laid out on a table. Set **Pickup columns** in the preset editor (for example, 2 columns of 6 for 12 mics) and each card becomes a wide strip: mic label, person, status.

**Planning Center:** fill mics from the people scheduled for the next service, by hand or automatically before each service. During a service, the pickup screen shows the live segment with its clock, and the engineer view shows a live banner. Whoever the item's Leader note names is highlighted. See [docs/planning-center.md](docs/planning-center.md).

**Remembered receivers (live mode):** every receiver and charger RF Ranger finds is remembered, with its channel names, in `~/.rf-ranger/known-devices.json`. At the next start they're on screen straight away, offline until they answer, so mics on a switched-off receiver can still have roles and presets. To remove one for good, use **Forget** on the Devices tab (on the RF Ranger computer).

**Updates:** the app checks rfranger.app now and then for a newer version, and shows **Update available** on the engineer and start screens when there is one. Offline, it shows nothing. Set `RF_RANGER_NO_UPDATE_CHECK=1` to turn the check off.

**Keyboard:** `1`–`9` select a group, `0` shows all groups, `f` toggles fullscreen, `Esc` returns to the launch screen.
