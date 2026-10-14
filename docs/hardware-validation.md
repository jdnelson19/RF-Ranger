# Hardware Validation: ULX-D and Axient Digital

The Shure adapter was built from Shure's published command-string documents and tested against simulators. This session confirms it reads **real** receivers correctly. Every tool writes raw logs to `server/logs/`. Those logs are the evidence we use to fix anything that doesn't match.

> **Safe on a live system.** RF Ranger only *reads* from devices. The only setting it changes is the metering rate (how often a receiver sends meter readings), which it switches back off when it disconnects. It never changes frequencies, gain, names, or mute. To be extra careful, test outside services and rehearsals.

## Before you go (needs internet)

```
git pull
cd web && npm install && npm run build
cd ../server && npm install
```

## On site

1. **Get on the right network.** Plug the laptop into the network the receivers are on, the one Wireless Workbench uses. The laptop must reach the receivers on TCP port **2202**.
2. **Allow the firewall prompt.** When Windows Firewall asks about Node.js, allow it on **Private** networks. On macOS, click **Allow** for incoming connections.

### Step 1: discovery (2 minutes)

```
cd server
npm run discover -- --seconds 90
```

This lists every Shure device that announces itself, then asks each one what it is. Expected: your ULX-D and Axient receivers show as **supported ✓** with the right model and channel count. Networked chargers (SBC220/SBC240) show as `charger`.

- [ ] All receivers appear
- [ ] Models and channel counts are correct
- [ ] Note anything shown as "Not supported" or "No answer"

If nothing appears after 90 s, discovery may be blocked on that network. It still works to give addresses directly: `npm run discover -- 10.0.1.20 10.0.1.21`.

### Step 2: live dashboard (main test)

```
npm run live
```

Then open **http://localhost:8058**. Supported devices appear on their own, with a slot for every channel. Slot labels and artist names come from the receiver channel names: a channel named "H1 MAYA" gets the label H1 and the artist MAYA.

If discovery didn't find everything, add devices by address:

```
npm run live -- --receiver 10.0.1.20 --receiver 10.0.1.21 --charger 10.0.1.30
npm run live -- --receiver axd@10.0.1.20 --no-discover     # skip discovery entirely
```

Open the **Engineer → Devices** tab to see what was found and each connection's state.

**Static readings** (compare each tile with the receiver front panel or WWB):
- [ ] Channel names, and the label/artist split, look right
- [ ] Frequencies match
- [ ] Battery bars match the transmitter
- [ ] With **Shure rechargeables**: battery % and runtime match
- [ ] With **AA batteries**: bars are shown, and % and runtime show "—" or "n/a"
- [ ] TX model is correct. Axient: the TX device ID appears.

**Live readings:**
- [ ] RF meters move as you walk away from the antennas. Axient shows A and B separately.
- [ ] The audio meter moves when talking into the mic
- [ ] Muting the receiver output (front panel or WWB) shows MUTED

**Transitions:**
- [ ] Switch a transmitter **off**: within about a second, the tile says "Transmitter off" and Pickup says *Check with audio*
- [ ] Switch it back **on**: values return
- [ ] **Dock a transmitter in a networked charger:** the Devices tab shows the bay's charge %
- [ ] Unplug a receiver's **network cable** for 30 s: the tile turns red ("Receiver offline") within about 5 s, then recovers by itself after replugging
- [ ] **Power-cycle** a receiver: it reconnects by itself
- [ ] Leave it running **1 hour or more** with WWB open as well: no drops, and the receivers' front panels stay responsive

**Pickup view:**
- [ ] Open **Artist Pickup** on a TV or second screen and check it reads well from across the room

Press **Ctrl+C** to stop. This switches metering off on every receiver.

### Step 3: Device Inspector (one report per model)

On the laptop running RF Ranger, open **Engineer → Inspector**. For each receiver model, and for the charger:

- [ ] **Watch** it, press **Get all**, and (for receivers) **Sample meters 30 s** while someone talks into a transmitter
- [ ] Switch a transmitter off and on while watching
- [ ] Fill in **What is this device?**, then **Export report**. Untick *Remove names & addresses* for our own testing, if you're happy to keep names in.

These reports are the reference data for every model RF Ranger supports.

### Step 4 (optional): raw probe of one receiver

If anything looks wrong, capture one receiver's full conversation:

```
npm run probe -- axd 10.0.1.20
npm run probe -- ulxd 10.0.1.21
```

## What to send back

- Everything in `server/logs/`
- Screenshots of anything that looked wrong, plus what the receiver showed instead
- Receiver models, firmware versions, transmitter models, battery types, and the charger model
