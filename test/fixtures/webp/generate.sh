#!/usr/bin/env bash
# Regenerates the WebP reference fixtures. See test/fixtures/png/generate.sh for why these
# come from ImageMagick rather than from our own encoder.
#
# WebP is THREE formats wearing one extension, and they store the dimensions in three
# different places:
#
#   VP8   simple lossy      -- dimensions in the VP8 keyframe header, 14 bits each
#   VP8L  simple lossless   -- dimensions bit-packed after a 0x2f signature, 14 bits each
#   VP8X  extended          -- a canvas size in the VP8X chunk, 24 bits each, stored MINUS ONE
#
# probeWebp reads all three in pure TypeScript, because the size guard has to fire BEFORE
# any bytes reach the WASM (features/codec-webp.md). A probe that handles only VP8 works on
# most files and reads garbage from the rest.
#
# No .rgba here for the lossy file: libwebp's decoder is the reference and we call it, so a
# byte comparison against ImageMagick's copy of the same library would be testing libwebp
# against itself. The lossless files DO get one -- lossless means exact, so ImageMagick's
# pixels are a real target.
set -euo pipefail
cd "$(dirname "$0")"

report () {
  printf '%-16s %-8s %-5s %s\n' "$1" \
    "$(magick identify -format '%wx%h' "$1")" \
    "$(xxd -p -l 16 "$1" | cut -c25-32 | xxd -r -p)" \
    "$(wc -c < "$1" | tr -d ' ') bytes"
}

# Simple lossy: the common case, a photo saved from the web.
magick -size 24x16 plasma:fractal -alpha off -quality 80 lossy.webp
# Simple lossless: what the format is for when the source is flat colour.
magick -size 24x16 plasma:fractal -alpha off -define webp:lossless=true lossless.webp
magick lossless.webp -depth 8 RGBA:lossless.rgba
# Lossless with alpha. WebP does alpha natively, so nothing is composited on the way in.
magick -size 24x16 plasma:fractal -alpha set -channel A -evaluate set 50% +channel \
  -define webp:lossless=true alpha.webp
magick alpha.webp -depth 8 RGBA:alpha.rgba
# Extended (VP8X): lossy pixels plus a separate ALPH chunk. This is the one whose canvas
# size is 24-bit and stored minus one, so an off-by-one here is invisible on every other
# fixture.
magick -size 24x16 plasma:fractal -alpha set -channel A -evaluate set 50% +channel \
  -quality 80 vp8x-alpha.webp
# 1x1, where "width minus one" is zero and a decoder that treats 0 as "missing" breaks.
magick -size 1x1 xc:'#c86432' -alpha off -define webp:lossless=true tiny-1x1.webp
magick tiny-1x1.webp -depth 8 RGBA:tiny-1x1.rgba

for f in *.webp; do report "$f"; done

echo
echo "regenerated. commit the .webp and .rgba files."
