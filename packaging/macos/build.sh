#!/usr/bin/env bash
# Build "RF Ranger.app" and a .dmg on macOS.
#
#   packaging/macos/build.sh [version] [build-number]
#
# Run from the repository root with the Node version you want to ship on PATH
# (the single-executable blob must be made by the same Node that runs it).
#
# Signing and notarization happen only when these are set; otherwise the app
# is ad-hoc signed, which runs on the build Mac but warns everywhere else:
#   SIGN_IDENTITY       "Developer ID Application: Name (TEAMID)", in a keychain
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD    for notarytool
#   BUNDLE_ID           defaults to io.github.jdnelson19.rfranger
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./server/package.json').version")}"
BUILD="${2:-1}"
BUNDLE_ID="${BUNDLE_ID:-io.github.jdnelson19.rfranger}"
NODE_VERSION="$(node --version)"
POSTJECT="postject@1.0.0-alpha.6"
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

OUT="$ROOT/dist-mac"
APP="$OUT/RF Ranger.app"
DMG="$OUT/RF-Ranger-$VERSION.dmg"
rm -rf "$OUT"
mkdir -p "$OUT"

step() { printf '\n==> %s\n' "$*"; }

step "RF Ranger $VERSION (build $BUILD) with Node $NODE_VERSION"

step "Web UI"
(cd web && npm ci && npm run build)

step "Server bundle and single-executable blob"
(cd server && npm ci && node scripts/bundle-app.mjs "$VERSION" && node --experimental-sea-config dist-app/sea-config.json)

step "Node binaries (arm64 + x64), checksums verified"
NODE_DIST="https://nodejs.org/dist/$NODE_VERSION"
curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$OUT/SHASUMS256.txt"
for arch in arm64 x64; do
  tarball="node-$NODE_VERSION-darwin-$arch.tar.gz"
  curl -fsSL "$NODE_DIST/$tarball" -o "$OUT/$tarball"
  (cd "$OUT" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c -)
  tar -xzf "$OUT/$tarball" -C "$OUT"
  cp "$OUT/node-$NODE_VERSION-darwin-$arch/bin/node" "$OUT/node-$arch"
  codesign --remove-signature "$OUT/node-$arch"
  npx --yes "$POSTJECT" "$OUT/node-$arch" NODE_SEA_BLOB server/dist-app/sea-prep.blob \
    --sentinel-fuse "$SEA_FUSE" --macho-segment-name NODE_SEA
done
lipo -create -output "$OUT/rf-ranger" "$OUT/node-arm64" "$OUT/node-x64"
lipo -info "$OUT/rf-ranger"

step "App bundle"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/rf-ranger" "$APP/Contents/MacOS/rf-ranger"
cp -R web/dist "$APP/Contents/Resources/web"
sed -e "s/@BUNDLE_ID@/$BUNDLE_ID/" -e "s/@VERSION@/$VERSION/" -e "s/@BUILD@/$BUILD/" \
  packaging/macos/Info.plist.template > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"

# Icon from the web UI's SVG. Cosmetic, so a failure here doesn't stop the build.
if qlmanage -t -s 1024 -o "$OUT" web/public/icon.svg >/dev/null 2>&1 && [ -f "$OUT/icon.svg.png" ]; then
  ICONSET="$OUT/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$OUT/icon.svg.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$OUT/icon.svg.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" || echo "warning: icon not created"
else
  echo "warning: could not render icon.svg; building without an icon"
fi

notarize() { # notarize <file>; staples nothing, returns non-zero unless Accepted
  local result id status
  result="$(xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" --wait --output-format json)"
  echo "$result"
  id="$(echo "$result" | plutil -extract id raw -o - -)"
  status="$(echo "$result" | plutil -extract status raw -o - -)"
  if [ "$status" != "Accepted" ]; then
    xcrun notarytool log "$id" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" || true
    return 1
  fi
}

CAN_NOTARIZE=""
if [ -n "${SIGN_IDENTITY:-}" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
  CAN_NOTARIZE=1
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  step "Signing with $SIGN_IDENTITY (hardened runtime)"
  for target in "$APP/Contents/MacOS/rf-ranger" "$APP"; do
    codesign --force --timestamp --options runtime \
      --entitlements packaging/macos/entitlements.plist --sign "$SIGN_IDENTITY" "$target"
  done
else
  step "No SIGN_IDENTITY: ad-hoc signing (Gatekeeper will warn on other Macs)"
  codesign --force --sign - "$APP/Contents/MacOS/rf-ranger"
  codesign --force --sign - "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

if [ -n "$CAN_NOTARIZE" ]; then
  # Staple the app itself too, so it opens without a network check: production
  # Macs are often offline.
  step "Notarizing the app"
  ditto -c -k --keepParent "$APP" "$OUT/app.zip"
  notarize "$OUT/app.zip"
  xcrun stapler staple "$APP"
fi

step "Disk image"
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "RF Ranger" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi
if [ -n "$CAN_NOTARIZE" ]; then
  step "Notarizing the disk image"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
  spctl --assess --type execute --verbose=2 "$APP"
fi

step "Done: $DMG"
ls -lh "$DMG"
