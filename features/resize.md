# resize()

**Milestone 1. Depends on: [resampling.md](resampling.md).**

## What it is

General-purpose resize. Allows upscaling, because the plugin's percentage chips go to 200%.
The shrink-only preset behaviour is a *different method*, [max-long-edge.md](max-long-edge.md),
not a flag on this one.

```typescript
interface ResizeOptions {
  width?: number;
  height?: number;
  /** Default true. False means never enlarge: if the target is bigger, do nothing. */
  upscale?: boolean;
  /** Only meaningful when both width and height are given. Default 'fill'. */
  fit?: 'fill' | 'contain' | 'cover';
  /** Default 'bilinear'. */
  resampling?: Resampling;
  /** Only used by fit: 'contain'. Default white, shared with rotate and encode. */
  background?: RGBA;
}
```

## Dimension resolution

- **Width only:** height is derived from the aspect ratio, rounded.
- **Height only:** width derived the same way.
- **Both:** `fit` decides.
- **Neither:** `INVALID_OPTION`. A resize with no target is a caller bug, not a no-op.

`fit` semantics, when both dimensions are given:

- `fill` — stretch to exactly width × height, aspect ratio be damned. The default, because
  a caller who passed both numbers explicitly asked for both numbers.
- `contain` — scale to fit inside the box, preserve the ratio, pad the remainder with
  `background`. Output is exactly width × height.
- `cover` — scale to fill the box, preserve the ratio, centre-crop the overflow. Output is
  exactly width × height.

All three produce exactly the requested dimensions. That is the point of the option;
"sometimes you get a different size" would make it useless for a layout.

## Clamping

Both dimensions clamp to **1–20000**, matching the plugin's existing limits.

Clamp or throw? **Throw** on a request outside the range (`INVALID_OPTION`), do not
silently clamp. Silently returning a 20000px image when the caller asked for 50000 means the
subsequent aspect-ratio maths in the plugin is wrong and nobody finds out until the output
looks stretched. The plugin's UI already clamps its slider; the library's job is to catch
the case where it did not.

Rounding: derived dimensions round to nearest, floor at 1. A 1200×1 image asked to fit
width 100 gives 100×1, not 100×0.

## upscale: false

If the computed target is larger than the source in either dimension, return the image
unchanged. Not "scale to the largest allowed size" — unchanged. This is the guard a caller
uses when they want "shrink if needed", and any partial-scaling interpretation would
surprise them.

Note this is subtly different from `maxLongEdge`, which works off the longest edge
regardless of orientation and never needs the caller to know which dimension is which. Both
exist because both are real operations. See [max-long-edge.md](max-long-edge.md).

## Use cases

- User drags the resize slider to 150%: `resize({ width: srcW * 1.5 })`.
- User types an exact width for a note's layout: `resize({ width: 800 })`.
- Thumbnail into a fixed box: `resize({ width: 200, height: 200, fit: 'cover' })`.
- Final export at maximum quality: `resize({ width: 2000, resampling: 'lanczos3' })`.

## Edge cases

- **Target equals source.** Short-circuit, no resample, no sub-pixel drift.
- **Extreme aspect ratios.** 20000×1 is legal and must not divide by zero anywhere.
- **`fit: 'cover'` with a matching ratio** degenerates to `fill`. Fine, no special case.
- **Non-integer input** (`width: 800.5`): `INVALID_OPTION`. Do not round for the caller;
  a fractional pixel count means their maths is wrong and they should see it.
- **Upscaling a 1×1** to 500×500 produces a solid colour under any kernel. Correct.

## Acceptance

- Width-only resize preserves the aspect ratio within one pixel of rounding.
- All three `fit` modes produce exactly the requested dimensions.
- `upscale: false` with a larger target returns an image with identical dimensions and
  identical pixels (and ideally the identical buffer, since nothing changed).
- 0, 20001, negative, and fractional targets each throw `INVALID_OPTION` naming the option.
- An 8× downscale of a high-frequency test pattern shows no moiré (see
  [resampling.md](resampling.md)).
