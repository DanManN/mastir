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
    style.textContent = "img, iframe[src*='youtube'], video, video-js, [image-src], [data-background-image-url] { filter: blur(20px) grayscale(100%) !important; clip-path: inset(0); }";
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

  const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?|$)/i;
  const BG_IMG_RE = /url\(["']?([^"')]*\.(jpe?g|png|gif|webp|avif|bmp)(\?[^"')]*)?|data:image\/[^"')]+)["']?\)/i;

  function isImageCustomElement(el) {
    if (!el.tagName || !el.tagName.includes("-")) return false;
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      if (attrs[i].name.endsWith("-src") && IMG_EXT_RE.test(attrs[i].value)) return true;
    }
    return false;
  }

  function hasBgImage(el) {
    const style = el.getAttribute("style");
    return style && BG_IMG_RE.test(style);
  }

  function shouldBlurExtra(el) {
    return isImageCustomElement(el) || hasBgImage(el);
  }

  function blurElement(el) {
    const filter = segEnabled ? MAX_BLUR : buildFilter(!blurOff);
    el.style.setProperty("filter", filter, "important");
    el.style.clipPath = "inset(0)";
  }

  function shouldBlurOnInsert(el) {
    return shouldBlurExtra(el) || (el.hasAttribute && el.hasAttribute("image-src"));
  }

  // Blur custom image elements and background-image divs as soon as they enter the DOM
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (shouldBlurOnInsert(node)) blurElement(node);
        if (node.querySelectorAll) {
          node.querySelectorAll("[image-src]").forEach(blurElement);
          node.querySelectorAll("*").forEach((child) => {
            if (shouldBlurExtra(child)) blurElement(child);
          });
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  const MAX_BLUR = "blur(20px) grayscale(100%)";

  let blurAmount = 0;
  let hoverOff = true;
  let blurOff = true;
  let grayOn = true;

  // --- Person Segmentation ---
  let segEnabled = true;
  let segThreshold = 64;
  const segProcessed = new WeakSet();
  const segOriginalSrc = new WeakMap();
  const segMaskCache = new WeakMap();
  const segUrlCache = new Map();

  // --- Bridge communication ---
  function bridgeRequest(type, payload) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const responseType = type + "-response";
      function handler(e) {
        if (e.source !== window) return;
        if (e.data?.type !== responseType || e.data.id !== id) return;
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

  async function bridgeSegment(url, canvas) {
    let resp;
    try {
      resp = await bridgeRequest("blurify-segment", { url });
    } catch (e) {
      // URL fetch failed in offscreen — fall back to sending data URL
      const dataUrl = canvas.toDataURL("image/png");
      resp = await bridgeRequest("blurify-segment", { url: dataUrl });
    }
    // Decode base64 mask
    const binary = atob(resp.maskBase64);
    const maskAlpha = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      maskAlpha[i] = binary.charCodeAt(i);
    }
    return { maskAlpha, w: resp.w, h: resp.h };
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
    if (src && !src.startsWith("data:") && !src.includes(" ")) return src;
    return null;
  }

  async function processImage(img) {
    if (segProcessed.has(img)) return;
    const imageSrcAttr = img.getAttribute("image-src");
    const src = imageSrcAttr || img.currentSrc || img.src;
    if (!src) return;
    if (!imageSrcAttr && (img.naturalWidth === 0 || img.naturalHeight === 0)) return;
    if (!imageSrcAttr && (img.naturalWidth < 16 || img.naturalHeight < 16)) return;

    segProcessed.add(img);

    if (/\.(svg|gif)(\?|$)/i.test(src)) {
      // Skip segmentation but mark as done so it gets normal filter
      segMaskCache.set(img, { originalPixels: null, maskAlpha: new Uint8Array(0), w: 0, h: 0 });
      img.style.setProperty("filter", buildFilter(!blurOff), "important");
      return;
    }
    segOriginalSrc.set(img, src);

    try {
      const fetchUrl = getImageUrl(img);
      if (!fetchUrl) return;

      if (segUrlCache.has(fetchUrl)) {
        const cached = segUrlCache.get(fetchUrl);
        segMaskCache.set(img, { originalPixels: cached.originalPixels.slice(), maskAlpha: cached.maskAlpha, w: cached.w, h: cached.h });
        applySegThreshold(img);
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

      const { maskAlpha, w, h } = await bridgeSegment(fetchUrl, canvas);

      // Get original pixels for threshold painting
      let originalPixels;
      if (canvas && canvas.width === w && canvas.height === h) {
        originalPixels = canvas.getContext("2d").getImageData(0, 0, w, h).data.slice();
      } else if (canvas) {
        // Resize local canvas to match offscreen dimensions
        const resized = document.createElement("canvas");
        resized.width = w;
        resized.height = h;
        resized.getContext("2d").drawImage(canvas, 0, 0, w, h);
        originalPixels = resized.getContext("2d").getImageData(0, 0, w, h).data.slice();
      } else {
        // No local pixels — try fetching again for painting
        const resp = await crossFetch(fetchUrl);
        const tmp = new Image();
        await new Promise((resolve) => { tmp.onload = resolve; tmp.src = resp; });
        const bmp = await createImageBitmap(tmp);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(bmp, 0, 0, w, h);
        originalPixels = c.getContext("2d").getImageData(0, 0, w, h).data.slice();
      }

      const cacheEntry = { originalPixels, maskAlpha, w, h };
      segUrlCache.set(fetchUrl, cacheEntry);
      segMaskCache.set(img, cacheEntry);
      applySegThreshold(img);
    } catch (e) {
      console.error("[blurify] processImage failed:", e, src.substring(0, 80));
      segMaskCache.set(img, { originalPixels: null, maskAlpha: new Uint8Array(0), w: 0, h: 0 });
      const filter = buildFilter(!blurOff);
      img.style.setProperty("filter", filter, "important");
    }
  }

  function applySegThreshold(img) {
    const cached = segMaskCache.get(img);
    if (!cached || !cached.originalPixels) return;
    const { originalPixels, maskAlpha, w, h } = cached;
    const pixels = originalPixels.slice();
    let didPaint = false;
    for (let i = 0; i < maskAlpha.length; i++) {
      if (maskAlpha[i] > segThreshold) {
        const pi = i * 4;
        pixels[pi] = 128; pixels[pi + 1] = 128; pixels[pi + 2] = 128; pixels[pi + 3] = 255;
        didPaint = true;
      }
    }
    if (img.tagName === "IMG") {
      selfUpdating = true;
      if (didPaint) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
        const picture = img.closest("picture");
        if (picture) picture.querySelectorAll("source").forEach((s) => s.remove());
        img.removeAttribute("srcset");
        img.src = canvas.toDataURL("image/png");
      } else if (segOriginalSrc.has(img)) {
        img.src = segOriginalSrc.get(img);
      }
      selfUpdating = false;
    }
    const filter = buildFilter(!blurOff);
    img.style.setProperty("filter", filter, "important");
    if (img.tagName === "IMG") observeSrc(img);
  }

  function reapplyAllThresholds() {
    document.querySelectorAll("img, [image-src]").forEach((el) => {
      if (segMaskCache.has(el)) applySegThreshold(el);
    });
  }

  let segQueue = Promise.resolve();
  function enqueueImage(img) {
    if (segMaskCache.has(img)) return;
    segQueue = segQueue.then(() => processImage(img)).catch((e) => {
      console.error("[blurify] queue error:", e);
    });
  }

  function runSegmentation() {
    if (!segEnabled) return;
    document.querySelectorAll("img").forEach((img) => {
      if (segProcessed.has(img) || segMaskCache.has(img)) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        enqueueImage(img);
      } else if (!img.complete) {
        img.addEventListener("load", () => enqueueImage(img), { once: true });
      }
    });
    document.querySelectorAll("[image-src]").forEach((el) => {
      if (segProcessed.has(el) || segMaskCache.has(el)) return;
      enqueueImage(el);
    });
  }

  function restoreImages() {
    document.querySelectorAll("img").forEach((img) => {
      if (segOriginalSrc.has(img)) {
        img.src = segOriginalSrc.get(img);
      }
      segProcessed.delete(img);
    });
  }

  function toggleSeg() {
    segEnabled = !segEnabled;
    updateBtn("toggle_seg", segEnabled, "Seg On", "Seg Off");
    if (segEnabled) {
      applyBlur();
      document.querySelectorAll("img").forEach((img) => {
        if (segMaskCache.has(img)) applySegThreshold(img);
      });
      runSegmentation();
    } else {
      restoreImages();
      applyBlur();
    }
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

    const toggleBtn = createButton("Stay Blurred", "#555", "#333", "0", toggleBlur);
    toggleBtn.id = "toggle_blur";

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
      updateStyleRule();
      applyBlur();
      broadcastState();
    });
    sliderWrap.append(slider, sliderLabel);

    const grayBtn = createButton("Gray On", "#555", "#333", "0", toggleGray);
    grayBtn.id = "toggle_gray";

    const segBtn = createButton("Seg On", "#555", "#333", "0", toggleSeg);
    segBtn.id = "toggle_seg";

    const segSliderWrap = document.createElement("div");
    Object.assign(segSliderWrap.style, {
      display: "flex", alignItems: "center", backgroundColor: "#555",
      border: "2px solid #333", borderRadius: "0 10px 10px 0", padding: "4px 10px", gap: "6px",
    });
    const segSliderLabel = document.createElement("span");
    segSliderLabel.textContent = segThreshold;
    Object.assign(segSliderLabel.style, { color: "#FFF", fontSize: "12px", minWidth: "20px", textAlign: "center" });
    const segSlider = document.createElement("input");
    segSlider.type = "range"; segSlider.min = "0"; segSlider.max = "255"; segSlider.value = String(segThreshold);
    Object.assign(segSlider.style, { width: "60px", cursor: "pointer" });
    segSlider.addEventListener("input", () => {
      segThreshold = parseInt(segSlider.value);
      segSliderLabel.textContent = segThreshold;
      if (segEnabled) reapplyAllThresholds();
    });
    segSliderWrap.append(segSlider, segSliderLabel);

    const extraBtns = [toggleBtn, sliderWrap, grayBtn, segBtn, segSliderWrap];

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
        segSliderWrap.style.borderRadius = collapsed ? "" : "0 10px 10px 0";
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

  const BLUR_SELECTOR = "img, iframe[src*='youtube'], video, [image-src], [data-background-image-url]";

  function applyBlur() {
    const elements = document.querySelectorAll(BLUR_SELECTOR);
    elements.forEach((img) => {
      const processed = segMaskCache.has(img);
      const maxBlur = segEnabled && !processed;
      const filter = maxBlur ? MAX_BLUR : buildFilter(!blurOff);
      img.style.setProperty("filter", filter, "important");
      img.style.transition = processed ? "filter 0.3s ease" : "none";
      img.style.clipPath = "inset(0)";
      img.onmouseenter = () => {
        if (maxBlur) return;
        img.style.setProperty("filter", (blurOff || !hoverOff) ? buildFilter(false) : buildFilter(true), "important");
      };
      img.onmouseleave = () => {
        if (maxBlur) return;
        img.style.setProperty("filter", buildFilter(!blurOff), "important");
      };
    });
  }

  function updateStyleRule() {
    const blurStyle = document.getElementById("blurify-blur-style");
    if (blurStyle) {
      const parts = [];
      if (!blurOff) parts.push(`blur(${blurAmount}px)`);
      if (grayOn) parts.push("grayscale(100%)");
      if (parts.length) {
        blurStyle.textContent = `img, iframe[src*='youtube'], video, video-js, [image-src], [data-background-image-url] { filter: ${parts.join(" ")} !important; clip-path: inset(0); }`;
        blurStyle.disabled = false;
      } else {
        blurStyle.disabled = true;
      }
    }
  }

  function broadcastState() {
    const msg = { type: "blurify-sync", hoverOff, blurOff, grayOn, blurAmount };
    document.querySelectorAll("iframe").forEach((iframe) => {
      try { iframe.contentWindow.postMessage(msg, "*"); } catch (e) { /* cross-origin */ }
    });
  }

  function applyState(state) {
    hoverOff = state.hoverOff;
    blurOff = state.blurOff;
    grayOn = state.grayOn;
    blurAmount = state.blurAmount;
    updateStyleRule();
    applyBlur();
  }

  function toggleBlur() {
    hoverOff = !hoverOff;
    updateBtn("toggle_blur", hoverOff, "Stay Blurred", "Unblur on Hover", "#555", "#d80", "#333", "#a60");
    applyBlur();
    broadcastState();
  }

  function toggleGray() {
    grayOn = !grayOn;
    updateStyleRule();
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
          applySegThreshold(img);
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
