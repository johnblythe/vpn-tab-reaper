"use strict";

const $ = (id) => document.getElementById(id);

function timeAgo(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function render(state) {
  const { settings = {}, stats = {}, activity = [] } = state || {};
  const enabled = settings.enabled !== false;

  $("statusLine").textContent = enabled ? "Enabled" : "Paused";
  $("statusLine").classList.toggle("paused", !enabled);
  $("toggleBtn").textContent = enabled ? "Pause" : "Resume";
  $("toggleBtn").classList.toggle("primary", enabled);
  $("pause5Btn").disabled = !enabled;
  $("pause5Btn").style.opacity = enabled ? "1" : "0.5";

  $("reapedCount").textContent = stats.reaped || 0;
  $("lastReap").textContent = timeAgo(stats.lastReapAt);

  const list = $("activityList");
  list.innerHTML = "";
  $("emptyActivity").style.display = activity.length ? "none" : "block";
  for (const a of activity.slice(0, 12)) {
    const li = document.createElement("li");
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = a.url || "(unknown url)";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${new Date(a.ts).toLocaleTimeString()} · closed at ${a.mode || "?"}`;
    li.append(url, meta);
    list.append(li);
  }
}

function getState() {
  chrome.runtime.sendMessage({ type: "getState" }, (state) => {
    if (chrome.runtime.lastError) return;
    render(state);
  });
}

$("toggleBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "toggle" }, () => getState());
});

$("pause5Btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "pause5" }, () => getState());
});

$("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("clearBtn").addEventListener("click", () => {
  // Route through the service worker so its in-memory copy is reset too,
  // otherwise the next reap would resurrect the log from memory.
  chrome.runtime.sendMessage({ type: "clearLog" }, () => getState());
});

getState();
