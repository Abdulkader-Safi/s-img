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

| | Size | vs ImageMagick |
|---|---|---|
| Core (PNG, JPEG, GIF, BMP, TIFF), min+gzip | under 150 KB | ~47x smaller |
| Core + WebP WASM, when WebP is used | under 500 KB | ~14x smaller |
| The ImageMagick bundle being replaced | 7 MB | |

If the core misses 150 KB, the premise is in trouble. `pnpm check:size` measures it.

## Status

**Nothing is built yet.** The design is done and the toolchain runs. The code starts now.

`features/index.md` is the plan: 30 features, one file each, ordered by milestone so every
dependency lands before the thing that needs it. Each unchecked box is one branch.

`docs/superpowers/specs/2026-07-16-s-img-setup-design.md` records the decisions those specs
left open, including why HEIC was dropped and why the whole API is async.

## Running it

Requires Node 22.18 or newer (the tests rely on its TypeScript type stripping) and pnpm.
Bun is optional, and only needed for the parity check.

```bash
pnpm install
pnpm check          # tsc strict + guards + tests. The one to run before a commit.
```

Individually:

```bash
pnpm build          # tsc to dist/, ESM
pnpm test           # node --test
pnpm test:bun       # the Bun half of the Node/Bun parity claim
pnpm check:guards   # the two boundary rules, see below
pnpm check:size     # the core bundle against its 150 KB budget
```

## Tests

`node --test`, no framework. Node 22 strips the types, so tests run straight from `.ts` with
no build step ahead of them.

```bash
pnpm test                          # everything
node --test test/guards.test.ts    # one file
node --test --watch                # on change
```

`pnpm test:bun` is deliberately not the full suite. Running the codec tests twice proves
little, and Bun's `node:test` support has gaps not worth fighting. It imports the package
under Bun and asserts it works, which is the parity claim's foundation. Today that means it
loads; it grows into a decode, transform, encode round-trip when PNG lands.

## The two guards

`pnpm check:guards` enforces the only two mechanical rules the design asserts:

1. **No host access under `src/core/`.** No `fs`, no `Buffer`, no `process`. Pixel code that
   can't reach the filesystem can't grow a filesystem-shaped bug, needs no mock, and stays
   portable to a browser build later. `node:zlib` in `codecs/png.ts` is the one exception,
   and it's what a browser build would swap for `CompressionStream`.
2. **No `any` in the emitted `.d.ts`.**

Two rules is not an eslint config. They're greps, in `scripts/guards.mjs`, with a test that
watches them fail on purpose.

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

Operations always apply in a fixed order (crop, rotate, flip, resize, format) no matter what
order they were called in. That's not a convenience. Resize-then-crop cuts the wrong region
and doesn't throw doing it. `features/pipeline-order.md` has the reasoning.

## Not in v1

No browser build, though the core wouldn't change and the `src/core` boundary exists to keep
that true. No AVIF, since no pure JS AV1 codec exists anywhere. No HEIC: libheif is 1 to 2
MB, roughly 13x the entire pure JS core, against a project whose reason to exist is a size
budget. No animated GIF. No preset storage or UI state, which stay in the plugin.

Each of those has a file in `features/` recording what would bring it back.

## Licence

MIT.
