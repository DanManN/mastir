"use strict";

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run MediaPipe person segmentation",
    });
  })();
  return offscreenReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "fetch") {
    fetch(msg.url)
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
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === "segment") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage(msg))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  return false;
});
