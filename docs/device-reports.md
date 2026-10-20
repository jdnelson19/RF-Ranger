# Contributing Device Reports

RF Ranger supports the hardware its contributors can test. If you have a receiver or charger that RF Ranger doesn't support, or one where a value looks wrong, a **device report** gives us what we need to fix it, without anyone needing your hardware.

## How to make one

1. Open RF Ranger (the app, or `npm run live` / `npm start`) on a computer on the same network as the device.
2. On **that computer**, go to **Engineer → ⚙ → Inspector**. The Inspector only works on the machine running RF Ranger, not from other screens on the network.
3. Enter the device's IP address and press **Watch**. Leave the port blank: RF Ranger tries Shure (2202, 2201) and Sennheiser (45).
4. **Shure:** press **Get all**. **Sennheiser:** press **Read everything** and wait for "Read … addresses" in the log (up to a minute).
   For receivers, also press **Sample meters 30 s** while a transmitter is on and someone is talking into it.
5. Optional but very useful: switch a transmitter off and on, mute it, and dock it in a charger while watching.
6. Fill in **What is this device?** (type, model, firmware, and notes on transmitters and batteries).
7. Press **Export report**, keeping **Remove names & addresses** on. Then send the file either way:
   - **Easiest:** use the feedback form at https://rfranger.app/#feedback. Choose **New device / device report** and attach the file. It's stored privately for the RF Ranger developers, and only a short summary (model, firmware, size) is posted publicly. The form only accepts reports exported with names and addresses removed.
   - **Or** attach it to a [Device report issue](https://github.com/jdnelson19/RF-Ranger/issues/new?template=device-report.yml) on GitHub, which is public.

## Sennheiser EW-DX and Digital 6000

Support for these is new and written from Sennheiser's protocol documents, without hardware to test on. Reports from real
receivers are what will confirm it, so they're especially welcome.

- **EW-DX (EM 2, EM 4):** third-party control is off by default. In **Sennheiser Control Cockpit**, open the receiver, go to
  **Access → 3rd party media control access**, and choose **Legacy** (SSCv1). RF Ranger doesn't support the **Secure**
  (SSCv2, password) option yet. Without this, the receiver doesn't answer on port 45 at all.
- **Digital 6000 (EM 6000):** answers on port 45 with no setup.
- The computer running RF Ranger must be able to reach the receiver's control network (the same one Control Cockpit or
  Wireless Systems Manager uses).

When reporting, please also note in **Notes** what the receiver's front panel shows for each channel: name, frequency,
transmitter type, battery, and whether a transmitter is on. That lets us check RF Ranger reads the values correctly.

If RF Ranger finds the receiver by itself, also check the Engineer view against the front panel, and say what didn't match.

## Is it safe?

- The Inspector only sends **read-only queries**: `GET` for Shure, and for Sennheiser reads (every value null) plus `/osc/schema`, which lists what addresses exist. Anything that would change a setting is refused. **Read everything** also skips anything named like reset, identify, update or password.
- The one exception is **Sample meters**, which switches metering on for 30 seconds and then back off (for Sennheiser, a meter subscription that also expires by itself). It also switches off when you stop watching.
- **Remove names & addresses** (on by default) strips channel names, device and transmitter names and IDs, serial numbers, and IP and MAC addresses from the export. The report holds protocol data only: what the device says and in what format.

## What's in a report

The identification RF Ranger made, your tags and notes, every field the device reported with its latest value, and the raw messages exchanged (up to the last 5,000), plus RF Ranger version and platform.
