# Bundle size budget

**Milestone 6. Cross-cutting. This is the number that justifies the project.**

## The budget

| Set | Budget | vs ImageMagick |
|---|---|---|
| Core (PNG, JPEG, GIF, BMP, TIFF), min+gzip | **< 150 KB** | ~47× smaller |
| Core + WebP WASM, when WebP is used | **< 500 KB** | ~14× smaller |
| Current ImageMagick bundle | 7 MB | — |

If the core misses 150 KB, the project's premise is in trouble. Obsidian Sync struggling
with a 7 MB binary is the entire reason this exists; shipping 800 KB would still be a win on
paper and a much weaker story.

## Where the bytes go

Rough expectations, worth writing down so a surprise is visible:

- **JPEG:** the biggest, by a lot. Huffman tables, quant tables, IDCT/FDCT, the marker
  parser, the colour transform. Maybe 40–60 KB. The standard Annex K tables are hardcoded
  data and are a real chunk of that.
- **TIFF:** the tag table, LZW, PackBits, predictor. Maybe 20–30 KB.
- **GIF:** LZW both ways, median cut, Floyd-Steinberg. Maybe 15–25 KB.
- **PNG:** small. The filters and chunk walking. zlib is Node's, free. Maybe 10–15 KB.
- **BMP:** tiny. Under 5 KB.
- **Transforms + resampling:** small, it is arithmetic. Maybe 10 KB.
- **Types, errors, pipeline, API:** small.

That is roughly 100–145 KB, which fits with no headroom to spare. **Measure early.** A
budget discovered at the end of milestone 6 is a rewrite; discovered in milestone 2 it is a
tweak.

## Enforcement

A CI check that fails the build over budget. Not a warning, not a comment on the PR — a
failure. A budget nobody enforces is a wish.

```
- build
- measure min+gzip of the core entry
- fail if > 150 KB
- print the delta vs the last commit
```

The delta printout is the useful half: "this PR added 12 KB" is what stops a slow slide.
`size-limit` does both and is one config file. Use it rather than writing a script.

**Built, and NOT with size-limit.** The deviation, recorded rather than left silent: the
reason given above is that size-limit does both halves. `scripts/size.mjs` now does both, in
~40 lines, with no dependency -- and it does one thing size-limit does not, which turned out
to be the only check here that ever caught anything (below). Adding a devDependency tree to
a project whose headline claim is "no dependencies", in order to replace a working script
with a less capable one, is not a trade worth making. `.github/workflows/ci.yml` runs it.

**What "the core" means, and why it is not the entry file.** The core is measured as the
entry PLUS the transitive closure of its static imports -- what a consumer's runtime fetches
before it can call anything. This is not pedantry, it is the entire check:

> The first version measured `index.js` alone. Planting the exact regression this spec
> predicts -- making the WebP `import()` static -- did **not** fail it. With code splitting
> on, esbuild hoists a statically-imported module into a shared *chunk* rather than inlining
> it, so `index.js` stayed 23 KB and pristine while eagerly depending on a 190 KB chunk
> sitting next to it. The check passed, at 15.5% of budget, with the disaster fully present.

Measured as the eager closure, the same plant reports 242.5 KB and fails twice over. The
lesson generalises past this project: "the bundle" is a reachability question, not a file.

**The WASM assertion looks for the WASM.** The spec says "assert on the file list, not just
the size", and the first version did the opposite -- `text.includes('WEBP') && text.length >
100 KB` -- which would pass happily if the WASM were inlined while something else shrank. It
now looks for `AGFzbQ`, the base64 of every WASM module's `\0asm` magic. Presence is proof;
absence is proof. Plus a self-check that the WASM is in *some* chunk, because "not in the
core" is trivially true of a build where it does not exist.

Both are pinned in `test/bundle-size.test.ts`, which plants the static import and watches
the check fail. The spec called it "a good test of the check". It was: it is what found the
bug in the check.

Track the WASM separately: it is a static file, its size is whatever libwebp is, and it does
not vary with our code. Two budgets, two lines.

## What keeps it small

- **No dependencies.** The single biggest lever. `s-img` has zero runtime deps besides the
  WebP WASM. Every dep is a transitive tree and a size surprise, and the PRD's whole premise
  is that the artifact is small and self-contained. The ladder's rung 5 (use an installed
  dependency) is genuinely unavailable here, and that is fine, because rung 3 (stdlib —
  `node:zlib`) covers the one hard part.
- **`node:zlib` instead of a bundled inflate.** pako is ~45 KB and would be a third of the
  budget for something the runtime already has.
- **WebP lazy.** Not in the core bundle at all. The `import()` must survive bundling as a
  real dynamic import; if esbuild inlines it (which it will, given the wrong config), the
  core silently gains 300 KB and the budget check catches it. That is a good test of the
  check.
- **Codecs as separate modules with clean boundaries** so a future consumer could tree-shake
  to just PNG. Not a v1 feature — the plugin wants all five — but the module structure that
  allows it costs nothing today and is impossible to retrofit into a tangle.
- **No dead generality.** The [heic-decision.md](heic-decision.md) file is this principle
  applied to the biggest possible violation.

## Tree-shaking, deliberately not a v1 feature

Sub-path exports (`s-img/png`) so a caller pulls one codec: real, plausible, and not what
the plugin needs. The plugin's Format panel offers all five. Building the export map, the
docs, and the tests for a use case with no user is speculative.

What v1 *does* do: keep the module graph clean enough that adding it later is a
`package.json` change, not a refactor. That means no barrel file that imports every codec
eagerly into one module for convenience — which is the one mistake that would foreclose it.

*(ponytail: skipped sub-path exports; the plugin needs all five. The module boundaries are
there if it ever matters.)*

## Use cases

- The project's headline claim, in the README.
- The Obsidian Sync story: a plugin that syncs is the whole deliverable.
- A regression gate: nobody adds a dependency without seeing the cost.

## Edge cases

- **min+gzip vs raw vs brotli.** Report min+gzip; it is what the budget is stated in and
  what most tooling means. Brotli is smaller and less standard as a comparison. Pick one,
  state it, do not move the goalposts mid-project.
- **What counts as "the bundle".** The library's own code, excluding `node:` builtins,
  excluding the WASM. State it in the config so the number is not arguable.
- **The plugin's final size** is what actually matters to Sync, and it includes the plugin's
  own UI code. The library's budget is a proxy for it, and a proxy is all this repo can
  measure -- the swap itself lives in the plugin's own project.
- **Source maps** are not in the budget. They ship separately or not at all.

## Acceptance

- CI measures min+gzip on every PR and fails over 150 KB. **Done** -- 23.2 KB, 15.5% of it.
- The delta vs the previous commit is printed on every PR.
- The WebP WASM is provably absent from the core bundle (assert on the file list, not just
  the size).
- A dynamic `import()` survives the plugin's esbuild config as a real chunk. **Done** for
  this repo's own esbuild config -- `test/bundle-size.test.ts` plants the static import and
  watches the check fail. Confirming it against the PLUGIN's config belongs to the plugin's
  project; it is the thing most likely to have quietly regressed.
- The first measurement happens in **milestone 1**, with just PNG, so the trend line exists
  from the start.
