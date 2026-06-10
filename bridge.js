"use strict";

window.postMessage({ type: "mastir-extension-url", baseUrl: chrome.runtime.getURL("") }, "*");

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
    const { id, url } = e.data;
    chrome.runtime.sendMessage({ type: "segment", url }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ type: "mastir-segment-response", id, error: chrome.runtime.lastError.message }, "*");
        return;
      }
      window.postMessage({ type: "mastir-segment-response", id, maskBase64: response.maskBase64, w: response.w, h: response.h, error: response.error }, "*");
    });
  }
});
