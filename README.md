# s-img

Short for safi-image. Image editing for Node and Bun, written entirely in TypeScript.
No native binaries, no postinstall compile step, no prebuilt platform packages.

## What it does

Decode an image to a pixel buffer, transform it, encode it back:

- **Read and write** PNG, JPEG, WebP, GIF, BMP, TIFF.
- **Crop, rotate, flip, resize.** Rotation handles arbitrary angles, not just 90 degree
  steps.
- **Format conversion and quality control**, plus metadata stripping (EXIF, GPS, colour
  profiles).

PNG, JPEG, GIF, BMP and TIFF are pure TypeScript and always loaded. WebP is a libwebp WASM
module that loads on first use, so you only pay for it if you touch a WebP file.

## Why it exists

It's the engine for an Obsidian image editor plugin that currently bundles ImageMagick.
That bundle is 7 MB, and Obsidian Sync struggles with binaries that size, so anyone using
Sync can't run the plugin.

Same editing capability, at a fraction of the size, is the whole point. The budget:

|                                            | Size         | vs ImageMagick |
| ------------------------------------------ | ------------ | -------------- |
| Core (PNG, JPEG, GIF, BMP, TIFF), min+gzip | under 150 KB | ~47x smaller   |
| Core + WebP WASM, when WebP is used        | under 500 KB | ~14x smaller   |
| The ImageMagick bundle being replaced      | 7 MB         |                |

If the core misses 150 KB, the premise is in trouble. `npm run check:size` measures it, and CI fails the build over budget.

## Status

**Every feature is built.** All six formats read and write, the transforms and the pipeline
are done, and the core is **23.2 KB min+gzip** — 15.5% of the 150 KB budget, against the 7 MB
it replaces. 558 tests, plus a Bun parity check and a size gate, on every PR.

`features/index.md` is the plan: one file per feature, ordered by milestone. Every box is
ticked; the handful of open sub-items under them are recorded gaps, not surprises.

`docs/superpowers/specs/2026-07-16-s-img-setup-design.md` records the decisions those specs
left open, including why HEIC was dropped and why the whole API is async.

The npm package is **`safi-image`** — which is what `s-img` was always short for. The repo
stays `s-img`.

**[Full documentation is in the wiki](https://github.com/Abdulkader-Safi/s-img/wiki)** —
[Getting Started](https://github.com/Abdulkader-Safi/s-img/wiki/Getting-Started),
[API Reference](https://github.com/Abdulkader-Safi/s-img/wiki/API-Reference),
[Formats](https://github.com/Abdulkader-Safi/s-img/wiki/Formats),
[Previews and Performance](https://github.com/Abdulkader-Safi/s-img/wiki/Previews-and-Performance).

## Install

```bash
npm i safi-image
```

Or straight from GitHub, if you want an unreleased commit:

```bash
npm i github:Abdulkader-Safi/s-img
```

npm clones the repo and builds it for you (`dist/` is not committed, so a `prepare` script
compiles it on install). Pin a branch or a tag when you want to:

```bash
npm i github:Abdulkader-Safi/s-img#main
```

Requires Node 22.18+ or Bun. The package is ESM with bundled type declarations; a CJS
consumer (an Obsidian plugin, say) gets there through its own bundler, which is what esbuild
is for.

Working on both repos at once? `npm link ../s-img` skips the reinstall on every change.

## Using it

```typescript
import { SImg } from 'safi-image';

const out = await SImg.fromBuffer(bytes)
  .crop({ x: 200, y: 100, width: 800, height: 600 })
  .rotate(8)
  .maxLongEdge(400)
  .toFormat("jpeg", { quality: 80 })
  .toBuffer();
```

`Uint8Array` in, `Uint8Array` out. Everything is async because WebP's WASM has to load
sometime, and one API that is sometimes async is worse than one that always is.

**The order is canonical, not the order you call it in:** crop → rotate → flip → resize →
format. Say what you want and the library sequences it, so a chain cannot mean two things.

### A recipe you can store

A chain edits one image. A pipeline is a recipe — plain JSON, so it survives a settings
file, and the same object drives both a preview and the full-resolution save.

```typescript
const preset = SImg.pipeline()
  .maxLongEdge(600)
  .stripMetadata()
  .toFormat("jpeg", { quality: 75 });

localStorage.setItem("preset", JSON.stringify(preset.toJSON()));
const restored = SImg.pipeline(JSON.parse(localStorage.getItem("preset")!));

for (const file of files) await restored.run(file); // reusable, no rebuilding
```

`SImg.pipeline(spec)` validates: a spec out of a settings file is untrusted input, and it
throws `InvalidOptionError` naming the field rather than failing weirdly three steps later.

### Previews: decode small, transform often

The reason the library exists. A full-resolution rotate on a 12MP photo is ~150ms — visible
stutter on every frame of a drag. So decode once, small, and transform _that_:

```typescript
const preview = await decode(bytes, { hintMaxLongEdge: 1600 }); // 68ms, not 224ms
// per frame: transform `preview`. No re-decode, no encode. ~9ms.
// on save:   SImg.pipeline(spec).run(bytes)  — full resolution, once.
```

**Read the size off the result, never compute it.** `hintMaxLongEdge` is a hint: JPEG scales
during the DCT, which only does powers of two, so a 4000px photo hinted at 1600 comes back
at **1000**. Assume `1600 / 4000` and every crop you map back is off by 1.6×.

```typescript
const scale = probe(bytes).width / preview.width; // probe() is microseconds, no decode
```

### Errors

Every failure is an `SImgError` with a `code`, never a raw `TypeError` from inside a decoder.

```typescript
import { SImgError, UnsupportedFormatError, ImageTooLargeError } from 'safi-image';

try {
  await SImg.fromBuffer(bytes).toFormat('webp').toBuffer();
} catch (e) {
  if (e instanceof UnsupportedFormatError) {
    // The bytes are not an image we read. e.message quotes the first few, so a
    // bug report tells you what the file actually was.
  } else if (e instanceof ImageTooLargeError) {
    // A decompression bomb, or a genuinely enormous photo. Raise the cap per call
    // with decode(bytes, { maxPixels }) if you meant it.
  } else if (e instanceof SImgError) {
    switch (e.code) { /* 'CORRUPT_IMAGE' | 'INVALID_OPTION' | ... */ }
  }
}
```

Messages are written for whoever reads the bug report, not for whoever wrote the throw:
`jpeg.quality must be an integer from 1 to 100, got 500`.

### What this build can do, right now

WebP is a WASM module that loads on first use, so it can genuinely be unavailable in a way
PNG never is. Ask rather than assume:

```typescript
supportedFormats(); // { read: [...], write: [...], pending: ['webp'], unavailable: [] }
await preload("webp"); // optional: load it up front instead of on first touch
```

### Examples

Two runnable scripts, which are the fastest way to see the whole surface:

```bash
npm run example          # the tour: read, chain, convert, store a spec, handle errors
npm run example:preview  # the two-pass preview design, with real timings on a 12MP photo
```

They write real files into `examples/output/` for you to open. See `examples/`.

## Running it

Requires Node 22.18 or newer (the tests rely on its TypeScript type stripping). Bun is optional, and only needed for the parity check.

```bash
npm install
npm run check       # tsc strict + guards + tests. The one to run before a commit.
```

Individually:

```bash
npm run build         # tsc to dist/, ESM
npm test              # node --test
npm run test:bun      # the Bun half of the Node/Bun parity claim
npm run check:guards  # the two boundary rules, see below
npm run check:size    # the core bundle against its 150 KB budget
npm run bench:preview # the preview path's numbers, on a generated 12MP JPEG
```

CI runs `check`, `build`, the Bun smoke test and the size gate on every PR.

## Tests

`node --test`, no framework. Node 22 strips the types, so tests run straight from `.ts` with no build step ahead of them.

```bash
npm test                           # everything
node --test test/guards.test.ts    # one file
node --test --watch                # on change
```

`npm run test:bun` is deliberately not the full suite. Running the codec tests twice proves little, and Bun's `node:test` support has gaps not worth fighting. It imports the package under Bun and asserts it works, which is the parity claim's foundation. Today that means it loads; it grows into a decode, transform, encode round-trip when PNG lands.

## The guards

`npm run check:guards` enforces the mechanical rules the design asserts:

1. **No host access under `src/core/`.** No `fs`, no `Buffer`, no `process`. Pixel code that can't reach the filesystem can't grow a filesystem-shaped bug, needs no mock, and stays portable to a browser build later. `node:zlib` in `codecs/png.ts` is the one exception, and it's what a browser build would swap for `CompressionStream`.
2. **Every throw is a typed `SImgError`**, so a caller's `instanceof` check is exhaustive.
3. **The emitted JS never imports a `.ts` path.** Source uses `.ts` specifiers and `tsc` rewrites them on emit. Lose that and the published package crashes on import for everyone, while the suite stays green, because tests run from source.
4. **No `any` in the emitted `.d.ts`.**

Four rules is not an eslint config. They're greps, in `scripts/guards.mjs`, and each has a test that watches it fail on purpose. That isn't ceremony: the first version of guard 1 reported clean on a real violation, because stripping string literals to protect prose also deleted the import specifiers it was hunting for.

## Layout

```
src/core/       the pixel pipeline. Host-free.
  image.ts      RawImage: width, height, RGBA bytes. The one currency.
  codecs/       png jpeg gif bmp tiff webp
  transform/    crop rotate flip resize resample
  pipeline.ts   the canonical-order executor
src/io/         the only fs in the repo
test/
scripts/        guards.mjs, size.mjs
features/       the design, one file per feature
```

Operations always apply in a fixed order (crop, rotate, flip, resize, format) no matter what order they were called in. That's not a convenience. Resize-then-crop cuts the wrong region and doesn't throw doing it. `features/pipeline-order.md` has the reasoning.

## Not in v1

No browser build, though the core wouldn't change and the `src/core` boundary exists to keep that true. No AVIF, since no pure JS AV1 codec exists anywhere. No HEIC: libheif is 1 to 2 MB, roughly 13x the entire pure JS core, against a project whose reason to exist is a size budget. No animated GIF. No preset storage or UI state, which stay in the plugin.

Each of those has a file in `features/` recording what would bring it back.

## Licence

MIT.
