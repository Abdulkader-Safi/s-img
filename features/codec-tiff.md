# TIFF codec

**Milestone 4. Depends on: [decode.md](decode.md), [encode.md](encode.md).**

## What it is

Read and write TIFF, common cases only: uncompressed and LZW. Prior art: UTIF.js, which
proves this is tractable in pure JS and is worth reading first.

TIFF is not a format, it is a container spec with a tag system, and "a TIFF" can be almost
anything. The scope discipline here matters more than the code.

## Decode

1. Byte order: `II` (little-endian) or `MM` (big-endian), then magic `42`. **Every
   subsequent read has to respect that endianness.** A reader that hardcodes LE works on
   most files and produces garbage on the rest, and it is the single most likely TIFF bug.
2. Offset to the first IFD (Image File Directory).
3. Walk the IFD: a count, then N 12-byte entries (tag, type, count, value-or-offset), then
   an offset to the next IFD.
4. Read the tags we care about:

| Tag | Name | Notes |
|---|---|---|
| 256 | ImageWidth | **size guard here** |
| 257 | ImageLength | |
| 258 | BitsPerSample | 8 supported; 1, 4, 16 see below |
| 259 | Compression | 1 = none, 5 = LZW, 7 = JPEG, 32773 = PackBits |
| 262 | PhotometricInterpretation | 0 = WhiteIsZero, 1 = BlackIsZero, 2 = RGB, 3 = palette |
| 273 | StripOffsets | where the data is |
| 277 | SamplesPerPixel | 1 = grey, 3 = RGB, 4 = RGBA |
| 278 | RowsPerStrip | |
| 279 | StripByteCounts | |
| 317 | Predictor | 2 = horizontal differencing, used with LZW |
| 338 | ExtraSamples | tells you if sample 4 is alpha and whether it is premultiplied |

5. Decompress each strip, concatenate, expand to RGBA.

### Compression

- **1, uncompressed.** Trivial.
- **5, LZW.** TIFF's LZW is *not* GIF's LZW — different code-width increment timing (the
  famous off-by-one that everyone hits), MSB-first bit packing, no sub-blocks. Do not try
  to share the implementation with [codec-gif.md](codec-gif.md); they look similar enough
  to tempt you and differ in exactly the ways that produce subtly corrupt output. Two
  small separate implementations beat one parameterised one here.
- **Predictor 2** (horizontal differencing) is common alongside LZW and must be undone
  after decompression or the image looks like a smear. Easy to forget because a
  predictor-1 file works fine without it.
- **32773, PackBits.** Simple RLE, ~20 lines. Include it, it is cheap and it turns up in
  scans.
- **7, JPEG-in-TIFF.** Out of scope per the PRD. It is technically a small job once
  [codec-jpeg.md](codec-jpeg.md) exists (hand the strip to the JPEG decoder), so note it as
  a cheap later win. Clear `UNSUPPORTED_FORMAT` for now.

### Scope limits (from the PRD, enforced here)

- **First IFD only.** Multi-page TIFF decodes page 0, no error. Same reasoning as animated
  GIF.
- **Strips, not tiles.** Tiled TIFF (tags 322/323) exists in GIS and huge-image workflows
  and is unlikely in a vault. Clear error.
- **8 bits per sample.** 16-bit truncates to 8 ([raw-image.md](raw-image.md)). 1-bit
  (fax/scan) is worth supporting if the PNG bit-unpacking is reusable — a 1-bit scan is a
  plausible vault file. 4-bit: skip.
- No CCITT G3/G4 fax compression. It is a whole codec for a narrow case. Clear error.

## Encode

One flavour: uncompressed or LZW (caller's choice, default LZW), RGB or RGBA, 8 bits per
sample, single strip, single IFD, little-endian, predictor 1.

Minimum viable tag set: ImageWidth, ImageLength, BitsPerSample, Compression,
PhotometricInterpretation, StripOffsets, SamplesPerPixel, RowsPerStrip, StripByteCounts, and
ExtraSamples when writing alpha. Nothing else. No EXIF IFD, no ICC, no software tag — which
means [strip-metadata.md](strip-metadata.md) is satisfied by construction on this codec.

Alpha *is* supported here (unlike BMP), via SamplesPerPixel 4 plus ExtraSamples 2
(unassociated / non-premultiplied), which matches [raw-image.md](raw-image.md)'s storage.

Lossless, so no quality option.

## Use cases

- Reading a scan or a photo from a camera that shoots TIFF and converting it to something
  a vault should actually hold.
- Lossless archival output where PNG is not wanted for some reason. Rare.
- Same shape as BMP: mostly a read-side compatibility feature.

## Edge cases

- **Big-endian (`MM`) files.** Test one. They are real (older Mac and print workflows) and
  they are the thing a hardcoded-LE reader silently mangles.
- **Predictor 2 with LZW.** Test one, or the smear ships.
- **Multiple strips.** The normal case, not the exception — RowsPerStrip is often 8 or 16,
  so a 3000px-tall image has hundreds of strips. A decoder that assumes one strip works on
  its own fixtures and fails on everything real.
- **StripOffsets with a single strip** is stored inline in the IFD entry rather than as an
  offset (because it fits in 4 bytes). The value-vs-offset rule (`count * typeSize <= 4`
  means the value is inline) applies to every tag and is TIFF's other classic bug.
- **PhotometricInterpretation 0** (WhiteIsZero) means the greyscale is inverted. Getting
  this wrong gives a negative image. Fax and scan files use it.
- **BigTIFF** (magic `43` instead of `42`, 64-bit offsets). Different format. Clear error.

## Acceptance

- Decodes: uncompressed RGB, LZW RGB, LZW with predictor 2, PackBits, greyscale,
  palette, big-endian, and a multi-strip file. Each its own fixture.
- A multi-page TIFF decodes page 0 with no error.
- WhiteIsZero greyscale decodes non-inverted.
- Encode → decode round-trip is byte-exact for both uncompressed and LZW.
- LZW output opens correctly in Preview and in an image tool that is not this library.
- Tiled TIFF, BigTIFF, JPEG-in-TIFF and CCITT each throw a specific, readable error naming
  what is unsupported.
