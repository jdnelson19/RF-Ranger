#!/usr/bin/env bash
# Install or update RF Ranger on a Raspberry Pi (64-bit Raspberry Pi OS) or
# another Linux machine with systemd, as a server that starts at boot.
#
#   curl -fsSL https://raw.githubusercontent.com/jdnelson19/RF-Ranger/main/packaging/linux/install.sh | bash
#
# or, from an unpacked RF-Ranger-<version>-Linux-<arch>.tar.gz: ./install.sh
#
#   --server         just the server; TVs and tablets open it over the network
#   --display        also show the pickup screen full-screen on this Pi's HDMI output at boot
#   --url <url>      what the display shows (default http://localhost:8058/#/pickup)
#   --tarball <file> install from this file instead of the latest release
#   --uninstall      remove RF Ranger (keeps settings in ~/.rf-ranger)
#
# Without --server or --display it asks. Running it again updates RF Ranger
# and keeps the settings. See docs/raspberry-pi.md.
set -Eeuo pipefail

REPO="jdnelson19/RF-Ranger"
PREFIX="/opt/rf-ranger"
SERVICE="rf-ranger"
PORT=8058

MODE=""
URL="http://localhost:$PORT/#/pickup"
TARBALL=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) MODE=server ;;
    --display) MODE=display ;;
    --url) URL="$2"; shift ;;
    --tarball) TARBALL="$2"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# Questions come from the terminal even when this script is piped into bash;
# with no terminal at all (CI, ssh without -t) every answer is the default.
HAS_TTY=0
( : < /dev/tty ) 2>/dev/null && HAS_TTY=1
ask() {
  local prompt=$1 default=$2 reply
  if [ "$HAS_TTY" = 0 ]; then echo "$default"; return; fi
  read -r -p "$prompt" reply < /dev/tty || true
  echo "${reply:-$default}"
}

# The service runs as the person installing it, so settings live in their home.
if [ "$(id -u)" -eq 0 ]; then
  RUN_USER="${SUDO_USER:-}"
  [ -n "$RUN_USER" ] && [ "$RUN_USER" != root ] || fail "Run this as your normal user (not root); it asks for sudo when it needs it."
  SUDO=""
else
  RUN_USER="$(id -un)"
  SUDO="sudo"
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
as_user() { if [ "$(id -un)" = "$RUN_USER" ]; then "$@"; else sudo -u "$RUN_USER" -H "$@"; fi; }

AUTOSTART="$RUN_HOME/.config/autostart/rf-ranger-display.desktop"
DISPLAY_SCRIPT="$PREFIX-display"

if [ "$UNINSTALL" = 1 ]; then
  say "Removing RF Ranger"
  $SUDO systemctl disable --now "$SERVICE" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/$SERVICE.service" /usr/local/bin/rf-ranger "$DISPLAY_SCRIPT"
  $SUDO systemctl daemon-reload
  $SUDO rm -rf "$PREFIX"
  rm -f "$AUTOSTART"
  echo "Done. Your settings are still in $RUN_HOME/.rf-ranger (delete that folder to remove them too)."
  exit 0
fi

command -v systemctl >/dev/null || fail "RF Ranger's installer needs systemd (Raspberry Pi OS, Debian and Ubuntu have it)."
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  armv7l|armv6l) fail "This is 32-bit Raspberry Pi OS. RF Ranger needs the 64-bit version: reinstall with Raspberry Pi Imager, choosing \"Raspberry Pi OS (64-bit)\"." ;;
  *) fail "Unsupported CPU: $(uname -m)" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- get the release --------------------------------------------------------

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [ -z "$TARBALL" ] && [ -n "$HERE" ] && [ -x "$HERE/rf-ranger" ] && [ -d "$HERE/web" ]; then
  say "Installing from $HERE"
  cp -R "$HERE" "$WORK/rf-ranger"
else
  if [ -z "$TARBALL" ]; then
    say "Finding the latest RF Ranger for Linux $ARCH"
    ASSET_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -o "\"browser_download_url\": *\"[^\"]*-Linux-$ARCH\.tar\.gz\"" | head -n1 | sed 's/.*"\(https[^"]*\)"$/\1/')" || true
    [ -n "${ASSET_URL:-}" ] || fail "The latest release has no Linux $ARCH download yet. See https://github.com/$REPO/releases"
    echo "$ASSET_URL"
    TARBALL="$WORK/rf-ranger.tar.gz"
    curl -fL --progress-bar "$ASSET_URL" -o "$TARBALL"
  fi
  tar -xzf "$TARBALL" -C "$WORK"
fi
[ -x "$WORK/rf-ranger/rf-ranger" ] || fail "That download doesn't contain RF Ranger."
VERSION="$(cat "$WORK/rf-ranger/VERSION" 2>/dev/null || echo unknown)"

# ---- install and start the service ------------------------------------------

UPDATING=0
[ -d "$PREFIX" ] && UPDATING=1
say "$([ "$UPDATING" = 1 ] && echo Updating to || echo Installing) RF Ranger $VERSION in $PREFIX"
$SUDO systemctl stop "$SERVICE" 2>/dev/null || true
$SUDO rm -rf "$PREFIX.old"
[ "$UPDATING" = 1 ] && $SUDO mv "$PREFIX" "$PREFIX.old"
$SUDO cp -R "$WORK/rf-ranger" "$PREFIX"
$SUDO chown -R root:root "$PREFIX"
$SUDO rm -rf "$PREFIX.old"
$SUDO ln -sf "$PREFIX/rf-ranger" /usr/local/bin/rf-ranger

$SUDO tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=RF Ranger wireless mic monitoring
Wants=network-online.target
After=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$RUN_HOME
Environment=RF_RANGER_NO_BROWSER=1
ExecStart=$PREFIX/rf-ranger --serve
# Quit on the launch screen stops it; it comes back after a few seconds.
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE" >/dev/null

for _ in $(seq 1 40); do
  curl -fs "http://localhost:$PORT/api/snapshot" >/dev/null && break
  sleep 0.5
done
curl -fs "http://localhost:$PORT/api/snapshot" >/dev/null \
  || fail "RF Ranger didn't start. Its log: $RUN_HOME/.rf-ranger/logs/rf-ranger.log  (and: journalctl -u $SERVICE)"
echo "Running on port $PORT, and starts by itself at boot."

# ---- admin password ---------------------------------------------------------

if [ ! -f "$RUN_HOME/.rf-ranger/admin.json" ] && [ "$HAS_TTY" = 1 ]; then
  say "Admin password"
  echo "Planning Center, Add device and the Inspector are admin settings. Normally they only work on the"
  echo "computer running RF Ranger; with a password you can sign in to them from a laptop or iPad."
  if [ "$(ask 'Set an admin password now? [Y/n] ' y)" != n ]; then
    for _ in 1 2 3; do
      as_user /usr/local/bin/rf-ranger --set-password < /dev/tty && break
    done
  else
    echo "Skipped. Set one later with: rf-ranger --set-password"
  fi
fi

# ---- display ----------------------------------------------------------------

if [ -z "$MODE" ]; then
  if [ -f "$AUTOSTART" ]; then
    MODE=display # an update keeps the display
  elif [ "$(systemctl get-default 2>/dev/null)" = graphical.target ]; then
    say "Display"
    echo "This Pi can show the pickup screen full-screen on a TV plugged into its HDMI port."
    [ "$(ask 'Show it on this Pi'"'"'s screen at startup? [Y/n] ' y)" = n ] && MODE=server || MODE=display
  else
    MODE=server
  fi
fi

if [ "$MODE" = display ]; then
  say "Setting up the display"
  BROWSER="$(command -v chromium || command -v chromium-browser || true)"
  if [ -z "$BROWSER" ]; then
    echo "Installing Chromium…"
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq chromium >/dev/null
    BROWSER="$(command -v chromium || command -v chromium-browser || true)"
  fi
  [ -n "$BROWSER" ] || fail "Couldn't find or install Chromium, which shows the display. Install it, then run this again."

  # Waits for the server so the TV never shows a "can't connect" page at boot.
  $SUDO tee "$DISPLAY_SCRIPT" >/dev/null <<EOF
#!/usr/bin/env bash
# RF Ranger on this Pi's screen. Written by install.sh; started at login from $AUTOSTART.
for _ in \$(seq 1 120); do
  curl -fs http://localhost:$PORT/api/snapshot >/dev/null && break
  sleep 1
done
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run --password-store=basic \\
  --disable-session-crashed-bubble --check-for-update-interval=31536000 --ozone-platform-hint=auto \\
  "$URL"
EOF
  $SUDO chmod 755 "$DISPLAY_SCRIPT"
  as_user mkdir -p "$(dirname "$AUTOSTART")"
  as_user tee "$AUTOSTART" >/dev/null <<EOF
[Desktop Entry]
Type=Application
Name=RF Ranger display
Comment=RF Ranger full-screen on this screen
Exec=$DISPLAY_SCRIPT
X-GNOME-Autostart-enabled=true
EOF

  if command -v raspi-config >/dev/null; then
    # Log in to the desktop by itself, and never blank the screen.
    $SUDO raspi-config nonint do_boot_behaviour B4 || true
    $SUDO raspi-config nonint do_blanking 1 || true
    echo "The Pi now logs in to the desktop by itself and won't blank the screen."
  fi
  echo "At the next start this Pi shows $URL full-screen."
elif [ -f "$AUTOSTART" ]; then
  rm -f "$AUTOSTART"
  $SUDO rm -f "$DISPLAY_SCRIPT"
  echo "Display turned off: this Pi no longer opens RF Ranger on its own screen."
fi

# ---- done -------------------------------------------------------------------

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "RF Ranger $VERSION is ready"
echo "Open it from any screen on the network:"
echo "  http://$(hostname).local:$PORT"
[ -n "$IP" ] && echo "  http://$IP:$PORT"
echo
echo "Pickup screen for a TV:  http://$(hostname).local:$PORT/#/pickup"
echo "Settings and log:        $RUN_HOME/.rf-ranger"
echo "Update:                  run this installer again"
echo "Uninstall:               curl -fsSL https://raw.githubusercontent.com/$REPO/main/packaging/linux/install.sh | bash -s -- --uninstall"
[ "$MODE" = display ] && echo && echo "Restart the Pi to start the display: sudo reboot"
exit 0
