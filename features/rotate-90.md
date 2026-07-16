# rotate: 90° steps

**Milestone 2. Depends on: [raw-image.md](raw-image.md).**

## What it is

Rotation by -90, +90 or 180. Exact, lossless, no resampling, no interpolation. A pure
index permutation: every output pixel is exactly one input pixel, moved.

This is a separate file from [rotate.md](rotate.md) because it is a separate implementation
with different guarantees, even though it is the same public method. `rotate(90)` must never
touch the resampler — routing an exact operation through a bilinear filter would blur an
image for no reason and lose data on a round-trip. `rotate(90).rotate(-90)` has to return
the original bytes.

## Behaviour

- `rotate(90)` — clockwise. Output dimensions swap: `w × h` becomes `h × w`.
- `rotate(-90)` / `rotate(270)` — counter-clockwise. Dimensions swap.
- `rotate(180)` — dimensions unchanged. It is a reverse of the whole pixel array, which is
  the cheapest case of all.
- `rotate(0)` / `rotate(360)` — no-op. Return unchanged.

Positive angles are clockwise. State it in the docs and never waver, because the one thing
worse than picking the wrong convention is picking both at different times.

## Dispatch

`rotate(angle)` normalises the angle into (-180, 180] and then:

- angle `% 90 === 0` → this exact path.
- otherwise → the resampled path in [rotate.md](rotate.md).

So the exactness is automatic. A caller asking for 90 gets the exact one without knowing
there are two implementations, and the fill colour, the growing canvas and the resampling
option are all irrelevant on this path.

## Implementation

The naive nested loop with a computed destination index is correct and clear:

```
dst[(x * h + (h - 1 - y)) * 4 + c] = src[(y * w + x) * 4 + c]   // for +90
```

It is also cache-hostile: it reads the source sequentially and writes the destination with
a stride of `h * 4` bytes, which is a cache miss per pixel on any large image. A tiled
version (process in 32×32 blocks so both the read and write regions stay resident) is
several times faster on a 12MP photo.

**Write the naive one first.** It is four lines and obviously correct, and it is the
reference the tiled version gets tested against. Tile it when a benchmark says the plugin
stutters, not before. 180 does not need tiling at all — it is a linear reverse.

## Interaction with EXIF orientation

Decode already applied the orientation tag, so by the time anything calls `rotate`, the
image is upright and `rotate(90)` means what the user just clicked, not what the camera
recorded. If decode did not do that, `rotate(90)` on a phone photo would appear to rotate by
180 and the bug report would be baffling. This dependency is the reason
[decode.md](decode.md) owns orientation.

## Use cases

- The plugin's rotate-left / rotate-right buttons. By far the most-clicked control in any
  image editor.
- Fixing a sideways scan.
- Internal: nothing. The arbitrary-angle path does not decompose into a 90 step plus a
  remainder; it does one resampled affine transform. See [rotate.md](rotate.md).

## Edge cases

- **Non-square images.** The dimension swap is the whole point and the easiest thing to get
  wrong. Fixture a 3×5 image, not a 4×4.
- **1×N and N×1.** Legal, becomes N×1 and 1×N.
- **Angle normalisation.** `rotate(450)` is `rotate(90)`. `rotate(-270)` is `rotate(90)`.
  Normalise before dispatching, then the exactness check is one modulo.
- **Float angles that are integer multiples**, like `rotate(90.0)`: exact path.
  `rotate(90.0001)`: resampled path. That cliff is real but unavoidable, and the plugin's UI
  only produces integer degrees anyway. Do not add a tolerance window; a caller passing
  90.0001 asked for 90.0001.

## Acceptance

- `rotate(90)` on a 3×5 fixture yields a 5×3 image whose pixels match a hand-written
  expected array.
- `rotate(90).rotate(90).rotate(90).rotate(90)` is byte-identical to the input. Four
  rotations, exact, no drift. This single test catches almost every index bug.
- `rotate(90)` then `rotate(-90)` is byte-identical to the input.
- `rotate(180)` twice is byte-identical to the input.
- The resampler module is never called on any 90-step path. Assert with a spy.
- `rotate(450)` equals `rotate(90)`.
