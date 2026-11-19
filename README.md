# VPN Tab Reaper

A Chrome extension that automatically closes the "Authentication successful —
you may now close this browser tab" tabs the AWS VPN Client leaves open at
`127.0.0.1:35001` on every single reconnect. The tab dies within a second (the
SAML assertion is already delivered by then), your previous tab gets focus
back, and if the VPN genuinely needs you to sign in you get a notification
instead of a silent VPN failure.

## Install by hand (~30 seconds)

1. Open `chrome://extensions` and turn on **Developer mode**
2. Click **Load unpacked** and select this repo's `extension/` folder
3. If it ever looks silent: click its **↻ reload** button once — fresh installs
   sometimes start with a dead service worker; one reload fixes it

## Install with an agent

Paste this prompt into your coding agent (Claude Code, OpenCode, Cursor, …):

> Install the VPN Tab Reaper Chrome extension for me. Clone
> https://github.com/johnblythe/vpn-tab-reaper if you don't have it yet, then:
> (1) open `chrome://extensions` in Chrome, enable Developer Mode, and load the
> repo's `extension/` folder as an unpacked extension — if your tools can't
> drive the native file picker, tell me exactly which folder to pick and I'll
> click it; (2) reload the extension once right after install (known Chrome
> quirk: a fresh Load unpacked can leave the service worker's event
> registration dead — one reload fixes it); (3) verify it works: run
> `node mock/server.js` from the repo, open `http://127.0.0.1:35001/` in a new
> tab — it should close itself within a couple of seconds, and the extension's
> popup should show a kill counter; (4) stop the mock server when done (it
> occupies port 35001, which the real AWS VPN Client needs).

## What it does

- Closes any tab that lands on `http(s)://(127.0.0.1|localhost):35001` — the
  AWS VPN Client's local SAML listener — as soon as the page finishes loading
- **Right-click any other junk page → "VPN Tab Reaper: auto-close tabs on this
  site"** — adds its origin to the kill list and closes it (great for other
  local OAuth callback tabs, e.g. token-refresh pages that keep popping open)
- Restores the tab you were on before the junk tab appeared
- Notifies you if an IdP sign-in page (AWS SSO, Okta, Entra, Ping) sits
  untouched for 30 seconds — your session expired, the VPN needs you
- Kill counter + recent-kills popup, pause controls (`Cmd+Shift+U`), and a
  settings page for custom URL patterns and close timing

Everything runs locally — no content scripts, no network calls, nothing leaves
your machine. Full research rationale, design notes, and test tooling are in
[PLAN.md](PLAN.md).
