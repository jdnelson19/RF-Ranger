#!/usr/bin/env bash
# Build RF Ranger for Windows (x64): rf-ranger.exe, a portable .zip and an installer.
#
#   packaging/windows/build.sh [version]
#
# Run from the repository root in Git Bash, with the Node version you want to
# ship on PATH (the single-executable blob must be made by the same Node that
# runs it). The installer needs Inno Setup 6 (ISCC.exe); without it the build
# stops after the .zip. Nothing is code-signed yet, so Windows SmartScreen asks
# for "More info → Run anyway" the first time.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./server/package.json').version")}"
NODE_VERSION="$(node --version)"
POSTJECT="postject@1.0.0-alpha.6"
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

OUT="$ROOT/dist-win"
STAGE="$OUT/RF Ranger"
TOOLS="$OUT/tools"
rm -rf "$OUT"
mkdir -p "$STAGE" "$TOOLS"

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
  echo "::error title=Windows build failed during: $CURRENT_STEP::exit $code at build.sh line $line%0A$tail"
}
trap 'on_error $? $LINENO' ERR

step "RF Ranger $VERSION for Windows with Node $NODE_VERSION"

step "Web UI"
(cd web && npm ci && npm run build)

step "Server bundle and single-executable blob"
(cd server && npm ci && node scripts/bundle-app.mjs "$VERSION" && node --experimental-sea-config dist-app/sea-config.json)

step "Build tools (icon renderer, resource editor)"
npm install --prefix "$TOOLS" --no-save --no-audit --no-fund @resvg/resvg-js@2.6.2 rcedit@4.0.1 >/dev/null
RCEDIT="$TOOLS/node_modules/rcedit/bin/rcedit-x64.exe"
[ -f "$RCEDIT" ] || { echo "rcedit-x64.exe not found in the rcedit package"; false; }

step "Icon"
NODE_PATH="$(cygpath -w "$TOOLS/node_modules" 2>/dev/null || echo "$TOOLS/node_modules")" \
  node packaging/windows/make-icon.mjs web/public/icon.svg "$OUT/rf-ranger.ico"

step "Node binary (win-x64), checksum verified"
NODE_DIST="https://nodejs.org/dist/$NODE_VERSION"
curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$OUT/SHASUMS256.txt"
mkdir -p "$OUT/win-x64"
curl -fsSL "$NODE_DIST/win-x64/node.exe" -o "$OUT/win-x64/node.exe"
(cd "$OUT" && grep " win-x64/node.exe\$" SHASUMS256.txt | sha256sum -c -)
EXE="$OUT/rf-ranger.exe"
cp "$OUT/win-x64/node.exe" "$EXE"

step "rf-ranger.exe: unsign, brand, inject the app, windowed"
node packaging/windows/pe.mjs unsign "$EXE"
# Task Manager and the firewall prompt show these names instead of "Node.js".
"$RCEDIT" "$(cygpath -w "$EXE" 2>/dev/null || echo "$EXE")" \
  --set-icon "$(cygpath -w "$OUT/rf-ranger.ico" 2>/dev/null || echo "$OUT/rf-ranger.ico")" \
  --set-file-version "$VERSION" --set-product-version "$VERSION" \
  --set-version-string ProductName "RF Ranger" \
  --set-version-string FileDescription "RF Ranger" \
  --set-version-string CompanyName "RF Ranger" \
  --set-version-string InternalName "rf-ranger" \
  --set-version-string OriginalFilename "rf-ranger.exe" \
  --set-version-string LegalCopyright "RF Ranger contributors. Includes Node.js (MIT); see NOTICE."
npx --yes "$POSTJECT" "$EXE" NODE_SEA_BLOB server/dist-app/sea-prep.blob --sentinel-fuse "$SEA_FUSE"
node packaging/windows/pe.mjs gui "$EXE"

step "Smoke test: the exe runs the bundled app"
node packaging/windows/smoke.mjs "$EXE"

step "Portable folder and .zip"
cp "$EXE" "$STAGE/rf-ranger.exe"
cp -R web/dist "$STAGE/web"
cp NOTICE "$STAGE/NOTICE.txt"
ZIP="$OUT/RF-Ranger-$VERSION-Windows-portable.zip"
powershell.exe -NoProfile -NonInteractive -Command \
  "Compress-Archive -Path '$(cygpath -w "$STAGE" 2>/dev/null || echo "$STAGE")' -DestinationPath '$(cygpath -w "$ZIP" 2>/dev/null || echo "$ZIP")' -Force"

step "Installer"
ISCC="${ISCC:-}"
for candidate in "$ISCC" "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "/c/Program Files/Inno Setup 6/ISCC.exe" "$LOCALAPPDATA/Programs/Inno Setup 6/ISCC.exe"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then ISCC="$candidate"; break; fi
  ISCC=""
done
if [ -z "$ISCC" ] && command -v iscc >/dev/null 2>&1; then ISCC="$(command -v iscc)"; fi
if [ -z "$ISCC" ]; then
  echo "Inno Setup (ISCC.exe) not found: skipping the installer. The portable .zip is ready."
  [ -z "${GITHUB_ACTIONS:-}" ] || { echo "::error::Inno Setup is required on CI"; false; }
else
  # Git Bash would rewrite ISCC's /D options as file paths; the paths here are already Windows-style.
  MSYS2_ARG_CONV_EXCL='*' "$ISCC" /Qp "/DVersion=$VERSION" "/DSourceDir=$(cygpath -w "$STAGE")" "/DIconFile=$(cygpath -w "$OUT/rf-ranger.ico")" \
    "/DOutDir=$(cygpath -w "$OUT")" "$(cygpath -w packaging/windows/rf-ranger.iss)"
fi

step "Done"
ls -lh "$OUT"/*.zip "$OUT"/*.exe
