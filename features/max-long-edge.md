# maxLongEdge()

**Milestone 2. Depends on: [resize.md](resize.md).**

## What it is

Shrink-only resize against the longest edge, whichever edge that happens to be.

```typescript
maxLongEdge(size: number, opts?: { resampling?: Resampling }): this;
```

Rules, all three non-negotiable:

1. If `max(width, height) <= size`, **do nothing**. Not "scale up to size". Nothing.
2. Aspect ratio always preserved.
3. Never upscales, under any input.

## Why it is its own method

The PRD is explicit about this and it is the right call. `resize({ width, upscale: false })`
looks like it covers the case, but it does not:

- It needs the caller to know which edge is longer. A vault has portrait and landscape
  photos mixed; a preset that says "nothing bigger than 1600px" has to branch on
  orientation per file if the API is width-based. That branch would end up copy-pasted into
  the plugin, which is the library failing at its job.
- `upscale: false` on `resize` is a *guard* on an operation that normally enlarges.
  `maxLongEdge` is an operation that structurally cannot enlarge. Same word, different
  contract. Folding them into one method with a flag means the flag changes what the method
  fundamentally is, and that is exactly the API design that produces "wait, does upscale:
  false mean it clamps or skips?" bug reports.

Two methods, two clear contracts, no flags that change the operation's meaning. It is also
less code than the conditional version.

## Not a preset

The library has no concept of a saved or named preset. Presets are plugin state: a name, a
target size, a format, a quality, stored in the plugin's settings. The library exposes
`maxLongEdge` because it is a real operation. The plugin reads its preset and calls this.
That boundary is in the PRD's non-goals and this file is where it gets enforced.

## Implementation

Compute the scale factor from the long edge, apply it to both dimensions, delegate to
`resize`. It is a handful of lines on top of [resize.md](resize.md), not a parallel resize
implementation:

```
const longest = Math.max(w, h);
if (longest <= size) return unchanged;
const scale = size / longest;
resize to (round(w * scale), round(h * scale))
```

The long edge lands exactly on `size`; the short edge rounds. Both floor at 1, so a
20000×3 image capped at 100 gives 100×1, never 100×0.

## Use cases

- The preset pipeline's whole reason for existing: "cap every attachment at 1600px" run
  across a folder of mixed-orientation photos, one config, no per-file branching.
- Batch save-all with a size cap ([batch-pipeline.md](batch-pipeline.md)).
- Cheap vault hygiene: shrink the 30 oversized screenshots someone pasted in, leave the
  already-small ones untouched and bit-identical.

## Edge cases

- **Square image.** Both edges are the longest. Both scale to `size`. No ambiguity.
- **Already under the cap.** Returns unchanged, and ideally the *same* buffer, since
  nothing happened. This matters for the batch case: capping a folder where 25 of 30 files
  are already small should cost almost nothing for those 25.
- **`size` out of range.** Clamp domain is 1–20000, same as resize, and same decision:
  throw `INVALID_OPTION` rather than clamp.
- **Extreme ratios.** 20000×3 capped at 100 → 100×1. Assert it, because the naive rounding
  gives 0 and a zero-dimension image is invalid ([raw-image.md](raw-image.md)).
- **Both `resize()` and `maxLongEdge()` called on one pipeline.** They occupy the same slot
  in the canonical order. Last call wins, consistent with every other method. See
  [pipeline-order.md](pipeline-order.md).

## Acceptance

- 2000×1000 capped at 1600 → 1600×800.
- 1000×2000 capped at 1600 → 800×1600. (The orientation test. This is the one that proves
  the method earns its existence.)
- 800×600 capped at 1600 → 800×600, unchanged, same pixels.
- 1000×1000 capped at 1600 → unchanged.
- 20000×3 capped at 100 → 100×1, not 100×0.
- Never, under any input, produces an image larger than the source in either dimension.
  Worth a property test over random dimensions.
