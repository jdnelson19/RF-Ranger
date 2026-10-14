# Contributing Device Reports

RF Ranger supports the hardware its contributors can test. If you have a receiver or charger that RF Ranger doesn't support, or one where a value looks wrong, a **device report** gives us what we need to fix it, without anyone needing your hardware.

## How to make one

1. Start RF Ranger (`npm run live` or `npm start`) on a computer on the same network as the device.
2. On **that computer**, open http://localhost:8058 and go to **Engineer → Inspector**. The Inspector only works on the machine running RF Ranger, not from other screens on the network.
3. Enter the device's IP address and press **Watch**.
4. Press **Get all**. For receivers, also press **Sample meters 30 s** while a transmitter is on and someone is talking into it.
5. Optional but very useful: switch a transmitter off and on, mute it, and dock it in a charger while watching.
6. Fill in **What is this device?** (type, model, firmware, and notes on transmitters and batteries).
7. Press **Export report**, then attach the file to a [Device report issue](https://github.com/jdnelson19/RF-Ranger/issues/new?template=device-report.yml).

## Is it safe?

- The Inspector only sends **read-only queries** (`GET`). Commands that change settings are refused.
- The one exception is **Sample meters**, which switches metering on for 30 seconds and then back off. It also switches off when you stop watching.
- **Remove names & addresses** (on by default) strips channel names, device and transmitter IDs, and IP addresses from the export. The report holds protocol data only: what the device says and in what format.

## What's in a report

The identification RF Ranger made, your tags and notes, every field the device reported with its latest value, and the raw messages exchanged (up to the last 5,000), plus RF Ranger version and platform.
