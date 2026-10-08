# macOS app

`npm run build:app` builds `dist/SkinnyAI.app`: a small native shell around a standalone `skinnyai` binary (Node is embedded, so nothing needs installing). Chats run in the app's own terminal windows, built on [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) with inline images and Shift+Enter.

## Using it

- **Start window.** Launching the app, or clicking the Dock icon with nothing open, shows a window with a profile picker (pre-selected to the one you used last), a one-line summary, and **New Chat**, **Settings…**, and **Open Chat…** buttons. Clicking the Dock icon while a chat is open brings it forward instead.
- **Skip the picker.** **Settings → App → Skip profile selection at start** (off by default) starts a chat with the default profile at launch and on a Dock click with nothing open. **File → New Chat** (⌘N) still shows the start window; **Make Default** in the Profile section chooses which profile is the default.
- **Chats.** Each chat is its own window; closing it ends the chat. A clean exit closes the window; a failed exit leaves it open with the exit code in the title. **Settings… → Open chats in** can send chats to Terminal or iTerm instead.
- **Sessions.** **File → Save / Save As…** type `/save [name]` into the front chat, and **File → Open Chat…** resumes a saved chat from `~/.skinny/sessions`. The window title shows the session name (`SkinnyAI: <name>`).
- **Text size.** **Option+=** and **Option+-** make text bigger or smaller, **Option+0** resets it (also under View); Settings has a font size too.
- **Settings** (⌘,) edit `~/.skinny/config.json`: a **Profile** box at the top picks, saves into, or creates a profile, and below it are the API key, server, model, and on/off options. Variables and MCP servers the app doesn't know about are preserved, only values that differ from the program's defaults are stored, and the file is written readable only by you. On first launch with no model set, Settings opens automatically (choosing an API fills in its usual server address). The Model field is a drop-down of what the server offers, refreshed when you change the server, API, or key; if the server can't be queried it falls back to a text field with the reason.

## Building

Building needs Xcode with its Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`); the Swift part is built with SwiftPM (`Package.swift`). Both builds are for the architecture of the Mac they run on; an Intel build needs an x64 Node binary.

```bash
npm run build:app      # ad-hoc signed: runs on this Mac only
npm run build:sea      # just the standalone CLI binary (build/skinnyai)
```

The app also bundles `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` (Node.js and SwiftTerm license texts) in `Contents/Resources`, generated at build time from the Node you build with and the pinned SwiftTerm checkout.

### Signing and notarizing

Gatekeeper blocks unsigned apps on other Macs. To distribute, you need a **Developer ID Application** certificate (not Apple Development or Apple Distribution) and a notarytool keychain profile, created once with `xcrun notarytool store-credentials` using your Apple ID, team ID, and an app-specific password. Put the identity and profile name in a gitignored `.signing.env` at the repo root:

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
NOTARY_PROFILE=skinnyai
```

Then:

```bash
npm run release:app    # signs, builds dist/SkinnyAI-<version>.dmg, notarizes, and staples it
```

(`scripts/build-app.sh --dmg` is the same thing; `SIGN_IDENTITY` and `NOTARY_PROFILE` can also be set on the command line.) The DMG is not built or attached by the GitHub release workflow; upload it yourself, e.g. with `gh release upload`.
