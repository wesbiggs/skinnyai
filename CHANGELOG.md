# Changelog

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
