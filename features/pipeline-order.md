# Canonical pipeline order

**Milestone 6. Depends on: crop, rotate, flip, resize, format.**

## What it is

Operations always apply in this order, no matter what order the chain was called in:

```
crop → rotate → flip → resize → format/quality
```

```typescript
SImg.fromBuffer(b).rotate(15).crop({...}).toBuffer()
// crop runs first. Always.
```

This is not a convenience, it is a correctness feature, and it is copied from the plugin's
existing behaviour on purpose.

## Why

**The plugin already works this way.** The user touches controls in whatever order they
like, and the plugin applies them in a fixed order. If the library respected call order, the
plugin would have to sort its own operations before calling — and the sort would live in the
plugin, be re-derived by anyone else using the library, and get it wrong.

**Because the bug class it prevents is nasty.** Resize-then-crop is the classic: the user
drags a crop box on a 1200px preview, the pipeline resizes to 600px first, and the crop
rectangle now cuts a region twice as large from the wrong part of the image. It does not
throw. It does not look obviously broken. It just quietly crops the wrong thing, and the
user does not notice until they look closely at a photo they saved last week.

**Because the operations genuinely do not commute.** This is maths, not preference:

- Crop then resize ≠ resize then crop (different regions, as above).
- Rotate then flip ≠ flip then rotate for any non-180 angle. Reflection composed with
  rotation is a rotation the other way.
- Rotate then crop ≠ crop then rotate — rotate grows the canvas, so the coordinate space the
  crop rectangle refers to has moved.

Every one of these is a real, silent, wrong-output bug. Fixing the order removes all of them
at once, in one place.

## Why *this* order specifically

1. **Crop first.** The user drew the rectangle on the image as they see it, which is the
   source image. Cropping first also means every subsequent operation works on less data,
   which is free performance on the expensive stages.
2. **Rotate second.** Operates on the cropped frame ([crop.md](crop.md)'s offset reset).
   Before resize, because rotating first and resizing after means the resize is doing the
   final quality pass on the rotated result — one resample of the rotate's output, rather
   than rotating an already-resized image and stacking two lots of blur at the wrong scale.
3. **Flip third.** Cheap and exact, so its position barely matters for quality; it matters
   for matching the plugin's existing rotate-then-flip semantics. Users who rotate and flip
   have a mental model, and it is the plugin's.
4. **Resize fourth.** The last geometric operation, so the final resample is what determines
   the output's sharpness. Resizing earlier means later operations resample an
   already-resampled image.
5. **Format last.** Obviously — it is the encode.

## Last call wins

Calling a method twice replaces the earlier call:

```typescript
.resize({width: 800}).resize({width: 1200})  // 1200
.crop(a).crop(b)                              // b
```

Not "apply both in sequence". The spec is a record with one slot per operation, so a second
call overwrites the slot. This falls straight out of the data structure and it is the
behaviour a UI wants: the user dragging the resize slider generates a hundred calls and
means the last one.

`resize()` and `maxLongEdge()` share a slot — they are the same stage
([max-long-edge.md](max-long-edge.md)). Last of either wins.

## The spec

```typescript
interface PipelineSpec {
  crop?: CropOptions;
  rotate?: { angle: number } & RotateOptions;
  flip?: FlipOptions;
  resize?: ResizeOptions | { maxLongEdge: number; resampling?: Resampling };
  format?: { format: Format; options?: FormatOptions<Format> };
  stripMetadata?: boolean;
  background?: RGBA;   // shared by rotate fill, contain-pad, alpha compositing. See Q2.
}
```

A plain object. No class, no methods, no order information in it at all — the order is in
the executor, which is a function that reads these fields in sequence. That is why it
serialises to JSON for free ([batch-pipeline.md](batch-pipeline.md)), and why the order
cannot be got wrong by a caller: there is nowhere for them to express it.

## Skipped stages

An absent field is a skipped stage, not an identity operation. No `crop` means no copy, not
a full-image crop. On a pipeline that only sets `format`, the pixel data is never touched
at all — the run is decode-then-encode. That matters for the batch case where most files
just get re-encoded.

## Buffer reuse

Each stage allocates a new `RawImage`. A 4000×3000 photo through crop → rotate → resize is
three full-size allocations plus the decode's.

Because the executor owns every intermediate and no caller can hold a reference to one, it
*may* reuse or free them internally — the exception noted in [raw-image.md](raw-image.md).
**Do not build this until a profile says so.** Allocation of a few 48 MB buffers is fast; V8
handles it; the rotate's inner loop is where the time goes. Note it here so the option is
remembered, not so it gets implemented on spec.

## Use cases

- Every edit the plugin makes.
- The batch pipeline, same executor.
- Reasoning about a bug report: "what did the library actually do" has one answer, always.

## Edge cases

- **Empty spec.** Decode, encode to source format. Legal.
- **Rotate then crop, chained in that order.** Crop applies to the *un-rotated* image,
  because crop is first. This will surprise exactly one caller who wanted to crop the
  rotated result. They cannot express that in one pipeline, and they should run two. Document
  it loudly — it is the honest cost of a fixed order and it is worth paying.
- **`background` set but no rotate and no contain-pad and an alpha-capable output.**
  Ignored. Not an error.
- **A stage that is a no-op** (`flip({})`, `rotate(0)`, `resize` to the same size) is
  short-circuited by its own implementation, so it costs an object check, not a copy.

## Acceptance

- `.rotate(15).crop(r)` and `.crop(r).rotate(15)` produce byte-identical output. This is
  the whole feature in one test.
- Every permutation of the five methods on one chain produces identical output. That is 120
  orderings, which is a loop, and it is the definitive proof.
- `.resize({width: 800}).resize({width: 1200})` produces a 1200px-wide image.
- `.resize({width: 800}).maxLongEdge(400)` applies `maxLongEdge` only.
- A spec with only `format` set never allocates a transform buffer (instrument it).
- The documented order matches the executor's actual field-read order. Keep the executor to
  one readable function so this stays checkable by eye.
