"use strict";

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

  if (msg.type === "hard-reload") {
    chrome.tabs.reload(sender.tab.id, { bypassCache: true }, () => {
      sendResponse({ status: "reloaded" });
    });
    return true;
  }

  if (msg.type === "csp-strip-request") {
    const domain = msg.domain;
    chrome.declarativeNetRequest.getDynamicRules((rules) => {
      const existing = rules.find((r) => r.condition.requestDomains?.includes(domain));
      if (existing) { sendResponse({ status: "already-enabled" }); return; }
      const id = rules.length > 0 ? Math.max(...rules.map((r) => r.id)) + 1 : 1000;
      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "Content-Security-Policy", operation: "remove" },
              { header: "Content-Security-Policy-Report-Only", operation: "remove" }
            ]
          },
          condition: {
            requestDomains: [domain],
            resourceTypes: ["main_frame", "sub_frame"]
          }
        }]
      }, () => {
        sendResponse({ status: "enabled" });
      });
    });
    return true;
  }

  return false;
});
