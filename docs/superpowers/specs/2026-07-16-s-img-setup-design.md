# s-img: decisions and setup

Date: 2026-07-16

The design lives in `features/` — 30 files, one per feature, indexed and ordered by
milestone in `features/index.md`. This document records only what those files left open:
the four PRD blockers, the toolchain, and how the work gets sequenced. It does not restate
the specs.

## The four blockers, settled

| # | Question | Decision |
|---|---|---|
| Q1 | HEIC/HEIF | **Dropped.** See [heic-decision.md](../../../features/heic-decision.md). |
| Q2 | Rotation fill colour | **One shared `background`, default white.** |
| Q3 | Sync vs async | **Async everywhere.** |
| Q4 | libwebp build | **Wrap `@jsquash/webp`.** |

### Q1: HEIC is dropped

libheif plus libde265 is 1 to 2 MB, roughly 13× the entire pure JS core, against a project
whose stated reason to exist is a size budget. The workaround is one-time and fixes it at
the source (iOS → Camera → Formats → Most Compatible).

HEIC bytes hit `UNSUPPORTED_FORMAT`. The message names HEIC specifically and states the fix
— a user who reads it is helped, one who gets "unsupported format" files an issue. That
message is a deliverable, not a fallback.

The lazy-load machinery from `codec-webp.md` and the `unavailable` reporting in
`supported-formats.md` mean adding HEIC later is a new module plus a registration, not a
refactor. Revisit if real users ask, or if someone ships a libheif build well under 1 MB.

### Q2: one `background`, default white

A single **pipeline-level** option, not a per-method one. It is read by three consumers:

- rotate's new corners (`rotate.md`)
- `resize({fit: 'contain'})` padding (`resize.md`)
- the encoder compositing alpha away for JPEG and BMP (`encode.md`)

One rule to learn instead of three defaults to keep in sync. It lives on `PipelineSpec`
(`pipeline-order.md`), which is why this had to be settled before the options type was
written.

Rotate still fills transparent internally; the encoder composites onto `background` only
when the target format has no alpha. `rotate({background})` stays as the escape hatch for a
caller who wants bars on an alpha-capable format.

### Q3: async everywhere

`toBuffer()` returns a Promise for all six formats. A sync/async split leaks WebP's
dynamic import into every call site, and a `toBufferSync()` that throws on WebP fires on
exactly the format the project most wants people to use. The only caller that matters
(Obsidian's vault API) is already async.

Effectively irreversible: adding sync later means a parallel API forever. Decided
deliberately for that reason.

### Q4: wrap @jsquash/webp

Maintained libwebp from the Squoosh lineage, with separate encode and decode modules so a
read-only caller never pays for the encoder. Self-building trims maybe 50 KB and costs an
Emscripten toolchain, a CI build step, and a binary to audit — drifting toward the compile
step the PRD rules out.

**The open risk is the loader, not the build.** jSquash targets browsers, and its `.wasm`
resolution may not survive Node, Bun, or an esbuild'd Obsidian bundle where
`import.meta.url` points nowhere useful. Spike this at the **start** of milestone 5, not the
end. If it fights back harder than an Emscripten build, revisit Q4.

## Toolchain

| Choice | Decision | Why |
|---|---|---|
| Package manager | pnpm | Installed, and not worth a debate. |
| Build | `tsc` alone, ESM only | No bundler dep. The plugin's esbuild does the bundling, so a real dynamic `import()` for WebP survives. CJS would mangle it into a `require` and silently blow the budget. |
| Tests | `node --test`, plus a Bun smoke test | Stdlib runner, zero deps. Node 22's type stripping runs `.ts` tests with no build step and no `tsx`. |
| Cross-runtime | One Bun smoke test | Imports the built package and round-trips an image. Proves the PRD's Node/Bun parity claim without maintaining a second full suite against Bun's `node:test` gaps. |
| CI | None for now | Checks run locally via `pnpm check`. |
| Lint | None | The specs need exactly two mechanical checks and both are greps. Add a formatter when a second person touches the repo. |
| devDeps | `typescript`, `@types/node`, `esbuild` | esbuild only serves `scripts/size.mjs`. |

Skipped `size-limit`: its value is the CI delta printout, and there is no CI. A ~20-line
script (bundle, minify, `gzipSync`, compare) gives the number.

## Layout

```
src/core/           zero node: imports, except zlib in codecs/png.ts
  image.ts          RawImage, createImage, assertValidImage, copyImage
  errors.ts         SImgError + subclasses
  formats.ts        Format type, magic-byte sniffing
  decode.ts
  encode.ts
  codecs/           png jpeg gif bmp tiff webp
  transform/        crop rotate flip resize resample
  pipeline.ts       PipelineSpec + the canonical-order executor
src/io/file.ts      the only fs in the repo
src/index.ts
test/fixtures/
scripts/            size.mjs, guards.mjs
```

The `core/` and `io/` split makes `file-io.md`'s rule structural rather than a promise. The
codec-per-file split keeps the module graph clean enough that sub-path exports
(`s-img/png`) stay possible later without a refactor — explicitly not a v1 feature
(`bundle-size.md`), just a door left open.

## The two guards

`pnpm check:guards` enforces what the specs assert and nothing else:

1. **No `fs` under `src/core/`.** `node:zlib` in `codecs/png.ts` is the one allowed
   exception, and it is the thing a browser build would swap for `CompressionStream`.
2. **No `any` in the emitted `.d.ts`.**

Also caught by the first guard: `Buffer`, `process`, `__dirname` in the core. Same mistake,
different hats.

## Sequencing

`features/index.md` is the plan. Each unchecked box is one branch off `main`, named
`feat/<file-slug>`: `feat/raw-image`, `feat/errors`, `feat/decode`, and so on. The index is
ordered so each item's dependencies are already merged before it starts.

Every branch ends with `pnpm check` green and one runnable check that fails if the logic
breaks, per the acceptance criteria in that feature's file.

### Milestone 1 carries the project's real risk

Two things happen on the first branches and both are load-bearing:

1. **`node:zlib` reachable from an Obsidian renderer.** `plugin-swap.md` calls this the
   five-minute check that de-risks the whole project. Do it the day PNG encode first works.
   If zlib is not reachable, PNG needs `CompressionStream` and milestone 1 reshapes. Finding
   out in milestone 7 would be brutal.
2. **The first size measurement.** With PNG only it reports ~15 KB against a 150 KB budget
   and looks pointless. That is the point: `bundle-size.md` wants the trend line starting at
   milestone 1, because a budget miss found at the end is a rewrite and found early is a
   tweak.

## What this does not decide

- Progressive JPEG: ships after baseline, must close before milestone 7 (`codec-jpeg.md`).
- Buffer reuse between pipeline stages: noted in `pipeline-order.md`, built only if a
  profile demands it.
- Sub-path exports, `runAll` batch helper, immutable chain forking: all deliberately
  skipped, each with the condition that would revive it recorded in its feature file.
