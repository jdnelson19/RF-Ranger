# RF Ranger

**Your wireless. Under control.**

RF Ranger monitors wireless microphone systems for live production. It has two views that share the same live data:

- **Pickup View:** a full-screen display at the RF table. Artists find their assigned mic or bodypack by name and photo, along with a simple readiness label.
- **Engineer View:** a dense dashboard showing battery, RF, audio, frequency, and connection status for every channel, plus a view of the channels that need attention.

Shure is the first supported hardware ecosystem. Sennheiser is planned next.

> **Status:** Early development. The Shure adapter (ULX-D, Axient Digital, SLX-D, SBC220/SBC240 chargers), readiness rules, and the Engineer and Pickup UIs run end-to-end against simulated hardware. Validation against real receivers is next.

## Docs

- [Micboard audit](docs/micboard-audit.md): license, architecture, defects, what to keep
- [Architecture](docs/architecture.md): data model, readings, readiness rules
- [Shure protocol notes](docs/shure-protocol.md): per-family fields, units, sentinels
- [Hardware validation](docs/hardware-validation.md): how to test against real receivers

## Try it

Requires Node.js 20 or newer, on macOS or Windows.

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

**Keyboard:** `1`–`9` select a group, `0` shows all groups, `f` toggles fullscreen, `Esc` returns to the launch screen.
