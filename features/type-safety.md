# Type safety

**Milestone 6. Cross-cutting. Depends on: [format-quality.md](format-quality.md).**

## What it is

Strict TypeScript, no `any` in the public API, and format-specific options that make
`.toFormat('png', { quality: 80 })` a **compile error** rather than a silently ignored
option.

## tsconfig

`strict: true` plus:

- `noUncheckedIndexedAccess` — a pixel buffer index returns `number | undefined`. Annoying
  in tight loops, and it is exactly right for a library whose entire job is indexing into
  typed arrays. Where it genuinely costs performance in an inner loop, one localised
  non-null assertion with a comment beats turning the flag off globally.
- `exactOptionalPropertyTypes` — `{ quality: undefined }` is not the same as `{}`.
  Matters when specs come from `JSON.parse` and a key is present but null.
- `noImplicitOverride`, `noFallthroughCasesInSwitch` — free.
- `verbatimModuleSyntax` — keeps the emitted imports honest for the bundler.

`any` is banned in the public surface. Internally, in a codec's bit-twiddling guts, a
narrow `as` with a comment explaining the invariant is acceptable — the type system cannot
express "byte 4 of this header is the colour type" and pretending otherwise produces worse
code than an honest cast.

## The format-options mechanism

The headline requirement, in full:

```typescript
type Format = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff';

type FormatOptions<F extends Format> =
  F extends 'jpeg'  ? { quality?: Quality }
: F extends 'webp'  ? { quality?: Quality; lossless?: boolean }
: F extends 'gif'   ? { dither?: boolean; paletteSize?: number }
: F extends 'tiff'  ? { compression?: 'none' | 'lzw' }
: F extends 'png' | 'bmp' ? Record<string, never>
: never;

toFormat<F extends Format>(format: F, opts?: FormatOptions<F>): this;
```

`Record<string, never>` on PNG and BMP is what produces the error: an object literal with
`quality` has an excess property against a type that permits none, and TypeScript's excess
property check fires on the literal. `{}` would not work — it accepts anything object-shaped.

The generic `F` must be inferred from the *literal* argument, so `toFormat('png', ...)`
narrows to the PNG branch. Passing a `Format`-typed variable widens `F` to the union and the
check goes soft. That is inherent to how this works, it is why the runtime check exists too
([format-quality.md](format-quality.md)), and it is worth a comment in the code so the next
person does not think the type is broken.

### Should `Quality` be branded?

```typescript
type Quality = number & { readonly __brand: 'Quality' };  // ?
```

**No.** Branding forces every caller to launder a plain number through a constructor, which
means the plugin's slider value needs `asQuality(v)` at every call site. That is a tax on
every user of the library to catch a mistake (`quality: 500`) that the runtime check catches
anyway with a better error message. A plain `number` with a documented 1–100 range and a
runtime guard is the right trade.

*(ponytail: skipped branded types; runtime validation covers the range, and the error
message is better than the type error would be.)*

## Types through the chain

Every chain method returns `this`, so the chain type is stable and inference does not
degrade over a long chain. `toFormat` is the only method with a generic, and it does not
change the chain's type — the format lives in the spec, not in the chain's type parameter.

The alternative (a phantom type parameter tracking the format so `toBuffer()` knows what it
returns) buys nothing: `toBuffer()` returns `Uint8Array` for every format. Do not build a
type-level state machine to track information nothing consumes.

## Types are not validation

Load-bearing, and stated in three files because it keeps mattering. Everything crossing
these boundaries has never met the compiler:

- `decode(bytes)` — bytes from a disk, from a user, possibly hostile.
- `SImg.pipeline(spec)` — from a settings JSON file, possibly hand-edited, possibly from an
  older version ([batch-pipeline.md](batch-pipeline.md)).
- Any call from plain JavaScript. The plugin is TypeScript today. Someone else's will not be.

Every one gets a runtime check, throwing a typed error ([errors.md](errors.md)). The types
are for the developer at 3pm; the validation is for production at 3am.

## Exported types

Export everything a caller could need to name a variable: `Format`, `RawImage`,
`PipelineSpec`, `CropOptions`, `ResizeOptions`, `RotateOptions`, `FlipOptions`,
`FormatOptions`, `Resampling`, `RGBA`, `SImgError` and its subclasses, `FormatSupport`.

A library that makes callers write `Parameters<typeof x>[0]` to name an argument type has
failed at its own API.

## Use cases

- The plugin's Format panel disables the quality slider on lossless formats. The library's
  types encode the same rule, so the two cannot drift.
- Someone reads the `.d.ts` instead of the docs (everyone does this) and the types tell them
  the truth.
- A refactor that breaks an option's shape breaks a build, not a user's images.

## Edge cases

- **A `Format`-typed variable** widens `F` and softens the check, as above. Runtime catches
  it. Document it.
- **JS callers** get no type checking at all. Runtime catches it.
- **`exactOptionalPropertyTypes` and `JSON.parse`.** A settings file with
  `"quality": null` produces `{quality: null}`, which fails the type *and* needs a runtime
  message that says something better than "expected number, got object".
- **Excess property checking only fires on object literals.** `const o = {quality: 80};
  toFormat('png', o)` compiles. Known TypeScript behaviour, not fixable, and the reason
  the runtime check is not optional.

## Acceptance

- `tsc --noEmit --strict` clean, with all the flags above on.
- `.toFormat('png', { quality: 80 })` fails to compile. Pinned with a
  `// @ts-expect-error` fixture so that loosening the type breaks a test rather than
  quietly shipping.
- The same call from `JSON.parse`d config throws `INVALID_OPTION` at runtime.
- No `any` in the generated `.d.ts`. Grep it in CI.
- Every public type is exported and nameable by a consumer.
- The PRD's example compiles verbatim.
