import * as vision from "./vision_bundle.mjs";

let segmenter = null;
let segLoading = null;

async function loadSegmenter() {
  if (segmenter === false) return false;
  if (segmenter) return segmenter;
  if (segLoading) return segLoading;
  segLoading = (async () => {
    try {
      const wasmFiles = await vision.FilesetResolver.forVisionTasks("./wasm");
      segmenter = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      return segmenter;
    } catch (e) {
      console.error("[blurify offscreen] segmenter init failed:", e);
      segmenter = false;
      return false;
    }
  })();
  return segLoading;
}

async function fetchImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "segment") return false;

  (async () => {
    try {
      const seg = await loadSegmenter();
      if (!seg) {
        sendResponse({ error: "segmenter unavailable" });
        return;
      }

      const bitmap = await fetchImage(msg.url);
      const w = bitmap.width, h = bitmap.height;

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);

      const result = seg.segment(canvas);
      const mask = result.categoryMask;
      const maskBytes = new Uint8Array(w * h);
      if (mask) {
        const maskData = mask.getAsUint8Array();
        for (let i = 0; i < maskData.length; i++) {
          maskBytes[i] = maskData[i] > 0 ? 255 : 0;
        }
        result.close();
      }
      // Encode as base64 to avoid massive JSON array serialization
      let binary = "";
      for (let i = 0; i < maskBytes.length; i++) {
        binary += String.fromCharCode(maskBytes[i]);
      }
      const maskBase64 = btoa(binary);
      sendResponse({ maskBase64, w, h });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true;
});
