# RawImage: the pixel buffer

**Milestone 1. Depends on: nothing. Everything else depends on this.**

## What it is

One flat, boring struct that every decoder produces, every transform consumes and
produces, and every encoder takes. It is the only currency in the library.

```typescript
interface RawImage {
  readonly width: number;          // >= 1
  readonly height: number;         // >= 1
  readonly data: Uint8ClampedArray; // RGBA, 8 bits per channel, length === width * height * 4
}
```

That is the whole type. No class, no methods, no hidden state. A decoder returns one,
a transform takes one and returns a new one, an encoder eats one. If a function in this
library needs to know anything about an image beyond these three fields, that function is
in the wrong layer.

## Why it looks like this

- **RGBA always, even for opaque images.** One layout means every transform is written
  once instead of once per pixel format. The 25% memory cost over RGB is worth not having
  a `PixelFormat` enum threading through every function. A 4000×3000 photo is 48 MB in
  RGBA, which is fine for a desktop Obsidian plugin editing one image at a time.
- **`Uint8ClampedArray`, not `Buffer`.** `Buffer` is Node-only and drags `node:buffer`
  into the core. `Uint8ClampedArray` works on Node, Bun, and (later) the browser, and its
  clamping semantics are exactly what resampling wants: writing `-3` or `280` from a
  Lanczos kernel saturates to `0` or `255` instead of wrapping. That clamp is not a nicety,
  it is the difference between a clean sharpened edge and black speckles in the highlights.
- **Non-premultiplied alpha.** PNG, WebP and GIF all store non-premultiplied. Storing
  premultiplied would mean converting at both ends of every pipeline for the benefit of
  operations we do not have (no compositing, no blending layers in v1). Rotation fill and
  bilinear-across-transparent-edges are the only places alpha interacts with a filter, and
  both are handled locally. See [rotate.md](rotate.md).
- **Row-major, top-left origin, no stride.** Pixel `(x, y)` lives at
  `(y * width + x) * 4`. No padding, no stride field. BMP stores rows bottom-up and TIFF
  can too; that is the codec's problem to normalise at the boundary, not a flag the
  transforms have to respect.
- **`readonly` on the fields, not deep-frozen.** Transforms allocate a new buffer and
  return a new object rather than mutating in place. That costs an allocation per stage
  and buys freedom from an entire class of aliasing bug. The one exception is documented
  in [pipeline-order.md](pipeline-order.md): a pipeline run may reuse the previous stage's
  buffer internally when it can prove no caller holds a reference.

## Helpers that live next to it

Small, internal, not necessarily exported in v1:

- `createImage(width, height, fill?: RGBA): RawImage` — allocate and optionally flood-fill.
  Used by rotate's grown canvas and by tests.
- `assertValidImage(img): asserts img is RawImage` — checks `data.length === w * h * 4`
  and that both dimensions are >= 1. Called at the decoder → pipeline boundary and in
  tests. A codec that returns a buffer of the wrong length is a bug we want caught at the
  seam, not three transforms later as a garbage image.
- `copyImage(img): RawImage` — the honest deep copy, for the rare caller that wants one.

```typescript
type RGBA = readonly [r: number, g: number, b: number, a: number];
```

## Use cases

- A decoder finishes parsing and hands back a `RawImage`. Nothing about the source format
  survives that boundary; a PNG and a JPEG of the same photo are indistinguishable
  downstream, which is what makes format conversion fall out for free.
- Crop, rotate, flip and resize each take one and return one. They can be tested in
  isolation against a hand-built 4×4 buffer with no file I/O anywhere near them.
- The plugin's preview layer can hand `data` straight to `ImageData` /
  `putImageData` in an Obsidian canvas with zero conversion, because `ImageData` is
  RGBA `Uint8ClampedArray` too. That is not an accident, it is why this layout was chosen.

## Edge cases and decisions

- **Zero-size images are invalid.** `width` or `height` of 0 throws at construction. There
  is no meaningful 0-pixel image and allowing one means every downstream loop needs a guard.
- **The maximum.** 20000×20000 RGBA is 1.6 GB, past what a V8 typed array will
  comfortably hold. `resize` clamps dimensions to 1–20000 per the plugin's existing limits
  (see [resize.md](resize.md)), but decode of a hostile file needs its own ceiling —
  a decoder must refuse a declared canvas whose byte length would exceed a configured cap
  before it allocates. Handled in [decode.md](decode.md), not here.
- **16-bit source images.** PNG and TIFF can carry 16 bits per channel. v1 truncates to 8
  during decode. Documented as a known loss. If it ever matters, the upgrade is a parallel
  `RawImage16`, not a `depth` field on this one; a union at the boundary beats a branch in
  every inner loop.
- **Greyscale and palette sources** are expanded to RGBA at decode. Yes, that means a
  1-bit fax TIFF explodes 32×. Correct and simple beats clever here.

## Acceptance

- The type compiles under `strict` with no `any`.
- `assertValidImage` rejects a mismatched buffer length, a zero dimension, and a
  non-integer dimension.
- A hand-built 2×2 image round-trips through `copyImage` byte-identically and the copy is
  not the same object.
