# Batch pipeline

**Milestone 6. Depends on: [pipeline-order.md](pipeline-order.md), [api-surface.md](api-surface.md).**

## What it is

The pipeline as a reusable, serialisable object, decoupled from any one image.

```typescript
const p = SImg.pipeline()
  .maxLongEdge(1600)
  .stripMetadata()
  .toFormat('webp', { quality: 80 });

for (const file of files) {
  const out = await p.run(await read(file));
  await write(file, out);
}
```

Same config, N inputs. The plugin's save-all, which is the feature that motivates this.

## Why it is not just "call the chain N times"

Rebuilding the chain per file would work. It would also mean:

- The plugin's preset config has nowhere to live except as code that constructs a chain, so
  a saved preset becomes "a function", which does not go in a settings JSON file.
- No way to inspect what a pipeline will do without running it.
- No way to compare two pipelines, or diff a preset against another.

Making the spec a value rather than a sequence of calls fixes all three, and it costs
nothing — the spec object already exists internally ([pipeline-order.md](pipeline-order.md))
because the canonical order needed it. This feature is mostly *exposing* a thing we already
built.

## Serialisation

```typescript
const spec: PipelineSpec = p.toJSON();
// { resize: { maxLongEdge: 1600 }, stripMetadata: true,
//   format: { format: 'webp', options: { quality: 80 } } }

const restored = SImg.pipeline(spec);
```

`PipelineSpec` is a plain object of plain values. No functions, no class instances, no
`RawImage`, no buffers. `JSON.parse(JSON.stringify(spec))` round-trips exactly, which is the
real requirement: the plugin's presets live in its settings file, and they need to survive
a reload.

**Runtime validation on the way in.** A spec from a settings file has never met the
compiler and may be from an older version of the plugin, or hand-edited, or corrupt.
`SImg.pipeline(spec)` validates every field and throws `INVALID_OPTION` naming the bad one.
This is a trust boundary and it gets the same treatment as decode's magic bytes. Types are
not validation ([format-quality.md](format-quality.md)).

**Versioning:** add a `version: 1` field now. It costs one line today and it is the
difference between a clean migration and a guessing game when the spec shape changes. An
unknown version → a clear error, not a best-effort parse.

## run()

```typescript
run(bytes: Uint8Array): Promise<Uint8Array>;
```

Stateless. Two `run()` calls on the same pipeline share nothing but the spec, so a pipeline
is safe to hold for the process lifetime and safe to use concurrently.

`Pipeline` is where a `runAll(inputs)` helper would go if it earned its place. It does not,
yet: the caller's loop is three lines, and a `runAll` would immediately need per-file error
policy (fail fast? collect?), progress callbacks, and concurrency control. Every one of
those is a decision the plugin should be making, since the plugin is the thing with a
progress bar. **Skip it.** Add it when the plugin's loop turns out to be copy-pasted in
three places.

*(ponytail: skipped runAll/concurrency/progress; the caller's for-loop covers it. Add when
the plugin has a real reason.)*

## Error policy is the caller's

One file in thirty is corrupt. The library throws from that `run()`, the plugin catches it,
records the failure, and continues. The library does not decide whether a batch aborts —
that is a product decision, and it belongs where the UI is.

This is why [errors.md](errors.md) matters: the plugin's catch block needs `code` to tell
"this file is corrupt, skip it" from "WebP will not load, abort the whole batch because the
other 29 will fail identically".

## Concurrency

Not the library's problem either, but worth a note for whoever writes the plugin loop: these
are CPU-bound synchronous operations wearing async clothes. `Promise.all` over 30 files does
not parallelise anything — it just interleaves nothing on one thread and holds 30 decoded
images in memory at once, which is how you OOM. A sequential loop is genuinely faster and
uses 1/30th the peak memory.

Real parallelism would mean worker threads, which means transferring buffers, which is a
project. The PRD does not ask. Document the sequential recommendation and move on.

## Use cases

- Save-all: one pipeline, every loaded file.
- The plugin's presets: a `PipelineSpec` in the settings JSON, restored on load.
- "Optimise this folder": one pipeline over a vault directory.
- Debugging: log the spec, see exactly what was asked for.

## Edge cases

- **Empty pipeline.** Decode, re-encode to source format, per file. Legal but wasteful —
  a JPEG loses quality for nothing. Worth a doc note.
- **Mixed input formats.** The point. No `toFormat` means each file keeps its own format,
  which is the correct and possibly surprising behaviour for a batch.
- **A crop rectangle valid for one file and not another.** Certain, in any real batch of
  mixed sizes. That file throws `INVALID_OPTION`, the rest are fine. Which is why crop is
  rarely in a batch preset — but the library should not stop you.
- **A spec from a future version.** Clear error on `version`.
- **`toJSON` on a pipeline holding a `background` RGBA tuple.** Serialises as an array,
  restores as an array. Fine, but the validator must accept it back.

## Acceptance

- One pipeline over 5 different inputs produces 5 correct outputs.
- `SImg.pipeline(p.toJSON())` produces byte-identical output to `p` for the same input.
- `JSON.parse(JSON.stringify(spec))` round-trips with no loss.
- A hand-corrupted spec throws `INVALID_OPTION` naming the field.
- An unknown `version` throws.
- Pipeline and chain produce identical output for the same operations (they share the
  executor, so this guards against drift).
- A corrupt file mid-batch throws only for that file; the loop continues.
