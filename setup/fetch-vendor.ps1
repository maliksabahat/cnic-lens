# Downloads the bundled offline assets into vendor/ (Tesseract OCR core +
# urd/eng traineddata, transformers.js + onnxruntime wasm, opus-mt-ur-en int8).
#
# Usage:  powershell -ExecutionPolicy Bypass -File setup\fetch-vendor.ps1
#
# The zip is a GitHub Release asset (~120 MB) of this repository.

$ErrorActionPreference = 'Stop'

$repo = 'maliksabahat/cnic-lens'
$tag = 'v2.2.1'
$asset = 'vendor.zip'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root 'vendor'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) $asset

if (Test-Path (Join-Path $dest 'tesseract.min.js')) {
  Write-Host "vendor/ already present - nothing to do."
  exit 0
}

$url = "https://github.com/$repo/releases/download/$tag/$asset"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

Write-Host "Extracting to $dest"
Expand-Archive -Path $tmp -DestinationPath $root -Force
Remove-Item $tmp -Force

$need = @(
  'vendor/tesseract.min.js',
  'vendor/lang/urd.traineddata.gz',
  'vendor/lang/eng.traineddata.gz',
  'vendor/mt/opus-mt-ur-en/onnx/encoder_model_quantized.onnx',
  'vendor/mt/opus-mt-ur-en/onnx/decoder_model_merged_quantized.onnx',
  'vendor/ort/ort-wasm-simd.wasm'
)

$missing = $need | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing) {
  Write-Error ("Missing after extract: " + ($missing -join ', '))
  exit 1
}

$size = (Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Done. vendor/ = {0:N0} MB" -f $size)
