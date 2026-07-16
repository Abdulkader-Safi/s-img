# crop()

**Milestone 1. Depends on: [raw-image.md](raw-image.md).**

## What it is

Cut a rectangle out. The cheapest operation in the library: no filtering, no interpolation,
just a row-wise copy of a sub-rectangle into a new buffer.

```typescript
interface CropOptions {
  x: number;       // integer, >= 0
  y: number;       // integer, >= 0
  width: number;   // integer, >= 1
  height: number;  // integer, >= 1
}
```

Origin is top-left, matching [raw-image.md](raw-image.md).

## Implementation

For each output row, one `.set()` of the corresponding source row slice. `TypedArray.set`
is a memcpy under the hood, so a crop of an N-pixel region costs about what copying N
pixels costs and no more. Do not write a per-pixel loop with per-channel indexing; it is
several times slower for zero benefit.

## Bounds

The rectangle must lie **entirely inside** the image. Out of bounds throws
`INVALID_OPTION` naming which field and what the actual bounds were.

Why throw rather than clamp to the intersection: a crop that silently shrinks returns an
image of a different size than the caller asked for, and every downstream calculation
(the plugin's aspect ratio display, its resize maths) is then quietly wrong. A crop
rectangle outside the image means the caller's coordinate space is out of sync with the
image's — that is a bug, and it should surface at the call site with the numbers attached.

## The canvas offset reset

The plugin's existing behaviour, and it matters: **after cropping, the coordinate origin is
the crop rectangle's top-left.** A subsequent rotate spins around the centre of the *cropped*
frame. A subsequent resize scales the *cropped* dimensions. There is no memory of the
original padded coordinate space.

This is free in the current design — crop returns a new `RawImage` and a `RawImage` has no
offset field to get stale. The point of writing it down is that any future attempt to
optimise crop into a lazy view-with-offset would reintroduce exactly the bug this note
prevents. Do not do that.

## Where it sits in the pipeline

**First, always.** Canonical order is crop → rotate → flip → resize → format, regardless of
the order the chain was called in. Crop is first because that is the plugin's existing
mental model and because the alternative is the classic bug: resize then crop, and the crop
rectangle the user drew on a 1200px preview now cuts the wrong region out of a 600px image.
See [pipeline-order.md](pipeline-order.md).

## Use cases

- The main event. User drags a crop box in the plugin's UI, hits apply.
- Aspect-ratio presets (16:9, 1:1) — the plugin computes the rectangle, the library cuts it.
- Internal: `fit: 'cover'` in [resize.md](resize.md) is a centre-crop plus a scale, and it
  reuses this code rather than duplicating the rectangle copy.

## Edge cases

- **Crop to the full image.** Legal. Returns a copy. Not worth short-circuiting to the same
  object — an operation that sometimes aliases and sometimes does not is a worse contract
  than one that always copies.
- **1×1 crop.** Legal.
- **Zero width or height.** `INVALID_OPTION`. There is no zero-pixel image
  ([raw-image.md](raw-image.md)).
- **Fractional coordinates.** `INVALID_OPTION`. The library does not decide whether the
  caller meant floor or round; a fractional crop is a fractional pixel and that is not a
  thing. The plugin rounds its own drag coordinates before calling.
- **Negative x/y.** `INVALID_OPTION`, same reasoning as out-of-bounds.

## Acceptance

- Cropping a known 4×4 fixture at (1,1,2,2) yields exactly the expected 4 pixels.
- `x + width > srcWidth` throws `INVALID_OPTION` with `option: 'crop.width'` and the actual
  bound in the message.
- Crop then rotate 90° produces the same result as rotating the already-cropped image
  standalone — proves the offset really is reset.
- Cropping a 4000×3000 image to 100×100 does not read or copy the whole source (assert on
  timing, or on a instrumented read count).
