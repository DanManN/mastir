"use strict";

(function () {
  if (document.contentType?.includes("svg")) return;

  const BLUR_CSS = "img, video, video-js, [image-src] { filter: blur(20px) grayscale(100%) !important; clip-path: inset(0); }";

  // Inject a CSS rule immediately so images are blurred/grayscaled before they even render
  let styleInjected = false;
  let styleFailed = false;
  function tryInjectStyle() {
    if (styleInjected || styleFailed) return;
    if (!document.head && !document.documentElement) return;
    const style = document.createElement("style");
    style.id = "mastir-blur-style";
    const existingNonce = document.querySelector("style[nonce], script[nonce]");
    if (existingNonce) style.nonce = existingNonce.nonce || existingNonce.getAttribute("nonce");
    style.textContent = BLUR_CSS;
    (document.head || document.documentElement).appendChild(style);
    if (!style.sheet || style.sheet.cssRules.length === 0) {
      style.remove();
      // Stylesheet blocked by CSP (style-src). Per-element blur via CSSOM
      // (element.style.setProperty) still works and isn't governed by CSP,
      // but it can't pre-empt the initial paint the way a global rule does —
      // so cover the page until we've blurred everything, then reveal.
      if (document.head) { styleFailed = true; showCover(); scheduleReveal(); }
    } else {
      styleInjected = true;
    }
  }

  // Opaque cover shown on strict-CSP sites (where the blur stylesheet is
  // rejected) to prevent a flash of unblurred images during initial parse.
  // Positioned via CSSOM, which CSP's style-src does not govern.
  let coverEl = null;
  function showCover() {
    if (coverEl) return;
    coverEl = document.createElement("div");
    const s = coverEl.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("top", "0", "important");
    s.setProperty("left", "0", "important");
    s.setProperty("width", "100vw", "important");
    s.setProperty("height", "100vh", "important");
    s.setProperty("background", "#1a1a1a", "important");
    s.setProperty("z-index", "2147483647", "important");
    s.setProperty("display", "flex", "important");
    s.setProperty("align-items", "center", "important");
    s.setProperty("justify-content", "center", "important");
    s.setProperty("color", "#888", "important");
    s.setProperty("font-family", "sans-serif", "important");
    s.setProperty("font-size", "14px", "important");
    coverEl.textContent = "Mastir: concealing images…";
    (document.body || document.documentElement).appendChild(coverEl);
  }
  function hideCover() {
    if (coverEl) { coverEl.remove(); coverEl = null; }
  }

  // Once the stylesheet is known-rejected, blur every current image via CSSOM
  // then lift the cover. Later images are handled by the top-level observer.
  let revealScheduled = false;
  function scheduleReveal() {
    if (revealScheduled) return;
    revealScheduled = true;
    const doReveal = () => {
      document.querySelectorAll("img, video, video-js, [image-src]").forEach((el) => {
        if (!isVideoIframe(el)) blurElement(el);
      });
      hideCover();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", doReveal, { once: true });
    } else {
      doReveal();
    }
    setTimeout(hideCover, 5000); // safety net
  }

  tryInjectStyle();
  if (!styleInjected && !styleFailed) {
    new MutationObserver((_, obs) => {
      tryInjectStyle();
      if (styleInjected || styleFailed) obs.disconnect();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  const BG_IMG_RE = /url\(["']?([^"')]*\.(jpe?g|png|gif|webp|avif|bmp)(\?[^"')]*)?|data:image\/[^"')]+)["']?\)/i;

  function isVideoIframe(el) {
    if (el.tagName !== "IFRAME") return false;
    if (el.hasAttribute("allowfullscreen")) return true;
    const allow = el.getAttribute("allow") || "";
    return /picture-in-picture|encrypted-media|autoplay/.test(allow);
  }

  function shouldPreBlur(el) {
    if (el.tagName === "IFRAME") return false;
    if (el.hasAttribute("image-src")) return true;
    const style = el.getAttribute("style");
    if (style && BG_IMG_RE.test(style)) return true;
    return false;
  }

  function blurElement(el) {
    el.style.setProperty("filter", MAX_BLUR, "important");
    el.style.clipPath = "inset(0)";
  }

  const isDirectImageView = document.contentType?.startsWith("image/");

  function processNode(node) {
    if (node.nodeType !== 1) return;
    if (shouldPreBlur(node)) blurElement(node);
    observeElement(node);
    if (node.querySelectorAll) {
      node.querySelectorAll("*").forEach((child) => {
        if (shouldPreBlur(child)) blurElement(child);
        observeElement(child);
        if (child.shadowRoot) processShadowRoot(child.shadowRoot);
      });
    }
    if (node.shadowRoot) processShadowRoot(node.shadowRoot);
  }

  function processShadowRoot(root) {
    // Skip the <style> injection when we already know the page's style-src
    // rejects it — it would just emit a CSP violation per shadow root.
    // Per-element blurElement below covers those images either way.
    if (!styleFailed && !root.querySelector("#mastir-blur-style")) {
      const style = document.createElement("style");
      style.textContent = BLUR_CSS;
      style.id = "mastir-blur-style";
      root.prepend(style);
    }
    root.querySelectorAll("*").forEach((child) => {
      if (shouldPreBlur(child)) blurElement(child);
      observeElement(child);
    });
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) processNode(node);
      }
    }).observe(root, { childList: true, subtree: true });
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) processNode(node);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  const MAX_BLUR = "blur(20px) grayscale(100%)";

  // --- Profiling ---
  const MASTIR_PROFILE = true;
  const profileStats = {};
  function profile(label, fn) {
    if (!MASTIR_PROFILE) return fn();
    const t0 = performance.now();
    const r = fn();
    const dt = performance.now() - t0;
    const s = profileStats[label] || (profileStats[label] = { n: 0, total: 0, max: 0 });
    s.n++; s.total += dt; s.max = Math.max(s.max, dt);
    return r;
  }
  async function profileAsync(label, fn) {
    if (!MASTIR_PROFILE) return fn();
    const t0 = performance.now();
    const r = await fn();
    const dt = performance.now() - t0;
    const s = profileStats[label] || (profileStats[label] = { n: 0, total: 0, max: 0 });
    s.n++; s.total += dt; s.max = Math.max(s.max, dt);
    return r;
  }
  if (MASTIR_PROFILE) {
    window.mastirProfile = () => {
      console.table(Object.fromEntries(Object.entries(profileStats).map(([k, s]) =>
        [k, { calls: s.n, avgMs: +(s.total / s.n).toFixed(2), maxMs: +s.max.toFixed(2), totalMs: +s.total.toFixed(1) }])));
    };
  }

  let blurAmount = 0;
  let blurOff = true;
  let grayOn = false;
  let maskBlur = 4;
  let maskExpand = 8;
  let blurSpans = circleRowSpans(maskBlur);
  let expandSpans = circleRowSpans(maskExpand);

  // --- Person Segmentation ---
  const segProcessed = new WeakSet();
  const segOriginalSrc = new WeakMap();
  const segMaskCache = new WeakMap();
  const segAllElements = new Set();
  const segUrlCache = new Map();

  // --- Bridge communication ---
  function bridgeRequest(type, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const responseType = type + "-response";
      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("bridge timeout"));
      }, timeoutMs);
      function handler(e) {
        if (e.source !== window) return;
        if (e.data?.type !== responseType || e.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data);
      }
      window.addEventListener("message", handler);
      window.postMessage({ ...payload, type, id }, "*");
    });
  }

  function crossFetch(url) {
    return bridgeRequest("mastir-fetch", { url }).then((r) => {
      if (r.error || !r.dataUrl) throw new Error(r.error || "fetch failed");
      return r.dataUrl;
    });
  }

  // Segmentation runs in an offscreen extension page (GPU, own CSP).
  const MAX_SEG_DIM = 256;

  function circleRowSpans(radius) {
    const spans = [];
    for (let dy = -radius; dy <= radius; dy++) {
      spans.push({ dy, dx: Math.floor(Math.sqrt(radius * radius - dy * dy)) });
    }
    return spans;
  }

  function buildIntegral(src, w, h) {
    const sat = new Uint32Array((w + 1) * (h + 1));
    const stride = w + 1;
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        sat[(y + 1) * stride + (x + 1)] = rowSum + sat[y * stride + (x + 1)];
      }
    }
    return sat;
  }

  function dilateOp(src, w, h, spans) {
    const sat = buildIntegral(src, w, h);
    const stride = w + 1;
    const dst = new Uint8Array(w * h);
    const numSpans = spans.length;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = false;
        for (let s = 0; s < numSpans && !hit; s++) {
          const row = y + spans[s].dy;
          if (row < 0 || row >= h) continue;
          const dx = spans[s].dx;
          const x0 = x - dx < 0 ? 0 : x - dx;
          const x1 = x + dx >= w ? w - 1 : x + dx;
          if (sat[(row + 1) * stride + (x1 + 1)] - sat[row * stride + (x1 + 1)] - sat[(row + 1) * stride + x0] + sat[row * stride + x0] > 0) hit = true;
        }
        dst[y * w + x] = hit ? 255 : 0;
      }
    }
    return dst;
  }

  function blurOp(src, w, h, spans) {
    const sat = buildIntegral(src, w, h);
    const stride = w + 1;
    const dst = new Uint8Array(w * h);
    const numSpans = spans.length;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let s = 0; s < numSpans; s++) {
          const row = y + spans[s].dy;
          if (row < 0 || row >= h) continue;
          const dx = spans[s].dx;
          const x0 = x - dx < 0 ? 0 : x - dx;
          const x1 = x + dx >= w ? w - 1 : x + dx;
          sum += sat[(row + 1) * stride + (x1 + 1)] - sat[row * stride + (x1 + 1)] - sat[(row + 1) * stride + x0] + sat[row * stride + x0];
          count += x1 - x0 + 1;
        }
        const val = (sum / count) | 0;
        dst[y * w + x] = val < 10 ? 0 : val;
      }
    }
    return dst;
  }

  function processRawMask(raw, w, h) {
    const EXPAND = maskExpand;
    const BLUR = maskBlur;
    if (EXPAND === 0 && BLUR === 0) {
      return raw.slice();
    }

    let source = raw;
    if (EXPAND > 0) {
      source = dilateOp(raw, w, h, expandSpans);
    }

    if (BLUR === 0) {
      return source;
    }

    return blurOp(source, w, h, blurSpans);
  }

  // Upscale a single-channel mask from (sw,sh) to (w,h) with bilinear smoothing.
  function upscaleMask(mask, sw, sh, w, h) {
    if (sw === w && sh === h) return mask;
    const src = document.createElement("canvas");
    src.width = sw; src.height = sh;
    const sctx = src.getContext("2d");
    const img = sctx.createImageData(sw, sh);
    for (let i = 0; i < mask.length; i++) {
      const pi = i * 4;
      img.data[pi] = img.data[pi + 1] = img.data[pi + 2] = mask[i];
      img.data[pi + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const dst = document.createElement("canvas");
    dst.width = w; dst.height = h;
    const dctx = dst.getContext("2d");
    dctx.imageSmoothingEnabled = true;
    dctx.drawImage(src, 0, 0, w, h);
    const out = new Uint8Array(w * h);
    const data = dctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
    return out;
  }

  // Process the raw seg-res mask (dilate + blur) then upscale to display res.
  function buildMaskAlpha(entry) {
    if (!entry.raw) return new Uint8Array(entry.w * entry.h);
    const small = profile("mask.dilateBlur", () => processRawMask(entry.raw, entry.sw, entry.sh));
    return profile("mask.upscale", () => upscaleMask(small, entry.sw, entry.sh, entry.w, entry.h));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Downscale bitmap to <= MAX_SEG_DIM, segment in the offscreen doc,
  // return the raw binary mask at the downscaled (seg) resolution.
  async function segment(bitmap) {
    const scale = Math.min(1, MAX_SEG_DIM / Math.max(bitmap.width, bitmap.height));
    const sw = Math.max(1, Math.round(bitmap.width * scale));
    const sh = Math.max(1, Math.round(bitmap.height * scale));
    const pixelsB64 = profile("seg.encode", () => {
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, sw, sh);
      const pixels = ctx.getImageData(0, 0, sw, sh).data;
      return bytesToBase64(new Uint8Array(pixels.buffer));
    });
    const resp = await profileAsync("seg.roundtrip", () => bridgeRequest("mastir-segment", { pixelsB64, w: sw, h: sh }, 20000));
    if (resp.error) throw new Error(resp.error);
    const raw = profile("seg.decode", () => resp.rawB64 ? base64ToBytes(resp.rawB64) : null);
    return { raw, sw, sh };
  }

  function getImageUrl(el) {
    if (el.tagName === "VIDEO") {
      return el.getAttribute("poster") || null;
    }
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const first = srcset.trim().split(/,\s*(?=https?:\/\/)/)[0];
      return first.trim().split(/\s+/)[0];
    }
    const imageSrc = el.getAttribute("image-src");
    if (imageSrc) return imageSrc;
    const src = el.currentSrc || el.src;
    if (src && !src.includes(" ")) return src;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match) return match[1];
    }
    return null;
  }

  function markDone(img) {
    segProcessed.add(img);
    segMaskCache.set(img, { originalPixels: null, maskAlpha: new Uint8Array(0), raw: null, sw: 0, sh: 0, w: 0, h: 0 });
    segAllElements.add(img);
    img.style.setProperty("filter", buildFilter(!blurOff), "important");
  }

  async function processImage(img) {
    if (segProcessed.has(img)) return;
    if (isVideoIframe(img)) { segProcessed.add(img); return; }
    const imageSrcAttr = img.getAttribute("image-src");
    const src = img.tagName === "VIDEO"
      ? getImageUrl(img)
      : (imageSrcAttr || img.currentSrc || img.src || getImageUrl(img));
    if (!src) return;
    if (img.tagName === "IMG" && !imageSrcAttr) {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        img.addEventListener("load", () => enqueueImage(img), { once: true });
        return;
      }
      if (img.naturalWidth < 48 || img.naturalHeight < 48) {
        markDone(img);
        return;
      }
    }

    segProcessed.add(img);

    if (/\.(svg|gif)(\?|$)/i.test(src) || /^data:image\/(svg|gif)/i.test(src)) {
      markDone(img);
      return;
    }
    segOriginalSrc.set(img, src);

    try {
      const fetchUrl = getImageUrl(img);
      if (!fetchUrl) return;

      if (segUrlCache.has(fetchUrl)) {
        const cached = segUrlCache.get(fetchUrl);
        const entry = { originalPixels: cached.originalPixels.slice(), raw: cached.raw, sw: cached.sw, sh: cached.sh, w: cached.w, h: cached.h };
        entry.maskAlpha = buildMaskAlpha(entry);
        segMaskCache.set(img, entry);
        segAllElements.add(img);
        applyMask(img);
        return;
      }

      const bitmap = await new Promise((resolve, reject) => {
        const tmp = new Image();
        if (!fetchUrl.startsWith("blob:")) tmp.crossOrigin = "anonymous";
        tmp.onload = () => resolve(createImageBitmap(tmp));
        tmp.onerror = () => {
          if (fetchUrl.startsWith("blob:")) { reject(new Error("blob load failed")); return; }
          crossFetch(fetchUrl).then((dataUrl) => {
            const tmp2 = new Image();
            tmp2.onload = () => resolve(createImageBitmap(tmp2));
            tmp2.onerror = () => reject(new Error("decode failed"));
            tmp2.src = dataUrl;
          }).catch(reject);
        };
        tmp.src = fetchUrl;
      });

      const { raw, sw, sh } = await segment(bitmap);
      const w = bitmap.width, h = bitmap.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const originalPixels = canvas.getContext("2d").getImageData(0, 0, w, h).data.slice();

      const cacheEntry = { originalPixels, raw, sw, sh, w, h };
      cacheEntry.maskAlpha = buildMaskAlpha(cacheEntry);
      segUrlCache.set(fetchUrl, cacheEntry);
      segMaskCache.set(img, cacheEntry);
      segAllElements.add(img);
      applyMask(img);
    } catch (e) {
      console.warn("[mastir] processImage failed:", e.message, src?.substring(0, 80));
      if (/SVG|natural dimensions|createImageBitmap|Assertion|CORS|blocked|decode failed|blob load failed/i.test(e.message)) {
        markDone(img);
      } else {
        segProcessed.delete(img);
        const retries = (img.__mastirRetries || 0) + 1;
        img.__mastirRetries = retries;
        if (retries <= 5) {
          setTimeout(() => enqueueImage(img), retries * 2000);
        }
      }
    }
  }

  function applyMask(img) {
    const cached = segMaskCache.get(img);
    if (!cached || !cached.originalPixels) return;
    const { originalPixels, maskAlpha, w, h } = cached;
    const pixels = originalPixels.slice();
    const didPaint = profile("paint.blend", () => {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      let hasPersonPixels = false;
      for (let i = 0; i < maskAlpha.length; i++) {
        if (maskAlpha[i] > 0) hasPersonPixels = true;
        if (maskAlpha[i] < 128) {
          const pi = i * 4;
          rSum += originalPixels[pi];
          gSum += originalPixels[pi + 1];
          bSum += originalPixels[pi + 2];
          count++;
        }
      }
      if (!hasPersonPixels) return false;
      const r = count > 0 ? (rSum / count) | 0 : 128;
      const g = count > 0 ? (gSum / count) | 0 : 128;
      const b = count > 0 ? (bSum / count) | 0 : 128;
      for (let i = 0; i < maskAlpha.length; i++) {
        if (maskAlpha[i] > 0) {
          const pi = i * 4;
          const a = maskAlpha[i] / 255;
          pixels[pi] = originalPixels[pi] * (1 - a) + r * a | 0;
          pixels[pi + 1] = originalPixels[pi + 1] * (1 - a) + g * a | 0;
          pixels[pi + 2] = originalPixels[pi + 2] * (1 - a) + b * a | 0;
          pixels[pi + 3] = 255;
        }
      }
      return true;
    });
    if (didPaint) {
      const dataUrl = profile("paint.toDataURL", () => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
        return canvas.toDataURL("image/png");
      });
      if (img.tagName === "IMG" && isDirectImageView) {
        let overlay = img.__mastirOverlay;
        if (!overlay) {
          overlay = document.createElement("div");
          Object.assign(overlay.style, {
            position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
            pointerEvents: "none", backgroundSize: "100% 100%", zIndex: "1",
          });
          img.__mastirOverlay = overlay;
          const parent = img.parentElement;
          if (parent) {
            if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
            parent.insertBefore(overlay, img.nextSibling);
          }
        }
        overlay.style.setProperty("background-image", `url(${dataUrl})`, "important");
      } else if (img.tagName === "IMG") {
        selfUpdating = true;
        const picture = img.closest("picture");
        if (picture) picture.querySelectorAll("source").forEach((s) => s.remove());
        img.removeAttribute("srcset");
        img.src = dataUrl;
        selfUpdating = false;
      } else if (img.tagName === "VIDEO") {
        img.setAttribute("poster", dataUrl);
      } else {
        // Background may layer gradients over the image url(); swap only the
        // url() so any decorative gradient tint is preserved.
        const origBg = getComputedStyle(img).backgroundImage;
        if (origBg && /url\(/.test(origBg) && /gradient/.test(origBg)) {
          const newBg = origBg.replace(/url\(["']?[^"')]+["']?\)/, `url(${dataUrl})`);
          img.style.setProperty("background-image", newBg, "important");
        } else {
          img.style.setProperty("background-image", `url(${dataUrl})`, "important");
        }
      }
    } else if (img.tagName === "IMG" && segOriginalSrc.has(img)) {
      selfUpdating = true;
      img.src = segOriginalSrc.get(img);
      selfUpdating = false;
    }
    const filter = buildFilter(!blurOff);
    img.style.setProperty("filter", filter, "important");
    if (img.tagName === "IMG") observeSrc(img);
  }



  const segQueue = [];
  const SEG_CONCURRENCY = 2;
  let segWorkers = 0;

  async function segWorker() {
    while (segQueue.length > 0) {
      const img = segQueue.shift();
      if (segMaskCache.has(img)) continue;
      try {
        await processImage(img);
      } catch (e) {
        console.error("[mastir] queue error:", e);
      }
    }
    segWorkers--;
  }

  function processQueue() {
    while (segWorkers < SEG_CONCURRENCY && segWorkers < segQueue.length) {
      segWorkers++;
      segWorker();
    }
  }

  function enqueueImage(img) {
    if (segMaskCache.has(img) || segQueue.includes(img) || segProcessed.has(img)) return;
    segQueue.push(img);
    processQueue();
  }


  const SKIP_BG_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "BR", "HR", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "SVG", "PATH", "IMG"]);

  const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      visibilityObserver.unobserve(el);
      if (segProcessed.has(el) || segMaskCache.has(el)) continue;
      if (el.tagName === "IMG" || el.hasAttribute("image-src")) {
        enqueueImage(el);
      } else if (el.tagName === "VIDEO" && el.getAttribute("poster")) {
        enqueueImage(el);
      } else {
        if (el.offsetWidth < 48 || el.offsetHeight < 48) continue;
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") continue;
        // The bg may layer gradients before a url() (e.g. a tinted photo),
        // so look for a url() anywhere rather than rejecting on prefix.
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (!match) continue;
        if (/\.(svg|gif)(\?|$)/i.test(match[1])) continue;
        blurElement(el);
        enqueueImage(el);
      }
    }
  });

  function observeElement(el) {
    if (segProcessed.has(el) || segMaskCache.has(el)) return;
    if (el.tagName === "IMG" || el.hasAttribute("image-src") || !SKIP_BG_TAGS.has(el.tagName)) {
      visibilityObserver.observe(el);
    }
  }

  function runSegmentation() {
    document.querySelectorAll("img").forEach(observeElement);
    document.querySelectorAll("[image-src]").forEach(observeElement);
    document.querySelectorAll("video[poster]").forEach(observeElement);
  }


  // --- UI ---

  function buildFilter(includeBlur) {
    const parts = [];
    if (includeBlur) parts.push(`blur(${blurAmount}px)`);
    if (grayOn) parts.push("grayscale(100%)");
    return parts.length ? parts.join(" ") : "none";
  }

  function applyBlur() {
    segAllElements.forEach((el) => {
      el.style.setProperty("filter", buildFilter(!blurOff), "important");
    });
  }

  function reprocessMasks() {
    segAllElements.forEach((img) => {
      const cached = segMaskCache.get(img);
      if (!cached || !cached.raw) return;
      cached.maskAlpha = buildMaskAlpha(cached);
      applyMask(img);
    });
  }



  function broadcastState() {
    const msg = { type: "mastir-sync", blurOff, grayOn, blurAmount };
    document.querySelectorAll("iframe").forEach((iframe) => {
      try { iframe.contentWindow.postMessage(msg, "*"); } catch (e) { /* cross-origin */ }
    });
  }

  window.addEventListener("message", (e) => {
    if (e.data && (e.data.type === "mastir-sync" || e.data.type === "mastir-settings")) {
      if (e.data.grayOn !== undefined) grayOn = e.data.grayOn;
      if (e.data.blurAmount !== undefined) { blurAmount = e.data.blurAmount; blurOff = blurAmount === 0; }
      if (e.data.blurOff !== undefined) blurOff = e.data.blurOff;
      const maskChanged = (e.data.maskBlur !== undefined && e.data.maskBlur !== maskBlur) ||
        (e.data.maskExpand !== undefined && e.data.maskExpand !== maskExpand);
      if (e.data.maskBlur !== undefined) { maskBlur = e.data.maskBlur; blurSpans = circleRowSpans(maskBlur); }
      if (e.data.maskExpand !== undefined) { maskExpand = e.data.maskExpand; expandSpans = circleRowSpans(maskExpand); }
      applyBlur();
      if (maskChanged) reprocessMasks();
      broadcastState();
    }
  });

  // Watch for external JS overwriting src on images we've already masked
  const srcReapplyCount = new WeakMap();
  const srcReapplyPending = new WeakSet();
  const MAX_REAPPLIES = 5;
  let selfUpdating = false;

  const srcObserver = new MutationObserver((mutations) => {
    if (selfUpdating) return;
    for (const m of mutations) {
      if (m.type !== "attributes") continue;
      const img = m.target;
      if (!segMaskCache.has(img)) continue;
      const cached = segMaskCache.get(img);
      if (!cached || !cached.originalPixels) continue;
      const current = img.src || "";
      if (current.startsWith("data:")) continue;
      img.style.setProperty("filter", MAX_BLUR, "important");
      const count = srcReapplyCount.get(img) || 0;
      if (count >= MAX_REAPPLIES) continue;
      if (srcReapplyPending.has(img)) continue;
      srcReapplyPending.add(img);
      srcReapplyCount.set(img, count + 1);
      requestAnimationFrame(() => {
        srcReapplyPending.delete(img);
        const cur = img.src || "";
        if (!cur.startsWith("data:") && segMaskCache.has(img)) {
          selfUpdating = true;
          applyMask(img);
          selfUpdating = false;
        }
      });
    }
  });

  function observeSrc(img) {
    srcReapplyCount.set(img, 0);
    srcObserver.observe(img, { attributes: true, attributeFilter: ["src", "srcset"] });
  }

  // Skip tiny iframes (tracking pixels, ad beacons) — no meaningful images.
  const isTinyFrame = window !== window.top && window.innerWidth < 48 && window.innerHeight < 48;

  let segDebounce = null;
  window.addEventListener("load", () => {
    if (isTinyFrame) return;
    new MutationObserver(() => {
      applyBlur();
      if (!segDebounce) {
        segDebounce = setTimeout(() => { segDebounce = null; runSegmentation(); }, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
    applyBlur();
    runSegmentation();
  });
})();