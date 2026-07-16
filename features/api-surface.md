# The public API

**Milestone 6. Depends on: everything. Contains open question Q3.**

## What it is

The shape the plugin actually calls. Package name: **`s-img`** (safi-image).

```typescript
import { SImg } from 's-img';

const out = await SImg
  .fromBuffer(inputBuffer)
  .crop({ x: 100, y: 50, width: 800, height: 600 })
  .rotate(15)
  .flip({ horizontal: true })
  .resize({ width: 1200, upscale: false })
  .stripMetadata()
  .toFormat('webp', { quality: 80 })
  .toBuffer();
```

Entry points:

```typescript
SImg.fromBuffer(bytes: Uint8Array): SImgChain;
SImg.pipeline(spec?: PipelineSpec): Pipeline;   // batch-pipeline.md
supportedFormats(): FormatSupport;              // supported-formats.md
preload(format: Format): Promise<void>;         // codec-webp.md
decode(bytes, opts?): Promise<RawImage>;        // the low-level door
encode(image, format, opts?): Promise<Uint8Array>;
```

The chain is sugar. `decode`/`encode` stay exported because a caller who wants to do
something we did not think of should not have to fight the builder.

## The chain is lazy

**No method on the chain does any work.** They record intent and return `this`. Nothing
decodes, nothing allocates a pixel buffer, nothing throws a codec error, until `.toBuffer()`
is awaited.

Consequences worth stating:

- `.crop({width: -5})` throws immediately (option validation is synchronous and eager,
  [errors.md](errors.md)), but `.toFormat('webp')` on a machine with no WASM does not throw
  until `.toBuffer()`. Both are correct: the first is a caller mistake visible at the call
  site, the second is an environment failure that can only be discovered by trying.
- The chain can be built once and executed never. Cheap.
- Call order does not matter, because nothing runs in call order. That is what makes
  [pipeline-order.md](pipeline-order.md) possible rather than a lie.

## Q3, ANSWERED: sync or async

The PRD asks: WebP's dynamic import is inherently async — does everything go async for
consistency, including PNG and JPEG work that could be synchronous?

**Decided: async everywhere. `toBuffer()` always returns a Promise.** Signed off explicitly, since it is irreversible in practice.

- A sync/async split leaks WebP's implementation detail into every call site. The plugin
  would need `if (format === 'webp') await ... else ...`, which is the library's problem
  wearing the caller's clothes.
- A `toBufferSync()` that throws on WebP is a footgun that fires on exactly the format the
  project most wants people to use.
- The plugin's callers are already async (Obsidian's vault API is), so `await` costs
  nothing there. The single caller that matters does not want sync.
- If [heic-decision.md](heic-decision.md) ever lands as option B, that is a second async
  module and the split would have to grow another arm.
- One shape, no branches, no format-dependent API. This is the lazy answer *and* the correct
  one, which is the good case.

The cost is honest and small: a Promise wrapper on work that could be synchronous. That is
microseconds against a 260ms rotate. Nobody will ever measure it.

Signed off. It is irreversible in practice — adding sync later means a parallel API forever
— which is exactly why it was asked rather than assumed.

## Chain state

Internally the chain holds a `PipelineSpec` (the serialisable operation set from
[batch-pipeline.md](batch-pipeline.md)) plus the input bytes. `.toBuffer()` is:

```
decode(bytes) → applyPipeline(spec) → encode(format, opts)
```

Which means `SImg.fromBuffer(b).crop(...).toBuffer()` and
`SImg.pipeline({crop: ...}).run(b)` are literally the same code path with the same spec.
The chain is a spec builder with an input attached. Two APIs, one implementation, and the
batch case is not a bolted-on afterthought.

## Mutability

`.crop()` mutates the chain and returns `this`, rather than returning a new immutable chain.

Immutable chains are nicer in principle (fork a chain, vary one option) but the plugin has
no forking use case, and `this`-returning is less allocation and less code. If forking ever
matters, `Pipeline` is already a plain serialisable object that can be cloned with a spread.
The escape hatch exists, so the simple version is safe.

*(ponytail: skipped immutable chain semantics; `Pipeline` covers forking if it's ever needed.)*

## Naming

`SImg` as the exported class. `s-img` as the package. The PRD's example uses `ImageLib` from
`'your-lib'`, both placeholders.

## Use cases

- The plugin's editor: build a chain from the UI state, `toBuffer()` on save.
- The plugin's preview: `decode(bytes, {maxLongEdge: 1600})` directly, apply a pipeline to
  the `RawImage`, hand the pixels to a canvas. Never touches `toBuffer()` — no encode on a
  preview frame. See [fast-decode.md](fast-decode.md).
- Batch save-all: one `Pipeline`, N inputs.
- A future caller doing something exotic: `decode` and `encode`, no chain.

## Edge cases

- **Empty chain.** `SImg.fromBuffer(b).toBuffer()` decodes and re-encodes to the source
  format. Legal. Not a no-op (it re-encodes, so a JPEG loses a little), which is worth a
  doc note.
- **`toBuffer()` twice.** Runs twice. Not cached. Deterministic, so the result is the same,
  just paid for twice. Caching would need a spec-dirty check and nobody is calling it twice.
- **Method called twice** (`.crop().crop()`): last wins ([pipeline-order.md](pipeline-order.md)).
- **`toBuffer()` on a chain with no `toFormat`**: source format
  ([format-quality.md](format-quality.md)).

## Acceptance

- The PRD's example compiles and runs, verbatim, with `SImg` and `s-img` substituted.
- `.crop({width: -5})` throws synchronously, on that line, before any decode.
- `.toFormat('webp')` on a chain never loads the WASM until `.toBuffer()` is awaited.
- The chain and `Pipeline` produce byte-identical output for the same operations. Same code
  path, so this is really a regression test against them drifting apart.
- No `any` in the exported types ([type-safety.md](type-safety.md)).
