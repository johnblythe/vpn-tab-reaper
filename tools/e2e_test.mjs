#!/usr/bin/env node
// End-to-end test for VPN Tab Reaper against a dedicated Chromium instance.
//
// Prereqs:
//   node mock/server.js                      (127.0.0.1:35001 + :4545)
//   Chromium launched with --remote-debugging-port=<port> \
//        --load-extension=<repo>/extension --user-data-dir=<tmp>
//
// Usage: node tools/e2e_test.mjs <port> <extensionId>
//
// Strategy: auto-attach (paused-on-start) to the extension's service worker,
// resume it, and keep the debugger session attached (which also keeps it
// alive). All assertions run through that session or the browser endpoint.
// Every CDP call has a timeout; a dead session triggers a re-wake + retry.

const PORT = process.argv[2] || "39777";
const EXT_ID = process.argv[3];
const BASE = `http://127.0.0.1:${PORT}`;

const DEFAULT_SETTINGS = {
  enabled: true,
  closeTiming: "complete",
  restoreFocus: true,
  notifyNeedsSignin: true,
  finalPatterns: [
    "http://127.0.0.1:35001/*",
    "http://localhost:35001/*",
    "https://127.0.0.1:35001/*",
    "https://localhost:35001/*"
  ],
  idpPatterns: [
    "https://device.sso.*.amazonaws.com/*",
    "https://*.awsapps.com/*",
    "https://*.okta.com/*",
    "https://login.microsoftonline.com/*",
    "https://*.pingidentity.com/*",
    "https://*.pingone.com/*"
  ]
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CDP plumbing ----------------------------------------------------------

const version = await (await fetch(`${BASE}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const sessions = []; // our extension's live service worker sessions (newest last)

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej, timer, method } = pending.get(m.id);
    clearTimeout(timer);
    pending.delete(m.id);
    if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
    else res(m.result);
    return;
  }
  if (m.method === "Target.attachedToTarget" &&
      m.params.targetInfo.type === "service_worker" &&
      (!EXT_ID || m.params.targetInfo.url.includes(EXT_ID))) {
    sessions.push(m.params.sessionId);
  }
};

function send(method, params = {}, sessionId, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      res,
      rej,
      timer,
      method
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function wakeSW() {
  // Wake the extension with a harmless tab event (root of mock IdP: never reaped)
  await send("Target.createTarget", { url: "http://127.0.0.1:4545/" }).catch(() => {});
  const before = sessions.length;
  for (let i = 0; i < 60 && sessions.length === before; i++) await sleep(100);
}

async function ext(expr, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (!sessions.length) await wakeSW();
    const sess = sessions[sessions.length - 1];
    try {
      const r = await send("Runtime.evaluate",
        { expression: expr, awaitPromise: true, returnByValue: true }, sess);
      if (r.exceptionDetails) {
        // a real JS error in the extension — surface it, don't drop the session
        throw new Error("SW eval exception: " +
          (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
      }
      return r.result?.value;
    } catch (e) {
      if (String(e.message).startsWith("SW eval exception")) throw e;
      sessions.splice(sessions.indexOf(sess), 1); // transport failure — session dead
      await wakeSW();
    }
  }
  throw new Error(`ext eval failed after ${tries} tries: ${expr.slice(0, 80)}`);
}

// Reset the extension through its own message API (also resets in-memory state).
// Runs in the SW context; if self-delivery fails, fall back to an options page.
async function resetExtension() {
  const direct = await ext(
    "new Promise(r => chrome.runtime.sendMessage({type:'reset'}, () => r(chrome.runtime.lastError ? 'ERR:' + chrome.runtime.lastError.message : 'reset-ok')))");
  if (direct === "reset-ok") return "service-worker";
  const { targetId } = await send("Target.createTarget",
    { url: `chrome-extension://${EXT_ID}/options.html` });
  await sleep(1200);
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const r = await send("Runtime.evaluate", {
    expression: "new Promise(r => chrome.runtime.sendMessage({type:'reset'}, () => r('reset-ok')))",
    awaitPromise: true, returnByValue: true
  }, sessionId);
  await send("Target.closeTarget", { targetId }).catch(() => {});
  return r.result?.value === "reset-ok" ? "options-page" : "failed";
}

const pageTargets = async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  return list.filter((t) => t.type === "page");
};
const tabs = () => ext("new Promise(r => chrome.tabs.query({}, ts => r(JSON.stringify(ts.map(t => ({id: t.id, active: t.active, url: t.url}))))))").then(JSON.parse);
const stats = () => ext("new Promise(r => chrome.storage.local.get('stats', s => r(JSON.stringify(s.stats))))").then(JSON.parse);
const activity = () => ext("new Promise(r => chrome.storage.local.get('activity', s => r(JSON.stringify(s.activity))))").then(JSON.parse);
const settings = () => ext("new Promise(r => chrome.storage.local.get('settings', s => r(JSON.stringify(s.settings))))").then(JSON.parse);

async function evalInPage(targetId, expr) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const r = await send("Runtime.evaluate",
      { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result?.value;
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

// --- setup --------------------------------------------------------------------

await send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "service_worker", exclude: false }]
});

// A persistent chrome://extensions surface: ensure enabled + fresh code.
const extPage = await send("Target.createTarget", { url: "chrome://extensions/" });
await sleep(1200);
const extPageSess = (await send("Target.attachToTarget", { targetId: extPage.targetId, flatten: true })).sessionId;
async function devPrivate(expr) {
  const r = await send("Runtime.evaluate",
    { expression: `new Promise(res => ${expr})`, awaitPromise: true, returnByValue: true },
    extPageSess);
  return r.result?.value;
}
// unpacked extensions need Developer Mode to survive reload/enable on modern Chromium
await devPrivate(`chrome.developerPrivate.updateProfileConfiguration(
  {inDeveloperMode: true}, res)`);
const enableResult = await devPrivate(`chrome.management.setEnabled(
  ${JSON.stringify(EXT_ID)}, true, () => res(chrome.runtime.lastError ? 'ERR ' + chrome.runtime.lastError.message : 'enabled'))`);
console.log("management.setEnabled ->", enableResult);
for (let i = 0; i < 80 && !sessions.length; i++) {
  if (i === 40) await send("Target.createTarget", { url: "http://127.0.0.1:4545/" }).catch(() => {});
  await sleep(100);
}
check("service worker running after enable", sessions.length > 0);
await sleep(800); // let init() settle

check("attached to VPN Tab Reaper SW",
  (await ext("chrome.runtime.getManifest().name")) === "VPN Tab Reaper");

const resetVia = await resetExtension();
check("extension state reset", resetVia !== "failed", `via ${resetVia}`);
const s0 = await stats();
check("stats are zeroed", s0.reaped === 0 && s0.lastReapAt === 0, JSON.stringify(s0));

for (const t of await tabs()) {
  if (t.url !== "about:blank" && t.url !== "chrome://extensions/") {
    await ext(`chrome.tabs.remove(${t.id}).catch(()=>{})`).catch(() => {});
  }
}
await sleep(300);

// --- T1: direct open of the VPN success page -----------------------------------

await send("Target.createTarget", { url: "http://127.0.0.1:35001/" });
await sleep(1800);
let nowTabs = await tabs();
check("T1 direct 35001 tab reaped",
  !nowTabs.some((t) => t.url.includes("35001")),
  `pages: ${nowTabs.map((t) => t.url.slice(0, 40)).join(", ") || "(none)"}`);
let s = await stats();
check("T1 stats.reaped == 1", s.reaped === 1, JSON.stringify(s));
let act = await activity();
check("T1 activity logged", act.length === 1 && act[0].url.includes("35001"), JSON.stringify(act));

// --- T2: full SAML chain (valid session) ----------------------------------------

await send("Target.createTarget", { url: "http://127.0.0.1:4545/auto" });
await sleep(2500);
nowTabs = await tabs();
check("T2 IdP /auto -> 35001 chain reaped",
  !nowTabs.some((t) => t.url.includes("35001") || t.url.includes("4545/auto")),
  `pages: ${nowTabs.map((t) => t.url.slice(0, 40)).join(", ") || "(none)"}`);
s = await stats();
check("T2 stats.reaped == 2", s.reaped === 2, JSON.stringify(s));

// --- T3: interactive login flow (expired session) -------------------------------

await send("Target.createTarget", { url: "http://127.0.0.1:4545/login" });
await sleep(1500);
nowTabs = await tabs();
check("T3 login tab left alone while signing in",
  nowTabs.some((t) => t.url.includes("4545/login")),
  `pages: ${nowTabs.map((t) => t.url.slice(0, 40)).join(", ")}`);

const loginTarget = (await pageTargets()).find((t) => t.url.includes("4545/login"));
await evalInPage(loginTarget.id, "document.querySelector('form').submit(), 'submitted'");
await sleep(2500);
nowTabs = await tabs();
check("T3 login tab reaped after success",
  !nowTabs.some((t) => t.url.includes("35001") || t.url.includes("4545")),
  `pages: ${nowTabs.map((t) => t.url.slice(0, 40)).join(", ") || "(none)"}`);
s = await stats();
check("T3 stats.reaped == 3", s.reaped === 3, JSON.stringify(s));

// --- T4: focus restoration -------------------------------------------------------

// park on tab A (mock IdP root — never reaped)
await send("Target.createTarget", { url: "http://127.0.0.1:4545/" });
await sleep(1200);
const tabA = (await tabs()).find((t) => t.url === "http://127.0.0.1:4545/");
check("T4 tab A present", !!tabA);
await ext(`chrome.tabs.update(${tabA.id}, {active: true}), 'activated A'`);
await sleep(300);
await send("Target.createTarget", { url: "http://127.0.0.1:35001/" });
await sleep(2000);
const activeNow = (await tabs()).filter((t) => t.active);
check("T4 previously active tab restored",
  activeNow.length === 1 && activeNow[0].url === "http://127.0.0.1:4545/",
  `active: ${activeNow.map((t) => t.url).join(", ")}`);
s = await stats();
check("T4 stats.reaped == 4", s.reaped === 4, JSON.stringify(s));

// --- T5: pause via settings (kill switch) -----------------------------------------

const cur = await settings();
await ext(`new Promise(r => chrome.storage.local.set({settings: ${JSON.stringify({ ...cur, enabled: false })}}, r('paused')))`);
await sleep(600); // let the SW's onChanged listener process
check("T5 pause persisted", (await settings()).enabled === false);

await send("Target.createTarget", { url: "http://127.0.0.1:35001/" });
await sleep(2000);
nowTabs = await tabs();
const survived = nowTabs.find((t) => t.url.includes("35001"));
check("T5 paused: 35001 tab survives", !!survived,
  `pages: ${nowTabs.map((t) => t.url.slice(0, 40)).join(", ")}`);
if (survived) await ext(`chrome.tabs.remove(${survived.id}), 'cleaned'`);
s = await stats();
check("T5 no reap while paused", s.reaped === 4, JSON.stringify(s));

const cur2 = await settings();
await ext(`new Promise(r => chrome.storage.local.set({settings: ${JSON.stringify({ ...cur2, enabled: true })}}, r('resumed')))`);
await sleep(600);
check("T5 resume persisted", (await settings()).enabled === true);

// --- T6: badge flash cleanup -------------------------------------------------------

await sleep(4500); // flash duration is 4s
const badge = await ext("new Promise(r => chrome.action.getBadgeText({}, r))");
check("T6 badge cleared after flash", badge === "", `badge="${badge}"`);

// --- T7: IdP sign-in page stuck -> notification (session expired) ---------------

const pre = await settings();
await ext(`new Promise(r => chrome.storage.local.set({settings: ${JSON.stringify(
  { ...pre, idpPatterns: [...pre.idpPatterns, "http://127.0.0.1:4545/login*"] }
)}}, r('pattern-added')))`);
await send("Target.createTarget", { url: "http://127.0.0.1:4545/login" });
await sleep(32000); // IDP_STUCK_MS is 30s
let s7 = await stats();
check("T7 stuck IdP page raised a notification", s7.notified === 1, JSON.stringify(s7));
const stuckTab = (await tabs()).find((t) => t.url.includes("4545/login"));
check("T7 stuck IdP page NOT closed", !!stuckTab);
if (stuckTab) await ext(`chrome.tabs.remove(${stuckTab.id}), 'cleaned'`);
await ext(`new Promise(r => chrome.storage.local.set({settings: ${JSON.stringify(pre)}}, r('pattern-restored')))`);

// --- T8: popup UI renders live state ----------------------------------------------

const popupT = await send("Target.createTarget",
  { url: `chrome-extension://${EXT_ID}/popup.html` });
await sleep(1000);
const { sessionId: popSess } = await send("Target.attachToTarget", { targetId: popupT.targetId, flatten: true });
const dom = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    title: document.querySelector('h1')?.textContent,
    status: document.getElementById('statusLine')?.textContent,
    reaped: document.getElementById('reapedCount')?.textContent,
    lastReap: document.getElementById('lastReap')?.textContent,
    activityItems: document.querySelectorAll('#activityList li').length
  })`, awaitPromise: true, returnByValue: true
}, popSess).then((r) => JSON.parse(r.result.value));
check("T8 popup title", dom.title === "VPN Tab Reaper", JSON.stringify(dom));
check("T8 popup shows kill count", dom.reaped === "4", `reaped=${dom.reaped}`);
check("T8 popup status enabled", dom.status === "Enabled", `status=${dom.status}`);
check("T8 popup activity list rendered", dom.activityItems >= 4, `items=${dom.activityItems}`);

// screenshot of the popup for the repo
try {
  await send("Page.enable", {}, popSess);
  await send("Page.bringToFront", {}, popSess);
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png" }, popSess);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("screenshots", { recursive: true });
  writeFileSync("screenshots/popup.png", Buffer.from(shot.data, "base64"));
  console.log("saved screenshots/popup.png");
} catch (e) { console.log("screenshot skipped:", e.message); }
await send("Target.closeTarget", { targetId: popupT.targetId }).catch(() => {});

// --- wrap up -------------------------------------------------------------------------

s = await stats();
const finalAct = await activity();
console.log("\nfinal stats:", JSON.stringify(s));
console.log("final activity:");
for (const e of finalAct) console.log("  ", new Date(e.ts).toLocaleTimeString(), e.mode, e.url);

// leave the test browser tidy: one about:blank tab only
for (const t of await tabs()) {
  if (t.url !== "about:blank") await ext(`chrome.tabs.remove(${t.id}).catch(()=>{})`).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await send("Target.closeTarget", { targetId: extPage.targetId }).catch(() => {});
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
ws.close();
process.exit(0);
