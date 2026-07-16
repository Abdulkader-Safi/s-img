#!/usr/bin/env bash
# Regenerates the JPEG reference fixtures. See test/fixtures/png/generate.sh for why these
# are produced by ImageMagick rather than by our own encoder.
#
# JPEG is lossy, so unlike the PNG and BMP fixtures the .rgba files are NOT a byte-exact
# target: two conforming decoders disagree by a unit or two per channel, because the IDCT
# is specified to a tolerance rather than to the bit. The tests compare within a small
# per-channel delta. What must match exactly is dimensions, component count and structure.
set -euo pipefail
cd "$(dirname "$0")"

gen () {
  local name="$1"; shift
  magick "$@" "${name}.jpg"
  magick "${name}.jpg" -depth 8 "RGBA:${name}.rgba"
  printf '%-16s %s\n' "$name" "$(magick identify -format '%wx%h %[jpeg:sampling-factor]' "${name}.jpg")"
}

# The three chroma subsamplings. 4:2:0 is the overwhelmingly common case; the other two
# exercise different MCU geometry, and a decoder hardcoded to 4:2:0 passes on 4:2:0 alone.
#
# The source MUST vary in BOTH axes, which is why it is plasma and not the `gradient:` these
# started as. ImageMagick's gradient runs top to bottom, so chroma was constant along every
# row -- and 4:2:2 upsamples HORIZONTALLY, so the whole filter could be replaced with
# nearest-neighbour and every test still passed. Same hole as a vertical palette gradient
# hiding a nibble-order bug in the BMP fixtures.
gen s420 -size 32x32 plasma:fractal -sampling-factor 2x2 -quality 90
gen s422 -size 32x32 plasma:fractal -sampling-factor 2x1 -quality 90
gen s444 -size 32x32 plasma:fractal -sampling-factor 1x1 -quality 90
# Dimensions not a multiple of 8 or 16: the encoder pads to the MCU boundary and the
# decoder crops back. Getting it wrong shows as a garbage strip on the right or bottom,
# and ONLY on sizes that are not round numbers.
gen odd-17x13 -size 17x13 gradient:magenta-green -sampling-factor 2x2 -quality 90
# A baseline file that sends each component in its OWN scan, rather than one interleaved
# scan. Legal, rare, and ImageMagick will not make one -- this needs cjpeg with a scan
# script. A decoder that stops at the first SOS decodes the luma and leaves both chroma
# planes at zero, which is a vividly green image, and no ordinary fixture catches it.
magick -size 24x24 plasma:fractal -depth 8 noninter-src.ppm
printf '0: 0 63 0 0;\n1: 0 63 0 0;\n2: 0 63 0 0;\n' > noninter-scans.txt
cjpeg -quality 90 -sample 2x2 -scans noninter-scans.txt -outfile noninter.jpg noninter-src.ppm
magick noninter.jpg -depth 8 RGBA:noninter.rgba
rm -f noninter-src.ppm noninter-scans.txt
printf '%-16s %s\n' "noninter" "$(magick identify -format '%wx%h' noninter.jpg) (3 separate scans)"
# One MCU, almost entirely padding.
gen tiny-1x1 -size 1x1 xc:'rgb(200,100,50)' -quality 90
# Greyscale: one component, common, and expands to RGBA with R === G === B.
gen grey -size 24x24 gradient:white-black -colorspace Gray -quality 90
# Restart markers: some encoders emit them, and without DRI/RSTn handling the image
# decodes as noise after the first interval.
gen restart -size 48x48 plasma:fractal -define jpeg:restart-interval=2 -quality 90
# Photo-like noise: real high-frequency content, unlike a smooth gradient.
gen photo -size 40x28 plasma:fractal -quality 85

# The quant-table scaling check. `quality: 80` has to mean roughly what it means in every
# other tool, and the only way to know is to compare our file size to libjpeg's for the
# same pixels. Big enough (256x256) that the ~600 bytes of fixed header do not dominate
# and hide a scan-data problem.
#
# No .rgba needed: our decode is bit-exact with libjpeg, so decoding qsource.jpg gives us
# exactly the pixels ImageMagick fed its own encoder to make qref-82.jpg.
#
# optimize-coding=false is NOT us tilting the field. ImageMagick turns optimized Huffman
# tables on by default and we ship the standard Annex K ones (codec-jpeg.md: not worth a
# second pass), so leaving it on would compare two different features. See the note in
# codec-jpeg.md: that default is worth more than the spec assumed.
magick -size 256x256 plasma:fractal -blur 0x1 -quality 95 -sampling-factor 2x2 qsource.jpg
magick qsource.jpg -quality 82 -sampling-factor 2x2 -define jpeg:optimize-coding=false qref-82.jpg
# And one BELOW 50, because libjpeg's quality curve has two branches: it falls linearly to
# zero from 50 to 100, and runs away hyperbolically (5000/q) below 50. A reference at 82
# alone leaves the entire low-quality half of the curve unchecked -- and low quality is the
# preset pipeline's main job, shrinking a vault attachment.
magick qsource.jpg -quality 20 -sampling-factor 2x2 -define jpeg:optimize-coding=false qref-20.jpg
printf '%-16s %s\n' "qsource/qref" "$(stat -f%z qref-82.jpg) bytes at q82, $(stat -f%z qref-20.jpg) at q20"

# Progressive: must throw a clear error until progressive lands.
magick -size 32x32 gradient:red-blue -interlace Plane -quality 90 progressive.jpg
printf '%-16s %s\n' "progressive" "(no .rgba: expected to throw)"

echo
echo "regenerated. commit the .jpg and .rgba files."
