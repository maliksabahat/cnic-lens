#!/usr/bin/env bash
# Downloads the bundled offline assets into vendor/ (GitHub Release asset).
# Usage: bash setup/fetch-vendor.sh
set -euo pipefail

REPO="maliksabahat/cnic-lens"
TAG="v2.2.1"
ASSET="vendor.zip"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor"

if [ -f "$DEST/tesseract.min.js" ]; then
  echo "vendor/ already present - nothing to do."
  exit 0
fi

curl -L --fail -o /tmp/vendor.zip "https://github.com/$REPO/releases/download/$TAG/$ASSET"
unzip -q -o /tmp/vendor.zip -d "$ROOT"
rm -f /tmp/vendor.zip

for f in \
  "vendor/tesseract.min.js" \
  "vendor/lang/urd.traineddata.gz" \
  "vendor/mt/opus-mt-ur-en/onnx/encoder_model_quantized.onnx" \
  "vendor/ort/ort-wasm-simd.wasm"
do
  [ -f "$ROOT/$f" ] || { echo "missing: $f" >&2; exit 1; }
done

echo "Done: $(du -sh "$DEST" | cut -f1) in vendor/"
