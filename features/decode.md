# decode()

**Milestone 1. Depends on: [raw-image.md](raw-image.md), [errors.md](errors.md).**

## What it is

Bytes in, `RawImage` out. Sniffs the format from magic bytes, dispatches to a codec,
normalises whatever the codec produces into RGBA.

```typescript
function decode(bytes: Uint8Array, opts?: DecodeOptions): Promise<RawImage>;

interface DecodeOptions {
  /** Downsample during decode so the long edge lands at or under this. See fast-decode.md. */
  maxLongEdge?: number;
  /** Skip the format sniff and force a codec. Escape hatch, rarely correct. */
  format?: Format;
  /** Refuse to allocate a canvas larger than this many pixels. Default 20000 * 20000. */
  maxPixels?: number;
}
```

Async because WebP's codec arrives via dynamic import. See Q3 in
[api-surface.md](api-surface.md) — the recommendation there is async everywhere rather than
a sync/async split that leaks the WebP special case into every call site.

## Format sniffing

The extension is a lie. The header is the truth. Sniff on magic bytes, always:

| Format | Bytes |
|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |
| GIF | `47 49 46 38` (`GIF8`, covers 87a and 89a) |
| BMP | `42 4D` (`BM`) |
| TIFF | `49 49 2A 00` (LE) or `4D 4D 00 2A` (BE) |
| WebP | `52 49 46 46` at 0, `57 45 42 50` at 8 (`RIFF....WEBP`) |

Two bytes is a weak signature: BMP's `BM` will false-positive on plenty of non-images. So
sniffing is a first pass that picks a codec, and the codec's own header parse is the real
validation. A file that sniffs as BMP and then fails the DIB header check throws
`CORRUPT_IMAGE`, not `UNSUPPORTED_FORMAT`, because we did recognise it and it was broken.
Nothing matches at all → `UNSUPPORTED_FORMAT` carrying the first 12 bytes.

If `opts.format` is passed and disagrees with the sniff, throw `FORMAT_MISMATCH` rather
than silently trusting either one. A caller who genuinely wants to force a codec against
the header is doing something exotic enough to deserve an explicit error first.

## The size guard, before allocation

Every container declares its dimensions in the header. Read them, multiply, compare against
`maxPixels`, throw `IMAGE_TOO_LARGE` **before** allocating the pixel buffer. A 30-byte BMP
header can claim 60000×60000, and a decoder that allocates first and validates second is a
one-line denial of service against anyone who opens an attachment folder. This check is not
optional and it is not a nicety; it is the trust boundary.

## Codec interface

Each codec is a module implementing the same shape, so `decode` is a dispatch table and
nothing more:

```typescript
interface Decoder {
  /** Cheap: parse the header only. Used for the size guard and for fast-decode planning. */
  probe(bytes: Uint8Array): { width: number; height: number };
  decode(bytes: Uint8Array, opts: ResolvedDecodeOptions): RawImage;
}
```

`probe` existing separately is what makes both the size guard and the `maxLongEdge`
downsample plan possible without decoding twice.

## Normalisation the boundary owns

By the time a `RawImage` leaves `decode`, all of this is already true, so no transform ever
has to care:

- Palette and greyscale sources are expanded to RGBA.
- 16-bit channels are truncated to 8. Known, documented loss.
- BMP's bottom-up row order is flipped to top-down.
- Missing alpha is filled with `255`.
- **EXIF orientation is applied.** This one is a real decision: an iPhone JPEG is stored
  landscape with an orientation tag saying "rotate 90". If we ignore the tag, every photo
  from a phone comes out sideways and the user's crop coordinates mean nothing. So decode
  applies the orientation and hands back pixels that are already the right way up. The tag
  is then dropped on encode — carrying it forward would double-rotate. See
  [strip-metadata.md](strip-metadata.md).

## Use cases

- Plugin opens an image for editing: `decode(bytes)`, full resolution, one call.
- Plugin builds a live preview: `decode(bytes, { maxLongEdge: 1600 })`, which is the
  difference between a 260ms stutter and a responsive drag. See
  [fast-decode.md](fast-decode.md).
- Batch save-all: `decode` per file inside the loop, each one independently catchable.
- Format conversion: decode a TIFF, encode a PNG. Falls out for free, because after this
  boundary the source format does not exist.

## Edge cases

- **Truncated file.** Header parses, pixel data runs out. Throw `CORRUPT_IMAGE`, do not
  return a half-decoded image with garbage at the bottom.
- **Trailing bytes after the image.** Common (thumbnails appended, junk from a bad
  exporter). Ignore them, do not throw.
- **Zero-length input.** `UNSUPPORTED_FORMAT`, and the magic-byte read must not itself
  throw on an empty array.
- **Animated GIF / multi-page TIFF.** Decode frame 0, ignore the rest. Not an error.
  Documented in the codec files.
- **CMYK JPEG.** Rare but real from print workflows. Convert to RGB with a naive formula
  and document that we are not colour-managed. A wrong-but-plausible conversion beats a
  hard failure on a file the user can see fine in Preview.

## Acceptance

- Each supported format decodes a known fixture to the expected width, height, and a
  spot-checked set of pixel values.
- A `.png` that is really a JPEG decodes correctly (sniff wins over extension).
- A hostile header claiming 60000×60000 throws `IMAGE_TOO_LARGE` and heap usage does not
  spike, verified with `process.memoryUsage()` around the call.
- An iPhone JPEG with orientation 6 decodes to a portrait `RawImage`, not a landscape one.
