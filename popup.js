"use strict";

const domainsEl = document.getElementById("domains");
const resetBtn = document.getElementById("reset");

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
