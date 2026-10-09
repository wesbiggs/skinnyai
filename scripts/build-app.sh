#!/bin/bash
# Builds dist/SkinnyAI.app (and dist/SkinnyAI-<version>.dmg with --dmg) for the
# architecture of this Mac: a native Swift shell (macos/main.swift, built with
# SwiftPM since it embeds SwiftTerm; its Metal shaders need Xcode's Metal
# Toolchain: xcodebuild -downloadComponent MetalToolchain) plus the standalone
# skinnyai binary from scripts/build-sea.mjs.
#
#   scripts/build-app.sh [--dmg]
#
# By default the app is ad-hoc signed, which runs on this Mac only. To
# distribute it, set a Developer ID identity and (for --dmg) a notarytool
# keychain profile (created once with `xcrun notarytool store-credentials`):
#
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   NOTARY_PROFILE=skinnyai scripts/build-app.sh --dmg
#
# Or put those two assignments in a gitignored .signing.env at the repo root
# (loaded automatically; `npm run release:app` is build-app.sh --dmg).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f .signing.env ] && . ./.signing.env
version="$(node -p "require('./package.json').version")"
identity="${SIGN_IDENTITY:--}"
app="dist/SkinnyAI.app"

node scripts/build-sea.mjs --out build/skinnyai
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

swift package resolve
swift build -c release --arch "$(uname -m)"
bin="$(swift build -c release --arch "$(uname -m)" --show-bin-path)"
cp "$bin/SkinnyAI" "$app/Contents/MacOS/SkinnyAI"
# SwiftTerm looks for its shader bundle in Contents/Resources.
cp -R "$bin/SwiftTerm_SwiftTerm.bundle" "$app/Contents/Resources/"
cp build/skinnyai "$app/Contents/MacOS/skinnyai-cli"
sed "s/@VERSION@/$version/g" macos/Info.plist > "$app/Contents/Info.plist"
[ -f macos/AppIcon.icns ] && cp macos/AppIcon.icns "$app/Contents/Resources/AppIcon.icns" || true

# License texts for what the app embeds (Node via the SEA binary, SwiftTerm)
# plus our own, so the notices travel with the binaries.
node_license="$(dirname "$(dirname "$(node -p process.execPath)")")/LICENSE"
swiftterm_license=".build/checkouts/SwiftTerm/LICENSE"
for f in "$node_license" "$swiftterm_license"; do
  [ -f "$f" ] || { echo "Missing license file for the notices: $f" >&2; exit 1; }
done
cp scripts/sessions-volume.sh "$app/Contents/Resources/sessions-volume.sh"
chmod +x "$app/Contents/Resources/sessions-volume.sh"
cp LICENSE "$app/Contents/Resources/LICENSE.txt"
{
  echo "SkinnyAI is licensed under the Apache License 2.0 (see LICENSE.txt)."
  echo "It includes the following third-party software."
  printf '\n================ Node.js %s (embedded in skinnyai-cli) ================\n\n' "$(node -p process.version)"
  cat "$node_license"
  printf '\n================ SwiftTerm ================\n\n'
  cat "$swiftterm_license"
} > "$app/Contents/Resources/THIRD_PARTY_NOTICES.txt"

# Sign inside-out: the node binary needs the JIT entitlements, then the bundle.
options=()
[ "$identity" != "-" ] && options=(--options runtime --timestamp)
codesign --force --sign "$identity" ${options[@]+"${options[@]}"} --entitlements macos/entitlements.plist "$app/Contents/MacOS/skinnyai-cli"
codesign --force --sign "$identity" ${options[@]+"${options[@]}"} "$app/Contents/Resources/SwiftTerm_SwiftTerm.bundle"
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
