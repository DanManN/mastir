"use strict";

const blurSlider = document.getElementById("blur-slider");
const blurVal = document.getElementById("blur-val");
const maskBlurSlider = document.getElementById("mask-blur-slider");
const maskBlurVal = document.getElementById("mask-blur-val");
const maskExpandSlider = document.getElementById("mask-expand-slider");
const maskExpandVal = document.getElementById("mask-expand-val");
const grayToggle = document.getElementById("gray-toggle");

let grayOn = false;

const DEFAULTS = { blurAmount: 0, maskBlur: 2, maskExpand: 8, grayOn: false };

function sendSettings(settings) {
  chrome.storage.local.set(settings);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "mastir-settings", ...settings });
    }
  });
}

chrome.storage.local.get(DEFAULTS, (s) => {
  blurSlider.value = s.blurAmount;
  blurVal.textContent = s.blurAmount;
  maskBlurSlider.value = s.maskBlur;
  maskBlurVal.textContent = s.maskBlur;
  maskExpandSlider.value = s.maskExpand;
  maskExpandVal.textContent = s.maskExpand;
  grayOn = s.grayOn;
  grayToggle.textContent = "Grayscale: " + (grayOn ? "On" : "Off");
  grayToggle.classList.toggle("active", grayOn);
});

blurSlider.addEventListener("input", () => {
  blurVal.textContent = blurSlider.value;
  sendSettings({ blurAmount: parseInt(blurSlider.value) });
});

maskBlurSlider.addEventListener("input", () => {
  maskBlurVal.textContent = maskBlurSlider.value;
});
maskBlurSlider.addEventListener("change", () => {
  sendSettings({ maskBlur: parseInt(maskBlurSlider.value) });
});

maskExpandSlider.addEventListener("input", () => {
  maskExpandVal.textContent = maskExpandSlider.value;
});
maskExpandSlider.addEventListener("change", () => {
  sendSettings({ maskExpand: parseInt(maskExpandSlider.value) });
});

grayToggle.addEventListener("click", () => {
  grayOn = !grayOn;
  grayToggle.textContent = "Grayscale: " + (grayOn ? "On" : "Off");
  grayToggle.classList.toggle("active", grayOn);
  sendSettings({ grayOn });
});
