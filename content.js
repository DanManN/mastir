"use strict";

(function () {
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
    style.textContent = "img, video, video-js, [image-src] { filter: blur(20px) grayscale(100%) !important; clip-path: inset(0); }";
    (document.head || document.documentElement).appendChild(style);
    if (!style.sheet || style.sheet.cssRules.length === 0) {
      style.remove();
      if (document.head) styleFailed = true;
    } else {
      styleInjected = true;
    }
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
    if (styleFailed) return;
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
    return bridgeRequest("mastir-fetch", { url }).then((r) => r.dataUrl);
  }

  // --- GPU segmenter (CDN → bundled fallback) ---
  let segmenter = null;
  let segLoading = null;
  let bundledVisionUrl = null;
  let bundledWasmUrl = null;
  let bundledModelUrl = null;

  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.type === "mastir-extension-urls") {
      bundledModelUrl = e.data.modelUrl;
      bundledVisionUrl = e.data.visionUrl;
      bundledWasmUrl = e.data.wasmUrl;
    }
  });

  let cspPrompted = false;

  function promptCspStrip() {
    if (cspPrompted) return;
    cspPrompted = true;
    const domain = location.hostname;
    const banner = document.createElement("div");
    Object.assign(banner.style, {
      position: "fixed", top: "10px", right: "10px", zIndex: "99999",
      background: "#333", color: "#fff", padding: "12px 16px",
      borderRadius: "8px", fontSize: "14px", maxWidth: "320px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)", fontFamily: "sans-serif",
    });
    const title = document.createElement("span");
    title.textContent = "Mastir";
    Object.assign(title.style, { fontWeight: "bold" });
    banner.appendChild(title);
    banner.appendChild(document.createElement("br"));
    banner.appendChild(document.createElement("br"));
    const desc = document.createElement("span");
    desc.textContent = "This site's Content Security Policy prevents image segmentation. To enable Mastir here, the CSP header must be removed for this domain.";
    banner.appendChild(desc);
    banner.appendChild(document.createElement("br"));
    banner.appendChild(document.createElement("br"));
    const warning = document.createElement("span");
    Object.assign(warning.style, { color: "#ffa", fontSize: "12px" });
    warning.textContent = "⚠ This reduces protection against cross-site scripting (XSS) on this site. Only allow on sites you trust.";
    banner.appendChild(warning);
    banner.appendChild(document.createElement("br"));
    banner.appendChild(document.createElement("br"));
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      background: "#047c9d", color: "#fff", border: "none", borderRadius: "4px",
      padding: "6px 12px", cursor: "pointer", marginRight: "8px",
    });
    btn.textContent = "Allow & Reload";
    btn.onclick = () => {
      bridgeRequest("mastir-csp-strip", { domain }).then(() => {
        bridgeRequest("mastir-hard-reload", {}).catch(() => location.reload());
      });
    };
    const dismiss = document.createElement("button");
    Object.assign(dismiss.style, {
      background: "transparent", color: "#aaa", border: "1px solid #555",
      borderRadius: "4px", padding: "6px 12px", cursor: "pointer",
    });
    dismiss.textContent = "Dismiss";
    dismiss.onclick = () => banner.remove();
    banner.appendChild(btn);
    banner.appendChild(dismiss);
    if (styleFailed) {
      document.documentElement.textContent = "";
      const body = document.createElement("body");
      body.appendChild(banner);
      document.documentElement.appendChild(body);
    } else {
      document.body.appendChild(banner);
    }
  }

  function loadSegmenter() {
    if (segmenter) return Promise.resolve(segmenter);
    if (segLoading) return segLoading;
    segLoading = (async () => {
      let vision, wasmBase, modelPath;
      try {
        vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0/vision_bundle.mjs");
        wasmBase = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0/wasm";
        console.log("[mastir] vision: CDN");
      } catch (e) {
        if (!bundledVisionUrl) { segLoading = null; promptCspStrip(); throw e; }
        vision = await import(bundledVisionUrl);
        wasmBase = bundledWasmUrl;
        console.log("[mastir] vision: bundled");
      }
      modelPath = bundledModelUrl || "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
      console.log("[mastir] model:", bundledModelUrl ? "bundled" : "CDN");
      try {
        const wasmFiles = await vision.FilesetResolver.forVisionTasks(wasmBase);
        segmenter = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
          baseOptions: { modelAssetPath: modelPath, delegate: "GPU" },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        console.log("[mastir] wasm:", wasmBase.startsWith("chrome-extension") ? "bundled" : "CDN");
      } catch (e) {
        if (!bundledWasmUrl || wasmBase === bundledWasmUrl) throw e;
        console.log("[mastir] wasm CDN failed, falling back to bundled");
        const wasmFiles = await vision.FilesetResolver.forVisionTasks(bundledWasmUrl);
        segmenter = await vision.ImageSegmenter.createFromOptions(wasmFiles, {
          baseOptions: { modelAssetPath: modelPath, delegate: "GPU" },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        console.log("[mastir] wasm: bundled (fallback)");
      }
      console.log("[mastir] segmenter ready");
      return segmenter;
    })().catch((e) => { promptCspStrip(); throw e; });
    return segLoading;
  }

  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => document.body ? resolve() : requestAnimationFrame(check);
      check();
    });
  }

  async function segment(canvas) {
    await waitForBody();
    const seg = await loadSegmenter();
    if (!seg) throw new Error("segmenter unavailable");
    let result;
    try {
      result = seg.segment(canvas);
    } catch (e) {
      await waitForBody();
      result = seg.segment(canvas);
    }
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

  // Load segmenter as soon as DOM is ready (MediaPipe needs document.body)
  if (document.body) {
    loadSegmenter();
  } else {
    document.addEventListener("DOMContentLoaded", () => loadSegmenter(), { once: true });
  }

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
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);

      const { maskAlpha, w, h } = await segment(canvas);
      const originalPixels = canvas.getContext("2d").getImageData(0, 0, w, h).data.slice();

      const cacheEntry = { originalPixels, maskAlpha, w, h };
      segUrlCache.set(fetchUrl, cacheEntry);
      segMaskCache.set(img, cacheEntry);
      segAllElements.add(img);
      applyMask(img);
    } catch (e) {
      console.warn("[mastir] processImage failed:", e.message, src?.substring(0, 80));
      segProcessed.delete(img);
      const retries = (img.__mastirRetries || 0) + 1;
      img.__mastirRetries = retries;
      if (retries <= 5) {
        setTimeout(() => enqueueImage(img), retries * 2000);
      }
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
  function setImportant(el, props) {
    for (const [k, v] of Object.entries(props)) {
      el.style.setProperty(k, v, "important");
    }
  }

  function createButton(text, bgColor, borderColor, borderRadius, clickHandler) {
    const btn = document.createElement("button");
    setImportant(btn, {
      padding: "8px 12px", "background-color": bgColor, color: "#FFF",
      border: `2px solid ${borderColor}`, "border-radius": borderRadius, "font-size": "14px",
      cursor: "pointer", transition: "all 0.3s ease", "line-height": "1",
      "font-family": "sans-serif", "font-weight": "normal", "text-transform": "none",
      "letter-spacing": "normal", "text-decoration": "none", "box-shadow": "none",
      margin: "0", "min-width": "0", "min-height": "0", display: "inline-block",
      "box-sizing": "content-box", width: "auto", height: "auto", "appearance": "none",
      outline: "none", "outline-offset": "0", "box-shadow": "none",
      "background-image": "none", "text-shadow": "none",
    });
    btn.textContent = text;
    btn.dataset.bgColor = bgColor;
    btn.onmouseenter = () => btn.style.setProperty("background-color", darkenColor(btn.dataset.bgColor), "important");
    btn.onmouseleave = () => btn.style.setProperty("background-color", btn.dataset.bgColor, "important");
    btn.onclick = clickHandler;
    return btn;
  }

  function updateBtn(id, active, onText, offText, onColor = "#555", offColor = "#f00", onBorder = "#333", offBorder = "#a00") {
    const btn = document.getElementById(id);
    if (!btn) return;
    const color = active ? onColor : offColor;
    btn.dataset.bgColor = color;
    btn.style.setProperty("background-color", color, "important");
    btn.style.setProperty("border-color", active ? onBorder : offBorder, "important");
    btn.textContent = active ? onText : offText;
  }

  function darkenColor(hex) {
    let num = parseInt(hex.slice(1), 16) - 0x202020;
    return `#${Math.max(0, num).toString(16).padStart(6, "0")}`;
  }

  function createToggleButton() {
    const container = document.createElement("div");
    container.id = "mastir-controls";
    setImportant(container, {
      position: "fixed", bottom: "25px", left: "25px", "z-index": "9999",
      display: "flex", "user-select": "none", "font-family": "sans-serif",
    });

    let collapsed = false;

    const sliderWrap = document.createElement("div");
    setImportant(sliderWrap, {
      display: "flex", "align-items": "center", "background-color": "#555",
      border: "2px solid #333", padding: "4px 10px", gap: "6px",
    });
    const sliderLabel = document.createElement("span");
    sliderLabel.textContent = "0";
    setImportant(sliderLabel, {
      color: "#FFF", "font-size": "12px", "min-width": "20px", "text-align": "center",
      "font-family": "sans-serif", "line-height": "1", margin: "0", padding: "0",
    });
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = "20"; slider.value = "0";
    setImportant(slider, {
      width: "80px", cursor: "pointer", height: "auto", margin: "0",
      "vertical-align": "middle", "appearance": "auto",
    });
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
    const msg = { type: "mastir-sync", blurOff, grayOn, blurAmount };
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
    if (e.data && e.data.type === "mastir-sync") {
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
    if (window === window.top && !document.getElementById("mastir-controls")) {
      createToggleButton();
    }
    applyBlur();
    runSegmentation();
  });
})();