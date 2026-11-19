# VPN Tab Reaper — Plan

A Chrome extension that automatically kills AWS VPN Client authentication tabs
(`127.0.0.1:35001`), restores your previously-focused tab, and only bothers you
when the VPN actually needs an interactive sign-in.

## Problem

AWS Client VPN with SAML/federated auth re-authenticates on every
connect/reconnect (keepalive, network blips, reneg — every 10/15/30 min
depending on setup). Each re-auth:

1. Opens a new browser tab at the IdP sign-in URL (stealing OS focus).
2. If the IdP session is still valid, the flow auto-redirects and POSTs the
   SAML assertion to the VPN client's local listener at `127.0.0.1:35001`.
3. The tab then parks on an "Authentication successful — You may now close
   this browser tab." page **forever**.

Result: you come back to 30 junk tabs, and Chrome yanks focus mid-work.

## Research findings

- The AWS-provided client **reserves TCP port 35001** for the SAML response;
  the assertion arrives as an HTTP POST to `http://127.0.0.1:35001/` from the
  browser tab the client opened. Once that navigation commits (let alone
  completes), the VPN client already has the assertion — the success page is
  purely cosmetic.
  - Source: AWS Client VPN User Guide + "Authenticate AWS Client VPN users
    with AWS IAM Identity Center" (AWS Security Blog):
    ACS URL = `127.0.0.1:35001`, Audience = `urn:amazon:webservices:clientvpn`.
- Known-good prior art: `dougle/aws-vpn-tab-close` (Chrome Web Store,
  "AWS VPN Tab Closer", ~1,000 users, supports client v5/v6) — closes the tab
  at `127.0.0.1:35001` once the confirmation renders. Proves the approach is
  safe in production for years.
- macOS client v6+ also reserves ports 8096–8115 for internal services, but
  the SAML ACS is still 35001.
- AWS re:Post threads confirm the focus-stealing pain ("opens the system
  browser for SAML on every connect and reconnect, stealing focus each time")
  and that AWS has no fix; session reuse is a feature request.

## Approach chosen: intercept-and-reap (v1, shipping)

A Manifest V3 extension with a background service worker that:

1. **Watches tab navigations.** When a tab's URL becomes a "final callback"
   pattern (`http://127.0.0.1:35001/*`, `http://localhost:35001/*`, plus
   user-configurable extras), the SAML POST has been delivered.
2. **Reaps the tab.** Default closes when the page reaches `complete`
   (response received — maximum safety). Optional "instant" mode closes at
   commit for minimum flash, with a watchdog that closes after 5 s if the
   local server holds the connection open.
3. **Restores focus.** Tracks the last-active tab per window and the
   previously-focused window; after reaping, re-activates the tab you were on.
   If the VPN spawned a throwaway window, removing its last tab closes it.
4. **Notifies only when needed.** If a tab matching IdP patterns
   (`*.awsapps.com`, `device.sso.*.amazonaws.com`, Okta, Entra, Ping) is still
   stuck on the IdP after 30 s, the session likely expired — fire a
   notification ("VPN sign-in needed") instead of silently dying.
5. **Stats + controls.** Kill counter, activity log, popup with
   enable/pause-5-min, options page for patterns/timing, keyboard shortcut to
   toggle pause.

## Alternatives considered (and why not, for v1)

- **Block the tab from ever opening:** impossible. No Chrome extension API can
  veto a tab creation initiated by another app via the OS (`open <url>`).
  `declarativeNetRequest` can block/redirect the request, but redirecting the
  final POST would drop the assertion body and break auth.
- **Fully silent background re-auth (close instantly, replay the SAML chain
  via `fetch` in the service worker):** attractive but fragile. SAML legs are
  form auto-POSTs (fetch won't execute them — you must parse HTML and re-POST
  manually), and IdP session cookies are SameSite=Lax, so they are not sent
  on cross-site extension fetches. Working around that means reading cookies
  via `chrome.cookies` and injecting a `Cookie` header through
  declarativeNetRequest on our own requests — doable but brittle against MFA,
  conditional access, and IdP changes. Documented as a future experiment
  (v2 "silent mode"), opt-in only.
- **Native companion that registers itself as the default browser and
  forwards everything to Chrome except VPN auth URLs (completing those via
  curl):** the only true zero-tab, zero-flash solution. Much bigger surface
  area (Swift app + default-browser dance). Future option.

## Architecture

```
vpn-tab-reaper/
├── PLAN.md                 ← this file
├── README.md               ← install/usage
├── extension/
│   ├── manifest.json       ← MV3, permissions: tabs, storage, notifications, alarms
│   ├── background.js       ← service worker: watchers, reaper, focus restore, notify
│   ├── popup.html/.js/.css ← status, stats, pause, activity log
│   ├── options.html/.js    ← patterns, timing, toggles
│   └── icons/              ← 16/48/128 PNG (generated, no external deps)
└── mock/
    ├── server.js           ← mock AWS VPN local auth server (:35001) + mock IdP (:4545)
    └── README.md           ← how to run test scenarios
```

## Safety rails

- Default patterns only ever match `localhost:35001` — never a real site.
- Never touches any tab that isn't a final-callback or (for notifications
  only) an IdP SSO page.
- Reaping is one `chrome.tabs.remove` — no content scripts, no reading page
  data, no external network calls. Nothing leaves the machine.
- Pause via popup or `Cmd+Shift+U`; "close at complete" default guarantees the
  VPN client has answered before the tab dies.

## Limitations (honest ones)

- **OS-level focus:** an extension cannot hand keyboard focus back to another
  macOS app after the OS gave it to Chrome. Best case: the junk tab dies in
  well under a second (often before it paints), your previous tab is
  re-activated, and throwaway windows vanish — so the focus steal is a
  sub-second flicker instead of a lingering tab. Fully eliminating it needs
  the v2 silent mode or native companion above.

## Test plan (browser-driven) — RESULTS: 26/26 passed (2026-11-19)

Verified end-to-end via `tools/e2e_test.mjs` (raw CDP against a dedicated
Chromium instance with the extension loaded unpacked), plus a mock AWS VPN
environment (`mock/server.js`):

| # | Scenario | Result |
| --- | --- | --- |
| T1 | Direct open of `http://127.0.0.1:35001/` → tab reaped, stats/activity logged | PASS |
| T2 | Full SAML chain: IdP auto-POST → 35001 → reaped; mock client log shows `POST / — SAML assertion DELIVERED ✓` **before** the close | PASS |
| T3 | Interactive login: tab left alone while signing in; reaped only after success | PASS |
| T4 | Previously-active tab restored after the junk tab is reaped | PASS |
| T5 | Pause (kill switch): 35001 tab survives while paused, no reap counted; resume works | PASS |
| T6 | Badge flash clears after 4 s | PASS |
| T7 | IdP page stuck 30 s → notification raised, page NOT closed | PASS |
| T8 | Popup UI: title/status/kill count/activity list all render live state | PASS |

### Hard-won testing gotchas (documented so future-us doesn't re-learn them)

- **"Load unpacked" can leave the extension's service worker with dead event
  registration** — installed, enabled, zero errors, but it never wakes on tab
  events and never reaps. This happened on the very first manual install.
  One click of the extension's ↻ reload button on `chrome://extensions`
  (or `chrome.developerPrivate.reload(id)`) fixes it permanently. If the
  reaper ever looks silent after an install or a big Chrome update, reload
  it and watch the SW console — `background.js` logs every decision and
  every `tabs.remove` failure to a `[reaper]` debug trail
  (`globalThis.__dbg` ring + console).

- **Branded Google Chrome ≥136 silently ignores `--load-extension`.** The
  extension appears to "load" targets at first, but `chrome://extensions`
  shows it never installed. Use real Chromium — a build is cached at
  `~/.cache/vtr-chromium/` (installed via
  `npx @puppeteer/browsers install chromium`).
- **Unpacked extensions get auto-disabled on reload unless the profile has
  Developer Mode on** (`developerPrivate.disableReasons.unsupportedDeveloperExtension`).
  The e2e script flips it via `chrome.developerPrivate.updateProfileConfiguration`
  on a `chrome://extensions` page, then `chrome.management.setEnabled`.
- **MV3 service workers vanish between events.** The reliable pattern:
  browser-level `Target.setAutoAttach` (filter: service_worker) to get a
  session the instant the SW starts; an attached debugger also pins the SW
  alive for the whole test.
- **`chrome.runtime.sendMessage` from a SW does not deliver to its own
  `onMessage` listener** — the e2e reset falls back to sending from an
  extension page (options.html) target.
- Writing `chrome.storage.local` from outside the SW gets clobbered by the
  SW's next `saveState()` (in-memory copy). Route state resets through the
  extension's own `reset`/`clearLog` messages instead.

## Rollout (daily Chrome) — DONE (2026-11-19)

Loaded unpacked into the daily Chrome and verified live: direct 35001 tabs
reaped, full SAML chain reaped (assertion delivered before close), kill
counter and popup rendering, focus restoration. One caveat discovered during
rollout: see the "dead event registration after Load unpacked" gotcha above —
if the extension ever goes silent, hit its reload button on
`chrome://extensions` once.
