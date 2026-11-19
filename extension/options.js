"use strict";

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
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

function load() {
  chrome.storage.local.get("settings").then(({ settings }) => {
    const s = { ...DEFAULTS, ...(settings || {}) };
    $("enabled").checked = s.enabled !== false;
    $("restoreFocus").checked = s.restoreFocus !== false;
    $("notifyNeedsSignin").checked = s.notifyNeedsSignin !== false;
    const radio = document.querySelector(
      `input[name="closeTiming"][value="${s.closeTiming || "complete"}"]`
    );
    if (radio) radio.checked = true;
    $("finalPatterns").value = s.finalPatterns.join("\n");
    $("idpPatterns").value = s.idpPatterns.join("\n");
  });
}

function collect() {
  return {
    enabled: $("enabled").checked,
    closeTiming:
      document.querySelector("input[name=closeTiming]:checked")?.value || "complete",
    restoreFocus: $("restoreFocus").checked,
    notifyNeedsSignin: $("notifyNeedsSignin").checked,
    finalPatterns: $("finalPatterns").value
      .split("\n").map((l) => l.trim()).filter(Boolean),
    idpPatterns: $("idpPatterns").value
      .split("\n").map((l) => l.trim()).filter(Boolean)
  };
}

$("saveBtn").addEventListener("click", () => {
  chrome.storage.local.set({ settings: collect() }).then(() => {
    $("saveMsg").style.visibility = "visible";
    setTimeout(() => ($("saveMsg").style.visibility = "hidden"), 1500);
  });
});

$("resetBtn").addEventListener("click", () => {
  chrome.storage.local.set({ settings: { ...DEFAULTS } }).then(load);
});

load();
