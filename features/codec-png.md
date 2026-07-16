# PNG codec

**Milestone 1. Depends on: [decode.md](decode.md), [encode.md](encode.md).**

## What it is

Read and write PNG. The easiest format in pure JS, because the hard part (DEFLATE) is
`node:zlib`, which exists on Node and Bun. This is the first codec to build: it gives the
whole pipeline a lossless round-trip to test against, so every other feature can be verified
without a JPEG's lossy noise in the way.

## Decode

1. Check the 8-byte signature.
2. Walk chunks: length, type, data, CRC. We care about `IHDR`, `PLTE`, `tRNS`, `IDAT`,
   `IEND`. Everything else (`gAMA`, `pHYs`, `tEXt`, `iCCP`, …) is skipped — it is metadata
   and we do not preserve metadata.
3. From `IHDR`: width, height, bit depth, colour type, interlace. **Run the size guard
   here**, before allocating.
4. Concatenate all `IDAT` payloads, inflate with `zlib.inflateSync`.
5. Undo the per-scanline filter. Each row is prefixed by a filter-type byte: 0 None,
   1 Sub, 2 Up, 3 Average, 4 Paeth. This is the one genuinely fiddly loop in PNG decoding
   and the one place to be careful about performance, because it is a tight per-byte loop
   over the entire image with a data dependency on the previous pixel and the previous row.
6. Expand to RGBA. Colour types: 0 greyscale, 2 truecolour, 3 palette, 4 greyscale+alpha,
   6 truecolour+alpha. Each expands differently, palette needs `PLTE` plus optional `tRNS`
   for per-entry alpha.

**CRC checking:** verify it. It is a cheap table-driven loop and it is the difference
between "this file is corrupt" and silently editing garbage. On mismatch throw
`CORRUPT_IMAGE`.

## Supported on read

- Bit depths 1, 2, 4, 8, 16. Sub-8-bit needs bit unpacking; 16-bit truncates to 8 (see
  [raw-image.md](raw-image.md)).
- All five colour types.
- Adam7 interlace. Annoying — seven passes with their own strides — but it exists in real
  files and a decoder that chokes on it is a bug report waiting. Implement it; it is
  contained and testable.

## Encode

Deliberately narrow. We write exactly one flavour:

- 8-bit RGBA, colour type 6, non-interlaced.
- One `IDAT`, deflated with `zlib.deflateSync` at level 9.
- Chunks written: `IHDR`, `IDAT`, `IEND`. Nothing else. No metadata, by construction.

**Filter choice:** the classic quality/speed tradeoff. Options, in order of laziness:
1. Filter type 0 (None) on every row. Simplest, worst compression, meaningfully bigger files.
2. Paeth (4) on every row. One line of change from option 1, usually near-optimal for
   photos, and what most fast encoders default to.
3. The libpng adaptive heuristic: try all five per row, pick the one with the lowest sum of
   absolute differences. 5× the filter cost for maybe 5 to 10% smaller output.

**Start with Paeth-always.** It is one heuristic, not five, and PNG is not the format
anyone reaches for when they care about bytes — that is what the JPEG and WebP paths are
for. Revisit only if a real file measurably disappoints.

## Not doing

- Writing palette PNGs, even when the image has ≤256 colours and would shrink a lot. That
  is a quantiser plus a palette builder, which is real work for a case (screenshots, line
  art) the user could get better results from as a GIF or WebP. Note it as a possible
  later win.
- 16-bit output.
- APNG.
- Preserving any ancillary chunk on round-trip.

## Use cases

- The default lossless output. Crop a screenshot, save as PNG, no generational loss.
- The test substrate: every transform's unit test round-trips through PNG because it is the
  only format that guarantees byte-exact pixels.
- Transparency-preserving output after an arbitrary-angle rotate ([rotate.md](rotate.md)).

## Edge cases

- **Zero-length `IDAT` / no `IDAT`.** `CORRUPT_IMAGE`.
- **`IDAT` split across many chunks.** Normal and common. Concatenate before inflating; do
  not inflate each chunk separately, the DEFLATE stream spans them.
- **Chunks after `IEND`.** Ignore.
- **Truncated inflate stream.** zlib throws; catch and wrap as `CORRUPT_IMAGE`.
- **Palette index out of range.** Throw rather than reading past the palette.

## Acceptance

- Decodes a PngSuite-style fixture set: all colour types, bit depths 1/2/4/8/16,
  interlaced and not, and one image with `tRNS`.
- Encode → decode round-trip is byte-exact on the pixel buffer for a 256×256 RGBA image.
- A file with one flipped bit in an `IDAT` CRC throws `CORRUPT_IMAGE`.
- Decoding a 1×1 fully-transparent PNG yields `[0,0,0,0]`.
