# rotate: arbitrary angle

**Milestone 3. Depends on: [resampling.md](resampling.md), [rotate-90.md](rotate-90.md).**

**This is the milestone most likely to run long.** It is the only feature in the library
that is not either "parse a spec" or "move bytes around" — it is real geometry with real
quality decisions, and it is where the "is this actually feasible in pure JS" risk lives
outside the codecs.

## What it is

Rotate by any angle in -180 to 180, 1° steps from the plugin's UI. Needs resampling, needs
the output canvas to grow, needs a fill for the corners that were not in the source.

```typescript
rotate(angle: number, opts?: RotateOptions): this;

interface RotateOptions {
  /** Default 'bilinear'. */
  resampling?: Resampling;
  /**
   * Fill for the new corners. Default: transparent for alpha-capable output formats,
   * `background` (default white) otherwise. See "Fill strategy" below.
   */
  background?: RGBA;
}
```

`angle % 90 === 0` dispatches to the exact path in [rotate-90.md](rotate-90.md) and none of
this file applies. Everything below is the remainder.

## Output dimensions

The rotated image's axis-aligned bounding box:

```
w' = |w·cos θ| + |h·sin θ|
h' = |w·sin θ| + |h·cos θ|
```

Rounded up (`ceil`), never down: floor loses a sliver of a real corner, and a lost corner is
the exact failure the growing canvas exists to prevent. A 1000×1000 image at 45° becomes
1415×1415.

The image is centred in the new canvas.

## The transform: iterate the destination, sample the source

The critical implementation decision, and the one that separates a correct rotate from a
broken one. **For each destination pixel, apply the inverse rotation to find the source
coordinate, and sample there.** Never iterate the source and scatter forward.

Forward mapping (source → destination) leaves holes: rotation is not a bijection on a
discrete grid, so some destination pixels get written twice and others never get written at
all, and you get a pinholed image. Inverse mapping guarantees every destination pixel is
written exactly once. This is not a preference, it is the difference between working and
not.

```
for each (dx, dy) in destination:
    // translate to centre, rotate by -θ, translate to source centre
    sx = (dx - cx')·cos θ + (dy - cy')·sin θ + cx
    sy = -(dx - cx')·sin θ + (dy - cy')·cos θ + cy
    if (sx, sy) is outside the source → fill colour
    else → sample(src, sx, sy)
```

Hoist `cos θ` and `sin θ` out of the loop. Compute the row's starting `sx`/`sy` once and
increment by the per-column delta rather than doing two multiplies per pixel — the mapping
is affine, so the increments are constant. That is a meaningful constant-factor win on the
hot loop of the slowest operation in the library.

## Fill strategy

New corners are pixels that have no source. What goes there depends on where the image is
going, and the library cannot always know that at `rotate()` time:

- **Alpha-capable output** (PNG, WebP, GIF): transparent, `[0,0,0,0]`.
- **No alpha** (JPEG, BMP): a solid colour.

The clean resolution: **rotate always fills with transparent**, and the encoder composites
onto `background` when the target format has no alpha ([encode.md](encode.md)). One rule,
decided at the boundary that actually knows the format, and it falls out of machinery that
has to exist anyway for "PNG with transparency converted to JPEG".

`opts.background` on rotate then means "fill the corners with this specific colour *now*,
even on an alpha format" — the escape hatch for a caller who wants black bars on a PNG.
Rarely used, cheap to support.

### Open question Q2: the default fill colour

The PRD asks: white, or caller-configurable with white as the default?

**Recommendation: configurable, defaulting to white**, and — the part worth deciding
deliberately — it is **the same `background` option used by rotate, `resize({fit:'contain'})`
and the encoder's alpha compositing**, resolved once at the pipeline level rather than
three separate options with three defaults. A user should learn "background is white unless
I say otherwise" once, not three times. White because a vault note is white-ish for most
users and because it is the least surprising default in every other image tool.

Needs your sign-off before the pipeline options type gets written, since it decides whether
`background` lives on the pipeline or on each method.

## Quality

Bilinear default. Lanczos-3 available for final output.

Nearest is available but is visibly awful on a rotate — every straight edge in the image
turns into a staircase. Do not make it the fast-preview default; a 1600px preview
([fast-decode.md](fast-decode.md)) is already 6× fewer pixels than the full res, which is
where the speed comes from. If bilinear at 1600px is still too slow, that is a profiling
result to act on, not a reason to ship a staircase.

The alpha trap from [resampling.md](resampling.md) bites hardest here: bilinear across the
boundary between opaque image and transparent fill will drag the fill's RGB into the edge
pixels. Premultiply before sampling or every rotated image gets a dark or white halo around
its diagonal edges. This is *the* visual bug of this feature.

## Performance

The PRD's own number: full-res rotate cost ~260ms and caused visible stutter. That is the
bar.

- The preview path runs on the ≤1600px decode, so it is sampling ~6× fewer pixels than
  full-res on a 12MP photo. That alone is most of the fix.
- Full-res rotate runs once, on save, where 260ms is acceptable.
- The inner loop should be a flat typed-array walk with no allocation, no closures, no
  per-pixel object creation. Return `out` params or write directly into the destination
  buffer. A per-pixel `{r,g,b,a}` allocation in this loop would be a hundred million short-
  lived objects on a large photo and the GC would eat the frame budget.
- Do not decompose into 3 shears. It is a classic trick, it is genuinely good for
  quality-per-cost with nearest-neighbour, and it is a lot more code with more edge cases
  than one inverse-mapped affine pass. Not until profiling demands it.

## Use cases

- Straightening a crooked photo or scan by a few degrees. The overwhelmingly common case:
  small angles, big images.
- Deliberate tilt for a note's layout.
- The live preview during a rotation-slider drag, on the downsampled image.

## Edge cases

- **Small angles.** 1° on a 4000px image still grows the canvas by ~70px and still
  resamples every pixel. There is no cheap path for small angles; it is a full transform.
- **±180.** Caught by the 90-step dispatcher, exact, dimensions unchanged.
- **Angles just off a right angle** (89.9°): resampled path, canvas grows a couple of
  pixels, output is very slightly blurred versus `rotate(90)`. Correct and expected;
  document that exact rotations need exact angles.
- **Rotating twice** (15° then 15°) is *not* the same as 30° — two resamples means two lots
  of blur and a bigger canvas. The pipeline only ever applies one rotate
  ([pipeline-order.md](pipeline-order.md)), which sidesteps this, but a caller doing two
  `.toBuffer()` round-trips will see it. Document it.
- **A fully transparent source.** Fine, produces a transparent output.
- **Extreme aspect ratios.** A 20000×1 rotated 45° has a 14143×14143 bounding box: 200M
  pixels, 0.75 GB. The `maxPixels` guard from [decode.md](decode.md) must apply to the
  *computed rotate output*, not just to decode, or a legal input and a legal angle OOM the
  process. Easy to miss; test it.

  Building this exposed that the cap's stated default (`20000 * 20000` = 400M pixels)
  was *higher* than this case, so the guard would never have fired. The default is now
  134M pixels / 512 MB. See [decode.md](decode.md).

## Acceptance

- `rotate(45)` on a 100×100 produces a 142×142 canvas (ceil of 141.42) with the image
  centred.
- Corners of the output are transparent, `[0,0,0,0]`.
- Encoding that result as JPEG gives white corners; with `background: [0,0,0,255]`, black.
- A soft-edged shape rotated 30° has no dark or light halo at the image/fill boundary
  (the premultiply test — this is the one that fails first).
- `rotate(90)` never enters this code path (spy assertion).
- A 20000×1 image rotated 45° throws `IMAGE_TOO_LARGE` rather than allocating 800 MB.
- Rotating a 1600×1200 image by 15° with bilinear completes in a budget that keeps a
  preview drag responsive. Benchmark it, record the number, watch it in CI.
- No allocation inside the per-pixel loop. Verify with a heap profile over a large rotate.
