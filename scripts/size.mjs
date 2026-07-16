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

const result = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  // node: builtins and the lazy WebP WASM are not our bytes. features/bundle-size.md
  // states what counts so the number isn't arguable.
  external: ['node:*', '@jsquash/*'],
  write: false,
  logLevel: 'silent',
});

const [out] = result.outputFiles;
const raw = out.contents.byteLength;
const gzipped = gzipSync(out.contents, { level: 9 }).byteLength;

const pct = ((gzipped / BUDGET) * 100).toFixed(1);
const fmt = (n) => `${(n / KB).toFixed(1)} KB`;

console.log(`core:   ${fmt(raw)} minified`);
console.log(`        ${fmt(gzipped)} min+gzip`);
console.log(`budget: ${fmt(BUDGET)}  (${pct}% used)`);

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
