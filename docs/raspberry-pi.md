# Raspberry Pi and Linux

RF Ranger can run on a Raspberry Pi as a small always-on server. A Pi can
also drive a TV: tuck it behind the TV by the mic table and it shows the
pickup screen at boot, with no laptop involved.

Two setups, chosen when you install:

- **Server**: the Pi runs RF Ranger. TVs, laptops and iPads open it in a
  browser over the network, as they would from the Mac or Windows app.
- **Server and display**: the same, and the Pi also shows the pickup screen
  full-screen on its own HDMI output.

## What you need

- A **Raspberry Pi 4 or 5** (2 GB or more). A Pi 3 or Zero 2 W runs the server,
  but is too slow to also drive a display.
- **Raspberry Pi OS (64-bit)**. For the display setup, the version with the
  desktop. 32-bit Pi OS isn't supported.
- **Wired Ethernet** on the same network as the receivers. Shure devices
  announce themselves by multicast, which Wi-Fi often drops. If discovery
  can't see a receiver, add it by IP address (Devices → Add device).

## Install

On the Pi, in a terminal or over ssh:

```sh
curl -fsSL https://raw.githubusercontent.com/jdnelson19/RF-Ranger/main/packaging/linux/install.sh | bash
```

It downloads the latest release, installs it in `/opt/rf-ranger` and starts
it as a service that comes back at every boot and after a crash. It asks:

1. **An admin password** (see below). Leave it out and admin settings stay on
   the Pi itself.
2. **Whether to show RF Ranger on the Pi's own screen** (only when the Pi
   boots to a desktop). Yes sets up Chromium to open the pickup screen
   full-screen at login, turns on automatic desktop login and turns off
   screen blanking. Restart the Pi to start it.

To choose without being asked: `… | bash -s -- --server` or `--display`.
`--url` changes what the display shows, for example one show preset:
`--url "http://localhost:8058/#/pickup?show=<preset id>"`.

When it's done it prints the addresses to open, such as
`http://raspberrypi.local:8058`. The engineer view is there, and the pickup
screen for a TV is at `/#/pickup`.

**Without internet on the Pi:** download `RF-Ranger-<version>-Linux-arm64.tar.gz`
from [Releases](https://github.com/jdnelson19/RF-Ranger/releases), copy it
over, then `tar -xzf RF-Ranger-*.tar.gz && ./rf-ranger/install.sh`.

## Admin password

Connecting Planning Center, adding or forgetting devices and the Device
Inspector are admin settings. Normally they work only in a browser on the
computer running RF Ranger, so a TV or iPad on the network can't change them.
A Pi has nobody sitting at it, so set an admin password, then sign in from
any screen: those pages show a password box. ⚙ → Sign out of admin signs a
shared screen out again.

- Set or change it: `rf-ranger --set-password` (changing it signs every
  screen out)
- Remove it: `rf-ranger --clear-password`

Signing in lasts 30 days on that browser, or until RF Ranger restarts. After
five wrong passwords in a minute, sign-in pauses for a minute.

The password travels over plain HTTP, like everything else RF Ranger serves,
so keep RF Ranger on the production network, not the open internet.

## Updating and removing

- **Update:** run the install command again. Settings, presets, Planning
  Center and the display setup are kept.
- **Uninstall:** `curl -fsSL https://raw.githubusercontent.com/jdnelson19/RF-Ranger/main/packaging/linux/install.sh | bash -s -- --uninstall`.
  Settings stay in `~/.rf-ranger` until you delete it.

## Where things are

| | |
|---|---|
| Program | `/opt/rf-ranger` (`rf-ranger` on the PATH) |
| Settings, presets, Planning Center link, admin password | `~/.rf-ranger` |
| Log | `~/.rf-ranger/logs/rf-ranger.log` |
| Service | `rf-ranger` (`sudo systemctl status rf-ranger`, `sudo systemctl restart rf-ranger`) |
| Display | `~/.config/autostart/rf-ranger-display.desktop`, which runs `/opt/rf-ranger-display` |

A show config (`rf-ranger.config.json`, see the main README) goes in
`~/.rf-ranger` too; without one RF Ranger finds devices by itself.

## How it's built

`packaging/linux/build.sh` makes the same single-executable app as the Mac and
Windows builds (Node with the bundled app injected), for the CPU it runs on.
`.github/workflows/linux-app.yml` builds arm64 on GitHub's arm64 runners and
x64 on the usual ones. Each build then runs `install.sh --server` on the
runner, checks the service answers with the right version, and uninstalls.
Tags attach `RF-Ranger-<version>-Linux-arm64.tar.gz` and `-Linux-x64.tar.gz`
to the release, where the installer finds them.

The display part (Chromium kiosk, desktop autologin) can't be tested on CI;
check it on a real Pi when it changes.
