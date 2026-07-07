"use strict";

// Runs MediaPipe segmentation on the GPU inside an extension-owned page,
// so the host page's CSP never applies. Accepts either an image URL (fetched
// and downscaled here, for sharper input) or pre-downscaled RGBA pixels
// (blob:/data: images the offscreen doc can't fetch). Returns a raw binary
// person-mask at the downscaled resolution.

const MAX_SEG_DIM = 256;

// --- Model configuration ---------------------------------------------------
// Swap the active model by changing ACTIVE_MODEL. Each entry describes its
// asset and how to interpret the category mask into "person" pixels:
//   isPerson(category) -> true if that class index counts as a person.
//
// selfie_multiclass_256x256: 6 classes, everything non-background (>0) is the
//   subject (hair/body-skin/face-skin/clothes/accessories). Selfie framing.
// deeplabv3 (Pascal VOC): 21 classes, person == class 15. General semantic
//   segmentation — whole clothed body, arbitrary framing, multiple people.
const MODELS = {
  selfie: {
    asset: "selfie_multiclass_256x256.tflite",
    isPerson: (c) => c > 0,
  },
  deeplab: {
    asset: "deeplabv3.tflite",
    isPerson: (c) => c === 15,
  },
};
const ACTIVE_MODEL = "selfie";

let segmenter = null;
let segLoading = null;

function loadSegmenter() {
  if (segmenter) return Promise.resolve(segmenter);
  if (segLoading) return segLoading;
  segLoading = (async () => {
    const model = MODELS[ACTIVE_MODEL];
    const vision = await import(chrome.runtime.getURL("vision_bundle.mjs"));
    const wasmFiles = await vision.FilesetResolver.forVisionTasks(chrome.runtime.getURL("wasm"));
    segmenter = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL(model.asset),
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    console.log(`[mastir/offscreen] segmenter ready (${ACTIVE_MODEL})`);
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

  // Build a segmentation-ready bitmap from a URL. Pass the FULL-res bitmap to
  // the segmenter and let MediaPipe do its own single resize to the model's
  // input tensor — this path is local to the offscreen doc, so there's no
  // transfer cost and no reason to pre-downscale (which would resample twice).
  async function bitmapFromUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const full = await createImageBitmap(blob);
    return { bitmap: full, sw: full.width, sh: full.height };
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
      const isPerson = MODELS[ACTIVE_MODEL].isPerson;
      const { bitmap } = msg.url
        ? await bitmapFromUrl(msg.url)
        : await bitmapFromPixels(msg.pixelsB64, msg.w, msg.h);
      const result = seg.segment(bitmap);
      bitmap.close();
      const mask = result.categoryMask;
      let raw = null;
      let mw = 0, mh = 0;
      if (mask) {
        // The mask comes back at MediaPipe's output resolution, which tracks
        // the input bitmap size — since we now pass full-res input, that can be
        // large. We don't need a high-res mask (the caller reshapes + upscales
        // it anyway), so cap the returned mask at MAX_SEG_DIM on the SHORT side
        // to keep the payload bounded while preserving detail on the short axis
        // (capping the long side would crush a wide banner to e.g. 256x57).
        // Binarize person vs. not.
        const fw = mask.width, fh = mask.height;
        const maskData = mask.getAsUint8Array();
        const mscale = Math.min(1, MAX_SEG_DIM / Math.min(fw, fh));
        mw = Math.max(1, Math.round(fw * mscale));
        mh = Math.max(1, Math.round(fh * mscale));
        raw = new Uint8Array(mw * mh);
        if (mw === fw && mh === fh) {
          for (let i = 0; i < maskData.length; i++) raw[i] = isPerson(maskData[i]) ? 255 : 0;
        } else {
          // Nearest-neighbour downsample of the binary person mask.
          for (let y = 0; y < mh; y++) {
            const sy = Math.min(fh - 1, (y / mscale) | 0);
            for (let x = 0; x < mw; x++) {
              const sx = Math.min(fw - 1, (x / mscale) | 0);
              raw[y * mw + x] = isPerson(maskData[sy * fw + sx]) ? 255 : 0;
            }
          }
        }
        result.close();
      }
      sendResponse({ rawB64: raw ? bytesToBase64(raw) : null, w: mw, h: mh });
    })().catch((e) => {
      console.warn("[mastir/offscreen] segment failed:", e.message);
      sendResponse({ error: e.message });
    });
    return true;
  });
