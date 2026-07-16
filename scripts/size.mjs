// Measures the core bundle against the budget from features/bundle-size.md.
//
// The budget is the number that justifies the whole project: replacing a 7 MB
// ImageMagick bundle that Obsidian Sync chokes on. If the pure JS core misses
// 150 KB, the premise is in trouble.
//
// Run it from milestone 1, when it reports ~15 KB and looks pointless. That's the
// point -- a budget miss found at the end is a rewrite, found early it's a tweak.
//
// ponytail: skipped size-limit. Its value is the CI delta printout and there is
// no CI. bundle + minify + gzipSync is the number.

import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const KB = 1024;
const BUDGET = 150 * KB; // core: PNG, JPEG, GIF, BMP, TIFF. min+gzip.

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
  logLevel: 'silent',
});

const out = result.outputFiles.find((f) => f.path.endsWith('index.js'));
const chunks = result.outputFiles.filter((f) => f !== out);
const raw = out.contents.byteLength;
const gzipped = gzipSync(out.contents, { level: 9 }).byteLength;

const pct = ((gzipped / BUDGET) * 100).toFixed(1);
const fmt = (n) => `${(n / KB).toFixed(1)} KB`;

console.log(`core:   ${fmt(raw)} minified`);
console.log(`        ${fmt(gzipped)} min+gzip`);
console.log(`budget: ${fmt(BUDGET)}  (${pct}% used)`);

// The WASM chunks, reported rather than hidden: they are real bytes a WebP caller pays.
for (const chunk of chunks.filter((c) => c.contents.byteLength > 8 * KB)) {
  const gz = gzipSync(chunk.contents, { level: 9 }).byteLength;
  console.log(`lazy:   ${fmt(gz)} min+gzip  ${chunk.path.split('/').pop()}  (WebP only, split out)`);
}

// The WASM must not be in here. If esbuild ever inlines the dynamic import(), the
// core silently gains ~300 KB -- this is the check that catches it.
if (out.text.includes('WEBP') && out.text.length > 100 * KB) {
  console.error('\nFAIL: the WebP WASM looks bundled into the core. It must stay a lazy import.');
  process.exit(1);
}

if (gzipped > BUDGET) {
  console.error(`\nFAIL: over budget by ${fmt(gzipped - BUDGET)}. See features/bundle-size.md.`);
  process.exit(1);
}
