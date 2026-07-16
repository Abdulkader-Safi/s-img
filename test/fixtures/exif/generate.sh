#!/usr/bin/env bash
# Regenerates the EXIF orientation fixtures. See test/fixtures/png/generate.sh for why
# these are produced by ImageMagick rather than by our own code.
#
# decode() applies the orientation tag (features/decode.md), so each fixture pairs a JPEG
# carrying a tag with the pixels that tag is supposed to produce. The .rgba comes from
# ImageMagick's own -auto-orient, which makes it a real reference: match it and we are
# applying the tag the way the rest of the world does.
#
# The tag itself is written by splice.mjs, because ImageMagick cannot write one -- see the
# comment at the top of that file. Ours is the only EXIF *writer* in the loop, so the
# check below matters: ImageMagick must read back what we wrote, or the fixture is a
# fiction and every test built on it is testing our own bug twice.
set -euo pipefail
cd "$(dirname "$0")"

# 24x16, so every rotation changes the dimensions and a transposed result cannot pass by
# accident. Asymmetric content (plasma, not a gradient) so no two of the eight agree.
magick -size 24x16 plasma:fractal -alpha off -quality 95 src.jpg

# The eight orientations, by their EXIF value. The names are the ones the spec uses; the
# transform is what a viewer must apply to the STORED pixels to display them correctly.
#   1 none          2 mirror horizontal    3 rotate 180     4 mirror vertical
#   5 transpose     6 rotate 90 CW         7 transverse     8 rotate 270 CW
gen () {
  local n="$1" endian="${2:-II}" name="orient-$1${2:+-mm}"
  node splice.mjs src.jpg "${name}.jpg" "$n" "$endian"

  local read_back
  read_back="$(magick identify -format '%[EXIF:Orientation]' "${name}.jpg" 2>/dev/null || true)"
  if [ "$read_back" != "$n" ]; then
    echo "FAIL: wrote orientation $n, ImageMagick read back '${read_back}'" >&2
    exit 1
  fi

  magick "${name}.jpg" -auto-orient -depth 8 "RGBA:${name}.rgba"
  printf '%-14s tag=%s  %s -> %s\n' "$name" "$n" \
    "$(magick identify -format '%wx%h' "${name}.jpg")" \
    "$(magick "${name}.jpg" -auto-orient -format '%wx%h' info:)"
}

for n in 1 2 3 4 5 6 7 8; do gen "$n"; done

# Big-endian ("MM") TIFF header inside the EXIF. iPhones write these, and a reader that
# hardcodes little-endian reads orientation 6 as 1536 and silently does nothing.
gen 6 MM

# A photo with the location still in it: the privacy case features/strip-metadata.md is
# actually about. No .rgba -- the pixels are src.jpg's and are not what this one is for.
#
# Checked with exifr, not trusted, because the failure mode is silent and total: a fixture
# with no readable GPS in it sails through a "no GPS out" test while proving nothing.
node splice-gps.mjs src.jpg gps.jpg
found="$(node -e "import('exifr').then(async m=>{const g=await m.default.gps(require('fs').readFileSync('gps.jpg'));process.stdout.write(g?g.latitude.toFixed(4)+','+g.longitude.toFixed(4):'none')})")"
if [ "$found" != "33.8938,35.5018" ]; then
  echo "FAIL: exifr read '${found}' from gps.jpg, expected 33.8938,35.5018" >&2
  exit 1
fi
printf '%-14s exifr reads %s\n' "gps" "$found"

echo
echo "regenerated. commit the .jpg and .rgba files."
