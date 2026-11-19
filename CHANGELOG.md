# Changelog

## [Unreleased]

### Added
- **Right-click kill list**: context menu on any page — "VPN Tab Reaper: auto-close tabs on this site" — derives a match pattern from the page's origin, adds it to the kill list, and closes the page. Patterns remain editable on the settings page. Also exposed as an `addFinalPattern` runtime message for automation.

## [1.0.0] - 2026-11-19

### Added
- **Auto-close AWS VPN Client auth tabs**: any tab landing on the VPN client's local SAML listener (`127.0.0.1:35001` / `localhost:35001`) is closed as soon as the page finishes loading, after the SAML assertion has been delivered. Optional "instant" mode closes on navigation commit.
- **Focus restoration**: re-activates the previously active tab after reaping; throwaway windows close with the junk tab.
- **Sign-in-needed notification**: an IdP sign-in page (AWS SSO, Okta, Entra, Ping) stuck for 30 seconds raises a notification instead of failing silently.
- **Popup UI**: kill counter, recent-kills log, pause / pause-5-min controls.
- **Options page**: final-callback and IdP URL match patterns, close timing, focus/notify toggles.
- **Keyboard shortcut** `Cmd+Shift+U` / `Ctrl+Shift+U` to toggle pause.
- **Debug trail**: every reap decision and `tabs.remove` failure is logged (`[reaper]` console lines + `globalThis.__dbg` ring).
- **Mock environment** (`mock/server.js`): mock AWS VPN local auth server + mock IdP for safe end-to-end testing.
- **E2E test suite** (`tools/e2e_test.mjs`): 26 CDP-driven checks against a dedicated Chromium instance — reaping, SAML-chain safety (assertion delivered before close), login flow, focus restore, pause, badge, notification, popup UI.

### Fixed
- **Match-pattern wildcards were broken**: `*` was never escaped before the wildcard substitution, so trailing `/*` only worked by accident (as a regex quantifier) and any pattern with a real path (e.g. `http://localhost:8095/authorization/callback`) never matched. Wildcards now work in scheme, host, and path as documented.
- Popup "clear" no longer gets clobbered by the service worker's in-memory log (routed through a `clearLog` message).

### Known issues
- A fresh manual "Load unpacked" can leave the service worker's event registration dead (installed, enabled, no errors, but never reaps). One click of the extension's reload button on `chrome://extensions` fixes it permanently.
