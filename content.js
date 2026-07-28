"use strict";

(function () {
  // Guard against double-injection (declarative + programmatic both fire).
  if (window.__mastirInjected) return;
  window.__mastirInjected = true;
  if (document.contentType?.includes("svg")) return;

  // Full-strength concealment: heavy blur + full desaturation. Applied to any
  // image not yet cleared by segmentation, and permanently to videos/animated
  // content. Single source of truth for blur strength — BLUR_CSS derives from it.
  const MAX_BLUR = "blur(32px) grayscale(100%)";
  // Global rule injected at document_start so images are concealed before they
  // ever paint. clip-path: inset(0) keeps the blur from bleeding past the box.
  const BLUR_CSS = `img, video, video-js, [image-src] { filter: ${MAX_BLUR} !important; clip-path: inset(0); }`;

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
    if (el.tagName === "VIDEO" || el.tagName === "VIDEO-JS") return true;
    if (el.tagName === "IMG") return true;
    if (el.hasAttribute("image-src")) return true;
    const style = el.getAttribute("style");
    if (style && BG_IMG_RE.test(style)) return true;
    return false;
  }

  function blurElement(el) {
    el.style.setProperty("filter", MAX_BLUR, "important");
    // Don't set clip-path on an SVG <image>: inline style overrides its
    // clip-path="url(#…)" attribute, replacing the element's real (often
    // non-rectangular) clip with a rectangle. inset(0) only exists to contain
    // blur bleed, which the element's own clip already does.
    if (!(el instanceof SVGImageElement)) el.style.clipPath = "inset(0)";
  }

  const isDirectImageView = document.contentType?.startsWith("image/");

  // Pre-blur, observe, and recurse into any shadow root on a single element.
  function handleElement(el) {
    // Our own concealment overlay is an <img> — never blur or segment it.
    if (el.__mastirIsOverlay) return;
    if (el.tagName === "VIDEO") watchVideoPlayback(el);
    if (shouldPreBlur(el)) blurElement(el);
    observeElement(el);
    if (el.shadowRoot) processShadowRoot(el.shadowRoot);
  }

  function processNode(node) {
    if (node.nodeType !== 1) return;
    handleElement(node);
    if (node.querySelectorAll) {
      node.querySelectorAll("*").forEach(handleElement);
    }
  }

  // Shared childList-observer callback: pre-blur/observe every newly-added node.
  function processMutations(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) processNode(node);
    }
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
    root.querySelectorAll("*").forEach(handleElement);
    new MutationObserver(processMutations).observe(root, { childList: true, subtree: true });
  }

  new MutationObserver((mutations) => {
    profile("obs.docChildList", () => processMutations(mutations));
  }).observe(document.documentElement, { childList: true, subtree: true });

  // --- Profiling ---
  // Wrap any function in profile()/profileAsync() to accumulate call count,
  // total, and max time under `label`. Dump the table from the console with
  // window.mastirProfile(). Flip MASTIR_PROFILE to false to make it a no-op.
  const MASTIR_PROFILE = true;
  const profileStats = {};
  function recordStat(label, elapsed) {
    const s = profileStats[label] || (profileStats[label] = { n: 0, total: 0, max: 0 });
    s.n++; s.total += elapsed; s.max = Math.max(s.max, elapsed);
  }
  function profile(label, fn) {
    if (!MASTIR_PROFILE) return fn();
    const t0 = performance.now();
    const r = fn();
    recordStat(label, performance.now() - t0);
    return r;
  }
  async function profileAsync(label, fn) {
    if (!MASTIR_PROFILE) return fn();
    const t0 = performance.now();
    const r = await fn();
    recordStat(label, performance.now() - t0);
    return r;
  }
  if (MASTIR_PROFILE) {
    window.mastirProfile = () => {
      console.table(Object.fromEntries(Object.entries(profileStats).map(([k, s]) =>
        [k, { calls: s.n, avgMs: +(s.total / s.n).toFixed(2), maxMs: +s.max.toFixed(2), totalMs: +s.total.toFixed(1) }])));
    };
  }

  // Buffer every mastir diagnostic line in memory instead of racing it against
  // the host page's own console spam (Google Images floods gen_204 errors).
  // Dump with window.mastirLog() or filter with window.mastirLog("skip") /
  // window.mastirLog("ANd9GcT..."). Clear with window.mastirLog.clear().
  const mastirLogBuffer = [];
  function mlog(msg) {
    if (!MASTIR_PROFILE) return;
    mastirLogBuffer.push(msg);
  }
  if (MASTIR_PROFILE) {
    window.mastirLog = (filter) => {
      const lines = filter ? mastirLogBuffer.filter((l) => l.includes(filter)) : mastirLogBuffer;
      console.log(`[mastir] ${lines.length} log line(s)${filter ? ` matching "${filter}"` : ""}:\n` + lines.join("\n"));
    };
    window.mastirLog.clear = () => { mastirLogBuffer.length = 0; };
    window.mastirBuild = "lazy-overlay-bg";
  }

  // Debug: overlay the computed mask (red, semi-transparent) on the ORIGINAL
  // image pixels so alignment can be inspected directly. Call from the console:
  //   mastirDebugMask(0)  — index into the currently segmented elements
  //   mastirDebugMask(document.querySelectorAll('img')[3])  — or pass an element
  // Opens a data URL in a new tab showing original + red mask.
  // Debug: dump an element's full tracking state (processed? cached? which URL
  // did we segment? does the cached mask have a person?). Answers "why isn't
  // THIS image concealed" without needing the closure-scoped maps in scope.
  //   mastirState($0)
  window.mastirState = (img) => {
    if (!img) { console.warn("[mastir] pass an element"); return; }
    const cached = segMaskCache.get(img);
    console.log("[mastir] state", {
      tag: img.tagName,
      currentSrc: (img.currentSrc || img.src || "").slice(0, 80),
      liveFetchUrl: (getImageUrl(img) || "").slice(0, 80),
      segFetchUrl: (segFetchUrl.get(img) || "").slice(0, 80),
      processed: segProcessed.has(img),
      hasCache: !!cached,
      hasPerson: cached ? cached.hasPerson : undefined,
      overlayPaint: !!img.__mastirOverlayPaint,
      forceBlur: !!img.__mastirForceBlur,
      filter: img.style.filter,
    });
  };

  window.mastirDebugMask = (target) => {
    let img = target;
    if (typeof target === "number") img = [...segAllElements][target];
    if (!img) { console.warn("[mastir] no element; segAllElements size =", segAllElements.size); return; }
    const cached = segMaskCache.get(img);
    if (!cached || !cached.originalPixels) { console.warn("[mastir] no cached mask for element", img); return; }
    const { originalPixels, maskAlpha, w, h } = cached;
    const out = new Uint8ClampedArray(originalPixels);
    // Tint red where the mask is set, and track its bounding box.
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < maskAlpha.length; i++) {
      const a = maskAlpha[i] / 255;
      if (a > 0) {
        const pi = i * 4;
        out[pi] = out[pi] * (1 - a) + 255 * a;
        out[pi + 1] = out[pi + 1] * (1 - a);
        out[pi + 2] = out[pi + 2] * (1 - a);
        const x = i % w, y = (i / w) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cctx = c.getContext("2d");
    cctx.putImageData(new ImageData(out, w, h), 0, 0);
    // Draw a lime outline around the mask's bounding box (its extent within the
    // image), so alignment vs. the person is obvious.
    if (maxX >= 0) {
      cctx.strokeStyle = "#00ff00";
      cctx.lineWidth = Math.max(2, Math.round(Math.max(w, h) / 200));
      cctx.strokeRect(minX + 0.5, minY + 0.5, maxX - minX, maxY - minY);
      console.log(`[mastir] mask bbox x[${minX}-${maxX}] y[${minY}-${maxY}] of image ${w}x${h}`);
    } else {
      console.log("[mastir] mask is EMPTY (no person pixels)");
    }
    console.log(`[mastir] mask ${cached.sw}x${cached.sh} -> image ${w}x${h}`, img);
    // Chrome blocks top-level navigation to data: URLs, so pin the canvas over
    // everything on the page instead. Click it to dismiss. Cyan frame = image
    // bounds (distinct from the lime mask-extent box drawn inside).
    c.style.cssText = "position:fixed;top:20px;left:20px;z-index:2147483647;" +
      "max-width:90vw;max-height:90vh;border:3px solid #00e5ff;background:#000;cursor:pointer;box-shadow:0 0 30px #000";
    c.title = "Mastir mask debug — click to close";
    c.addEventListener("click", () => c.remove());
    document.body.appendChild(c);

    // Second canvas: the RAW seg mask at its own native sw x sh, so its shape
    // can be compared apples-to-apples against the image aspect ratio. If the
    // raw mask's aspect differs from the image's, the model saw a distorted
    // (squished) image — that's the "weird resolution" failure mode.
    if (cached.raw && cached.sw && cached.sh) {
      const rc = document.createElement("canvas");
      rc.width = cached.sw; rc.height = cached.sh;
      const rctx = rc.getContext("2d");
      // Draw the ORIGINAL image downscaled to the raw mask's native size, so the
      // mask can be checked against real content at the exact resolution the
      // model produced it.
      const oc = document.createElement("canvas");
      oc.width = w; oc.height = h;
      oc.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(originalPixels), w, h), 0, 0);
      rctx.imageSmoothingEnabled = true;
      rctx.drawImage(oc, 0, 0, cached.sw, cached.sh);
      // Paint the raw mask as solid red (not transparent) on top of the
      // downscaled original.
      const rimg = rctx.getImageData(0, 0, cached.sw, cached.sh);
      for (let i = 0; i < cached.raw.length; i++) {
        if (cached.raw[i] > 0) {
          const pi = i * 4;
          rimg.data[pi] = 255;
          rimg.data[pi + 1] = 0;
          rimg.data[pi + 2] = 0;
        }
      }
      rctx.putImageData(rimg, 0, 0);
      rc.style.cssText = "position:fixed;top:20px;right:20px;z-index:2147483647;" +
        "max-width:45vw;max-height:90vh;border:3px solid #ffb300;background:#000;cursor:pointer;" +
        "image-rendering:pixelated;box-shadow:0 0 30px #000";
      rc.title = "Mastir RAW mask (native sw x sh) — click to close";
      rc.addEventListener("click", () => rc.remove());
      document.body.appendChild(rc);
      const imgAspect = (w / h).toFixed(3), maskAspect = (cached.sw / cached.sh).toFixed(3);
      console.log(`[mastir] aspect  image=${imgAspect}  rawMask=${maskAspect}  ${imgAspect === maskAspect ? "(match)" : "(DIFFERENT — mask distorted vs image)"}`);
    }
    // Also emit a blob URL (not blocked like data:) in case you want it in a tab.
    c.toBlob((b) => console.log("[mastir] mask preview blob:", URL.createObjectURL(b)));
  };

  // --- Live settings (kept in sync with the popup via postMessage) ---
  let blurAmount = 0;       // global blur strength applied to ALL images (px)
  let blurOff = true;       // true when blurAmount === 0 (no global blur)
  let grayOn = false;       // desaturate all images
  let skinOnly = false;     // conceal only skin pixels, not the whole person
  let maskBlur = 2;         // softness of the mask edge (px radius)
  let maskExpand = 8;       // grow the mask outward (px radius)
  // Precomputed circular kernels for the mask blur/expand radii; recomputed
  // whenever the corresponding setting changes.
  let blurSpans = circleRowSpans(maskBlur);
  let expandSpans = circleRowSpans(maskExpand);

  // --- Person Segmentation ---
  // Per-image bookkeeping. WeakMap/WeakSet so entries vanish with the element.
  const segProcessed = new WeakSet();       // images we've already handled
  const segOriginalSrc = new WeakMap();     // img -> src before we rewrote it
  const segFetchUrl = new WeakMap();        // img -> exact URL we segmented
  const segMaskCache = new WeakMap();       // img -> { originalPixels, maskAlpha, raw, ... }
  const segAllElements = new Set();         // every segmented element (for applyBlur/reprocess)
  const segUrlCache = new Map();            // url -> cached mask, shared across identical images

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

  function decodeToBitmap(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(createImageBitmap(im));
      im.onerror = () => reject(new Error("decode failed"));
      im.src = src;
    });
  }

  // Read pixels from an already-decoded <img> element by drawing it to a
  // canvas. Uses the element's IN-MEMORY decoded bitmap, not its src — so it
  // works even after the src (e.g. a blob:) has been revoked. Throws if the
  // element isn't decoded yet or if the canvas is tainted (cross-origin without
  // CORS), in which case the caller falls back to fetching.
  async function bitmapFromElement(el) {
    // Require a fully-loaded, decoded element. naturalWidth>0 alone is NOT
    // enough — it goes non-zero at header decode, before the image is actually
    // drawable, and drawing too early yields a BLACK canvas (which then paints
    // the concealed person as a solid black blob). `complete` + decode() ensure
    // the pixels are really there.
    if (!el || el.tagName !== "IMG" || !el.naturalWidth || !el.naturalHeight || !el.complete) {
      throw new Error("element not decoded");
    }
    // decode() resolves only once the image is fully decoded and drawable, so
    // drawing after it can't produce the premature black frame.
    try { await el.decode(); } catch (e) { throw new Error("element not decoded"); }
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(el, 0, 0);
    // Touch the pixels to force the taint check to throw here (not later).
    ctx.getImageData(0, 0, 1, 1);
    return createImageBitmap(canvas);
  }

  // Acquire a decoded bitmap for an image. Fetch the URL first (reliable,
  // full-res source), and only fall back to reading the live element's pixels
  // if fetching is impossible/failed:
  //   1. crossOrigin="anonymous" <img> load — readable when the response
  //      carries CORS headers. Our declarativeNetRequest rule injects
  //      Access-Control-Allow-Origin on image responses, so this works for most
  //      cross-origin images without an extra request.
  //   2. Background fetch (crossFetch) — extension origin + host permissions,
  //      bypasses the PAGE's CORS for images rung 1 still can't read.
  //   3. Live <img> element pixels (drawImage) — LAST resort, for images whose
  //      URL can't be fetched at all (e.g. revoked blob: srcs like Tableau
  //      tiles). Draws the element's in-memory decode. Guarded against a
  //      failed/black draw so it fails safe (stays blurred) rather than
  //      concealing to a black blob.
  async function acquireBitmap(fetchUrl, el) {
    // blob: can't be fetched cross-context — try in-page decode, then element.
    if (fetchUrl.startsWith("blob:")) {
      try { return await decodeToBitmap(fetchUrl); }
      catch (e) { return await bitmapFromElement(el); }
    }
    // 1. crossOrigin image load (unblocked by the DNR ACAO rule).
    try {
      const im = new Image();
      im.crossOrigin = "anonymous";
      return await new Promise((resolve, reject) => {
        im.onload = () => resolve(createImageBitmap(im));
        im.onerror = () => reject(new Error("crossOrigin load failed"));
        im.src = fetchUrl;
      });
    } catch (e) { /* fall through */ }
    // 2. Background fetch (extension context, host-permission CORS bypass).
    try {
      const dataUrl = await crossFetch(fetchUrl);
      return await decodeToBitmap(dataUrl);
    } catch (e) { /* fall through */ }
    // 3. Last resort: the live element's own decoded pixels.
    return bitmapFromElement(el);
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
  // Raw mask labels: 0=background, 1=person-non-skin, 2=skin.
  // When skinOnly is true, only skin pixels (2) are masked.
  function buildMaskAlpha(entry) {
    if (!entry.raw) return new Uint8Array(entry.w * entry.h);
    const threshold = skinOnly ? 2 : 1;
    const binary = new Uint8Array(entry.raw.length);
    for (let i = 0; i < entry.raw.length; i++) {
      binary[i] = entry.raw[i] >= threshold ? 255 : 0;
    }
    const scale = Math.min(1, MAX_SEG_DIM / Math.max(entry.w, entry.h));
    const iw = Math.max(1, Math.round(entry.w * scale));
    const ih = Math.max(1, Math.round(entry.h * scale));
    const aspectFixed = (entry.sw === iw && entry.sh === ih)
      ? binary
      : profile("mask.aspectFix", () => upscaleMask(binary, entry.sw, entry.sh, iw, ih));
    const processed = profile("mask.dilateBlur", () => processRawMask(aspectFixed, iw, ih));
    return profile("mask.upscale", () => upscaleMask(processed, iw, ih, entry.w, entry.h));
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

  // Segment in the offscreen doc. For normal http(s) URLs, send just the URL
  // and let the offscreen page fetch + downscale full-res (sharper input). For
  // blob:/data: URLs it can't fetch, downscale here and send the pixels.
  // Encode the already-decoded bitmap to a downscaled base64 payload for the
  // offscreen doc. Used as the fallback when the URL fast-path fails.
  function encodePixels(bitmap) {
    return profile("seg.encode", () => {
      // Cap the SHORT side at MAX_SEG_DIM (not the long side) so wide/tall
      // images keep detail on their short axis instead of being crushed
      // (a 4.5:1 banner capped long-side would be 256x57). Also bound total
      // pixels so an extreme aspect ratio can't blow up the base64 payload
      // sent across the bridge.
      const MAX_SEG_PIXELS = MAX_SEG_DIM * MAX_SEG_DIM * 4; // ~4x a square 256
      let scale = Math.min(1, MAX_SEG_DIM / Math.min(bitmap.width, bitmap.height));
      if (bitmap.width * bitmap.height * scale * scale > MAX_SEG_PIXELS) {
        scale = Math.sqrt(MAX_SEG_PIXELS / (bitmap.width * bitmap.height));
      }
      const sw = Math.max(1, Math.round(bitmap.width * scale));
      const sh = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, sw, sh);
      const pixels = ctx.getImageData(0, 0, sw, sh).data;
      return { pixelsB64: bytesToBase64(new Uint8Array(pixels.buffer)), w: sw, h: sh };
    });
  }

  async function segment(fetchUrl, bitmap) {
    // Ask the offscreen doc to segment `payload` and decode its raw-mask reply.
    const requestSeg = async (payload) => {
      const resp = await profileAsync("seg.roundtrip", () => bridgeRequest("mastir-segment", payload, 20000));
      if (resp.error) throw new Error(resp.error);
      const raw = profile("seg.decode", () => resp.rawB64 ? base64ToBytes(resp.rawB64) : null);
      return { raw, sw: resp.w, sh: resp.h };
    };
    // Fast path: for http(s) URLs, let the offscreen doc fetch full-res itself
    // (sharper mask, no bridge transfer). If that fails — e.g. the offscreen's
    // fetch hits CORS on an image whose bytes we ALREADY have in `bitmap` (wiki
    // images that 302 to origin-locked S3, which our background fetch got past)
    // — fall back to shipping the decoded pixels across the bridge.
    if (/^https?:/.test(fetchUrl)) {
      try {
        return await requestSeg({ url: fetchUrl });
      } catch (e) {
        console.debug("[mastir] URL segment failed, retrying with pixels:", e.message);
      }
    }
    return requestSeg(encodePixels(bitmap));
  }

  const IMG_URL_ATTR_RE = /\.(jpe?g|png|webp|avif|bmp)(\?|$)/i;

  // Find the best image URL stored in any attribute. Covers two off-spec cases
  // with one generic scan, no attribute-name allowlist:
  //  - custom elements holding a src off-spec (<adbl-full-bleed-image
  //    landscape-src="…">), and
  //  - lazy-load plugins (WP LazyLoad, WP-Rocket, UAGB) parking the real image
  //    in data-lazy-src / data-lazy-srcset / data-src / etc. while src shows a
  //    transparent placeholder.
  // Each attribute value is parsed as a srcset-style list (a bare URL is just a
  // one-candidate list), so the LARGEST variant wins — segmenting a small
  // thumbnail yields a coarse blob mask. URLs are resolved to absolute, since
  // lazy attributes are frequently relative.
  function attrImageUrl(el) {
    let best = null;
    for (const attr of el.attributes) {
      if (!attr.value) continue;
      for (const cand of attr.value.split(",")) {
        const [url, d] = cand.trim().split(/\s+/);
        if (!url || url.startsWith("data:") || !IMG_URL_ATTR_RE.test(url)) continue;
        const w = parseFloat(d) || 0;
        if (!best || w > best.w) best = { url, w };
      }
    }
    if (!best) return null;
    try { return new URL(best.url, location.href).href; }
    catch (e) { return null; }
  }

  // Compare two image URLs by their resolved absolute form, so a relative src
  // ("/path.png") and its absolute equivalent ("https://host/path.png") — the
  // same image — compare equal. Falls back to raw equality for unresolvable
  // (blob:/data:) URLs.
  function sameUrl(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try { return new URL(a, location.href).href === new URL(b, location.href).href; }
    catch (e) { return false; }
  }

  function getImageUrl(el) {
    if (el.tagName === "VIDEO") {
      return el.getAttribute("poster") || null;
    }
    // Prefer a real http(s)/blob source over a tiny data:-URI placeholder that
    // some sites (e.g. Google Images) show in currentSrc while the real image
    // lazy-loads. currentSrc reflects what's *displayed* (often the placeholder),
    // but el.src / the src attribute frequently already holds the real URL.
    const isReal = (u) => !!u && !u.startsWith("data:") && !u.includes(" ");
    if (isReal(el.currentSrc)) return el.currentSrc;
    const imageSrc = el.getAttribute("image-src");
    if (imageSrc) return imageSrc;
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      // Pick the largest candidate (highest descriptor), skipping data: URIs.
      const best = srcset.split(",")
        .map((c) => c.trim())
        .map((c) => { const [url, d] = c.split(/\s+/); return { url, w: parseFloat(d) || 0 }; })
        .filter((c) => c.url && !c.url.startsWith("data:"))
        .sort((a, b) => b.w - a.w)[0];
      if (best) return best.url;
    }
    // The src attribute may hold the real URL even when currentSrc is a
    // placeholder — check el.src and the raw attribute, not currentSrc.
    if (isReal(el.src)) return el.src;
    const srcAttr = el.getAttribute("src");
    if (isReal(srcAttr)) return srcAttr;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match) return match[1];
    }
    // Generic scan of every attribute for an image URL — covers custom-element
    // src attributes AND lazy-load plugins (data-lazy-src/-srcset, data-src),
    // picking the largest srcset variant and resolving relative URLs.
    const attrUrl = attrImageUrl(el);
    if (attrUrl) return attrUrl;
    // Last resort: a data:-URI placeholder is still a real, viewable image —
    // segment its pixels rather than skipping the element entirely.
    return el.currentSrc || el.src || null;
  }

  // Mark an image resolved without a mask. keepBlur=true leaves it fully
  // blurred (fail-safe for images we couldn't inspect — 404/CORS/decode — so we
  // never reveal something unexamined). keepBlur=false reveals per the global
  // preference (SVG/GIF/tiny images that are safe to show).
  function markDone(img, keepBlur = false, reason = "") {
    if (MASTIR_PROFILE) {
      const u = (getImageUrl(img) || img.currentSrc || img.src || "").slice(0, 90);
      mlog(`[mastir:skip] markDone keepBlur=${keepBlur} reason=${reason} nat=${img.naturalWidth}x${img.naturalHeight} ${u}`);
    }
    segProcessed.add(img);
    segMaskCache.set(img, { originalPixels: null, maskAlpha: new Uint8Array(0), raw: null, sw: 0, sh: 0, w: 0, h: 0 });
    segAllElements.add(img);
    if (keepBlur) {
      // Latch permanent blur — applyBlur (runs on every mutation) must not
      // reset this to the revealed state, since we couldn't inspect the image.
      img.__mastirForceBlur = true;
      img.style.setProperty("filter", MAX_BLUR, "important");
    } else {
      img.style.setProperty("filter", buildFilter(!blurOff), "important");
    }
  }

  async function processImage(img) {
    if (segProcessed.has(img)) return;
    if (isVideoIframe(img)) { segProcessed.add(img); return; }
    // A result is safe to apply only if it's still the newest run for this
    // element AND the element still displays the URL we segmented. Instagram
    // Feed churns src webp<->placeholder rapidly, so segmentations finish out of
    // order and for URLs the element no longer shows. Returns true (and handles
    // re-triggering) when this run must NOT apply its result:
    //  - gen bumped: a newer run was enqueued (urlSwapObserver clears
    //    segProcessed + re-enqueues on a swap) — it will apply; we just drop.
    //  - url changed but gen same: the swap didn't re-enqueue (dedup/selfUpdating
    //    collapsed it), so nothing else will fix this element — re-enqueue it.
    const gen = img.__mastirGen;
    const isStale = (fetchUrl) => {
      if (img.__mastirGen !== gen) return true;
      if (fetchUrl !== undefined && !sameUrl(getImageUrl(img), fetchUrl)) {
        segProcessed.delete(img);
        enqueueImage(img);
        return true;
      }
      return false;
    };
    const imageSrcAttr = img.getAttribute("image-src");
    // `src` is what's DISPLAYED (currentSrc/img.src, may be a data:-URI
    // placeholder) — used for the SVG check and as the restore point. It
    // deliberately differs from the `fetchUrl` below (getImageUrl prefers a real
    // http(s) URL to actually segment); don't collapse the two.
    const src = img.tagName === "VIDEO"
      ? getImageUrl(img)
      : (imageSrcAttr || img.currentSrc || img.src || getImageUrl(img));
    if (!src) { mlog("[mastir:skip] no src"); return; }
    if (img.tagName === "IMG" && !imageSrcAttr) {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        mlog(`[mastir:skip] not decoded (nat 0), waiting for load: ${src.slice(0, 90)}`);
        img.addEventListener("load", () => enqueueImage(img), { once: true });
        return;
      }
      if (img.naturalWidth < 48 || img.naturalHeight < 48) {
        // A tiny NATURAL size can mean two very different things:
        //  - a genuine small icon (favicon, avatar) — safe to reveal, and
        //  - a not-yet-loaded placeholder (Google's deferred grid images sit at
        //    1x1 until scrolled near, then load real bytes IN PLACE without
        //    changing src — so urlSwapObserver never re-fires).
        // Tell them apart by the RENDERED box: a real icon is laid out small,
        // a placeholder for a grid photo is laid out large. If it's displayed
        // large, leave it blurred and re-process on load rather than revealing
        // it permanently.
        if (img.offsetWidth >= 48 && img.offsetHeight >= 48) {
          mlog(`[mastir:skip] tiny natural (${img.naturalWidth}x${img.naturalHeight}) but rendered ${img.offsetWidth}x${img.offsetHeight} — placeholder, waiting for load: ${src.slice(0, 90)}`);
          img.addEventListener("load", () => enqueueImage(img), { once: true });
          return;
        }
        // naturalWidth can be STALE right after a src swap: it keeps reporting
        // the PREVIOUS decode's size (e.g. a 1x1 placeholder) until the new bytes
        // decode. urlSwapObserver re-enqueues the instant src changes, so we can
        // arrive here before the real image has decoded and wrongly judge a
        // full-size photo as a tiny icon (Outlook re-vends blob: URLs this way,
        // and markDone would reveal the person permanently). decode() resolves
        // only once the CURRENT src is decoded — recheck the size after it, and
        // re-segment if it turns out to be full-size after all.
        try { await img.decode(); } catch (e) { /* undecodable — fall through */ }
        if (img.naturalWidth >= 48 && img.naturalHeight >= 48) {
          mlog(`[mastir:skip] tiny was stale — decoded to ${img.naturalWidth}x${img.naturalHeight}, re-segmenting: ${src.slice(0, 90)}`);
          enqueueImage(img);
          return;
        }
        markDone(img, false, "tiny");
        return;
      }
    }

    segProcessed.add(img);

    // SVGs are vector (no photographic people) and safe to reveal without
    // segmenting. GIFs are raster and CAN contain people, so they go through
    // normal segmentation (first frame) rather than being blanket-revealed.
    // Test the URL we'd actually SEGMENT, not the displayed `src`: lazy-load
    // plugins set src to an inline SVG placeholder while the real raster image
    // waits in srcset/data-src, and testing src would reveal that photo as a
    // bogus "vector" (getImageUrl already skips data: placeholders).
    const svgUrl = getImageUrl(img) || src;
    if (/\.svg(\?|$)/i.test(svgUrl) || /^data:image\/svg/i.test(svgUrl)) {
      markDone(img, false, "svg");
      return;
    }
    segOriginalSrc.set(img, src);

    try {
      const fetchUrl = getImageUrl(img);
      if (!fetchUrl) { mlog("[mastir:skip] no fetchUrl"); return; }
      // Record the exact URL we segment, so urlSwapObserver can tell a genuine
      // content swap (re-segment) from benign churn of the same URL.
      segFetchUrl.set(img, fetchUrl);

      if (segUrlCache.has(fetchUrl)) {
        const cached = segUrlCache.get(fetchUrl);
        // Superseded (newer run) or the element no longer shows this url — drop.
        if (isStale(fetchUrl)) {
          mlog(`[mastir:skip] stale before cache-apply, dropping ${fetchUrl.slice(0, 60)}`);
          return;
        }
        mlog(`[mastir:skip] URL-cache hit hasPerson=${cached.hasPerson} ${fetchUrl.slice(0, 90)}`);
        const entry = { originalPixels: cached.originalPixels.slice(), raw: cached.raw, sw: cached.sw, sh: cached.sh, w: cached.w, h: cached.h };
        entry.maskAlpha = buildMaskAlpha(entry);
        segMaskCache.set(img, entry);
        segAllElements.add(img);
        applyMask(img);
        return;
      }

      const bitmap = await acquireBitmap(fetchUrl, img);

      const { raw, sw, sh } = await segment(fetchUrl, bitmap);
      const w = bitmap.width, h = bitmap.height;
      if (MASTIR_PROFILE) {
        let personPx = 0;
        if (raw) for (let i = 0; i < raw.length; i++) if (raw[i] > 0) personPx++;
        mlog(`[mastir] seg  bitmap=${w}x${h}  mask=${sw}x${sh}  person=${personPx}/${raw ? raw.length : 0}  ${fetchUrl.slice(0, 90)}`);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const originalPixels = canvas.getContext("2d").getImageData(0, 0, w, h).data.slice();

      const cacheEntry = { originalPixels, raw, sw, sh, w, h };
      cacheEntry.maskAlpha = buildMaskAlpha(cacheEntry);
      // Cache the result by URL regardless — it's valid for that URL and reused
      // if the element (or another) shows it again.
      segUrlCache.set(fetchUrl, cacheEntry);

      // Superseded (newer run) or the element no longer shows this url while
      // segmentation was in flight. The URL cache above keeps our result for
      // reuse, but don't apply it here — the current generation / current url
      // will. Closes the completion-ordering race per-URL guards alone can't.
      if (isStale(fetchUrl)) {
        mlog(`[mastir:skip] stale mid-segment, dropping ${fetchUrl.slice(0, 60)}`);
        return;
      }

      segMaskCache.set(img, cacheEntry);
      segAllElements.add(img);
      applyMask(img);
    } catch (e) {
      console.warn("[mastir] processImage failed:", e.message, src?.substring(0, 80));
      // Unreadable-by-script: give up immediately and KEEP the pre-blur — never
      // reveal an image we couldn't inspect. HTTP 4xx (404/403/410) are dead or
      // forbidden URLs; CORS/decode failures won't change on retry either.
      if (/CORS|blocked|decode failed|blob load failed|HTTP 4\d\d|context invalidated/i.test(e.message)) {
        markDone(img, true, "unreadable:" + e.message.slice(0, 30));
      } else if (/SVG|natural dimensions|createImageBitmap|Assertion/i.test(e.message)) {
        // Benign non-images (SVG/GIF/undecodable vector) — safe to reveal.
        markDone(img, false, "benign:" + e.message.slice(0, 30));
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

  // We only segment the poster frame, never playback — so a playing video is
  // always fully blurred, regardless of what the poster segmentation decided.
  // Attached at discovery time (before segmentation) so no play() can slip
  // through unblurred. When paused/ended, restore whatever filter is on the
  // element (the poster decision from applyMask, or the pre-blur if not yet
  // processed).
  // Only the pristine poster frame is segmented. The instant a video plays,
  // every subsequent frame — including any paused mid-video frame — is
  // unsegmented and could contain a person, so we blur permanently on first
  // play and never restore. (The poster's reveal/mask decision only applies
  // before playback.) Latching this way also avoids the blur flashing on/off
  // as players cycle play/pause/buffer events.
  function watchVideoPlayback(video) {
    if (video.__mastirPlaybackWatched) return;
    video.__mastirPlaybackWatched = true;
    const blurForever = () => {
      video.__mastirPlayed = true;
      video.style.setProperty("filter", MAX_BLUR, "important");
    };
    video.addEventListener("play", blurForever);
    video.addEventListener("playing", blurForever);
    video.addEventListener("timeupdate", () => { if (video.currentTime > 0) blurForever(); });
    if (!video.paused || video.currentTime > 0) blurForever();
  }

  // Paint the masked result as a positioned overlay over the element — used
  // for images we can't repaint in place (direct-view IMG, shadow-DOM custom
  // elements, churning images). All styling via CSSOM (setProperty), which
  // CSP style-src does not govern — so this works under strict CSP too.
  //
  // The overlay is inserted as a SIBLING of the element and absolutely
  // positioned to the element's own box (offsetLeft/Top/Width/Height), with the
  // element's existing parent made position:relative to serve as the containing
  // block. We deliberately do NOT wrap/reparent the element: a wrapper changes
  // the element's position in the DOM tree, which breaks any structural CSS the
  // page uses to size it (`.container > img`, flex/grid child participation,
  // :first-child, …) and blows its layout up. Sizing to the element's own box
  // (not the parent's) keeps a small icon in a large grid cell from ballooning,
  // and handles a grid of images sharing one parent — each overlay lands on its
  // own image's sub-rectangle. A ResizeObserver re-syncs on reflow, since
  // absolute positioning (unlike flow) doesn't track the element automatically.
  function syncOverlay(el, overlay) {
    overlay.style.setProperty("left", `${el.offsetLeft}px`, "important");
    overlay.style.setProperty("top", `${el.offsetTop}px`, "important");
    overlay.style.setProperty("width", `${el.offsetWidth}px`, "important");
    overlay.style.setProperty("height", `${el.offsetHeight}px`, "important");
  }

  function paintOverlay(el, dataUrl) {
    let overlay = el.__mastirOverlay;
    if (!overlay) {
      // An SVG <image> lives in the SVG coordinate model, not HTML flow: an HTML
      // wrapper/overlay can't participate in its viewBox mapping or clip-path and
      // just breaks the element's layout. Overlay it the SVG-native way instead —
      // append a sibling <image> in the same coordinate space, reusing the
      // original's geometry and clip-path so the mask lands pixel-aligned and
      // identically clipped. Later siblings paint on top in document order, so no
      // z-index is needed.
      if (el instanceof SVGImageElement) {
        const parent = el.parentNode;
        if (!parent) return;
        overlay = document.createElementNS("http://www.w3.org/2000/svg", "image");
        overlay.__mastirIsOverlay = true; // exclude from our own scan/pre-blur
        for (const attr of ["x", "y", "width", "height", "preserveAspectRatio", "clip-path"]) {
          const v = el.getAttribute(attr);
          if (v != null) overlay.setAttribute(attr, v);
        }
        el.__mastirOverlay = overlay;
        parent.insertBefore(overlay, el.nextSibling);
        overlay.setAttribute("href", dataUrl);
        return;
      }
      const parent = el.parentElement;
      if (!parent) return;
      const cs = getComputedStyle(el);
      // The overlay's containing block must be a positioned ancestor. Promote the
      // element's existing parent to position:relative if it's static — without
      // reparenting the element, so the page's structural sizing CSS keeps
      // matching. (If already positioned, leave it: offsetLeft/Top are relative
      // to it either way.)
      if (getComputedStyle(parent).position === "static") {
        parent.style.setProperty("position", "relative", "important");
      }

      // Use an <img>, not a div background-image: background-images get a fast
      // low-quality scale on first paint and a deferred high-quality re-raster,
      // which reads as a colored-but-blurry mask that snaps sharp a beat later.
      // An <img> uses the normal decode+scale path (same as in-place painting,
      // which never flashes), so the overlay lands sharp.
      overlay = document.createElement("img");
      overlay.__mastirIsOverlay = true; // exclude from our own scan/pre-blur
      // Set every layout-critical prop with !important: page/theme `img {...!important}`
      // rules match our overlay too and would otherwise override position/size.
      // Inherit object-fit/position from the element so contain-vs-cover matches
      // and the mask aligns with how the page actually renders the image.
      const s = {
        position: "absolute",
        "pointer-events": "none",
        "object-fit": cs.objectFit, "object-position": cs.objectPosition,
        "z-index": "1", filter: "none",
      };
      for (const [k, v] of Object.entries(s)) overlay.style.setProperty(k, v, "important");
      syncOverlay(el, overlay);
      el.__mastirOverlay = overlay;
      // Re-sync the overlay to the element's box whenever it reflows (responsive
      // breakpoints, window resize). Absolute positioning doesn't track flow.
      new ResizeObserver(() => syncOverlay(el, overlay)).observe(el);
      parent.insertBefore(overlay, el.nextSibling);
    }
    if (overlay instanceof SVGImageElement) overlay.setAttribute("href", dataUrl);
    else overlay.src = dataUrl;
  }

  function applyMask(img) {
    const cached = segMaskCache.get(img);
    if (!cached || !cached.originalPixels) return;
    const { originalPixels, maskAlpha, w, h } = cached;
    // DIAGNOSTIC: count how many times applyMask paints each element and with
    // what mask coverage. Two paints with different coverage => double-segment
    // (coarse then refined). One paint => the blob is final / cause is elsewhere.
    if (MASTIR_PROFILE) {
      let personPx = 0;
      for (let i = 0; i < maskAlpha.length; i++) if (maskAlpha[i] > 0) personPx++;
      img.__mastirPaintN = (img.__mastirPaintN || 0) + 1;
      const cov = maskAlpha.length ? ((personPx / maskAlpha.length) * 100).toFixed(1) : "0";
      mlog(`[mastir:paint] #${img.__mastirPaintN} ${img.tagName} seg=${w}x${h} coverage=${cov}% url=${(segFetchUrl.get(img) || "").slice(0, 70)}`);
    }
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
    cached.hasPerson = didPaint;
    // The poster-decision filter (global blur/grayscale pref, "none" at
    // defaults). For a video, only a pristine poster (never played, still at
    // frame 0) may be revealed — once it has played, it's latched to MAX_BLUR,
    // because playback frames past the poster are never segmented.
    const finalFilter = (img.tagName === "VIDEO" && (img.__mastirPlayed || !img.paused || img.currentTime > 0))
      ? MAX_BLUR : buildFilter(!blurOff);
    if (didPaint) {
      const dataUrl = profile("paint.toDataURL", () => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
        return canvas.toDataURL("image/png");
      });
      // When the PAGE owns src (a lazy-loader will keep writing it), painting
      // into src is a war we can't win — the loader swaps its real/placeholder
      // URL back in and reveals the person until srcObserver reacts a frame
      // later. Detect this up front (lazy-* attrs present, or src is still a
      // transparent data: placeholder while we segmented a real image) and paint
      // as an OVERLAY instead: the mask sits on top and src can churn freely
      // underneath. Makes what's displayed match what we segmented, structurally.
      const displayed = img.currentSrc || img.src || "";
      const pageOwnsSrc = img.hasAttribute("data-lazy-src") || img.hasAttribute("data-src") ||
        img.hasAttribute("data-lazy-srcset") || img.hasAttribute("data-srcset") ||
        displayed.startsWith("data:");
      if (pageOwnsSrc) img.__mastirOverlayPaint = true;
      // Decode the concealed PNG off-screen BEFORE swapping it in and lifting
      // the blur. Otherwise the filter clears synchronously while the OLD real
      // pixels are still on screen (src/background decode async) — a brief
      // sharp reveal, worst on large images that decode slowest. Swapping and
      // un-blurring only after decode makes the reveal atomic.
      const swap = () => {
        if ((img.tagName === "IMG" && isDirectImageView) || img.__mastirOverlayPaint) {
          paintOverlay(img, dataUrl);
        } else if (img.tagName === "IMG") {
          selfUpdating = true;
          const picture = img.closest("picture");
          if (picture) picture.querySelectorAll("source").forEach((s) => s.remove());
          img.removeAttribute("srcset");
          img.src = dataUrl;
          img.__mastirPaintedSrc = dataUrl;
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
        img.style.setProperty("filter", finalFilter, "important");
      };
      const decoder = new Image();
      decoder.onload = decoder.onerror = swap;
      decoder.src = dataUrl;
    } else {
      if (img.tagName === "IMG" && img.src !== segOriginalSrc.get(img) &&
          segOriginalSrc.has(img) && !segOriginalSrc.get(img).startsWith("blob:")) {
        // No person found: restore the original src ONLY if we actually changed
        // it and the original is still valid. Never rewrite to a blob: URL — the
        // page may have revoked it (e.g. Tableau tiles), which would blank the
        // image. In the normal no-person flow src was never touched, so this is
        // usually a no-op.
        selfUpdating = true;
        img.src = segOriginalSrc.get(img);
        selfUpdating = false;
      }
      img.style.setProperty("filter", finalFilter, "important");
    }
    // Observe src changes on every segmented image, not just painted ones —
    // a revealed (no-person) thumbnail can later have its src swapped to new
    // content (e.g. YouTube's animated hover preview), which must be re-blurred
    // and re-segmented rather than left revealed.
    if (img.tagName === "IMG" && !img.__mastirOverlayPaint) observeSrc(img);
  }

  // Segmentation queue with a small worker pool. Each roundtrip to the offscreen
  // doc is GPU-bound and slow (~100ms+), so we cap concurrency to avoid flooding
  // the bridge; images past the cap wait in segQueue until a worker frees up.
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

  // Known-animated image URLs (YouTube's `an_webp` hover previews and
  // `_<N>s.webp` animated thumbnails) are moving content we can only segment
  // one frame of — a person could appear later — so treat them like video:
  // keep permanently blurred, never segment or reveal.
  // NOTE: .gif is intentionally NOT matched here — most GIFs are static (e.g.
  // product/book covers) and blurring them all is wrong. A GIF goes through
  // normal segmentation on its first frame like any other image.
  const ANIMATED_IMG_RE = /\/an_webp\/|_\d+s\.webp/i;
  function isAnimatedImageUrl(url) {
    return !!url && ANIMATED_IMG_RE.test(url);
  }

  function enqueueImage(img) {
    if (img.__mastirIsOverlay) return; // our own concealment overlay, never segment it
    if (segMaskCache.has(img) || segQueue.includes(img) || segProcessed.has(img)) return;
    if (img.tagName === "IMG" && isAnimatedImageUrl(getImageUrl(img))) {
      segProcessed.add(img);
      blurElement(img);
      return;
    }
    // Bump a per-image generation token on every (re)enqueue. processImage
    // captures it at start and only applies its result if the token is still
    // current — so when a churning lazy-load src (Instagram Feed swaps
    // webp<->placeholder rapidly) re-enqueues an image, a slower in-flight
    // segmentation that finishes LATER can't clobber the newest one. Closes the
    // completion-ordering race that per-URL guards can't (both may pass their
    // URL check yet still apply out of order).
    img.__mastirGen = (img.__mastirGen || 0) + 1;
    segQueue.push(img);
    processQueue();
  }


  const SKIP_BG_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "BR", "HR", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "SVG", "PATH", "IMG"]);

  // Resolve a non-img element's background image and enqueue it for masking.
  // Returns true once handled (or watched for a later lazy-bg), false if the
  // element has no usable background and isn't worth watching.
  function handleBgElement(el) {
    if (segProcessed.has(el) || segMaskCache.has(el)) return true;
    if (el.offsetWidth < 48 || el.offsetHeight < 48) return true;
    const bg = getComputedStyle(el).backgroundImage;
    const match = bg && bg !== "none" ? bg.match(/url\(["']?([^"')]+)["']?\)/) : null;
    let url = match ? match[1] : null;
    // Only fall back to an attribute-stored URL (data-png, landscape-src,
    // etc.) when the element ISN'T just a container around a real <img>.
    // Grid cells like flaticon's <li data-png="…512/….png"> hold the icon
    // URL in an attribute but render it via a child <img> that we already
    // segment — treating the <li> as an image too paints a cover-sized
    // overlay over the whole cell and blows the layout up.
    if (!url && !el.querySelector("img, image, [image-src]")) url = attrImageUrl(el);
    if (!url) {
      // No background yet. A lazy-bg plugin (WP-Rocket) applies the
      // background-image AFTER this one-shot intersection check and flips its
      // data-rocket-lazy-bg-* attr to "loaded". Watch this element's attributes
      // so we re-check once the real background lands, instead of discarding it
      // and leaving it permanently revealed.
      if (!el.__mastirBgWatched) {
        el.__mastirBgWatched = true;
        bgSwapObserver.observe(el, { attributes: true });
      }
      return false;
    }
    if (/\.(svg|gif)(\?|$)/i.test(url)) return true;
    // Custom elements that render their image in shadow DOM can't be
    // repainted via a host background — flag them for an overlay.
    if (!match) el.__mastirOverlayPaint = true;
    blurElement(el);
    enqueueImage(el);
    return true;
  }

  // Re-check an element whose background arrived after its intersection check.
  // Debounced on settle (lazy-bg plugins flip several attrs in a burst).
  const bgSettleTimers = new WeakMap();
  const bgSwapObserver = new MutationObserver((mutations) => {
    profile("obs.bgSwap", () => {
      for (const m of mutations) {
        if (m.type !== "attributes") continue;
        const el = m.target;
        if (segProcessed.has(el) || segMaskCache.has(el)) continue;
        // Blur IMMEDIATELY once a background image actually appears, before the
        // settle debounce. The element wasn't pre-blurred (it had no inline
        // background at discovery), so a lazy-bg plugin injecting the real image
        // would otherwise show it unconcealed for the whole SWAP_SETTLE_MS
        // window. Two guards:
        //  - a URL must be present: these watched elements are often plain
        //    layout containers (even <body>, which AOS mutates on scroll), and
        //    blurring one with no image blurs all its descendants (whole page).
        //  - blur AT MOST ONCE: blurElement writes el.style, itself an attribute
        //    mutation that re-fires this observer — an unguarded blur would loop
        //    and keep clearing the settle timer so handleBgElement never runs.
        //    handleBgElement/applyMask takes over the filter after settle.
        if (!el.__mastirBgBlurred) {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== "none" && /url\(/.test(bg)) {
            el.__mastirBgBlurred = true;
            blurElement(el);
          }
        }
        clearTimeout(bgSettleTimers.get(el));
        bgSettleTimers.set(el, setTimeout(() => {
          bgSettleTimers.delete(el);
          // Idempotent: handleBgElement early-returns once processed/cached, so
          // leaving the observer attached (like urlSwapObserver) is harmless.
          handleBgElement(el);
        }, SWAP_SETTLE_MS));
      }
    });
  });

  const visibilityObserver = new IntersectionObserver((entries) => {
    profile("obs.intersection", () => {
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
        handleBgElement(el);
      }
    }
    });
  });

  function observeElement(el) {
    if (segProcessed.has(el) || segMaskCache.has(el)) return;
    if (el.tagName === "IMG" || el.hasAttribute("image-src") || !SKIP_BG_TAGS.has(el.tagName)) {
      visibilityObserver.observe(el);
    }
    // Watch <img> src swaps (placeholder -> real URL) so lazy-loaded images get
    // re-segmented once their real source lands, regardless of processing order.
    if (el.tagName === "IMG" && !el.__mastirUrlSwapWatched) {
      el.__mastirUrlSwapWatched = true;
      observeUrlSwap(el);
    }
  }

  function runSegmentation() {
    document.querySelectorAll("img").forEach(observeElement);
    document.querySelectorAll("[image-src]").forEach(observeElement);
    document.querySelectorAll("video[poster]").forEach(observeElement);
  }

  // Eagerly segment every image, not just the ones scrolled into view. The
  // visible ones are already enqueued by the IntersectionObserver, so this just
  // drains the offscreen remainder in the background. Matters for Chrome's
  // Reading Mode: it distills the tab's LIVE DOM into a browser-internal panel
  // extensions can't touch — images we've already masked carry over (their src
  // is our painted data-URL), unprocessed ones appear unconcealed. Runs on
  // idle, a few seconds after load, so visible images always get first turn.
  function eagerSegmentAll() {
    document.querySelectorAll("img, video[poster]").forEach((el) => {
      if (segProcessed.has(el) || segMaskCache.has(el)) return;
      enqueueImage(el);
    });
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
      // A played video is latched to MAX_BLUR — don't reset it here (applyBlur
      // runs on every DOM mutation, which would fight the playback blur).
      if (el.tagName === "VIDEO" && el.__mastirPlayed) return;
      // Unreadable images (404/CORS) are force-blurred and must never be
      // revealed by a mutation-driven applyBlur pass.
      if (el.__mastirForceBlur) return;
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
      const skinChanged = e.data.skinOnly !== undefined && e.data.skinOnly !== skinOnly;
      if (e.data.skinOnly !== undefined) skinOnly = e.data.skinOnly;
      if (e.data.blurAmount !== undefined) { blurAmount = e.data.blurAmount; blurOff = blurAmount === 0; }
      if (e.data.blurOff !== undefined) blurOff = e.data.blurOff;
      const maskChanged = (e.data.maskBlur !== undefined && e.data.maskBlur !== maskBlur) ||
        (e.data.maskExpand !== undefined && e.data.maskExpand !== maskExpand);
      if (e.data.maskBlur !== undefined) { maskBlur = e.data.maskBlur; blurSpans = circleRowSpans(maskBlur); }
      if (e.data.maskExpand !== undefined) { maskExpand = e.data.maskExpand; expandSpans = circleRowSpans(maskExpand); }
      applyBlur();
      if (maskChanged || skinChanged) reprocessMasks();
      broadcastState();
    }
  });

  // Watch for external JS (e.g. Amazon carousels) overwriting src on images
  // we've masked. On the first couple of overwrites we re-mask in place; if it
  // keeps churning we switch the image to overlay mode — restore its real src
  // and paint the mask as an overlay on top, so the page can rewrite src
  // freely without fighting us.
  const srcReapplyCount = new WeakMap();
  const srcReapplyPending = new WeakSet();
  const MAX_INPLACE_REAPPLIES = 2;
  let selfUpdating = false;

  const srcObserver = new MutationObserver((mutations) => {
    if (selfUpdating) return;
    profile("obs.srcReapply", () => {
      for (const m of mutations) {
        if (m.type !== "attributes") continue;
        const img = m.target;
        if (img.__mastirOverlayPaint) continue; // already overlay-mode
        if (!segMaskCache.has(img)) continue;
        const current = img.src || "";
        // Skip only OUR OWN painted mask — not every data: URL. A lazy-loader
        // (WP LazyLoad on UAGB blocks) swaps src back to its transparent data:
        // placeholder AFTER we paint, clobbering the mask; that foreign data:
        // must fall through to the reapply/overlay path below, or the image is
        // left revealed. getImageUrl resolves the real image from data-lazy-*.
        if (current === img.__mastirPaintedSrc) continue;

        // Src swapped to an animated image (e.g. YouTube's hover preview over a
        // revealed thumbnail) — moving content we can't fully segment. Blur it
        // permanently and stop observing; don't reapply the stale mask.
        if (isAnimatedImageUrl(current)) {
          img.style.setProperty("filter", MAX_BLUR, "important");
          srcObserver.unobserve(img);
          continue;
        }

        const cached = segMaskCache.get(img);
        if (!cached || !cached.originalPixels) continue;
        if (!cached.hasPerson) continue;
        img.style.setProperty("filter", MAX_BLUR, "important");
        if (srcReapplyPending.has(img)) continue;
        const count = srcReapplyCount.get(img) || 0;
        srcReapplyPending.add(img);
        srcReapplyCount.set(img, count + 1);
        requestAnimationFrame(() => {
          srcReapplyPending.delete(img);
          if (!segMaskCache.has(img)) return;
          // Escalate to overlay when we've lost the src war too many times, OR
          // the page reset src to a data: placeholder (a lazy-loader owns src
          // and will keep clobbering an in-place mask — we can never win by
          // rewriting src, so paint on top immediately). Overlay uses the
          // segmented real image, so the person stays concealed regardless.
          if (count >= MAX_INPLACE_REAPPLIES || (img.src || "").startsWith("data:")) {
            img.__mastirOverlayPaint = true;
            srcObserver.unobserve(img);
            img.style.setProperty("filter", buildFilter(!blurOff), "important");
            selfUpdating = true;
            applyMask(img);
            selfUpdating = false;
          } else {
            selfUpdating = true;
            applyMask(img);
            selfUpdating = false;
          }
        });
      }
    });
  });

  function observeSrc(img) {
    srcReapplyCount.set(img, 0);
    srcObserver.observe(img, { attributes: true, attributeFilter: ["src", "srcset"] });
  }

  // Watches EVERY discovered image for its src becoming a real (http/blob) URL.
  // Lazy-loading sites (Google Images, infinite-scroll grids, SPAs) often mount
  // an <img> with only a tiny data:-URI placeholder, then swap in the real URL
  // asynchronously. If we happened to process the element while it still had the
  // placeholder, we segmented the wrong (tiny) image or bailed — this re-runs
  // segmentation once the real URL lands, closing that timing race.
  //
  // React on SETTLE, not on every write. Lazy-load plugins (Instagram Feed)
  // churn src rapidly — real webp -> placeholder.png -> webp — within a few ms.
  // Segmenting mid-churn processes a transient URL (the placeholder: no person,
  // reveals) and the guards can't tell it from real content. So debounce per
  // element and only act once writes go quiet, reading what's ACTUALLY
  // displayed then. Pre-blur means nothing is revealed during the settle window.
  const swapSettleTimers = new WeakMap();
  const SWAP_SETTLE_MS = 500;
  const urlSwapObserver = new MutationObserver((mutations) => {
    if (selfUpdating) return;
    profile("obs.urlSwap", () => {
      for (const m of mutations) {
        if (m.type !== "attributes") continue;
        const img = m.target;
        if (img.__mastirOverlayPaint) continue;
        clearTimeout(swapSettleTimers.get(img));
        swapSettleTimers.set(img, setTimeout(() => {
          swapSettleTimers.delete(img);
          const url = getImageUrl(img);
          if (!url || url.startsWith("data:")) return;
          // Dedup on what we SEGMENTED (segFetchUrl). sameUrl() so a relative
          // src and its absolute currentSrc for the same image compare equal.
          // Once settled, url is the displayed image — if it matches, our mask
          // is already correct (the churn returned to it) and we do nothing.
          if (segMaskCache.has(img) && sameUrl(segFetchUrl.get(img), url)) return;
          if (MASTIR_PROFILE) {
            const prev = segFetchUrl.get(img) || "";
            mlog(`[mastir:urlSwap] WIPE hadCache=${segMaskCache.has(img)} prev=${prev.slice(0, 50)} new=${url.slice(0, 50)}`);
          }
          segProcessed.delete(img);
          segMaskCache.delete(img);
          enqueueImage(img);
        }, SWAP_SETTLE_MS));
      }
    });
  });

  function observeUrlSwap(img) {
    urlSwapObserver.observe(img, { attributes: true, attributeFilter: ["src", "srcset"] });
  }

  // Skip tiny iframes (tracking pixels, ad beacons) — no meaningful images.
  const isTinyFrame = window !== window.top && window.innerWidth < 48 && window.innerHeight < 48;

  let segDebounce = null;
  window.addEventListener("load", () => {
    if (isTinyFrame) return;
    new MutationObserver(() => {
      profile("obs.bodyChildList", () => {
        applyBlur();
        if (!segDebounce) {
          segDebounce = setTimeout(() => { segDebounce = null; runSegmentation(); }, 500);
        }
      });
    }).observe(document.body, { childList: true, subtree: true });
    applyBlur();
    runSegmentation();
    // Once visible images have had their turn, drain the offscreen remainder in
    // the background so a later Reading Mode (or Ctrl+F jump) finds them masked.
    const scheduleEager = () => setTimeout(eagerSegmentAll, 3000);
    if (window.requestIdleCallback) requestIdleCallback(scheduleEager);
    else scheduleEager();
  });
})();