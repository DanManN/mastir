"use strict";

const domainsEl = document.getElementById("domains");
const resetBtn = document.getElementById("reset");
const blurSlider = document.getElementById("blur-slider");
const blurVal = document.getElementById("blur-val");
const grayToggle = document.getElementById("gray-toggle");

let grayOn = true;

function sendSettings(settings) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "mastir-settings", ...settings });
    }
  });
}

blurSlider.addEventListener("input", () => {
  blurVal.textContent = blurSlider.value;
  sendSettings({ blurAmount: parseInt(blurSlider.value) });
});

grayToggle.addEventListener("click", () => {
  grayOn = !grayOn;
  grayToggle.textContent = "Grayscale: " + (grayOn ? "On" : "Off");
  grayToggle.classList.toggle("active", grayOn);
  sendSettings({ grayOn });
});

function loadRules() {
  chrome.declarativeNetRequest.getDynamicRules((rules) => {
    domainsEl.textContent = "";
    if (rules.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "None";
      domainsEl.appendChild(empty);
    } else {
      rules.forEach((rule) => {
        const domains = rule.condition?.requestDomains || [];
        domains.forEach((d) => {
          const el = document.createElement("div");
          el.className = "domain";
          el.textContent = d;
          domainsEl.appendChild(el);
        });
      });
    }
  });
}

resetBtn.addEventListener("click", () => {
  chrome.declarativeNetRequest.getDynamicRules((rules) => {
    const ids = rules.map((r) => r.id);
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids }, () => {
      loadRules();
    });
  });
});

loadRules();
