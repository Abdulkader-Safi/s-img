# BMP codec

**Milestone 4. Depends on: [decode.md](decode.md), [encode.md](encode.md).**

## What it is

Read and write BMP. Trivial once the pixel pipeline exists: no compression, no entropy
coding, essentially a header followed by the pixels. Build it early if a morale win is
needed; it is an afternoon.

## Decode

1. File header (14 bytes): `BM`, file size, offset to the pixel data.
2. DIB header. The size field tells you which one: `BITMAPINFOHEADER` (40 bytes) is
   ~everything real; `BITMAPV4HEADER` (108) and `BITMAPV5HEADER` (124) are supersets and
   can be read as an INFOHEADER plus ignored trailing fields. `BITMAPCOREHEADER` (12) is
   from 1990 and can be skipped with a clear error.
3. **Size guard** off the header dimensions, before allocation.
4. Pixel data at the declared offset.

Bit depths to support on read: **24 and 32** (the real world), plus **8-bit palette**
(screenshots from old tools). 1-bit and 4-bit exist; support them if the unpacking code from
[codec-png.md](codec-png.md) is reusable, otherwise a clear error is defensible.

Three specifics that will each bite once:

- **Rows are stored bottom-up** when `height` is positive, top-down when it is *negative*.
  Yes, a negative height is the flag. Normalise to top-down at this boundary
  ([raw-image.md](raw-image.md) has no stride or orientation field, deliberately).
- **Rows are padded to a 4-byte boundary.** A 3-pixel-wide 24-bit image has 9 bytes of
  pixels and 3 bytes of padding per row. Ignoring this shears the image diagonally, which is
  a memorable bug.
- **Channel order is BGR(A), not RGB(A).** Swap on read and write.

`BI_RLE8` / `BI_RLE4` compression: rare, and a clear `UNSUPPORTED_FORMAT` is fine.
`BI_BITFIELDS` (16-bit with custom masks): also rare; error is fine unless a real file
turns up.

## Encode

One flavour only: 24-bit `BI_RGB`, `BITMAPINFOHEADER`, top-down or bottom-up (pick
bottom-up, positive height, the maximally-compatible option), rows padded to 4 bytes.

**No alpha.** 32-bit BMP with alpha exists but support for it across viewers is a mess —
plenty of software reads the alpha channel as garbage or ignores it. Writing 24-bit means
compositing onto `background` at the encoder ([encode.md](encode.md)), same as JPEG. That
is the boring, correct choice.

No quality option: BMP is lossless and uncompressed. `.toFormat('bmp', { quality })` is a
compile error ([type-safety.md](type-safety.md)).

## Why support it at all

Honestly: because it is nearly free once the pipeline exists, and because BMPs do turn up in
vaults from old Windows tooling and scanners. Nobody chooses BMP as an output format on
purpose. It is a read-side compatibility feature with the write side thrown in because the
encoder is 40 lines.

## Use cases

- Reading a legacy BMP from a scanner or an old screenshot tool and converting it to
  literally anything else. This is 95% of BMP's value here.
- A lossless, zero-CPU intermediate. Marginal, but real for a debugging dump.

## Edge cases

- **Negative height** → top-down rows. Fixture it, it is the classic.
- **Row padding on widths not divisible by 4.** Fixture a 3px-wide and a 5px-wide image.
  A 4px-wide fixture will pass while the code is broken.
- **The pixel data offset** in the file header is authoritative and can be *past* the end of
  the DIB header (there can be a gap). Seek to it; do not assume the pixels start right after
  the header.
- **32-bit BMP where the alpha channel is all zeros.** Common, and means "no alpha" not
  "fully transparent". If every alpha byte is 0, treat the image as opaque. Otherwise a
  perfectly good BMP decodes to an invisible image, which is a real bug in real libraries.
- **File size field disagrees with the actual length.** Ignore it, trust the actual bytes.

## Acceptance

- Decodes 24-bit, 32-bit and 8-bit-palette fixtures.
- Decodes a bottom-up and a top-down (negative height) fixture to the same pixels.
- Decodes 3px and 5px wide images with no diagonal shear (the padding test).
- A 32-bit BMP with an all-zero alpha channel decodes as fully opaque.
- Encode → decode round-trip is byte-exact on RGB for an opaque image.
- Channel order verified: a pure-red fixture decodes to `[255,0,0,255]`, not `[0,0,255,255]`.
