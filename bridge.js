"use strict";

window.postMessage({
  type: "mastir-extension-urls",
  modelUrl: chrome.runtime.getURL("selfie_multiclass_256x256.tflite"),
  visionUrl: chrome.runtime.getURL("vision_bundle.mjs"),
  wasmUrl: chrome.runtime.getURL("wasm")
}, "*");

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
});
