#!/usr/bin/env bash
# Build RF Ranger for Linux (arm64 for a Raspberry Pi, or x64): a .tar.gz with
# the rf-ranger binary, the web UI and the installer.
#
#   packaging/linux/build.sh [version]
#
# Run on Linux, on the CPU you are building for (CI uses an arm64 runner for
# the Pi), with the Node version you want to ship on PATH: the
# single-executable blob must be made by the same Node that runs it.
# install.sh in this folder sets the result up as a service (see docs/raspberry-pi.md).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./server/package.json').version")}"
NODE_VERSION="$(node --version)"
POSTJECT="postject@1.0.0-alpha.6"
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported CPU: $(uname -m) (64-bit arm or x86 only)"; exit 1 ;;
esac

OUT="$ROOT/dist-linux"
STAGE="$OUT/rf-ranger"
rm -rf "$OUT"
mkdir -p "$STAGE"

LOG="$OUT/build.log"
exec > >(tee -a "$LOG") 2>&1
CURRENT_STEP="start"
step() { CURRENT_STEP="$*"; printf '\n==> %s\n' "$*"; }
on_error() {
  local code=$1 line=$2
  [ -n "${GITHUB_ACTIONS:-}" ] || return 0
  sleep 1
  local tail
  tail="$(tail -n 30 "$LOG" | sed -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')"
  echo "::error title=Linux build failed during: $CURRENT_STEP::exit $code at build.sh line $line%0A$tail"
}
trap 'on_error $? $LINENO' ERR

step "RF Ranger $VERSION for Linux $ARCH with Node $NODE_VERSION"

step "Web UI"
(cd web && npm ci && npm run build)

step "Server bundle and single-executable blob"
(cd server && npm ci && node scripts/bundle-app.mjs "$VERSION" && node --experimental-sea-config dist-app/sea-config.json)

step "Node binary (linux-$ARCH), checksum verified"
NODE_DIST="https://nodejs.org/dist/$NODE_VERSION"
NODE_TAR="node-$NODE_VERSION-linux-$ARCH.tar.xz"
curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$OUT/SHASUMS256.txt"
curl -fsSL "$NODE_DIST/$NODE_TAR" -o "$OUT/$NODE_TAR"
(cd "$OUT" && grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$OUT/$NODE_TAR" -C "$OUT" "node-$NODE_VERSION-linux-$ARCH/bin/node"
BIN="$STAGE/rf-ranger"
cp "$OUT/node-$NODE_VERSION-linux-$ARCH/bin/node" "$BIN"

step "rf-ranger: inject the app"
npx --yes "$POSTJECT" "$BIN" NODE_SEA_BLOB server/dist-app/sea-prep.blob --sentinel-fuse "$SEA_FUSE"
chmod 755 "$BIN"

step "Smoke test: the binary runs the bundled app"
SMOKE_HOME="$(mktemp -d)"
echo "smoke-test-password" | HOME="$SMOKE_HOME" "$BIN" --set-password
grep -q '"hash"' "$SMOKE_HOME/.rf-ranger/admin.json" || { echo "rf-ranger --set-password wrote no admin.json: the app blob didn't run"; false; }
rm -rf "$SMOKE_HOME"
echo "Smoke test passed."

step "Package"
cp -R web/dist "$STAGE/web"
cp NOTICE "$STAGE/NOTICE.txt"
cp packaging/linux/install.sh "$STAGE/install.sh"
chmod 755 "$STAGE/install.sh"
echo "$VERSION" > "$STAGE/VERSION"
TARBALL="$OUT/RF-Ranger-$VERSION-Linux-$ARCH.tar.gz"
tar -czf "$TARBALL" -C "$OUT" rf-ranger

step "Done"
ls -lh "$TARBALL"
