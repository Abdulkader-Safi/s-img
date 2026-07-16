# s-img feature index

> `s-img`, short for safi-image. npm package name: `s-img`.

Pure TypeScript image manipulation library. No native binaries, no postinstall step.
Engine layer for the Obsidian image editor plugin, replacing a 7 MB ImageMagick bundle.

Every feature below has its own file in this folder. Work through them in order:
the list is sorted so each item's dependencies are already ticked above it.

---

## Blockers: decide these before writing code

- [ ] **Q1. HEIC/HEIF support.** Drop it (like AVIF), or ship it as a second lazy WASM module at 1 to 2 MB? See [heic-decision.md](heic-decision.md).
- [ ] **Q2. Rotation fill colour.** Configurable with white as the default? See [rotate.md](rotate.md).
- [ ] **Q3. Sync vs async API.** Async-only for consistency with WebP's dynamic import? See [api-surface.md](api-surface.md).
- [ ] **Q4. Which libwebp WASM build.** Wrap jSquash's binary, or build a minimal one? See [codec-webp.md](codec-webp.md).

---

## Milestone 1: core buffer, PNG, resize, crop

- [x] [errors.md](errors.md) — typed error classes, thrown early, never a bare `Error`.
      *(Moved ahead of raw-image: `createImage` and `assertValidImage` both have to throw,
      and errors.md bans a bare `throw new Error(` anywhere in the codebase. Errors has no
      dependencies of its own. `CodecLoadError` is deliberately absent until
      `feat/codec-webp`, which is when the `Format` type it carries will exist.)*
- [x] [raw-image.md](raw-image.md) — the `RawImage` pixel buffer type, the one currency the whole library trades in.
- [x] **formats** — the `Format` union and the magic-byte sniffer, carved out of
      [decode.md](decode.md)'s "Format sniffing" section. Not a spec file of its own.
      *(Split out because decode needs `Format` before it can have a signature, and
      decode with no codec to dispatch to is nothing. Identifying HEIC by name for the
      error message lands with feat/decode, where the error is built.)*
- [ ] [codec-png.md](codec-png.md) — PNG read and write on Node's `zlib`.
      **Do this before decode/encode**: the dispatch layer needs something to dispatch to,
      and PNG is the lossless round-trip every later feature gets tested against.
      Carries the `node:zlib`-in-an-Obsidian-renderer check (see below).
- [ ] [decode.md](decode.md) — `decode(bytes, opts)`, the size guard, codec dispatch.
- [ ] [encode.md](encode.md) — `encode(image, format, opts)`, the mirror of decode.
- [ ] [resampling.md](resampling.md) — nearest, bilinear, Lanczos-3 kernels, shared by resize and rotate.
- [ ] [resize.md](resize.md) — `resize({ width, height, upscale, fit })`.
- [ ] [crop.md](crop.md) — `crop({ x, y, width, height })`.

## Milestone 2: JPEG, cheap transforms, preset resize

- [ ] [codec-jpeg.md](codec-jpeg.md) — baseline DCT read and write.
- [ ] [rotate-90.md](rotate-90.md) — exact 90° step rotation, no resampling.
- [ ] [flip.md](flip.md) — horizontal and vertical mirroring.
- [ ] [max-long-edge.md](max-long-edge.md) — shrink-only preset resize.

## Milestone 3: the hard one

- [ ] [rotate.md](rotate.md) — arbitrary-angle rotation, resampled, growing canvas, fill strategy.

## Milestone 4: the rest of the pure JS formats

- [ ] [codec-bmp.md](codec-bmp.md) — BMP read and write.
- [ ] [codec-gif.md](codec-gif.md) — GIF read and write, static frames, quantisation.
- [ ] [codec-tiff.md](codec-tiff.md) — TIFF read and write, uncompressed and LZW.
- [ ] [strip-metadata.md](strip-metadata.md) — EXIF, GPS and ICC removal, per codec.
- [ ] [format-quality.md](format-quality.md) — `toFormat()` and the quality option.

## Milestone 5: WebP

- [ ] [codec-webp.md](codec-webp.md) — libwebp WASM, lazy-loaded, `preload()` escape hatch.
- [ ] [supported-formats.md](supported-formats.md) — `supportedFormats()` runtime probe.

## Milestone 6: the API the plugin actually calls

- [ ] [api-surface.md](api-surface.md) — the chained builder, async shape, entry points.
- [ ] [pipeline-order.md](pipeline-order.md) — canonical crop → rotate → flip → resize → format order.
- [ ] [batch-pipeline.md](batch-pipeline.md) — the reusable, serialisable pipeline object.
- [ ] [fast-decode.md](fast-decode.md) — downsample during decode for the live preview path.
- [ ] [type-safety.md](type-safety.md) — strict types, `.toFormat('png', { quality })` is a compile error.
- [ ] [file-io.md](file-io.md) — the `fs` boundary, kept out of the pixel code.
- [ ] [bundle-size.md](bundle-size.md) — the size budget and how it gets enforced in CI.

## Milestone 7: integration

- [ ] [plugin-swap.md](plugin-swap.md) — replace ImageMagick in the Obsidian plugin, confirm Sync works.

---

## Explicitly not in v1

AVIF (no pure JS AV1 codec exists). Browser build. Animated GIF. Preset storage,
UI state, preview rendering — those stay in the plugin. Multi-page TIFF and
JPEG-in-TIFF. See the individual codec files for what each one does and does not cover.
