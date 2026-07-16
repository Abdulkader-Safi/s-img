# Fast decode path

**Milestone 6. Depends on: [decode.md](decode.md), every codec.**

**This is a hard performance requirement, not a nice-to-have.** The PRD's own measurement:
a full-resolution rotate cost ~260ms and caused visible stutter. The preview path is the fix.

```typescript
decode(bytes, { hintMaxLongEdge: 1600 });
```

Downsample **during** decode. Not decode-full-then-resize — that pays the full-resolution
cost and then adds a resize on top, which is the opposite of the point.

## Why it has to be during decode

A 12MP photo is 4000×3000. Decoding it fully means inverse-DCT'ing 187,500 blocks and
allocating 48 MB, every frame, while the user drags a slider. Then the rotate resamples all
12 million pixels. That is the 260ms.

At 1600px long edge it is 1600×1200 = 1.9M pixels, 6.25× fewer. The rotate drops to
roughly 40ms, which is a frame. And if the decode itself is doing less work rather than
decoding everything and throwing 84% of it away, the decode drops too.

The plugin's existing design already assumes this: decode a preview once capped at 1600px,
do a separate full-resolution pass only when the user stops interacting. The library needs to
support that directly or the plugin cannot be built on it.

## What each codec can actually do

The win varies enormously by format, and being honest about that up front matters:

| Format | Native downsample | Notes |
|---|---|---|
| **JPEG** | **Yes, big win** | DCT scaling: decode each 8×8 block at 1/2, 1/4 or 1/8 by only inverse-transforming the top-left 4×4, 2×2 or 1×1 coefficients. Nearly free — the IDCT gets *cheaper*, and it is the format that matters most. |
| PNG | No | DEFLATE is a byte stream; you cannot inflate 1/4 of it. Must inflate and unfilter everything. |
| WebP | Maybe | libwebp has scaled decode. Whether jSquash exposes it is a spike question ([codec-webp.md](codec-webp.md)). |
| GIF | No | LZW, same problem as PNG. |
| BMP | Partial | Uncompressed, so rows and pixels can be skipped without reading them. Real, if minor. |
| TIFF | Partial | Uncompressed: same as BMP. LZW: no. |

**JPEG's DCT scaling is the feature.** It is the format the plugin sees most, it is the one
with the biggest full-res cost, and its downsample is nearly free. Everything else is a
fallback.

## The fallback

For formats that cannot downsample natively: decode fully, then resize, then **release the
full-resolution buffer**. The caller still gets a small image and still saves on every
downstream transform, which is where most of the cost is anyway. The decode itself is not
faster, and the docs should say so rather than implying a uniform win.

Resampling for the fallback: box average for an integer factor, bilinear otherwise. Not
Lanczos — it is a preview.

## The two-pass design this enables

The plugin's actual flow, which the library exists to serve:

1. **On open:** `decode(bytes, {hintMaxLongEdge: 1600})`. One small `RawImage`, held.
2. **On every interaction:** apply the pipeline to that small image, push pixels to a
   canvas. No re-decode, no encode. Should be a frame.
3. **On save:** `decode(bytes)` at full resolution, apply the same pipeline
   ([batch-pipeline.md](batch-pipeline.md)'s spec is the same object), encode. 260ms is
   fine here; the user hit save.

Step 2 never encodes. That is worth saying twice: the preview loop is decode-once,
transform-per-frame, and `toBuffer()` is not in it. A preview that encodes a JPEG every
frame would be slower than the thing we are fixing.

## Coordinate scaling, the trap

The crop rectangle the user drew is in **preview coordinates**. The full-resolution save
needs it in **source coordinates**, scaled by exactly the ratio the preview decode used.

Two ways to get this wrong, both real:

- The plugin assumes the scale factor is `1600 / longEdge` and the decoder actually gave it
  1/4 (JPEG's DCT scaling only does powers of two, so a 4000px image capped at 1600 decodes
  at 1000px, not 1600). Off by 1.6×.
- Rounding drift accumulates over the two passes.

So: **`decode` must report what it actually did.** The returned image's `width`/`height` are
the truth, and the plugin computes its scale from `source.width / preview.width`. Which
means the plugin needs the source dimensions too, cheaply, without a full decode — that is
what `probe()` is for ([decode.md](decode.md)).

Worth considering: expose `probe(bytes)` publicly so the plugin can get real dimensions in
microseconds. It is already there internally for the size guard. One export, no new code,
removes a whole class of scaling bug. **Do it.** -- done, and note it reports STORED
dimensions while `decode` applies EXIF orientation, so a rotated photo's probe is transposed
relative to its decode. Scaling still comes out right because both edges scale by the same
factor, but it is pinned as a test rather than left to be discovered.

## maxLongEdge on decode vs the pipeline method

Same name, different things, and the collision is worth being deliberate about:

- `decode(bytes, {hintMaxLongEdge})` — a **performance hint**. "I do not need more than this
  many pixels." Best-effort, may return larger (JPEG's powers of two), never smaller than
  necessary.
- `.maxLongEdge(n)` on the pipeline — an **output guarantee**
  ([max-long-edge.md](max-long-edge.md)). Exact.

A caller who confuses them gets a preview that is the wrong size, or an output that is not
capped. Different enough that the shared name is a liability. **Rename the decode option to
`hintMaxLongEdge`**, or document the distinction hard. Prefer the rename; a name that lies
costs more than a longer name. **Done** -- and the rename immediately caught a real
confusion: a blind search-and-replace hit `PipelineSpec`'s `resize.maxLongEdge`, which is
the OTHER thing, and the spec round-trip test went red within a minute.

## Use cases

- The live preview. The reason this feature exists.
- Thumbnails: fast, small, quality does not matter much.
- Cheap `probe` for "how big is this image" without decoding.

## Edge cases

- **Image already under the cap.** Decode normally, no downsample, return as-is.
- **JPEG's power-of-two granularity.** A 4000px image capped at 1600 decodes at 1000px
  (1/4), not 1600 — because 1/2 gives 2000, which is over. Always err on the side of *at or
  under* the cap, never over. Then the caller reads the real dimensions off the result.
- **`hintMaxLongEdge: 1`.** Legal. Produces roughly a 1px image. Silly but not an error.
- **The fallback path's peak memory.** PNG still allocates the full 48 MB before
  downsampling. On a memory-constrained machine, opening a huge PNG preview costs the same
  as opening it fully. Honest limitation, document it.

## Measured

`npm run bench:preview`, on a 4000x3000 (12MP) JPEG. Median of 5, M-series laptop --
directional, not a contract; the CONTRACT is the instrumented counter in
test/core/fast-decode-counter.test.ts, which proves the reduced transform actually runs.

| | Time | Result |
|---|---|---|
| decode, full resolution | 181ms | 4000x3000 |
| decode, `hintMaxLongEdge: 1600` | **37ms** | 1000x750 (1/4, exactly as the worked example predicts) |
| decode, `hintMaxLongEdge: 400` | 25ms | 400x300 |
| crop + rotate 15 on the preview | **10ms** | the per-interaction cost |
| crop + rotate 15 at full resolution | 153ms | what the PRD measured as a stutter |

Decode is **4.9x** faster at 1600. The number that matters is the 10ms: the PRD's ~260ms
stutter was a full-resolution transform per interaction, and the two-pass design replaces it
with a 10ms one, inside a 16ms frame. The remaining decode cost is the entropy decode, which
no amount of DCT scaling can avoid -- the Huffman stream has to be walked in full whatever
size you want out of it. That is the ceiling here, and at 1/8 it is most of what is left.

## Acceptance

- A 4000×3000 JPEG decoded with `hintMaxLongEdge: 1600` is at or under 1600 on the long
  edge, and decodes measurably faster than the full-res decode. Benchmark it, record it.
- The DCT-scaled decode never inverse-transforms the full coefficient set. Assert with an
  instrumented counter, not a stopwatch — a stopwatch test is flaky and this fact is not.
- Fallback formats return the right dimensions even though they are not faster.
- `probe()` on every format returns correct dimensions without allocating a pixel buffer.
- Preview-coordinate crop scaled to source coordinates produces the same region as cropping
  the full-res image directly, within a pixel. This is the coordinate-drift test and it is
  the one that catches the real bug.
- A full preview cycle (decode 1600px, crop, rotate 15°, push to canvas) fits in a frame
  budget on a 12MP source. Record the number; watch it.
