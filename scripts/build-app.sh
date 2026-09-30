#!/bin/bash
# Builds dist/SkinnyAI.app (and dist/SkinnyAI-<version>.dmg with --dmg) for the
# architecture of this Mac: a native Swift shell (macos/main.swift) plus the
# standalone skinnyai binary from scripts/build-sea.mjs.
#
#   scripts/build-app.sh [--dmg]
#
# By default the app is ad-hoc signed, which runs on this Mac only. To
# distribute it, set a Developer ID identity and (for --dmg) a notarytool
# keychain profile (created once with `xcrun notarytool store-credentials`):
#
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   NOTARY_PROFILE=skinnyai scripts/build-app.sh --dmg
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(node -p "require('./package.json').version")"
identity="${SIGN_IDENTITY:--}"
app="dist/SkinnyAI.app"

node scripts/build-sea.mjs --out build/skinnyai
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

swiftc -O -target "$(uname -m)-apple-macos13.0" macos/main.swift -o "$app/Contents/MacOS/SkinnyAI"
cp build/skinnyai "$app/Contents/MacOS/skinnyai-cli"
sed "s/@VERSION@/$version/g" macos/Info.plist > "$app/Contents/Info.plist"
[ -f macos/AppIcon.icns ] && cp macos/AppIcon.icns "$app/Contents/Resources/AppIcon.icns" || true

# Sign inside-out: the node binary needs the JIT entitlements, then the bundle.
options=()
[ "$identity" != "-" ] && options=(--options runtime --timestamp)
codesign --force --sign "$identity" ${options[@]+"${options[@]}"} --entitlements macos/entitlements.plist "$app/Contents/MacOS/skinnyai-cli"
codesign --force --sign "$identity" ${options[@]+"${options[@]}"} "$app"
codesign --verify --strict --verbose=1 "$app"
echo "Built $app"

if [ "${1:-}" = "--dmg" ]; then
  dmg="dist/SkinnyAI-$version.dmg"
  stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -volname "SkinnyAI" -srcfolder "$stage" -format UDZO "$dmg"
  rm -rf "$stage"
  if [ "$identity" != "-" ]; then
    codesign --force --sign "$identity" --timestamp "$dmg"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
      xcrun stapler staple "$dmg"
    fi
  fi
  echo "Built $dmg"
fi
