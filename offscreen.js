"use strict";

// Runs MediaPipe segmentation on the GPU inside an extension-owned page,
// so the host page's CSP never applies. Accepts either an image URL (fetched
// and downscaled here, for sharper input) or pre-downscaled RGBA pixels
// (blob:/data: images the offscreen doc can't fetch). Returns a raw binary
// person-mask at the downscaled resolution.

const MAX_SEG_DIM = 256;

// --- Model configuration ---------------------------------------------------
// Which models run, and in what order, is set from the popup's Advanced
// settings (see modelChain below). Each entry here describes its asset and how
// to interpret the category mask into "person" pixels:
//   isPerson(category) -> true if that class index counts as a person.
//
// selfie_multiclass_256x256: 6 classes, everything non-background (>0) is the
//   subject (hair/body-skin/face-skin/clothes/accessories). Selfie framing.
// deeplabv3 (Pascal VOC): 21 classes, person == class 15. General semantic
//   segmentation — whole clothed body, arbitrary framing, multiple people.
// selfie_segmenter / _landscape: 2 classes, person == class 0 (inverted vs
//   the other models), no skin/hair/clothes split — so person maps to 2 (skin)
//   like deeplab, or Skin Only mode (threshold 2) would conceal nothing. The
//   landscape variant has a 256x144 input tensor, so wide images squash to
//   1.78:1, not 1:1.
// selfie_multiclass_256x256 classes:
//   0=background, 1=hair, 2=body-skin, 3=face-skin, 4=clothes, 5=accessories
// Output mask labels (sent to content.js):
//   0=background, 1=person-non-skin, 2=skin
const MODELS = {
  selfie: {
    asset: "selfie_multiclass_256x256.tflite",
    label: (c) => (c === 2 || c === 3) ? 2 : c > 0 ? 1 : 0,
  },
  deeplab: {
    asset: "deeplabv3.tflite",
    label: (c) => c === 15 ? 2 : 0,
  },
  // These two invert the usual convention: class 0 is the PERSON, not the
  // background. Mapping c>0 to person conceals the backdrop and leaves the
  // subject visible.
  selfieBinary: {
    asset: "selfie_segmenter.tflite",
    label: (c) => c === 0 ? 2 : 0,
  },
  landscape: {
    asset: "selfie_segmenter_landscape.tflite",
    label: (c) => c === 0 ? 2 : 0,
  },
};
// Models to try, in order, until one finds a person. Each entry is a key of
// MODELS above; a single-element chain pins one model. Falling back only costs
// extra inference when a model finds NOTHING — the case we'd otherwise lose —
// so images that the first model handles pay nothing. Models load lazily, so
// later entries cost no memory until something actually misses.
//
// The popup's Advanced settings own this at runtime: the config is stored as
// chrome.storage.local `modelChain` (an ordered [{ key, on }]) and arrives
// WITH each segment request. This list is the fallback for a request that
// carries no usable chain. Keep it in sync with DEFAULT_CHAIN in popup.js.
//
// It's bridge.js that reads storage, not this file: an offscreen document may
// only use chrome.runtime APIs. chrome.storage is undefined here, so touching
// it throws at load and takes the whole script — including the onMessage
// listener at the bottom — with it, which silently stops ALL segmentation and
// leaves every image on every page stuck behind its pre-blur.
const DEFAULT_CHAIN = ["selfie", "selfieBinary", "landscape"];

// Reduce that config to an ordered list of runnable model keys. Unknown keys
// are dropped, so a model deleted from MODELS can't break segmentation. The
// result is never empty: an empty chain would stop concealing every image on
// every page, which is the one failure this must not allow — the popup already
// refuses to turn the last model off, and this is the backstop for a config
// that's stale, hand-edited, or corrupt.
function readChain(stored) {
  const keys = Array.isArray(stored)
    ? stored.filter((m) => m && m.on && MODELS[m.key]).map((m) => m.key)
    : [];
  return keys.length ? keys : DEFAULT_CHAIN;
}

const segmenters = new Map();  // name -> ImageSegmenter
const segLoading = new Map();  // name -> in-flight load promise

function loadSegmenter(name) {
  if (segmenters.has(name)) return Promise.resolve(segmenters.get(name));
  if (segLoading.has(name)) return segLoading.get(name);
  const loading = (async () => {
    const model = MODELS[name];
    const vision = await import(chrome.runtime.getURL("vision_bundle.mjs"));
    const wasmFiles = await vision.FilesetResolver.forVisionTasks(chrome.runtime.getURL("wasm"));
    const seg = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL(model.asset),
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    segmenters.set(name, seg);
    console.log(`[mastir/offscreen] segmenter ready (${name})`);
    return seg;
  })().catch((e) => {
    segLoading.delete(name);
    throw e;
  });
  segLoading.set(name, loading);
  return loading;
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

  // Run one model over the bitmap and return its person-mask, the mask dims,
  // and how many person pixels it found (0 = this model saw nobody).
  function runModel(seg, label, bitmap) {
      const result = seg.segment(bitmap);
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
          for (let i = 0; i < maskData.length; i++) raw[i] = label(maskData[i]);
        } else {
          // Nearest-neighbour downsample of the binary person mask.
          for (let y = 0; y < mh; y++) {
            const sy = Math.min(fh - 1, (y / mscale) | 0);
            for (let x = 0; x < mw; x++) {
              const sx = Math.min(fw - 1, (x / mscale) | 0);
              raw[y * mw + x] = label(maskData[sy * fw + sx]);
            }
          }
        }
        result.close();
      }
      let personPx = 0;
      if (raw) for (let i = 0; i < raw.length; i++) if (raw[i] > 0) personPx++;
      return { raw, mw, mh, personPx };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "mastir-segment-offscreen") return false;
    (async () => {
      const { bitmap } = msg.url
        ? await bitmapFromUrl(msg.url)
        : await bitmapFromPixels(msg.pixelsB64, msg.w, msg.h);
      let out = null, used = null;
      const failed = [];
      try {
        // Stop at the first model that finds a person. If none do, keep the
        // last result so the caller still gets a well-formed (empty) mask.
        for (const name of readChain(msg.modelChain)) {
          // Isolate each model. The chain is user-ordered from the popup now,
          // so an entry that can't load (missing asset, delegate unsupported)
          // is reachable in a way it wasn't when the chain was hardcoded —
          // and letting it throw out of the loop would fail EVERY image on
          // every page, leaving the whole web pre-blurred. Skip it instead.
          try {
            const seg = await loadSegmenter(name);
            out = runModel(seg, MODELS[name].label, bitmap);
            used = name;
          } catch (e) {
            failed.push(`${name}: ${e.message}`);
            console.warn(`[mastir/offscreen] model ${name} unusable, skipping:`, e.message);
            continue;
          }
          if (out.personPx > 0) break;
        }
      } finally {
        bitmap.close();
      }
      // Nothing ran: report an error, never an empty mask. An empty mask means
      // "no person in this image" and makes the caller REVEAL it, so a
      // chain-wide failure has to fail closed and leave the pre-blur on.
      if (!out) throw new Error(`no usable model (${failed.join("; ") || "empty chain"})`);
      sendResponse({
        rawB64: out && out.raw ? bytesToBase64(out.raw) : null,
        w: out ? out.mw : 0,
        h: out ? out.mh : 0,
        model: used,
      });
    })().catch((e) => {
      console.warn("[mastir/offscreen] segment failed:", e.message);
      sendResponse({ error: e.message });
    });
    return true;
  });
