"use strict";


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "fetch") return false;

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
});
