#!/usr/bin/env bash
# Regenerates the TIFF reference fixtures. See test/fixtures/png/generate.sh for why these
# are produced by ImageMagick rather than by our own encoder.
#
# TIFF decode is EXACT -- every supported compression here is lossless -- so the .rgba
# files are a byte-for-byte target.
#
# TIFF is not a format, it is a container spec with a tag system, and "a TIFF" can be
# almost anything. Each fixture below pins one specific variant we claim to read; the
# structural facts each one is supposed to exercise are asserted in the test rather than
# trusted, because it is very easy to ask ImageMagick for a variant and quietly get
# another.
set -euo pipefail
cd "$(dirname "$0")"

# -depth 8 is on almost every recipe below for a reason: ImageMagick writes SIXTEEN bits
# per sample by default, for RGB as well as greyscale. Every fixture here was 16-bit on the
# first attempt, so the whole 8-bit path -- the one virtually every real TIFF uses -- went
# untested while the tests looked green.
gen () {
  local name="$1"; shift
  magick "$@" "${name}.tif"
  magick "${name}.tif[0]" -depth 8 "RGBA:${name}.rgba"
  printf '%-14s %s\n' "$name" "$(magick identify -format '%wx%h %[tiff:endian] %C' "${name}.tif[0]")"
}

# Uncompressed RGB: the trivial case.
gen rgb-none -size 16x16 plasma:fractal -depth 8 -alpha off -compress None
# LZW: TIFF's LZW is NOT GIF's LZW, and the differences are exactly the ones that produce
# subtly corrupt output rather than obvious failure.
#
# predictor=1 must be asked for EXPLICITLY. ImageMagick turns predictor 2 on by default
# with LZW, so the obvious recipe gives two fixtures of the same variant and leaves the
# plain path -- the one every other TIFF writer uses -- untested.
gen rgb-lzw -size 16x16 plasma:fractal -depth 8 -alpha off -compress LZW -define tiff:predictor=1
# LZW with predictor 2 (horizontal differencing). Common, and forgetting to undo it makes
# the image a smear -- but a predictor-1 file decodes fine without the code, so nothing
# catches it unless this fixture exists.
gen rgb-lzw-pred -size 32x32 plasma:fractal -depth 8 -alpha off -compress LZW -define tiff:predictor=2
# PackBits: simple RLE, turns up in scans.
gen rgb-packbits -size 16x16 plasma:fractal -depth 8 -alpha off -compress RLE
# Big-endian. Real (older Mac and print workflows), and the single most likely TIFF bug: a
# reader that hardcodes little-endian works on most files and mangles these.
gen rgb-be -size 16x16 plasma:fractal -depth 8 -alpha off -compress None -endian MSB
# Greyscale, one sample per pixel. -depth 8 must be explicit: ImageMagick writes 16-bit
# greyscale by default, so the plain recipe silently tests the 16-bit path instead.
gen grey -size 16x16 gradient:white-black -colorspace Gray -depth 8 -alpha off -compress None
# 16 bits per sample, which truncates to 8 (raw-image.md). Big-endian as well as little,
# because the high byte of a 16-bit sample is the one we keep and which end it sits on is
# decided by the file's byte order -- read it from the wrong end and every channel is noise.
gen grey16 -size 16x16 gradient:white-black -colorspace Gray -depth 16 -alpha off -compress None
gen rgb16 -size 16x16 plasma:fractal -depth 16 -alpha off -compress None
gen rgb16-be -size 16x16 plasma:fractal -depth 16 -alpha off -compress None -endian MSB
# PhotometricInterpretation 0: WhiteIsZero, an INVERTED greyscale. Getting it wrong gives a
# negative image. Fax and scan files use it.
#
# The .rgba comes back as the NEGATIVE of the source gradient, which is correct and not a
# mistake: ImageMagick stores the samples un-inverted and just sets the tag, so its own read
# inverts them. That is exactly what makes this a fixture -- match ImageMagick and you are
# applying the tag; ignore the tag and you are 255 out on every pixel.
gen grey-wiz -size 16x16 gradient:white-black -colorspace Gray -depth 8 -alpha off -compress None -define quantum:polarity=min-is-white
# 1 bit per sample: a scan. -depth 1 must be explicit or -monochrome still writes 16-bit.
gen bilevel -size 16x16 plasma:fractal -monochrome -depth 1 -compress None
# Palette.
gen palette -size 16x16 plasma:fractal -alpha off -colors 16 -type Palette -compress None
# RGBA: alpha IS supported here, unlike BMP.
gen rgba -size 16x16 plasma:fractal -depth 8 -alpha set -channel A -evaluate set 50% +channel -compress None
# Multiple strips: the NORMAL case, not the exception. RowsPerStrip is often 8 or 16, so a
# tall image has hundreds. A decoder that assumes one strip passes its own fixtures and
# fails on everything real.
gen multistrip -size 32x64 plasma:fractal -depth 8 -alpha off -compress None -define tiff:rows-per-strip=8
# ...and a height that is NOT a multiple of RowsPerStrip, so the last strip is a short one.
# 64 rows in strips of 8 divides exactly, which means the "how many rows are left" clamp is
# never exercised and can be deleted with every test still passing. 60 leaves 4.
gen multistrip-odd -size 32x60 plasma:fractal -depth 8 -alpha off -compress None -define tiff:rows-per-strip=8

# Multi-page: we decode page 0 and ignore the rest, deliberately.
magick -size 16x16 xc:red -size 16x16 xc:lime multipage.tif
magick 'multipage.tif[0]' -depth 8 RGBA:multipage.rgba
printf '%-14s %s\n' "multipage" "$(magick identify multipage.tif | wc -l | tr -d ' ') pages, we decode the first"

# Variants that must each throw a specific, readable error naming what is unsupported.
magick -size 16x16 plasma:fractal -alpha off -compress JPEG jpeg-in-tiff.tif
magick -size 16x16 plasma:fractal -alpha off -compress None -define tiff:tile-geometry=16x16 tiled.tif
magick -size 16x16 xc:white -monochrome -compress Group4 ccitt.tif
printf '%-14s %s\n' "unsupported" "jpeg-in-tiff, tiled, ccitt (no .rgba: expected to throw)"

echo
echo "regenerated. commit the .tif and .rgba files."
