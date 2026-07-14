# Mastir

*Eyes are a portal into the soul*

That means what you see becomes part of you. And certainly, what you see influences what you think about. Everyone has different sensitivities and opinions as to what they consider distracting and undesirable, but our brains are hardwired to particularly notice people and be especially stimulated by images of people. So whether you want to guard your eyes from unwanted imagery, or simply stay focused while browsing, Mastir automatically detects and hides people in every image on every page — before you ever see them.

## Features

- Pre-blurs all images before paint — no flashing of uncensored content
- Person segmentation via MediaPipe selfie multiclass model (GPU-accelerated)
- Skin-only mode — mask exposed skin while leaving hair/clothes visible
- Adjustable blur intensity, mask softness, and mask expansion
- Optional global blur on all images (adjustable intensity)
- Optional grayscale filter
- Works inside iframes (ads, embeds) via programmatic injection
- Detects new images as they appear — works on infinite-scroll feeds, carousels, and sites that load content without a full page refresh

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this directory

## Settings

Click the extension icon to open the popup. All changes apply immediately.

| Setting | What it does |
|---------|-------------|
| **Blur** (0–32) | Blurs **all** images on the page by this amount. At 0, images are sharp but detected persons are still concealed with a flat color fill. |
| **Mask blur** (0–32) | Controls how soft the edges of the person mask are. 0 = hard cutoff, higher = gradual fade between concealed and visible areas. |
| **Mask expand** (0–32) | Grows the person mask outward by this many pixels. Useful for covering hair edges or limbs the model barely missed. |
| **Grayscale** | Turns all images black-and-white (applied on top of blur). |
| **Skin Only** | Only conceals exposed skin (face and body). Hair, clothes, and accessories remain visible. |