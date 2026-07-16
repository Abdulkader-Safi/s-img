#!/usr/bin/env bash
# Regenerates the PNG reference fixtures. Run only when adding a case.
#
# Why these exist: our own test helpers build PNGs from the same assumptions as our
# decoder, so a symmetric bug passes both sides and ships. Mutation testing proved it --
# breaking the Paeth tie-break failed ZERO tests until these landed, because the
# hand-built fixtures never produced a pb == pc tie.
#
# So the fixtures come from ImageMagick (libpng), an entirely independent
# implementation, and each .png ships with a .rgba dump of the pixels IT decoded. The
# test decodes the .png and must match the .rgba byte for byte.
#
# ImageMagick is NOT a test dependency: the outputs are committed. It is only needed
# here, to regenerate.
set -euo pipefail
cd "$(dirname "$0")"

# gen <name> <png-format-prefix> <magick input args...>
gen () {
  local name="$1" format="$2"; shift 2
  magick "$@" "${format}${name}.png"
  # The reference decode: raw non-premultiplied RGBA, our exact RawImage layout.
  magick "${name}.png" -depth 8 "RGBA:${name}.rgba"
  printf '%-14s %s\n' "$name" "$(magick identify -format '%wx%h' "${name}.png")"
}

# Photo-like: gradient plus noise, so libpng actually reaches for Paeth and hits the
# pb == pc tie our hand-built fixtures never produced.
gen paeth-photo PNG24: -size 48x32 gradient:red-blue -attenuate 0.6 +noise Gaussian -depth 8

# One flat colour: trivially compressible, exercises the boring path.
gen flat PNG24: -size 8x8 xc:'#1e5aa8' -depth 8

# Alpha, including partially transparent pixels.
gen rgba8 PNG32: -size 16x16 gradient:'rgba(255,0,0,1)-rgba(0,0,255,0)' -depth 8

# 8-bit greyscale (colour type 0).
gen gray8 PNG: -size 16x16 gradient:black-white -colorspace Gray -depth 8 -define png:color-type=0

# 1-bit: sub-byte unpacking, on a width whose rows do not end on a byte boundary.
gen gray1 PNG: -size 13x5 gradient:black-white -colorspace Gray -monochrome -depth 1 \
  -define png:color-type=0 -define png:bit-depth=1

# 16-bit: must truncate to 8 (features/raw-image.md).
gen gray16 PNG: -size 16x4 gradient:black-white -colorspace Gray -depth 16 \
  -define png:color-type=0 -define png:bit-depth=16

# Palette (colour type 3), with and without a tRNS chunk.
gen palette PNG8: -size 16x16 gradient:red-yellow -colors 8
gen palette-trns PNG8: -size 16x16 gradient:'rgba(255,0,0,1)-rgba(0,255,0,0)' -colors 8

# Adam7: seven passes, each with its own stride and filter state.
gen interlaced PNG24: -size 24x18 gradient:green-magenta -interlace PNG -depth 8

# Odd dimensions: the size nobody fixtures until something breaks.
gen odd-17x13 PNG24: -size 17x13 gradient:cyan-black -depth 8

echo
echo "regenerated. commit both the .png and the .rgba files."
