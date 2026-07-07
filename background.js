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
