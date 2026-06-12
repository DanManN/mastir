#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="0"

echo "Downloading MediaPipe tasks-vision@${VERSION}..."
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs" -o "$DIR/vision_bundle.mjs"

mkdir -p "$DIR/wasm"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_internal.js" -o "$DIR/wasm/vision_wasm_internal.js"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_internal.wasm" -o "$DIR/wasm/vision_wasm_internal.wasm"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_nosimd_internal.js" -o "$DIR/wasm/vision_wasm_nosimd_internal.js"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_nosimd_internal.wasm" -o "$DIR/wasm/vision_wasm_nosimd_internal.wasm"

echo "Downloading selfie segmentation model..."
curl -sL "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite" -o "$DIR/selfie_multiclass_256x256.tflite"

echo "Done. Bundle updated."
