# toFormat() and quality

**Milestone 4. Depends on: every codec, [type-safety.md](type-safety.md).**

## What it is

Pick the output format and its options. The last stage of the canonical pipeline.

```typescript
toFormat<F extends Format>(format: F, opts?: FormatOptions<F>): this;

type Format = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff';
```

## The type-level rule

`quality` exists only on the lossy formats. This is the PRD's headline type-safety
requirement and it is a compile error, not a runtime no-op:

```typescript
type FormatOptions<F extends Format> =
  F extends 'jpeg'  ? { quality?: Quality; background?: RGBA }
: F extends 'webp'  ? { quality?: Quality; lossless?: boolean }
: F extends 'gif'   ? { dither?: boolean; colors?: number }
: F extends 'tiff'  ? { compression?: 'none' | 'lzw' }
: F extends 'bmp'   ? { background?: RGBA }
: F extends 'png'   ? Record<string, never>
: never;

type Quality = number; // 1-100, validated at runtime
```

```typescript
.toFormat('jpeg', { quality: 80 })   // fine
.toFormat('png',  { quality: 80 })   // Error: Object literal may only specify known properties
.toFormat('webp', { quality: 80 })   // fine
.toFormat('gif',  { dither: false }) // fine
```

PNG's `Record<string, never>` is what makes the error message land on the excess
property.

Two corrections to the sketch above, both found while building this against the codecs that
already existed. It said `paletteSize` where [codec-gif.md](codec-gif.md) and the
implementation say **`colors`** -- one name had to win, and `colors` is the one already
shipped and the one the ecosystem uses (`magick -colors`, pngquant, sharp). And it gave BMP
no options and JPEG only `quality`, but [encode.md](encode.md) requires `background` on both
of the formats with no alpha, or a rotated PNG's transparent corners have nowhere to go. The
sketch was illustrative; the codecs are the contract. Mechanism and the branded-`Quality` question are in
[type-safety.md](type-safety.md).

Why this instead of ignoring the option: it mirrors the plugin's UI, which disables the
quality slider on lossless formats and says why. The library and the UI should not disagree
about what is possible. A silently-ignored option is a lie the compiler could have caught.

## Runtime validation too

Types do not survive `JSON.parse`. The batch pipeline is explicitly serialisable
([batch-pipeline.md](batch-pipeline.md)), so a config can arrive from the plugin's settings
file with `{format: 'png', quality: 80}` in it, having never seen the compiler. Validate at
runtime as well: unknown format → `INVALID_OPTION`, quality outside 1–100 →
`INVALID_OPTION`, quality on a lossless format → `INVALID_OPTION`.

Belt and braces, and the runtime check is the one that actually fires in production.

## Defaults

- No `toFormat()` call at all → **encode back to the source format.** The plugin's "just
  crop this and save it" case, and re-encoding a JPEG as a PNG because the caller forgot to
  say would be a nasty surprise (a 200 KB photo becomes 4 MB). Requires `decode` to tell the
  pipeline which format came in, which is a field on the pipeline's internal state, not on
  `RawImage` ([raw-image.md](raw-image.md) stays clean).
- `quality` unspecified on JPEG → **82**.
- `quality` unspecified on WebP → **80**. WebP's quality scale is not JPEG's; the same
  number does not mean the same thing, and 80 is roughly where WebP sits for
  visually-lossless-ish photos.
- GIF `dither` → true. `colors` → 256.
- TIFF `compression` → `'lzw'`.

## Quality is not comparable across formats

`quality: 80` on JPEG and `quality: 80` on WebP produce different files at different sizes
with different artifacts. There is no shared scale and pretending otherwise would be a lie.
If the user switches format in the UI, the plugin should keep the slider value (the least
surprising behaviour) but the library makes no promise that output size is preserved.
Document this in the API docs; it is a support question waiting to happen.

## WebP lossless

WebP is the only format that is both. `lossless: true` ignores `quality` — which is
arguably a type sin (an option that silently does nothing under another option), but the
alternative is a discriminated union on the WebP options and that is more machinery than the
case deserves. Document it, validate it: passing both `lossless: true` and an explicit
`quality` throws `INVALID_OPTION` rather than silently ignoring one. If it is worth
throwing over, it is worth being explicit about.

## Use cases

- The plugin's Format panel: user picks WebP, drags quality to 80, saves.
- Batch conversion: the whole vault's PNGs to WebP at quality 80.
- Format-preserving edit: crop and save, no `toFormat`, output stays JPEG at the default
  quality. (Note the generational loss: re-encoding a JPEG always costs a little, even at
  quality 100. Nothing to do about it, but the plugin might want to warn.)

## Edge cases

- **`toFormat` called twice.** Last wins, consistent with every other method
  ([pipeline-order.md](pipeline-order.md)).
- **WebP requested but the WASM will not load.** `CODEC_LOAD_FAILED` at
  `toBuffer()` time, not at `toFormat()` time — the chain is lazy, nothing executes until
  the buffer is asked for. The plugin should call `supportedFormats()` first and not offer
  what is not there ([supported-formats.md](supported-formats.md)).
- **`quality: 100` on JPEG** is still lossy. Users assume otherwise, forever. A doc note is
  the whole fix.
- **`quality: 0`** → `INVALID_OPTION`. The range is 1–100.
- **Converting an alpha format to JPEG or BMP** → composited onto `background`
  ([encode.md](encode.md)), no error, no silent black.

## Acceptance

- `.toFormat('png', { quality: 80 })` fails to compile. Test with `expect-type` or a
  `// @ts-expect-error` fixture, so a future refactor that loosens the type breaks a test
  rather than shipping.
- The same, at runtime, from a `JSON.parse`d config → `INVALID_OPTION`.
- No `toFormat()` → output format matches input format, for all six.
- `quality: 40` produces a measurably smaller JPEG than `quality: 90`.
- `lossless: true` plus `quality` → `INVALID_OPTION`.
- Every format is reachable from every other format (a 6×6 conversion matrix test). This is
  one loop and it catches an entire class of "we never tried TIFF → GIF" bug.
