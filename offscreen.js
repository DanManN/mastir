"use strict";

// Runs MediaPipe segmentation on the GPU inside an extension-owned page,
// so the host page's CSP never applies. Accepts either an image URL (fetched
// and downscaled here, for sharper input) or pre-downscaled RGBA pixels
// (blob:/data: images the offscreen doc can't fetch). Returns a raw binary
// person-mask at the downscaled resolution.

const MAX_SEG_DIM = 256;
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

  // Build a segmentation-ready bitmap (downscaled to <= MAX_SEG_DIM) from a URL.
  async function bitmapFromUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const full = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SEG_DIM / Math.max(full.width, full.height));
    const sw = Math.max(1, Math.round(full.width * scale));
    const sh = Math.max(1, Math.round(full.height * scale));
    if (scale === 1) return { bitmap: full, sw, sh };
    const scaled = await createImageBitmap(full, { resizeWidth: sw, resizeHeight: sh, resizeQuality: "high" });
    full.close();
    return { bitmap: scaled, sw, sh };
  }

  // Build a bitmap from pre-downscaled RGBA pixels (blob:/data: fallback).
  async function bitmapFromPixels(pixelsB64, w, h) {
    const rgba = base64ToBytes(pixelsB64);
    const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), w, h);
    return { bitmap: await createImageBitmap(imageData), sw: w, sh: h };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "mastir-segment-offscreen") return false;
    (async () => {
      const seg = await loadSegmenter();
      const { bitmap } = msg.url
        ? await bitmapFromUrl(msg.url)
        : await bitmapFromPixels(msg.pixelsB64, msg.w, msg.h);
      const result = seg.segment(bitmap);
      bitmap.close();
      const mask = result.categoryMask;
      let raw = null;
      let mw = 0, mh = 0;
      if (mask) {
        // The mask is returned at the model's own output resolution
        // (e.g. 256x256), NOT the input bitmap's size — use the mask's real
        // width/height so the caller upscales it correctly. Assuming input
        // dims here misaligns the mask on non-square images.
        mw = mask.width;
        mh = mask.height;
        const maskData = mask.getAsUint8Array();
        raw = new Uint8Array(mw * mh);
        for (let i = 0; i < maskData.length; i++) raw[i] = maskData[i] > 0 ? 255 : 0;
        result.close();
      }
      sendResponse({ rawB64: raw ? bytesToBase64(raw) : null, w: mw, h: mh });
    })().catch((e) => {
      console.warn("[mastir/offscreen] segment failed:", e.message);
      sendResponse({ error: e.message });
    });
    return true;
  });
