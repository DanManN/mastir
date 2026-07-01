"use strict";

// Runs MediaPipe segmentation on the GPU inside an extension-owned page,
// so the host page's CSP never applies. Receives downscaled RGBA pixels,
// returns a raw binary person-mask.

let segmenter = null;
let segLoading = null;

function loadSegmenter() {
  if (segmenter) return Promise.resolve(segmenter);
  if (segLoading) return segLoading;
  segLoading = (async () => {
    const vision = await import(chrome.runtime.getURL("vision_bundle.mjs"));
    const wasmFiles = await vision.FilesetResolver.forVisionTasks(chrome.runtime.getURL("wasm"));
    segmenter = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL("selfie_multiclass_256x256.tflite"),
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    console.log("[mastir/offscreen] segmenter ready");
    return segmenter;
  })().catch((e) => {
    segLoading = null;
    throw e;
  });
  return segLoading;
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "mastir-segment-offscreen") return false;
  (async () => {
    const seg = await loadSegmenter();
    const { pixelsB64, w, h } = msg;
    const tDecode = performance.now();
    const rgba = base64ToBytes(pixelsB64);
    const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), w, h);
    const bitmap = await createImageBitmap(imageData);
    const tInfer = performance.now();
    const result = seg.segment(bitmap);
    bitmap.close();
    const mask = result.categoryMask;
    let raw = null;
    if (mask) {
      const maskData = mask.getAsUint8Array();
      raw = new Uint8Array(w * h);
      for (let i = 0; i < maskData.length; i++) raw[i] = maskData[i] > 0 ? 255 : 0;
      result.close();
    }
    const tEnd = performance.now();
    console.log(`[mastir/offscreen] decode+bitmap=${(tInfer - tDecode).toFixed(1)}ms infer+read=${(tEnd - tInfer).toFixed(1)}ms (${w}x${h})`);
    sendResponse({ rawB64: raw ? bytesToBase64(raw) : null, w, h });
  })().catch((e) => {
    console.warn("[mastir/offscreen] segment failed:", e.message);
    sendResponse({ error: e.message });
  });
  return true;
});
