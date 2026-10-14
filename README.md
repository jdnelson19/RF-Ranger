# RF Ranger

**Your wireless. Under control.**

RF Ranger monitors wireless microphone systems for live production. It has two views that share the same live data:

- **Pickup View:** a full-screen display at the RF table. Artists find their assigned mic or bodypack by name and photo, along with a simple readiness label.
- **Engineer View:** a dense dashboard showing battery, RF, audio, frequency, and connection status for every channel, plus a view of the channels that need attention.

Shure is the first supported hardware ecosystem. Sennheiser is planned next.

> **Status:** Early development. The Shure protocol adapter (ULX-D, Axient Digital, SLX-D) and readiness rules exist and are tested against a simulator; real-hardware validation is next. There is no UI yet.

## Docs

- [Micboard audit](docs/micboard-audit.md): license, architecture, defects, what to keep
- [Architecture](docs/architecture.md): data model, readings, readiness rules
- [Shure protocol notes](docs/shure-protocol.md): per-family fields, units, sentinels
- [Hardware validation](docs/hardware-validation.md): how to test against real receivers

## Try it

Requires Node.js 20+.

```
cd server
npm install
npm test
npm run sim -- ulxd                      # simulated receiver on :2202
npm run probe -- ulxd 127.0.0.1          # live table + raw log (use a real receiver IP for hardware)
```

## Relationship to Micboard

RF Ranger is an **independent project** inspired by and building on [Micboard](https://github.com/karlcswanson/micboard) by Karl Swanson. Micboard established a practical way to visualize Shure wireless systems for artists and engineers, and RF Ranger aims to keep that value available to the people who rely on it.

RF Ranger is **not** an official continuation of Micboard and is not endorsed by its author. Portions derived from Micboard are used under the MIT License. See [NOTICE](NOTICE).

Shure and Sennheiser are trademarks of their respective owners. RF Ranger is not affiliated with or endorsed by either company.
