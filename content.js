"use strict";

(function () {
  // Inject a CSS rule immediately so images are blurred/grayscaled before they even render
  let styleInjected = false;
  function tryInjectStyle() {
    if (styleInjected) return;
    const style = document.createElement("style");
    style.id = "blurify-blur-style";
    const existingNonce = document.querySelector("style[nonce], script[nonce]");
    if (existingNonce) style.nonce = existingNonce.nonce || existingNonce.getAttribute("nonce");
    style.textContent = "img, video, video-js, [image-src] { filter: blur(20px) grayscale(100%) !important; clip-path: inset(0); }";
    (document.head || document.documentElement).appendChild(style);
    if (!style.sheet || style.sheet.cssRules.length === 0) {
      style.remove();
    } else {
      styleInjected = true;
    }
  }
  tryInjectStyle();
  if (!styleInjected) {
    new MutationObserver((_, obs) => {
      tryInjectStyle();
      if (styleInjected) obs.disconnect();
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
    if (el.hasAttribute && el.hasAttribute("image-src")) return true;
    if (isVideoIframe(el)) return true;
    const style = el.getAttribute("style");
    if (style && BG_IMG_RE.test(style)) return true;
    return false;
  }

  function blurElement(el) {
    el.style.setProperty("filter", MAX_BLUR, "important");
    el.style.clipPath = "inset(0)";
  }

  function processNode(node) {
    if (node.nodeType !== 1) return;
    if (shouldPreBlur(node)) blurElement(node);
    observeElement(node);
    if (node.querySelectorAll) {
      node.querySelectorAll("*").forEach((child) => {
        if (shouldPreBlur(child)) blurElement(child);
        observeElement(child);
      });
    }
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) processNode(node);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  const MAX_BLUR = "blur(20px) grayscale(100%)";

  let blurAmount = 0;
  let blurOff = true;
  let grayOn = true;

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
    return bridgeRequest("blurify-fetch", { url }).then((r) => r.dataUrl);
  }

  // --- Local GPU segmenter (CDN import, falls back to offscreen CPU) ---
  let localSegmenter = null;
  let localSegFailed = false;
  let localSegLoading = null;

  function loadLocalSegmenter() {
    if (localSegFailed) return Promise.resolve(null);
    if (localSegmenter) return Promise.resolve(localSegmenter);
    if (localSegLoading) return localSegLoading;
    localSegLoading = (async () => {
      try {
        const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0/vision_bundle.mjs");
        const wasmFiles = await vision.FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0/wasm"
        );
        localSegmenter = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        return localSegmenter;
      } catch (e) {
        localSegFailed = true;
        return null;
      }
    })();
    return localSegLoading;
  }

  async function localSegment(canvas) {
    const seg = await loadLocalSegmenter();
    if (!seg) return null;
    const result = seg.segment(canvas);
    const mask = result.categoryMask;
    const w = canvas.width, h = canvas.height;
    const maskAlpha = new Uint8Array(w * h);
    if (mask) {
      const maskData = mask.getAsUint8Array();
      for (let i = 0; i < maskData.length; i++) {
        maskAlpha[i] = maskData[i] > 0 ? 255 : 0;
      }
      result.close();
    }
    return { maskAlpha, w, h };
  }

  async function bridgeSegment(url, canvas) {
    let resp;
    try {
      resp = await bridgeRequest("blurify-segment", { url });
    } catch (e) {
      if (!canvas) throw e;
      const dataUrl = canvas.toDataURL("image/png");
      resp = await bridgeRequest("blurify-segment", { url: dataUrl });
    }
    const binary = atob(resp.maskBase64);
    const maskAlpha = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      maskAlpha[i] = binary.charCodeAt(i);
    }
    return { maskAlpha, w: resp.w, h: resp.h };
  }

  async function segment(fetchUrl, canvas) {
    if (canvas && !localSegFailed) {
      const result = await localSegment(canvas);
      if (result) return result;
    }
    return bridgeSegment(fetchUrl, canvas);
  }

  // Start loading segmenter immediately
  loadLocalSegmenter();

  function getImageUrl(el) {
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
    segMaskCache.set(img, { originalPixels: null, maskAlpha: new Uint8Array(0), w: 0, h: 0 });
    segAllElements.add(img);
    img.style.setProperty("filter", buildFilter(!blurOff), "important");
  }

  async function processImage(img) {
    if (segProcessed.has(img)) return;
    if (isVideoIframe(img)) { segProcessed.add(img); return; }
    const imageSrcAttr = img.getAttribute("image-src");
    const src = imageSrcAttr || img.currentSrc || img.src || getImageUrl(img);
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
        segMaskCache.set(img, { originalPixels: cached.originalPixels.slice(), maskAlpha: cached.maskAlpha, w: cached.w, h: cached.h });
        segAllElements.add(img);
        applyMask(img);
        return;
      }

      // Try to get a local canvas for fallback data URL
      let canvas = null;
      try {
        const bitmap = await new Promise((resolve, reject) => {
          const tmp = new Image();
          tmp.crossOrigin = "anonymous";
          tmp.onload = () => resolve(createImageBitmap(tmp));
          tmp.onerror = () => {
            crossFetch(fetchUrl).then((dataUrl) => {
              const tmp2 = new Image();
              tmp2.onload = () => resolve(createImageBitmap(tmp2));
              tmp2.onerror = () => reject(new Error("decode failed"));
              tmp2.src = dataUrl;
            }).catch(reject);
          };
          tmp.src = fetchUrl;
        });
        canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
      } catch (e) {
        // Can't get pixels locally — offscreen will fetch directly
      }

      const { maskAlpha, w, h } = await segment(fetchUrl, canvas);

      // Get original pixels for threshold painting
      if (!canvas) {
        const resp = await crossFetch(fetchUrl);
        const tmp = new Image();
        await new Promise((resolve) => { tmp.onload = resolve; tmp.src = resp; });
        const bmp = await createImageBitmap(tmp);
        canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext("2d").drawImage(bmp, 0, 0);
      }
      if (canvas.width !== w || canvas.height !== h) {
        const resized = document.createElement("canvas");
        resized.width = w;
        resized.height = h;
        resized.getContext("2d").drawImage(canvas, 0, 0, w, h);
        canvas = resized;
      }
      const originalPixels = canvas.getContext("2d").getImageData(0, 0, w, h).data.slice();

      const cacheEntry = { originalPixels, maskAlpha, w, h };
      segUrlCache.set(fetchUrl, cacheEntry);
      segMaskCache.set(img, cacheEntry);
      segAllElements.add(img);
      applyMask(img);
    } catch (e) {
      console.warn("[mastir] processImage failed:", e.message, src?.substring(0, 80));
      markDone(img);
    }
  }

  function applyMask(img) {
    const cached = segMaskCache.get(img);
    if (!cached || !cached.originalPixels) return;
    const { originalPixels, maskAlpha, w, h } = cached;
    const pixels = originalPixels.slice();
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < maskAlpha.length; i++) {
      if (maskAlpha[i] > 0) {
        const pi = i * 4;
        rSum += originalPixels[pi];
        gSum += originalPixels[pi + 1];
        bSum += originalPixels[pi + 2];
        count++;
      }
    }
    const didPaint = count > 0;
    if (didPaint) {
      const r = (rSum / count) | 0;
      const g = (gSum / count) | 0;
      const b = (bSum / count) | 0;
      for (let i = 0; i < maskAlpha.length; i++) {
        if (maskAlpha[i] > 0) {
          const pi = i * 4;
          pixels[pi] = r; pixels[pi + 1] = g; pixels[pi + 2] = b; pixels[pi + 3] = 255;
        }
      }
    }
    if (didPaint) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      if (img.tagName === "IMG") {
        selfUpdating = true;
        const picture = img.closest("picture");
        if (picture) picture.querySelectorAll("source").forEach((s) => s.remove());
        img.removeAttribute("srcset");
        img.src = dataUrl;
        selfUpdating = false;
      } else {
        img.style.setProperty("background-image", `url(${dataUrl})`, "important");
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
  let segRunning = false;

  async function processQueue() {
    if (segRunning) return;
    segRunning = true;
    while (segQueue.length > 0) {
      const img = segQueue.shift();
      if (segMaskCache.has(img)) continue;
      try {
        await processImage(img);
      } catch (e) {
        console.error("[mastir] queue error:", e);
      }
    }
    segRunning = false;
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
      } else {
        if (el.offsetWidth < 48 || el.offsetHeight < 48) continue;
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") continue;
        if (bg.startsWith("linear-gradient") || bg.startsWith("radial-gradient")) continue;
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
  }


  // --- UI ---
  function createButton(text, bgColor, borderColor, borderRadius, clickHandler) {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      padding: "8px 12px", backgroundColor: bgColor, color: "#FFF",
      border: `2px solid ${borderColor}`, borderRadius, fontSize: "14px",
      cursor: "pointer", transition: "all 0.3s ease",
    });
    btn.textContent = text;
    btn.dataset.bgColor = bgColor;
    btn.onmouseenter = () => (btn.style.backgroundColor = darkenColor(btn.dataset.bgColor));
    btn.onmouseleave = () => (btn.style.backgroundColor = btn.dataset.bgColor);
    btn.onclick = clickHandler;
    return btn;
  }

  function updateBtn(id, active, onText, offText, onColor = "#555", offColor = "#f00", onBorder = "#333", offBorder = "#a00") {
    const btn = document.getElementById(id);
    if (!btn) return;
    const color = active ? onColor : offColor;
    btn.dataset.bgColor = color;
    btn.style.backgroundColor = color;
    btn.style.borderColor = active ? onBorder : offBorder;
    btn.textContent = active ? onText : offText;
  }

  function darkenColor(hex) {
    let num = parseInt(hex.slice(1), 16) - 0x202020;
    return `#${Math.max(0, num).toString(16).padStart(6, "0")}`;
  }

  function createToggleButton() {
    const container = document.createElement("div");
    container.id = "blurify-controls";
    Object.assign(container.style, {
      position: "fixed", bottom: "25px", left: "25px", zIndex: "9999",
      display: "flex", userSelect: "none",
    });

    let collapsed = false;

    const sliderWrap = document.createElement("div");
    Object.assign(sliderWrap.style, {
      display: "flex", alignItems: "center", backgroundColor: "#555",
      border: "2px solid #333", padding: "4px 10px", gap: "6px",
    });
    const sliderLabel = document.createElement("span");
    sliderLabel.textContent = "0";
    Object.assign(sliderLabel.style, { color: "#FFF", fontSize: "12px", minWidth: "20px", textAlign: "center" });
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = "20"; slider.value = "0";
    Object.assign(slider.style, { width: "80px", cursor: "pointer" });
    slider.addEventListener("input", () => {
      blurAmount = parseInt(slider.value);
      sliderLabel.textContent = blurAmount;
      blurOff = blurAmount === 0;
      applyBlur();
      broadcastState();
    });
    sliderWrap.append(slider, sliderLabel);

    const grayBtn = createButton("Gray On", "#555", "#333", "0 10px 10px 0", toggleGray);
    grayBtn.id = "toggle_gray";

    const extraBtns = [sliderWrap, grayBtn];

    const hideBtn = createButton("Hide", "#047c9dff", "#09495bff", "10px 0 0 10px", () => {});
    hideBtn.style.cursor = "grab";

    let isDragging = false, dragMoved = false, offsetX, offsetY;
    hideBtn.addEventListener("mousedown", (e) => {
      isDragging = true; dragMoved = false;
      offsetX = e.clientX - container.getBoundingClientRect().left;
      offsetY = e.clientY - container.getBoundingClientRect().top;
      hideBtn.style.cursor = "grabbing"; e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      dragMoved = true;
      container.style.left = (e.clientX - offsetX) + "px";
      container.style.top = (e.clientY - offsetY) + "px";
      container.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (!isDragging) return;
      isDragging = false; hideBtn.style.cursor = "grab";
      if (!dragMoved) {
        collapsed = !collapsed;
        extraBtns.forEach(btn => btn.style.display = collapsed ? "none" : "");
        hideBtn.style.borderRadius = collapsed ? "10px" : "10px 0 0 10px";
        hideBtn.textContent = collapsed ? "Show" : "Hide";
        const c = collapsed ? "#555" : "#047c9dff";
        hideBtn.dataset.bgColor = c; hideBtn.style.backgroundColor = c;
        hideBtn.style.borderColor = collapsed ? "#333" : "#09495bff";
        grayBtn.style.borderRadius = collapsed ? "" : "0 10px 10px 0";
      }
    });

    container.append(hideBtn, ...extraBtns);
    document.body.appendChild(container);
  }

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



  function broadcastState() {
    const msg = { type: "blurify-sync", blurOff, grayOn, blurAmount };
    document.querySelectorAll("iframe").forEach((iframe) => {
      try { iframe.contentWindow.postMessage(msg, "*"); } catch (e) { /* cross-origin */ }
    });
  }

  function applyState(state) {
    blurOff = state.blurOff;
    grayOn = state.grayOn;
    blurAmount = state.blurAmount;
    applyBlur();
    applyBlur();
  }


  function toggleGray() {
    grayOn = !grayOn;
    applyBlur();
    updateBtn("toggle_gray", grayOn, "Gray On", "Gray Off");
    applyBlur();
    broadcastState();
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "blurify-sync") {
      applyState(e.data);
      broadcastState();
    }
  });

  // Watch for external JS overwriting src on images we've already masked
  const srcReapplyCount = new WeakMap();
  const srcReapplyPending = new WeakSet();
  const MAX_REAPPLIES = 3;
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

  let segDebounce = null;
  window.addEventListener("load", () => {
    new MutationObserver(() => {
      applyBlur();
      if (!segDebounce) {
        segDebounce = setTimeout(() => { segDebounce = null; runSegmentation(); }, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
    if (window === window.top && !document.getElementById("blurify-controls")) {
      createToggleButton();
    }
    applyBlur();
    runSegmentation();
  });
})();