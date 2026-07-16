#!/usr/bin/env bash
# Regenerates the BMP reference fixtures. See test/fixtures/png/generate.sh for why
# these are produced by ImageMagick rather than by our own encoder: fixtures built from
# our assumptions cannot catch a symmetric bug.
set -euo pipefail
cd "$(dirname "$0")"

gen () {
  local name="$1" format="$2"; shift 2
  magick "$@" "${format}${name}.bmp"
  magick "${name}.bmp" -depth 8 "RGBA:${name}.rgba"
  printf '%-14s %s\n' "$name" "$(magick identify -format '%wx%h' "${name}.bmp")"
}

# 24-bit: the overwhelmingly common case.
gen rgb24 BMP3: -size 16x16 gradient:red-blue -depth 8 -alpha off
# Widths not divisible by 4: the row-padding trap. A 4-wide fixture passes while broken.
gen pad-3w BMP3: -size 3x5 gradient:lime-black -depth 8 -alpha off
gen pad-5w BMP3: -size 5x3 gradient:cyan-black -depth 8 -alpha off
gen pad-7w BMP3: -size 7x2 gradient:yellow-black -depth 8 -alpha off
# Palette: old screenshot tools. ImageMagick packs 16 colours into 4 bits per pixel, not
# 8, so this is the sub-byte index path. Rotated so the gradient runs LEFT TO RIGHT: a
# vertical gradient makes every row one colour, every nibble pair identical, and reading
# the two nibbles in the wrong order invisible.
gen palette8 BMP3: -size 16x16 gradient:red-yellow -rotate 90 -colors 16 -type Palette -depth 8 -alpha off
# 16-bit RGB565: the channel masks are not byte-aligned, so a field has to be shifted
# down and stretched back up to 0-255. Every other depth's masks are whole bytes and the
# stretch cancels out.
gen rgb565 BMP: -size 8x8 gradient:red-blue -rotate 90 -depth 8 -alpha off -define bmp:subtype=RGB565
# 32-bit with a real alpha channel.
gen rgba32 BMP: -size 16x16 gradient:'rgba(255,0,0,1)-rgba(0,0,255,0)' -depth 8 -define bmp:format=bmp4
# Odd size, photo-like.
gen photo-17x13 BMP3: -size 17x13 gradient:magenta-green -attenuate 0.5 +noise Gaussian -depth 8 -alpha off

echo
echo "regenerated. commit both the .bmp and the .rgba files."
