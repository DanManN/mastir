"use strict";

let creatingOffscreen = null;

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "GPU person-segmentation of images without touching page CSP",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// Programmatically inject into subframes that Chrome's declarative content
// scripts miss (dynamically-created cross-origin ad iframes). Fires on every
// committed subframe navigation; the injection is idempotent (content.js
// checks for double-init via its IIFE closure / stylesheet presence).
const injectedFrames = new Set();
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) return;                     // skip main frame
  if (details.url === "about:blank") return;             // blank placeholder
  const key = `${details.tabId}:${details.frameId}`;
  if (injectedFrames.has(key)) return;
  injectedFrames.add(key);
  // Inject content.js in MAIN world + bridge.js in ISOLATED world, mirroring
  // the manifest content_scripts declaration.
  chrome.scripting.executeScript({
    target: { tabId: details.tabId, frameIds: [details.frameId] },
    files: ["content.js"],
    world: "MAIN",
    injectImmediately: true,
  }).catch(() => {});
  chrome.scripting.executeScript({
    target: { tabId: details.tabId, frameIds: [details.frameId] },
    files: ["bridge.js"],
    world: "ISOLATED",
    injectImmediately: true,
  }).catch(() => {});
});
// Clean up on tab removal so the Set doesn't grow unbounded.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const k of injectedFrames) {
    if (k.startsWith(`${tabId}:`)) injectedFrames.delete(k);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "fetch") {
    fetch(msg.url, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ dataUrl: reader.result });
        reader.onerror = () => sendResponse({ error: "FileReader failed" });
        reader.readAsDataURL(blob);
      })
      .catch((e) => {
        console.warn("[mastir/bg] fetch failed:", msg.url.slice(0, 100), e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (msg.type === "ensure-offscreen") {
    ensureOffscreen()
      .then(() => sendResponse({ ready: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  return false;
});
