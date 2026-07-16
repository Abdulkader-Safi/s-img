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

   **Built: Loeffler, specifically libjpeg's `islow`, and the choice pays off twice.** It
   is exact integer arithmetic, so Node and Bun produce byte-identical output (verified by
   hashing a decode+encode on both) where a float AAN can disagree with itself between
   engines. And because `islow` is libjpeg's own default, our decode comes out
   **byte-identical to libjpeg on every fixture** rather than merely close. That turned the
   acceptance criterion below from a judgement call into an equality check.
6. **Upsample chroma.** 4:2:0 is the overwhelmingly common case: chroma planes are half
   resolution in both axes. Bilinear upsample, not nearest, or colour edges get chunky.

   **Built: the triangle filter libjpeg calls "fancy upsampling", and it must be ONE fused
   pass.** Doing the vertical half and then the horizontal half is the same filter on
   paper, but it rounds to 8 bits twice and the error compounds: it left ~15% of channels
   off by one against libjpeg while 4:2:2 and 4:4:4 were already exact. Both axes before
   the single divide makes 4:2:0 exact too.
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

## Multi-scan baseline: a gap the spec missed

**Not in the list above, and it should have been.** Baseline is *usually* one interleaved
scan carrying every component, but it is perfectly legal to send each component in its own
scan, and `cjpeg -scans` produces exactly that. A decoder that returns at the first `SOS`
decodes the luma, leaves both chroma planes at zero, and renders a vividly green image.

This was written that way and shipped green until mutation testing asked whether the
non-interleaved code path was reachable. It is: the fix is to keep walking markers to
`EOI`, decode every scan, and only inverse-transform once they are all in — plus a check
that every component was actually covered, since "I saw a scan" is no longer proof.

ImageMagick will not make one of these files. The fixture needs `cjpeg` and a scan script.

## Encode

Baseline only, and only one flavour:

- 4:2:0 chroma subsampling. (4:4:4 at `quality >= 90` is a nice-to-have; a lot of encoders
  do it because subsampling at high quality is a waste of the quality setting. Note it,
  do not block on it.)
- Standard Annex K Huffman tables, hardcoded. ~~Optimised per-image Huffman tables buy maybe
  2 to 5% and cost a second pass. Not worth it.~~

  **Built, and the 2 to 5% is wrong — measured against libjpeg on an 800x600 photo:**

  | quality | standard tables | optimised | saving |
  |---|---|---|---|
  | 95 | 108,568 B | 105,024 B | 3.3% |
  | 82 | 51,080 B | 47,811 B | 6.4% |
  | 50 | 25,422 B | 21,407 B | 15.8% |
  | 20 | 13,334 B | 8,338 B | **37.5%** |

  The estimate holds at high quality and collapses at low: the fewer coefficients survive
  quantisation, the worse the fixed tables fit what is left. And low quality is precisely
  the preset pipeline's main job — re-encoding to shrink a vault attachment. 37% is not a
  rounding error.

  Still shipped with standard tables, because that decision was made on a wrong number and
  should be re-made deliberately rather than mid-branch. Tracked as its own task.
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
  within a small per-channel delta of a reference decoder. **Built: exceeded — every
  fixture is byte-identical to libjpeg, so the tests assert equality rather than a delta.
  "A couple of units" is exactly the width a real bug hides in.**

  The fixture source must vary in **both** axes. These started as ImageMagick `gradient:`,
  which runs top to bottom, so chroma was constant along every row — and 4:2:2 upsamples
  *horizontally*, so the entire filter could be swapped for nearest-neighbour with every
  test still passing. Now `plasma:`. (Same hole as a vertical palette gradient hiding a
  nibble-order bug in the BMP fixtures. It is a recurring one.)
- A 17×13 image round-trips with no edge garbage.
- `quality: 80` output is within ~10% of libjpeg's file size for the same input, and
  visually indistinguishable. This is the check that the quant-table scaling is right.
  **Built: 0.17% at quality 82.** Pinned in CI against a committed libjpeg-encoded
  reference, and **at two qualities, not one**: libjpeg's curve has two branches (linear
  from 50 to 100, hyperbolic `5000/q` below it), so a reference at 82 alone leaves the
  whole low-quality half unchecked. Flattening the curve to one branch passed every other
  test in the suite.

  Compare with `jpeg:optimize-coding=false`, or the comparison is against a different
  feature: ImageMagick turns optimised Huffman tables on by default and we ship the
  standard ones.
- Greyscale JPEG decodes to RGBA with R === G === B.
- A progressive JPEG throws a clear, specific error (until progressive lands, then it
  decodes).
- An iPhone JPEG with orientation 6 comes out upright.
