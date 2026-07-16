# JPEG codec

**Milestone 2. Depends on: [decode.md](decode.md), [encode.md](encode.md).**

## What it is

Baseline DCT read and write. The biggest, gnarliest pure JS codec in the set, and the one
that matters most: an Obsidian vault is mostly photos, and photos are mostly JPEG.

Prior art: jpeg-js. Reading it is worth a day before writing a line, not to copy but to see
which parts of the spec real files actually exercise.

## Decode

The pipeline, in order:

1. **Marker parse.** Segments framed by `FF xx`. The ones we need: `SOI`, `APPn`
   (skipped, that is EXIF and we do not preserve it — except `APP1`/EXIF gets read *only*
   for the orientation tag, see below), `DQT` (quantisation tables), `SOF0` (baseline
   frame header: dimensions, components, sampling factors), `SOF2` (progressive — see
   below), `DHT` (Huffman tables), `SOS` (start of scan), `DRI` (restart interval), `EOI`.
2. **Size guard** off `SOF`, before allocation.
3. **Huffman decode** the entropy-coded data into coefficient blocks. A bit reader with
   byte stuffing (`FF 00` means a literal `FF`) and restart-marker handling.
4. **Dequantise** each 8×8 block against its table.
5. **Inverse DCT.** Use the AAN or Loeffler fast integer IDCT, not the naive O(n⁴)
   double loop. This is the hot loop of the whole library; the naive version is roughly an
   order of magnitude slower and there is no reason to write it.
6. **Upsample chroma.** 4:2:0 is the overwhelmingly common case: chroma planes are half
   resolution in both axes. Bilinear upsample, not nearest, or colour edges get chunky.
7. **YCbCr → RGB**, integer approximation, per the JFIF coefficients.
8. **Apply EXIF orientation** ([decode.md](decode.md)) and drop the rest of the metadata.

## Progressive JPEG

Not in the baseline spec of this milestone, but **real files are progressive**. A large
share of web-sourced JPEGs are, and a decoder that throws on them will generate bug reports
in week one.

Options: implement progressive (successive approximation and spectral selection, a genuine
chunk of work), or detect `SOF2` and throw a clear `UNSUPPORTED_FORMAT` saying "progressive
JPEG is not supported yet".

**Ship baseline first with the clear error, then add progressive before the plugin swap
in milestone 7.** It is a real gap and it needs to close, but it should not block the rest
of the pipeline from existing. Track it as its own task.

Arithmetic-coded JPEG: do not implement. Vanishingly rare, patent-shadowed history, nobody
produces them. Clear error is fine forever.

## Encode

Baseline only, and only one flavour:

- 4:2:0 chroma subsampling. (4:4:4 at `quality >= 90` is a nice-to-have; a lot of encoders
  do it because subsampling at high quality is a waste of the quality setting. Note it,
  do not block on it.)
- Standard Annex K Huffman tables, hardcoded. Optimised per-image Huffman tables buy maybe
  2 to 5% and cost a second pass. Not worth it.
- Quantisation tables scaled from the standard Annex K tables by the quality value, using
  the libjpeg scaling formula. Do not invent a scaling curve; use libjpeg's, because
  `quality: 80` needs to mean roughly what `quality: 80` means everywhere else in the
  world or every user expectation is wrong.
- Forward DCT: the same fast integer transform as the decoder, in reverse.
- No EXIF, no thumbnail, no ICC. A bare JFIF `APP0` and nothing else.

**Alpha:** JPEG has none. Composite onto `background` (default white) at the encoder
boundary — see [encode.md](encode.md).

## Quality

1–100, only meaningful here and on WebP. Enforced by the type system: `.toFormat('png',
{ quality })` must not compile. See [type-safety.md](type-safety.md).

Default when unspecified: **82**. High enough that nobody complains about artifacts,
low enough that it is meaningfully smaller than 95, and it is roughly where the rest of the
ecosystem sits.

## Edge cases

- **Dimensions not a multiple of 8 (or 16 with subsampling).** The encoder pads to the MCU
  boundary and the decoder crops back. Getting this wrong shows as a garbage strip on the
  right or bottom edge, and it only shows on images whose size is not a round number, which
  is to say: not the ones in the test fixtures unless you deliberately add them. Fixture a
  17×13 image.
- **Restart markers.** Present in some encoders' output. Handle `DRI` and `RSTn` or those
  files decode as noise after the first restart interval.
- **CMYK / YCCK JPEG.** From print workflows, with an Adobe `APP14` marker, and often
  inverted. Convert naively, document the lack of colour management, do not fail.
- **Greyscale JPEG (1 component).** Common. Expand to RGBA.
- **Truncated scan data.** Throw `CORRUPT_IMAGE`. Many viewers show a partial image; we do
  not, because a half-image silently saved over the original is data loss.
- **1×1 JPEG.** One MCU, mostly padding. Round-trip it in tests.

## Use cases

- Photo editing, the plugin's dominant case.
- Re-encoding at lower quality to shrink a vault attachment — the preset pipeline's main job.
- Converting a screenshot PNG to JPEG for size.

## Acceptance

- Decodes 4:2:0, 4:2:2 and 4:4:4 baseline fixtures with correct dimensions and pixels
  within a small per-channel delta of a reference decoder.
- A 17×13 image round-trips with no edge garbage.
- `quality: 80` output is within ~10% of libjpeg's file size for the same input, and
  visually indistinguishable. This is the check that the quant-table scaling is right.
- Greyscale JPEG decodes to RGBA with R === G === B.
- A progressive JPEG throws a clear, specific error (until progressive lands, then it
  decodes).
- An iPhone JPEG with orientation 6 comes out upright.
