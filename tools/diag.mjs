#!/usr/bin/env node
const PORT = process.argv[2] || "39777";
const BASE = `http://127.0.0.1:${PORT}`;

const version = await (await fetch(`${BASE}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (m) =>
      m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

console.log("== targets ==");
const list = await (await fetch(`${BASE}/json/list`)).json();
for (const t of list) console.log(t.type, "|", t.title.slice(0, 40), "|", t.url.slice(0, 90));

const { targetId } = await send("Target.createTarget", { url: "chrome://extensions/" });
await new Promise((r) => setTimeout(r, 1500));
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

const info = await send("Runtime.evaluate", {
  expression: "new Promise(r => chrome.developerPrivate.getExtensionsInfo(l => r(JSON.stringify(l.map(e => ({name: e.name, id: e.id, state: e.state, location: e.location, errors: (e.errors||[]).map(x => x.message), sw: e.runtimeStatus || null, views: (e.views||[]).map(v => v.url)}))))))",
  awaitPromise: true, returnByValue: true
}, sessionId);
console.log("\n== extensions ==");
console.log(info.result.value);

const dm = await send("Runtime.evaluate", {
  expression: "new Promise(r => chrome.developerPrivate.getProfileConfiguration(c => r(JSON.stringify(c))))",
  awaitPromise: true, returnByValue: true
}, sessionId);
console.log("\n== profile config ==");
console.log(dm.result.value);

await send("Target.closeTarget", { targetId });
ws.close();
process.exit(0);
