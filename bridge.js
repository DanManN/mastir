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

  if (e.data?.type === "mastir-hard-reload") {
    const { id } = e.data;
    chrome.runtime.sendMessage({ type: "hard-reload" }, () => {
      window.postMessage({ type: "mastir-hard-reload-response", id }, "*");
    });
  }

  if (e.data?.type === "mastir-csp-strip") {
    const { id, domain } = e.data;
    chrome.runtime.sendMessage({ type: "csp-strip-request", domain }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ type: "mastir-csp-strip-response", id, error: chrome.runtime.lastError.message }, "*");
        return;
      }
      window.postMessage({ type: "mastir-csp-strip-response", id, status: response.status }, "*");
    });
  }
});
