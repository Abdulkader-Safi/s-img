# WebP codec (WASM, lazy)

**Milestone 5. Depends on: [decode.md](decode.md), [encode.md](encode.md),
[errors.md](errors.md).**

## What it is

Full WebP encode and decode via a libwebp WASM build, loaded on first use. The only
non-pure-JS thing in the library and the only thing that can push it past the size budget.

Roughly 200 to 400 KB, paid **only** if a caller touches a WebP file. The five pure JS
codecs stay under ~150 KB gzipped without it ([bundle-size.md](bundle-size.md)).

## Why WASM and not pure JS

There is no pure JS WebP encoder worth having. WebP's lossy mode is VP8 intra-frame coding
— a full video codec's intra path. Writing that in TypeScript is a multi-month project that
would end up slower and buggier than the WASM. This is the one place where "pure TypeScript"
loses to reality, and the PRD already concedes it.

Decode-only in pure JS is a bit more plausible but still large and still slow, and we need
encode anyway (WebP is the format the plugin wants people to *convert to* — it is the whole
size-saving story). So: one WASM module, both directions.

## Open question Q4: which build

The PRD asks: wrap jSquash's binary, or build a minimal libwebp ourselves?

**Recommendation: wrap jSquash.**

- `@jsquash/webp` is a maintained, tested libwebp build from the Squoosh lineage, with
  separate encode and decode modules so we can lazy-load them independently — a plugin that
  only ever reads WebP never pays for the encoder.
- Building our own means an Emscripten toolchain in the repo, a build step in CI, and a
  binary blob to audit. That is a lot of machinery to trim maybe 50 KB, and the PRD's
  explicit non-goal is "no postinstall compile step" — self-building drifts toward exactly
  that culture even if the artifact ships prebuilt.
- The ladder applies: an existing dependency solves this. Take it.

The reason it is still a question and not a decision: jSquash targets browsers and its
loader may need a shim to find the `.wasm` next to the `.js` under Node and Bun, and inside
an Obsidian plugin bundle (which is esbuild'd into a single file, so `import.meta.url` may
not point anywhere useful). **Prototype the load path inside an actual Obsidian plugin
before committing.** If that fight turns out worse than an Emscripten build, revisit. Do
this spike early in the milestone, not at the end — it is the only real unknown here.

## Loading

```typescript
// Lazy: first WebP touch pays the load.
await decode(webpBytes);

// Or warm it at plugin startup so the first image open is not slow.
await preload('webp');
```

- Dynamic `import()` on first use, inside the codec module, behind a memoised promise so
  concurrent first-touches load once. A batch of 30 WebP files must not trigger 30 loads.
- `preload(format)` for the plugin to warm at startup. This is why it exists: paying 300 KB
  of instantiation on the first image open is a visible stall in the UI, and the plugin
  knows at startup whether WebP is in its preset list.
- Load failure → `CodecLoadError` with the original rejection in `cause`
  ([errors.md](errors.md)). Never a bare rejection, never a silent fall back to another
  format.
- Once loaded, stays loaded for the process lifetime. No unloading, no cache eviction.
  YAGNI: the plugin runs in a long-lived Electron process and 300 KB of WASM is not the
  memory problem.

This dynamic import is the reason the whole API is async. See Q3 in
[api-surface.md](api-surface.md).

## Options

```typescript
{ quality?: 1-100, lossless?: boolean }
```

Default quality 80. `lossless: true` plus an explicit `quality` throws — see
[format-quality.md](format-quality.md).

Not exposing: `method` (the 0–6 effort dial), `alphaQuality`, `sns`, `filter`, the near-
lossless mode. libwebp has dozens of knobs and every one of them is a support question and a
line of API surface for a plugin whose UI has exactly one slider. Add them when something
real asks.

Alpha is supported natively, no compositing needed.

## Metadata

libwebp can write `EXIF` and `ICCP` chunks. Configure it to write neither, and **assert it
in a test** — this is the one codec where we do not control the output bytes, so
[strip-metadata.md](strip-metadata.md)'s guarantee is an assumption here until proven.

## Use cases

- The size story. Converting a vault's PNGs and JPEGs to WebP is where the real byte savings
  are, and byte savings through Obsidian Sync is the point of the whole project.
- Reading WebP files someone saved from the web. Increasingly common.
- The preset pipeline's likely default output format.

## Edge cases

- **Animated WebP.** Exists (an `ANMF` chunk). Decode frame 0, same as GIF and TIFF. Or a
  clear error if jSquash's decoder does not expose it gracefully — check during the spike.
- **Extended format (`VP8X`)** vs simple lossy (`VP8 `) vs simple lossless (`VP8L`). The
  sniff in [decode.md](decode.md) matches `RIFF....WEBP` and libwebp handles the rest.
- **Very large images.** WASM memory is a fixed heap that grows in pages. A 20000×20000
  RGBA is 1.6 GB and will fail inside the module, probably ungracefully. The `maxPixels`
  guard should fire before we ever hand bytes to WASM. Test that the guard, not the WASM,
  is what throws.
- **WASM disabled or blocked.** Some hardened Electron configs. `CodecLoadError`, and the
  plugin's `supportedFormats()` should already be reporting WebP as unavailable so the UI
  never offered it ([supported-formats.md](supported-formats.md)).
- **Bun vs Node WASM instantiation.** Both support it; the loader shim is where they differ.
  Part of the spike.

## Acceptance

- Decode and encode round-trip a WebP fixture, lossy and lossless.
- The WASM is not loaded until a WebP operation runs. Assert by checking that a PNG-only
  pipeline never touches the module (spy on the import, or measure).
- 30 concurrent WebP decodes trigger exactly one module load.
- `preload('webp')` makes the subsequent first decode measurably faster.
- Encoded output carries no EXIF and no ICC chunk.
- A simulated import failure produces `CodecLoadError` with `cause` intact.
- Works on Node and Bun, and inside a real esbuild'd Obsidian plugin bundle. That last one
  is the acceptance test that matters and the one most likely to fail.
