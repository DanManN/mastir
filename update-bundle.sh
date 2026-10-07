#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="1"

echo "Downloading MediaPipe tasks-vision@${VERSION}..."
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs" -o "$DIR/vision_bundle.mjs"

mkdir -p "$DIR/wasm"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_internal.js" -o "$DIR/wasm/vision_wasm_internal.js"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_internal.wasm" -o "$DIR/wasm/vision_wasm_internal.wasm"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_nosimd_internal.js" -o "$DIR/wasm/vision_wasm_nosimd_internal.js"
curl -sL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm/vision_wasm_nosimd_internal.wasm" -o "$DIR/wasm/vision_wasm_nosimd_internal.wasm"

echo "Downloading selfie segmentation model..."
curl -sL "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite" -o "$DIR/selfie_multiclass_256x256.tflite"

echo "Downloading deeplabv3 segmentation model..."
curl -sL "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/latest/deeplab_v3.tflite" -o "$DIR/deeplabv3.tflite"

echo "Downloading selfie segmenter models (square + landscape)..."
curl -sL "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite" -o "$DIR/selfie_segmenter.tflite"
curl -sL "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite" -o "$DIR/selfie_segmenter_landscape.tflite"

echo "Done. Bundle updated."
