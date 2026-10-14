# Hardware Validation: ULX-D and Axient Digital

The Shure adapter was built from Shure's published command-string documents and tested against a simulator. This checklist confirms that it reads **real** receivers correctly. Every probe session writes a raw log of everything the receiver sent. Those logs are the evidence we'll use to fix any mapping errors.

## Setup

1. Install Node.js 20 or newer (macOS or Windows).
2. `cd server && npm install`
3. Give each receiver a fixed or reserved IP address. Confirm you can reach it: `ping <ip>`.
4. Note each receiver's **model, RF band, and firmware version** (front panel, or Wireless Workbench).
5. Optional: try the tool without hardware first, with `npm run sim -- ulxd` in one terminal and `npm run probe -- ulxd 127.0.0.1` in another.

## Run the probe

```
npm run probe -- ulxd 192.168.1.50          # ULXD4 / ULXD4D / ULXD4Q
npm run probe -- axd  192.168.1.60          # AD4D / AD4Q
npm run probe -- ulxd 192.168.1.50 --channels 2   # dual receiver
```

The table refreshes every second. `—` means the receiver says the value is unavailable, `n/a` means the family can't report it, and `…` means nothing has been received yet. Raw logs are saved in `server/logs/`. Press **Ctrl+C** to stop. This switches metering off on the receiver before disconnecting.

## Checklist

For each check, note the result next to it and keep the log file.

**Static readings** (compare with the receiver front panel):
- [ ] Receiver model, device ID, and firmware shown correctly
- [ ] Channel names match
- [ ] Frequencies match (MHz)
- [ ] Battery bars match the transmitter display
- [ ] With a **Shure rechargeable** (SB900 / SB910 / SB920): battery %, and runtime in hours:minutes, match the receiver
- [ ] With **AA batteries**: bars shown, and % and runtime show `—`
- [ ] TX model correct (e.g. ULXD2, AD2)
- [ ] Axient: TX device ID shows what is set on the transmitter
- [ ] ULX-D with ULXD1/ULXD2: TX ID shows `n/a`

**Live readings:**
- [ ] RF dBm moves as you walk away from the antennas, roughly in line with the receiver's RF meter
- [ ] Axient: both antenna values (A/B) appear and differ sensibly
- [ ] Audio dBFS rises when speaking or singing into the mic
- [ ] Receiver output mute (`AUDIO_MUTE`) shows `MUTED` when muted from the front panel or WWB
- [ ] Axient: TX mute switch on a bodypack is reflected

**Transitions** (where real problems hide):
- [ ] Switch a transmitter **off**: battery changes to `—`, and readiness becomes CHECK_WITH_AUDIO within about 1 s
- [ ] Switch it **on** again: values return
- [ ] **Pull the battery** out of a live transmitter: same as switching off
- [ ] Unplug the receiver's **network cable** for 30 s: status becomes DISCONNECTED within about 5 s, then reconnects by itself after replugging
- [ ] **Power-cycle** the receiver: reconnects by itself once it has booted
- [ ] Run **Wireless Workbench at the same time**: both keep working
- [ ] Leave the probe running for **1 hour or more**: no disconnects, and the receiver front panel stays responsive (we're watching for the QLX-D-style lockup)
- [ ] Ctrl+C, then check that the receiver is still fine and WWB shows nothing unusual

## What to send back

- The `server/logs/probe-*.log` files
- Model, band, and firmware of each receiver
- Transmitter models and battery types used
- Any row in the table that didn't match the receiver, with what the receiver showed instead
