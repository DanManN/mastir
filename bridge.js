"use strict";

chrome.storage.local.get({ blurAmount: 0, maskBlur: 4, maskExpand: 8, grayOn: false }, (s) => {
  window.postMessage({ type: "mastir-settings", ...s }, "*");
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
      .then(() => chrome.runtime.sendMessage({ type: "mastir-segment-offscreen", url, pixelsB64, w, h }))
      .then((response) => {
        window.postMessage({ type: "mastir-segment-response", id, rawB64: response.rawB64, w: response.w, h: response.h, error: response.error }, "*");
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
