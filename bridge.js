"use strict";
if (self.__mastirBridgeInjected) { /* already injected */ } else {
self.__mastirBridgeInjected = true;

// The segmentation model chain, forwarded with every segment request below.
// It's read HERE rather than in the offscreen document because that document
// may only use chrome.runtime APIs — it cannot read chrome.storage itself.
// Until this first read lands, requests carry null and the offscreen doc
// falls back to its own default chain.
let modelChain = null;

chrome.storage.local.get({ blurAmount: 0, maskBlur: 2, maskExpand: 8, grayOn: false, skinOnly: false, modelChain: null }, (s) => {
  modelChain = s.modelChain;
  window.postMessage({ type: "mastir-settings", ...s }, "*");
});

// Track popup edits in EVERY tab. The popup messages only the active tab, so
// watching storage is what keeps background tabs from segmenting with a stale
// chain until they're reloaded.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.modelChain) modelChain = changes.modelChain.newValue;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "mastir-settings") {
    window.postMessage(msg, "*");
  }
});

window.addEventListener("message", (e) => {
  if (e.source !== window) return;

  if (e.data?.type === "mastir-fetch") {
    const { id, url } = e.data;
    chrome.runtime.sendMessage({ type: "fetch", url }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ type: "mastir-fetch-response", id, error: chrome.runtime.lastError.message }, "*");
        return;
      }
      window.postMessage({ type: "mastir-fetch-response", id, dataUrl: response.dataUrl, error: response.error }, "*");
    });
  }

  if (e.data?.type === "mastir-segment") {
    const { id, url, pixelsB64, w, h } = e.data;
    // Ensure the offscreen doc exists (once), then message it directly —
    // skipping a background relay hop each way.
    offscreenReady()
      .then(() => chrome.runtime.sendMessage({ type: "mastir-segment-offscreen", url, pixelsB64, w, h, modelChain }))
      .then((response) => {
        window.postMessage({ type: "mastir-segment-response", id, rawB64: response.rawB64, w: response.w, h: response.h, model: response.model, error: response.error }, "*");
      })
      .catch((err) => {
        window.postMessage({ type: "mastir-segment-response", id, error: err.message }, "*");
      });
  }
});

let offscreenReadyPromise = null;
function offscreenReady() {
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = chrome.runtime.sendMessage({ type: "ensure-offscreen" }).then((r) => {
      if (r?.error) { offscreenReadyPromise = null; throw new Error(r.error); }
    });
  }
  return offscreenReadyPromise;
}
} // end double-injection guard
