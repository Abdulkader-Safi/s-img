# s-img feature index

> `s-img`, short for safi-image. npm package name: `s-img`.

Pure TypeScript image manipulation library. No native binaries, no postinstall step.
Engine layer for the Obsidian image editor plugin, replacing a 7 MB ImageMagick bundle.

Every feature below has its own file in this folder. Work through them in order:
the list is sorted so each item's dependencies are already ticked above it.

---

## Blockers: settled 2026-07-16

- [x] **Q1. HEIC/HEIF support.** **Dropped.** libheif is 1 to 2 MB, ~13x the pure JS core. See [heic-decision.md](heic-decision.md).
- [x] **Q2. Rotation fill colour.** **One shared pipeline-level `background`, default white.** See [rotate.md](rotate.md).
- [x] **Q3. Sync vs async API.** **Async everywhere.** See [api-surface.md](api-surface.md).
- [x] **Q4. Which libwebp WASM build.** **Wrap `@jsquash/webp`.** See [codec-webp.md](codec-webp.md).

---

## Milestone 1: core buffer, PNG, resize, crop

- [x] [errors.md](errors.md) — typed error classes, thrown early, never a bare `Error`. (Moved ahead of raw-image: `createImage` and `assertValidImage` both have to throw, and errors.md bans a bare `throw new Error(` anywhere in the codebase. Errors has no dependencies of its own. `CodecLoadError` is deliberately absent until `feat/codec-webp`, which is when the `Format` type it carries will exist.)*
- [x] [raw-image.md](raw-image.md) — the `RawImage` pixel buffer type, the one currency the whole library trades in.
- [x] **formats** — the `Format` union and the magic-byte sniffer, carved out of [decode.md](decode.md)'s "Format sniffing" section. Not a spec file of its own. (Split out because decode needs `Format` before it can have a signature, and decode with no codec to dispatch to is nothing. Identifying HEIC by name for the error message lands with feat/decode, where the error is built.)*
- [x] [codec-png.md](codec-png.md) — PNG read and write on Node’s `zlib`. Verified byte-identical to libpng on 120 real system PNGs.
- [x] [decode.md](decode.md) — `decode(bytes, opts)`, the size guard, codec dispatch.
- [x] [encode.md](encode.md) — `encode(image, format, opts)`, the mirror of decode.
  - [ ] **TIFF's own Orientation tag.** decode.md's orientation step covers JPEG only. TIFF carries the same tag number (274) in its IFD rather than in an APP1, and our TIFF decoder ignores it, so a scanner file tagged "rotate 90" decodes sideways. Found while proving a mutant equivalent on feat/dispatch; belongs to [codec-tiff.md](codec-tiff.md).
- [x] [resampling.md](resampling.md) — nearest, bilinear, Lanczos-3 kernels, shared by resize and rotate.
- [x] [resize.md](resize.md) — `resize({ width, height, upscale, fit })`.
- [x] [crop.md](crop.md) — `crop({ x, y, width, height })`.

## Milestone 2: JPEG, cheap transforms, preset resize

- [x] [codec-jpeg.md](codec-jpeg.md) — baseline DCT read and write.
  - [ ] **Progressive JPEG.** Deliberately deferred by [codec-jpeg.md](codec-jpeg.md): baseline ships with a clear `UNSUPPORTED_FORMAT`, and this closes before [plugin-swap.md](plugin-swap.md). Real files are progressive; this is a real gap, not a nice-to-have.
  - [ ] **Optimised Huffman tables on encode.** [codec-jpeg.md](codec-jpeg.md) waved this off as "2 to 5%, not worth a second pass". Measured against libjpeg it is 3% at quality 95 but **37% at quality 20**, and low quality is the preset pipeline's main job. The decision was made on a wrong number; re-make it deliberately.
- [x] [rotate-90.md](rotate-90.md) — exact 90° step rotation, no resampling.
- [x] [flip.md](flip.md) — horizontal and vertical mirroring.
- [x] [max-long-edge.md](max-long-edge.md) — shrink-only preset resize.

## Milestone 3: the hard one

- [x] [rotate.md](rotate.md) — arbitrary-angle rotation, resampled, growing canvas, fill strategy.

## Milestone 4: the rest of the pure JS formats

- [x] [codec-bmp.md](codec-bmp.md) — BMP read and write.
- [x] [codec-gif.md](codec-gif.md) — GIF read and write, static frames, quantisation.
- [x] [codec-tiff.md](codec-tiff.md) — TIFF read and write, uncompressed and LZW.
- [x] [strip-metadata.md](strip-metadata.md) — EXIF, GPS and ICC removal, per codec.
- [ ] [format-quality.md](format-quality.md) — `toFormat()` and the quality option.

## Milestone 5: WebP

- [ ] [codec-webp.md](codec-webp.md) — libwebp WASM, lazy-loaded, `preload()` escape hatch.
- [ ] [supported-formats.md](supported-formats.md) — `supportedFormats()` runtime probe.

## Milestone 6: the API the plugin actually calls

- [ ] [api-surface.md](api-surface.md) — the chained builder, async shape, entry points.
  - [ ] **`stripMetadata()` is a byte-for-byte no-op.** [strip-metadata.md](strip-metadata.md) is already true by construction and needs no code; the method is a builder method and belongs here. Its last acceptance item -- calling it and not calling it produce identical output -- can only be asserted once the builder exists.
  - [ ] **A runnable example, not a test.** Once the SDK exists, add a real script under `examples/` that exercises it end to end the way a consumer would, and link it from the README. It has to be something you can actually run and watch work, separate from the test suite.
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

AVIF (no pure JS AV1 codec exists). Browser build. Animated GIF. Preset storage, UI state, preview rendering — those stay in the plugin. Multi-page TIFF and JPEG-in-TIFF. See the individual codec files for what each one does and does not cover.
