"use strict";

const blurSlider = document.getElementById("blur-slider");
const blurVal = document.getElementById("blur-val");
const maskBlurSlider = document.getElementById("mask-blur-slider");
const maskBlurVal = document.getElementById("mask-blur-val");
const maskExpandSlider = document.getElementById("mask-expand-slider");
const maskExpandVal = document.getElementById("mask-expand-val");
const grayToggle = document.getElementById("gray-toggle");
const skinToggle = document.getElementById("skin-toggle");
const modelList = document.getElementById("model-list");

let grayOn = false;
let skinOnly = false;

// Display names for the segmentation models. Keys must match MODELS in
// offscreen.js, which owns each model's asset and class mapping.
const MODEL_NAMES = {
  selfie: "Selfie multiclass",
  selfieBinary: "Selfie binary",
  landscape: "Selfie landscape",
  deeplab: "DeepLab v3",
};
// Default chain: order is try-order, `on` is whether the model runs. Mirrors
// DEFAULT_CHAIN in offscreen.js (deeplab is available but off by default).
const DEFAULT_CHAIN = [
  { key: "selfie", on: true },
  { key: "selfieBinary", on: true },
  { key: "landscape", on: true },
  { key: "deeplab", on: false },
];
let modelChain = DEFAULT_CHAIN;

const DEFAULTS = { blurAmount: 0, maskBlur: 2, maskExpand: 8, grayOn: false, skinOnly: false, modelChain: null };

function sendSettings(settings) {
  chrome.storage.local.set(settings);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "mastir-settings", ...settings });
    }
  });
}

// Reconcile a stored chain with the models that actually exist: drop unknown
// or duplicated keys, append models added to the extension since it was saved
// (so a new model shows up in the list instead of being invisible), and
// guarantee one is on.
function normalizeChain(stored) {
  const chain = [];
  const seen = new Set();
  for (const m of Array.isArray(stored) ? stored : []) {
    if (!m || !MODEL_NAMES[m.key] || seen.has(m.key)) continue;
    seen.add(m.key);
    chain.push({ key: m.key, on: !!m.on });
  }
  for (const d of DEFAULT_CHAIN) if (!seen.has(d.key)) chain.push({ ...d });
  if (!chain.some((m) => m.on)) chain[0].on = true;
  return chain;
}

function renderModels() {
  modelList.textContent = "";
  // With one model left on, its toggle is inert: an empty chain would stop
  // concealing images entirely, so there's no valid way to reach it.
  const lastOn = modelChain.filter((m) => m.on).length === 1;
  modelChain.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "model";
    const name = document.createElement("div");
    name.className = "toggle" + (m.on ? " active" : "") + (m.on && lastOn ? " locked" : "");
    name.textContent = MODEL_NAMES[m.key];
    if (m.on && lastOn) {
      name.title = "At least one model must stay on";
    } else {
      name.addEventListener("click", () => { m.on = !m.on; saveModels(); });
    }
    row.appendChild(name);
    // ▲/▼ escaped rather than literal: these are the only non-ASCII
    // characters that reach the UI, and as escapes they render correctly no
    // matter how the browser decides to decode this file.
    row.appendChild(arrow("\u25B2", i > 0, () => swapModels(i, i - 1)));
    row.appendChild(arrow("\u25BC", i < modelChain.length - 1, () => swapModels(i, i + 1)));
    modelList.appendChild(row);
  });
}

function arrow(glyph, enabled, onClick) {
  const el = document.createElement("div");
  el.className = enabled ? "arrow" : "arrow off";
  el.textContent = glyph;
  if (enabled) el.addEventListener("click", onClick);
  return el;
}

function swapModels(i, j) {
  [modelChain[i], modelChain[j]] = [modelChain[j], modelChain[i]];
  saveModels();
}

function saveModels() {
  renderModels();
  sendSettings({ modelChain });
}

chrome.storage.local.get(DEFAULTS, (s) => {
  modelChain = normalizeChain(s.modelChain);
  renderModels();
  blurSlider.value = s.blurAmount;
  blurVal.textContent = s.blurAmount;
  maskBlurSlider.value = s.maskBlur;
  maskBlurVal.textContent = s.maskBlur;
  maskExpandSlider.value = s.maskExpand;
  maskExpandVal.textContent = s.maskExpand;
  grayOn = s.grayOn;
  grayToggle.textContent = "Grayscale: " + (grayOn ? "On" : "Off");
  grayToggle.classList.toggle("active", grayOn);
  skinOnly = s.skinOnly;
  skinToggle.textContent = "Skin Only: " + (skinOnly ? "On" : "Off");
  skinToggle.classList.toggle("active", skinOnly);
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

skinToggle.addEventListener("click", () => {
  skinOnly = !skinOnly;
  skinToggle.textContent = "Skin Only: " + (skinOnly ? "On" : "Off");
  skinToggle.classList.toggle("active", skinOnly);
  sendSettings({ skinOnly });
});
