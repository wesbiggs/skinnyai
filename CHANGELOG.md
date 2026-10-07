# Changelog

## Unreleased

### Changed
- Removed the DuckDuckGo HTML scraper and the `recency` argument. Without an `OLLAMA_API_KEY`, `web_search` returns only DuckDuckGo Instant Answers (with `t=skinnyai` and attribution, per the API's terms); full web search uses Ollama's hosted search.
- skinnyai identifies itself (`skinnyai/<version>`) instead of sending a browser User-Agent, for Instant Answers and `fetch_page`.
- README trimmed to an overview; details moved to `docs/*.md`, with corrections (requests go to `/api/chat`, the app's start window, the Anthropic API).
- `npm run release:app` signs, notarizes, and staples the DMG; `build-app.sh` reads `SIGN_IDENTITY` and `NOTARY_PROFILE` from a gitignored `.signing.env`.
- The app bundles `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` (Node.js and SwiftTerm licenses).
- `/show settings` separates settings you can change from those fixed for the session.
- Session names keep spaces in their filenames (files saved with `%20` still load).
- After `/save`, the resume hint matches how the program was launched (`skinnyai`, or File > Open Chat... in the app).
- A chat that finds another chat saved to its session file since it last did asks whether to reload, save under a new name, overwrite, or skip.
- `/set format json` also adds "Respond only with a valid JSON object." to the system message.

### Fixed
- Starting with a saved session's name now restores its model, API, and host before the welcome box (it showed the session name as the model, and ignored the saved API).

## 0.10.0

### Added
- Config profiles: top-level `"defaultProfile"` names the profile used when none is requested (no profile needs to be called "Default"), `"shared"` (profile-shaped) sits under every profile, and `"startupEnv"` holds launch-only settings (CA file, colors, trusted hosts, image dir).
- `/set profile [name]` lists or switches profiles, restarting MCP servers and starting a new conversation.
- Sessions also save verbose and stop-on-exit; `/load` reports the autosave state.
- macOS app: "Make Default" for profiles and a "Skip profile selection at start" option (off by default).

### Changed
- SwiftTerm is pinned to main commit `4d5eeea` (wide-character reflow fix) instead of tracking `main`.
- The SEA binary strips local symbols on macOS (~25 MB smaller).

### Fixed
- App build against current SwiftTerm main.

## 0.9.0

Initial tagged release.
