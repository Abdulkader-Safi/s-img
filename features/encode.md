# encode()

**Milestone 1. Depends on: [raw-image.md](raw-image.md), [errors.md](errors.md).**

## What it is

`RawImage` in, bytes out. The mirror of [decode.md](decode.md).

```typescript
function encode<F extends Format>(
  image: RawImage,
  format: F,
  opts?: FormatOptions<F>,
): Promise<Uint8Array>;
```

`FormatOptions<F>` is format-conditional so `quality` only exists on the lossy formats.
(This file originally called it `EncodeOptions`; [type-safety.md](type-safety.md),
[format-quality.md](format-quality.md) and [pipeline-order.md](pipeline-order.md) all called
it `FormatOptions`, and it is the better name because it is what both doors take —
`encode(img, 'jpeg', …)` and `.toFormat('jpeg', …)`. One type, one name.)
That whole mechanism lives in [type-safety.md](type-safety.md) and
[format-quality.md](format-quality.md); this file is about the encoding itself.

Returns `Uint8Array`, not `Buffer`. The `fs` boundary converts if it wants to
([file-io.md](file-io.md)); the core stays runtime-neutral.

## Codec interface

```typescript
interface Encoder {
  encode(image: RawImage, opts: ResolvedEncodeOptions): Uint8Array;
}
```

Symmetric with `Decoder`, one module per format, `encode` is a dispatch table.

## What the encoder has to handle

- **Alpha loss.** JPEG and BMP have no alpha (BMP technically can, we do not write it).
  The image arriving may well have transparent pixels — a rotated PNG has transparent
  corners. Compositing them onto the background colour is the encoder's job, not a thing we
  ask every caller to remember. Default background is white, configurable via
  `background`, and it is the same option and the same default as rotation's fill colour so
  a user does not learn two rules. See [rotate.md](rotate.md).
- **Colour reduction.** GIF is 256 colours. The quantiser lives in
  [codec-gif.md](codec-gif.md), but the point is that the caller does not opt in; asking
  for a GIF means accepting the quantise.
- **Metadata.** By default we write no EXIF, no GPS, no ICC. There is nothing to preserve:
  decode already dropped it and applied the orientation. So `stripMetadata()` is
  effectively the default behaviour and the method exists mainly as an explicit statement of
  intent. See [strip-metadata.md](strip-metadata.md) for why it still deserves to be a
  method and what would change if we ever preserved metadata.

## Use cases

- End of every pipeline. `.toFormat('jpeg', { quality: 82 }).toBuffer()` bottoms out here.
- Format conversion: the only thing that makes a TIFF a PNG is which encoder ran.
- Batch: the same encoder called N times with the same options, once per file.

## Edge cases

- **1×1 images.** Every encoder must handle them. JPEG's MCU padding and GIF's LZW
  minimum code size both have degenerate paths at tiny sizes and both are easy to get
  wrong.
- **Fully transparent image to JPEG.** Composites to a solid background rectangle. Correct,
  if surprising. Not our problem to second-guess.
- **Very wide or very tall.** A 20000×1 image is legal. Encoders that assume a minimum
  dimension for a block or a stride break here. Fixture it.
- **Encoder throws.** Wrap in `ENCODE_FAILED` with the cause attached, never let a raw
  `RangeError` from a typed-array write escape.

## Acceptance

- Every format: decode fixture → encode → decode again → dimensions match and pixels match
  within the format's expected tolerance (exact for PNG/BMP/TIFF, a small per-channel delta
  for JPEG, zero for GIF only if the source is already ≤256 colours).
- An RGBA image with transparent regions encoded to JPEG produces white where the
  transparency was, and the configured colour when `background` is set.
- 1×1 round-trips in every format.
