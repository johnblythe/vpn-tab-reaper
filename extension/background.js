"use strict";

// VPN Tab Reaper — background service worker.
//
// Watches for tabs that land on a VPN client's local auth callback
// (default: http(s)://(127.0.0.1|localhost):35001/*). The SAML assertion
// is delivered to the VPN client by the time that navigation completes, so
// the tab is pure garbage: reap it, restore the previously active tab, and
// get on with life.

const DEFAULT_SETTINGS = {
  enabled: true,
  // "complete" = close after the local server answered (safe, default)
  // "commit"   = close the instant navigation commits (fastest flash-kill)
  closeTiming: "complete",
  restoreFocus: true,
  notifyNeedsSignin: true,
  // Tabs that match these are ALWAYS closed (final auth callback pages).
  finalPatterns: [
    "http://127.0.0.1:35001/*",
    "http://localhost:35001/*",
    "https://127.0.0.1:35001/*",
    "https://localhost:35001/*"
  ],
  // Tabs that match these are never closed — but if one is still sitting
  // there after 30s, the VPN session probably expired and we notify.
  idpPatterns: [
    "https://device.sso.*.amazonaws.com/*",
    "https://*.awsapps.com/*",
    "https://*.okta.com/*",
    "https://login.microsoftonline.com/*",
    "https://*.pingidentity.com/*",
    "https://*.pingone.com/*"
  ]
};

const MAX_LOG = 25;
const IDP_STUCK_MS = 30000;     // how long on an IdP page before we nudge
const FINAL_WATCHDOG_MS = 5000; // close a final tab even if it never finishes

let settings = { ...DEFAULT_SETTINGS };
let stats = { reaped: 0, notified: 0, lastReapAt: 0 };
let activity = [];

// --- in-memory focus tracking (best effort; SW restarts just lose history)
/** @type {Map<number, {tabId: number, ts: number}>} windowId -> last active tab */
const lastActiveByWindow = new Map();
let prevFocusedWindowId = null;
let lastFocusedWindowId = null;

/** @type {Map<number, number>} tabId -> ts when commit to a final URL was seen */
const finalSeen = new Map();
/** @type {Map<number, {url: string, notified: boolean}>} */
const idpWatch = new Map();

// ---------------------------------------------------------------------------
// Settings / persistence
// ---------------------------------------------------------------------------

async function init() {
  const stored = await chrome.storage.local.get(["settings", "stats", "activity"]);
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  stats = { reaped: 0, notified: 0, lastReapAt: 0, ...(stored.stats || {}) };
  activity = stored.activity || [];
  recompile();
  updateEnabledBadge();
  dbg("service worker started, settings:", settings);
}
init();

function saveState() {
  chrome.storage.local.set({ settings, stats, activity });
}

// ---------------------------------------------------------------------------
// Pattern matching (chrome-style match patterns, * wildcard)
// ---------------------------------------------------------------------------

function esc(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(pattern) {
  pattern = String(pattern || "").trim();
  if (!pattern) return null;
  const m = /^(\*|https?|ftp|file):\/\/([^/?#]*)(\/.*)?$/.exec(pattern);
  if (!m) {
    // Bare glob fallback: whole string is a glob.
    return new RegExp("^" + esc(pattern).replace(/\\\*/g, ".*") + "$", "i");
  }
  const scheme = m[1] === "*" ? "https?" : m[1];
  const host = esc(m[2]).replace(/\\\*/g, "[^./]*");
  const path = esc(m[3] || "/*").replace(/\\\*/g, ".*");
  return new RegExp("^" + scheme + "://" + host + path + "$", "i");
}

let finalRes = [];
let idpRes = [];

function recompile() {
  finalRes = (settings.finalPatterns || []).map(patternToRegExp).filter(Boolean);
  idpRes = (settings.idpPatterns || []).map(patternToRegExp).filter(Boolean);
}

function isFinal(url) {
  return finalRes.some((re) => re.test(url));
}

function isIdp(url) {
  return idpRes.some((re) => re.test(url));
}

// ---------------------------------------------------------------------------
// Listeners — registered at top level (MV3 requirement)
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  lastActiveByWindow.set(windowId, { tabId, ts: Date.now() });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // all chrome unfocused
  if (lastFocusedWindowId && lastFocusedWindowId !== windowId) {
    prevFocusedWindowId = lastFocusedWindowId;
  }
  lastFocusedWindowId = windowId;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  finalSeen.delete(tabId);
  idpWatch.delete(tabId);
});

function dbg(...args) {
  // Debug trail: SW console + an in-memory ring readable from devtools/CDP.
  try {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    (globalThis.__dbg ||= []).push(`${new Date().toISOString()} ${line}`);
    if (globalThis.__dbg.length > 50) globalThis.__dbg.shift();
    console.log("[reaper]", line);
  } catch { /* never let logging break the reaper */ }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!settings.enabled) { dbg("skip: disabled", tabId); return; }
  const url = changeInfo.url || tab.url || tab.pendingUrl;
  if (!url || !/^https?:/i.test(url)) return;
  if (isFinal(url)) {
    dbg("final url seen", tabId, url, changeInfo.status, "timing:", settings.closeTiming);
    if (settings.closeTiming === "commit" && changeInfo.status === "loading") {
      reapTab(tabId, url, "instant");
      return;
    }
    if (changeInfo.status === "complete") {
      reapTab(tabId, url, "complete");
      return;
    }
    if (changeInfo.status === "loading" && !finalSeen.has(tabId)) {
      // Watchdog: some clients hold the connection; if "complete" never
      // comes, the POST was still delivered — close anyway.
      finalSeen.set(tabId, Date.now());
      setTimeout(() => {
        if (finalSeen.has(tabId)) reapTab(tabId, url, "watchdog");
      }, FINAL_WATCHDOG_MS);
    }
    return;
  }

  // Navigated somewhere that isn't a final URL — drop any watchdog.
  finalSeen.delete(tabId);

  if (isIdp(url) && changeInfo.status === "complete") {
    watchIdpTab(tabId, url);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    recompile();
    updateEnabledBadge();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reaper-resume") {
    settings.enabled = true;
    saveState();
    updateEnabledBadge();
    notify("Back to work", "VPN Tab Reaper resumed.");
  }
});

chrome.commands?.onCommand.addListener?.((command) => {
  if (command === "toggle-pause") toggleEnabled();
});

// ---------------------------------------------------------------------------
// The reaper
// ---------------------------------------------------------------------------

async function reapTab(tabId, url, mode) {
  finalSeen.delete(tabId);
  idpWatch.delete(tabId);

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    dbg("tabs.get failed", tabId, String(e));
    return; // already gone
  }

  const prevActive = lastActiveByWindow.get(tab.windowId);
  const wasActive = tab.active;

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    dbg("tabs.remove FAILED", tabId, String(e));
    return;
  }

  stats.reaped++;
  stats.lastReapAt = Date.now();
  pushActivity({ ts: stats.lastReapAt, url, mode });
  saveState();
  flashBadge(String(stats.reaped));

  // Focus restoration (best effort).
  if (settings.restoreFocus) {
    // If the VPN opened its own window for this tab, removing the last tab
    // closes the window. If the user was in a different Chrome window
    // before that, put focus back there.
    if (wasActive && prevFocusedWindowId && prevFocusedWindowId !== tab.windowId) {
      chrome.windows.update(prevFocusedWindowId, { focused: true }).catch(() => {});
    }
    // Re-activate the tab the user was on before the junk tab took over.
    if (wasActive && prevActive && prevActive.tabId !== tabId) {
      chrome.tabs.update(prevActive.tabId, { active: true }).catch(() => {});
    }
  }
}

function watchIdpTab(tabId, url) {
  if (!settings.notifyNeedsSignin) return;
  const existing = idpWatch.get(tabId);
  if (existing && (existing.notified || existing.url === url)) return;
  idpWatch.set(tabId, { url, notified: false });

  setTimeout(async () => {
    const w = idpWatch.get(tabId);
    if (!w || w.notified) return;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      idpWatch.delete(tabId);
      return;
    }
    if (!tab.url || !isIdp(tab.url)) return; // moved on (e.g. toward 35001)
    w.notified = true;
    stats.notified++;
    saveState();
    notify(
      "VPN sign-in needed",
      "A VPN authentication page has been waiting for 30 seconds. Your session may have expired."
    );
    setBadge("!", "#c62828");
  }, IDP_STUCK_MS);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function pushActivity(entry) {
  activity.unshift(entry);
  activity = activity.slice(0, MAX_LOG);
}

function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 4000);
}

function setBadge(text, color) {
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

function updateEnabledBadge() {
  if (settings.enabled) {
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
    chrome.action.setBadgeText({ text: "OFF" });
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "VPN Tab Reaper",
    message: `${title} — ${message}`,
    priority: 2
  });
}

// ---------------------------------------------------------------------------
// Actions invoked from popup / options
// ---------------------------------------------------------------------------

function toggleEnabled() {
  settings.enabled = !settings.enabled;
  if (settings.enabled) chrome.alarms.clear("reaper-resume");
  saveState();
  updateEnabledBadge();
  notify(
    settings.enabled ? "Reaping enabled" : "Reaping paused",
    settings.enabled
      ? "VPN auth tabs will be closed automatically."
      : "VPN auth tabs will be left alone."
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "toggle") {
    toggleEnabled();
    sendResponse({ enabled: settings.enabled });
    return false;
  }
  if (msg?.type === "pause5") {
    settings.enabled = false;
    chrome.alarms.create("reaper-resume", {
      when: Date.now() + 5 * 60 * 1000
    });
    saveState();
    updateEnabledBadge();
    sendResponse({ pausedUntil: Date.now() + 5 * 60 * 1000 });
    return false;
  }
  if (msg?.type === "getState") {
    chrome.storage.local.get(["settings", "stats", "activity"]).then((s) => {
      sendResponse(s);
    });
    return true; // async
  }
  if (msg?.type === "clearLog") {
    activity = [];
    saveState();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "reset") {
    stats = { reaped: 0, notified: 0, lastReapAt: 0 };
    activity = [];
    settings = { ...DEFAULT_SETTINGS };
    saveState();
    recompile();
    updateEnabledBadge();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
