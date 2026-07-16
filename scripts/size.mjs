// Measures the core bundle against the budget from features/bundle-size.md.
//
// The budget is the number that justifies the whole project: replacing a 7 MB
// ImageMagick bundle that Obsidian Sync chokes on. If the pure JS core misses
// 150 KB, the premise is in trouble.
//
// Run it from milestone 1, when it reports ~15 KB and looks pointless. That's the
// point -- a budget miss found at the end is a rewrite, found early it's a tweak.
//
// `--json` prints just the numbers, for the CI delta. See .github/workflows/ci.yml.
//
// ponytail: still skipped size-limit, and now that CI exists that is a real decision
// rather than a deferral. features/bundle-size.md says to use it "rather than writing a
// script" because it does both halves -- the budget failure and the delta. This script now
// does both, in 40 lines with no dependency, and it also does the thing size-limit cannot:
// assert the WASM is provably absent from the entry chunk by looking for its bytes. Adding
// a devDependency tree to a project whose headline claim is "no dependencies", to replace
// a working script with a less capable one, is not a trade worth making. Recorded in the
// spec rather than left as a silent deviation.

import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const KB = 1024;
const BUDGET = 150 * KB; // core: PNG, JPEG, GIF, BMP, TIFF. min+gzip.
const JSON_ONLY = process.argv.includes('--json');

// splitting:true so the WebP WASM lands where it belongs -- in its own chunk, reached by
// the dynamic import in codecs/webp.ts -- rather than being inlined into the entry.
//
// This is not the measurement being flattered. It is what makes the check below MEAN
// something: a lazy import can be split out, and a static one cannot. Turn that dynamic
// import into a static one and the base64 has nowhere to go but the entry chunk, which
// blows the budget by 170% and fails. That is exactly the regression worth catching.
//
// A consumer who bundles without splitting (an Obsidian plugin is CJS, so it cannot split)
// inlines the WASM into their one file. They still pay nothing at RUNTIME until a WebP is
// touched -- the module is not evaluated -- but the bytes are there. features/codec-webp.md.
const result = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  outdir: 'out',
  // node: builtins and the lazy WebP WASM are not our bytes. features/bundle-size.md
  // states what counts so the number isn't arguable.
  external: ['node:*', '@jsquash/*'],
  write: false,
  metafile: true,
  logLevel: 'silent',
});

const files = new Map(result.outputFiles.map((f) => [f.path.split('/').pop(), f]));
const meta = Object.fromEntries(Object.entries(result.metafile.outputs).map(([k, v]) => [k.split('/').pop(), v]));

/**
 * Everything the entry pulls in EAGERLY: itself plus the transitive closure of its
 * static imports. This is "the core", and it is deliberately not "the entry file".
 *
 * The difference is the whole check. With splitting on, esbuild hoists a statically
 * imported module into a SHARED CHUNK rather than inlining it -- so making the WebP import
 * static leaves index.js looking exactly as small and clean as before, while the entry now
 * eagerly loads a 190 KB chunk sitting next to it. Measuring index.js alone reported 23 KB
 * and passed. That is not a hypothetical: it was this script's behaviour, and planting the
 * regression it was written to catch is how it surfaced.
 *
 * The static closure is also just the honest number -- it is what a consumer's runtime
 * actually fetches before it can call anything.
 */
function eagerClosure(entry) {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name) || meta[name] === undefined) return;
    seen.add(name);
    for (const imp of meta[name].imports) {
      // 'dynamic-import' is the one kind that does NOT count: it is a separate fetch that
      // only happens if a caller touches WebP. Every other kind is eager.
      if (imp.kind !== 'dynamic-import') walk(imp.path.split('/').pop());
    }
  };
  walk(entry);
  return [...seen];
}

const core = eagerClosure('index.js');
const chunks = [...files.values()].filter((f) => !core.includes(f.path.split('/').pop()));

// Gzipped together, because that is how they ship: a consumer bundling without splitting
// (an Obsidian plugin is one CJS main.js, so it cannot split) gets exactly this.
const coreBytes = Buffer.concat(core.map((name) => Buffer.from(files.get(name).contents)));
const raw = coreBytes.byteLength;
const gzipped = gzipSync(coreBytes, { level: 9 }).byteLength;
const out = files.get('index.js');

const pct = ((gzipped / BUDGET) * 100).toFixed(1);
const fmt = (n) => `${(n / KB).toFixed(1)} KB`;

const lazy = chunks
  .filter((c) => c.contents.byteLength > 8 * KB)
  .map((c) => ({ name: c.path.split('/').pop(), gzip: gzipSync(c.contents, { level: 9 }).byteLength }));

if (JSON_ONLY) {
  console.log(JSON.stringify({ raw, gzipped, budget: BUDGET, lazy }));
} else {
  console.log(`core:   ${fmt(raw)} minified`);
  console.log(`        ${fmt(gzipped)} min+gzip`);
  console.log(`budget: ${fmt(BUDGET)}  (${pct}% used)`);
  // The WASM chunks, reported rather than hidden: they are real bytes a WebP caller pays.
  for (const chunk of lazy) console.log(`lazy:   ${fmt(chunk.gzip)} min+gzip  ${chunk.name}  (WebP only, split out)`);
}

// The WASM must not be in the entry. If esbuild ever inlines the dynamic import(), the core
// silently gains ~300 KB. features/bundle-size.md: "assert on the file list, not just the
// size" -- so look for the WASM's actual bytes rather than guessing from how big the file
// got. Every WASM module starts with the magic `\0asm`, which base64s to a literal "AGFzbQ"
// at the head of the generated string, so its presence is proof and its absence is proof.
// The old check here was `text.includes('WEBP') && text.length > 100 KB`, which is the size
// heuristic the spec warns against: it would pass happily if the WASM were inlined while
// something else shrank.
const WASM_MAGIC = 'AGFzbQ';
if (coreBytes.includes(WASM_MAGIC)) {
  console.error('\nFAIL: the WebP WASM is reachable EAGERLY from the core entry. It must stay a lazy import.');
  console.error('features/bundle-size.md: "The import() must survive bundling as a real dynamic import."');
  process.exit(1);
}
if (!chunks.some((c) => c.text.includes(WASM_MAGIC))) {
  console.error('\nFAIL: the WebP WASM is not in ANY chunk, so this build is not measuring what it thinks.');
  console.error('The check above only means something if the WASM exists to be found. Did gen:wasm run?');
  process.exit(1);
}

if (gzipped > BUDGET) {
  console.error(`\nFAIL: over budget by ${fmt(gzipped - BUDGET)}. See features/bundle-size.md.`);
  console.error('A budget nobody enforces is a wish.');
  process.exit(1);
}
