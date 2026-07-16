# Resampling kernels

**Milestone 1. Depends on: [raw-image.md](raw-image.md). Shared by [resize.md](resize.md)
and [rotate.md](rotate.md).**

## What it is

The three sampling strategies, written once, in one module, used by both resize and
arbitrary-angle rotate. They are the same maths problem — given a source image and a
fractional coordinate, what colour goes here — so they are the same code.

```typescript
type Resampling = 'nearest' | 'bilinear' | 'lanczos3';
```

## Nearest neighbour

Round the source coordinate, copy the pixel. Blocky, exact, fast, no arithmetic on the
channel values at all.

**Where it earns its place:** the fast decode path ([fast-decode.md](fast-decode.md)) when
downsampling by a large integer factor for a preview nobody is inspecting at 1:1, and
pixel-art upscaling where blur is the wrong answer. Not the default for anything a user
saves.

## Bilinear

Weighted average of the four surrounding pixels. The default for both `resize` and
arbitrary-angle `rotate`.

The important caveat that gets skipped and produces a real visual bug: **when downscaling
by more than 2×, plain bilinear only reads 4 source pixels and ignores everything between
them.** Shrink a 4000px photo to 400px and 90% of the source never gets read, which is
aliasing — moiré on fabric, jagged text, sparkling detail. Two ways out:

1. **Box-prefilter then bilinear.** Average each source region down by the integer part of
   the scale factor, then bilinear the remainder. Cheap, and it is what a lot of fast
   resizers do.
2. **Scale the filter footprint with the ratio** (a proper separable filter that widens
   when minifying). More correct, more code.

Do option 1. It is a small amount of extra code guarding against an obvious, visible
artifact on the exact operation the plugin runs most (shrink a big photo for a note), and
"bilinear that aliases badly on the common case" is not a working default.

*(ponytail note: this is one of the places where the lazy version is wrong. Fewest lines
that actually work, not fewest lines.)*

## Lanczos-3

Windowed sinc, 3 lobes, so a 6×6 footprint per output pixel. Sharpest result, the most
CPU, and it rings — a light halo on hard edges, which is inherent to the filter and not a
bug.

Make it **separable**: resample horizontally into a temp buffer, then vertically. That
turns 36 taps per pixel into 6 + 6 and is the difference between usable and unusable.

**Precompute the weights per output column and row, once.** Every output pixel in column
`x` uses the same 6 horizontal weights. Computing `sinc()` per pixel instead of per column
is the single biggest performance mistake available here, and it is easy to make.

Offer it as an option on final-output resize. Never the default; it does not pay for itself
on a preview.

## Alpha handling, the trap

Averaging non-premultiplied RGBA is wrong. A fully transparent pixel still carries an RGB
value (often black, often garbage), and if you average it in, that garbage bleeds into the
neighbouring opaque pixel and you get dark fringes around every soft edge. This shows up in
exactly the place it hurts most: the edges of an arbitrary-angle rotate, where opaque image
meets transparent fill.

So: **premultiply before filtering, un-premultiply after.** Only inside the resampler, only
for images that actually have any non-opaque pixel (worth a fast scan — most photos are
fully opaque and can skip both conversions entirely). Everything outside this module keeps
seeing non-premultiplied data, per [raw-image.md](raw-image.md).

## Interface

```typescript
interface Sampler {
  /** Bilinear/Lanczos read fractional coordinates; nearest rounds. */
  sample(src: RawImage, x: number, y: number, out: RGBA): void;
}
```

Rotate wants per-coordinate sampling (its mapping is not axis-aligned). Resize wants the
separable two-pass path, which is a different, faster shape than calling `sample()` per
pixel. So the module exposes both: a general `sample` for rotate, and a
`resizeSeparable(src, w, h, kernel)` for resize. Same kernel definitions underneath, two
traversal strategies on top. Do not force resize through the per-pixel interface for the
sake of one shared signature; that is an abstraction bought with a 3× slowdown.

## Edge behaviour

At the border, the filter footprint hangs off the image. Options: clamp to edge, wrap,
reflect, or treat outside as transparent. **Clamp to edge** for resize (standard, no
surprises). For rotate, outside-the-source is genuinely empty and must be the fill colour /
transparent, not a smeared edge pixel — see [rotate.md](rotate.md).

## Edge cases

- **Upscaling with Lanczos** rings harder than downscaling. Expected, documented.
- **Scale factor of exactly 1.** Short-circuit: return a copy, run no filter. Prevents a
  needless full-image resample and the sub-pixel drift that comes with it.
- **Integer scale factors.** A 2× downscale is an exact box average. Worth special-casing
  later if profiling says so, not before.
- **Rounding.** Accumulate in float, clamp to 0–255 at the end. `Uint8ClampedArray` does the
  clamping on write, which is exactly why it was chosen.

## Acceptance

- Nearest: a 2×2 upscaled 4× is 16 pixels in 4 exact 4×4 blocks, no intermediate values.
- Bilinear: a black-to-white horizontal gradient resized 2× produces a monotonic ramp with
  no banding.
- Bilinear downscale of a 1px checkerboard by 8× produces uniform mid-grey, not moiré.
  This is the box-prefilter test and it fails on naive bilinear.
- Lanczos: sharper than bilinear on a test edge, measured as a higher gradient magnitude at
  the transition.
- A 50% transparent soft-edged shape resized 4× shows no dark fringe (the premultiply test).
- Lanczos weight computation is called O(width + height) times, not O(width × height).
  Assert with a call counter.
