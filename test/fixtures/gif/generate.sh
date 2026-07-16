#!/usr/bin/env bash
# Regenerates the GIF reference fixtures. See test/fixtures/png/generate.sh for why these
# are produced by ImageMagick rather than by our own encoder.
#
# GIF decode is EXACT: indices map through a palette, so unlike JPEG there is no tolerance
# to argue about. The .rgba files are a byte-for-byte target.
#
# The reference is taken with -coalesce, NOT a plain decode. A GIF frame can be smaller
# than the logical screen and sit at an offset, and ImageMagick's plain decode hands back
# the FRAME (8x8), while the file plainly declares a 20x20 image. -coalesce composites the
# frame onto the logical screen, which is what codec-gif.md specifies, what a browser
# renders, and what the file means. On a fixture whose frame already fills the screen it
# changes nothing.
set -euo pipefail
cd "$(dirname "$0")"

# $1 name, $2 output format prefix ('' or 'GIF87:'), rest: the ImageMagick recipe.
# The prefix has to attach to the OUTPUT filename; passed as a bare argument it is an
# input, and ImageMagick sits waiting on stdin forever.
gen () {
  local name="$1" format="$2"; shift 2
  magick "$@" "${format}${name}.gif"
  magick "${name}.gif" -coalesce -depth 8 "RGBA:${name}.rgba"
  printf '%-14s %s\n' "$name" "$(magick identify -format '%wx%h page=%g' "${name}.gif[0]")"
}

# The ordinary case: 89a, global colour table, no transparency.
gen basic '' -size 32x32 plasma:fractal -colors 64
# 87a: the older header, two bytes different.
gen gif87a GIF87: -size 16x16 plasma:fractal -colors 16
# Transparency: one palette index is the transparent one.
gen transparent '' -size 16x16 xc:none -fill red -draw 'circle 8,8 8,3'
# Interlaced: rows arrive in 4 passes. Reading them in order shreds the image into bands.
gen interlaced '' -size 32x32 plasma:fractal -colors 32 -interlace GIF
# Few colours, so an exact-palette round-trip has something to be exact about.
gen flat '' -size 8x8 xc:'#ff0000' -fill '#00ff00' -draw 'rectangle 0,0 3,3'
# A frame smaller than the logical screen, placed at an offset. The image descriptor has
# its own x/y/w/h, and the LOGICAL SCREEN size is what the file means by its size.
#
# It must be -repage. Compositing onto a 20x20 canvas first (the obvious recipe) makes
# ImageMagick flatten it to a full-size 20x20 frame at 0,0 -- a fixture that looks right in
# the listing and tests nothing at all.
#
# NO .rgba, deliberately: this is the one fixture where ImageMagick is not our reference.
# It fills the uncovered area with the GIF background colour (red, here) and we leave it
# transparent. Checked against Chromium, which is what Obsidian renders with, and it agrees
# with us: 20x20, rgba(0,0,0,0) outside the frame, red inside. See codec-gif.md. The test
# asserts that behaviour directly instead of diffing bytes.
magick -size 8x8 xc:red -repage 20x20+6+5 offset-frame.gif
printf '%-14s %s\n' "offset-frame" "$(magick identify -format '%wx%h page=%g' offset-frame.gif) (no .rgba: see codec-gif.md)"

# Animated: we decode frame 0 and ignore the rest, deliberately and without erroring.
magick -delay 10 -size 16x16 xc:red xc:lime xc:blue -loop 0 animated.gif
magick animated.gif -coalesce -depth 8 RGBA:animated-all.rgba
# Frame 0 only: the first 16*16*4 bytes of the coalesced sequence.
dd if=animated-all.rgba of=animated.rgba bs=1024 count=1 2>/dev/null
rm -f animated-all.rgba
printf '%-14s %s\n' "animated" "$(magick identify animated.gif | wc -l | tr -d ' ') frames, we decode the first"

echo
echo "regenerated. commit the .gif and .rgba files."
