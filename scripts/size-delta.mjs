// Prints the size delta between two `size.mjs --json` runs, as markdown.
//
//   node scripts/size-delta.mjs base.json head.json
//
// features/bundle-size.md: "The delta printout is the useful half: 'this PR added 12 KB' is
// what stops a slow slide." The budget failure catches the cliff; nothing catches a
// hundred PRs each adding 1 KB except a number in front of a reviewer every time.
//
// Never fails the build. Being 1 KB bigger is not wrong, it is information -- the FAIL
// belongs to size.mjs and its budget, and a delta script that can also fail CI just gives
// people two things to argue with.

import { readFileSync } from 'node:fs';

const KB = 1024;
const [basePath, headPath] = process.argv.slice(2);
const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined; // No baseline: a first PR, or a base that predates this script.
  }
};

const head = read(headPath);
const base = read(basePath);
if (head === undefined) {
  console.log('Could not measure this branch. See the job log.');
  process.exit(0);
}

const fmt = (n) => `${(n / KB).toFixed(1)} KB`;
const pct = ((head.gzipped / head.budget) * 100).toFixed(1);

// Every row first, then the prose. A markdown table ends at its first blank line, so a
// note printed mid-table silently orphans every row after it -- which is what the first
// version did: the lazy chunks came out below "_No baseline_" as literal pipes.
const rows = [`| core | **${fmt(head.gzipped)}** | ${pct}% of the ${fmt(head.budget)} budget |`];
const notes = [];

if (base === undefined) {
  notes.push('_No baseline to compare against: the base commit predates these scripts, or could not be measured._');
} else {
  const delta = head.gzipped - base.gzipped;
  // A sign always, so "no change" reads as a measurement rather than a missing number.
  const sign = delta > 0 ? `+${fmt(delta)}` : delta < 0 ? `-${fmt(-delta)}` : 'no change';
  const mood = delta > 0 ? '🔺' : delta < 0 ? '🔽' : '';
  rows.push(`| change | ${mood} ${sign} | was ${fmt(base.gzipped)} |`);
}

for (const chunk of head.lazy ?? []) {
  rows.push(`| ${chunk.name.replace(/-[A-Z0-9]{8}\.js$/, '')} | ${fmt(chunk.gzip)} | lazy, WebP only |`);
}

console.log('### Bundle size\n');
console.log('| | min+gzip | |');
console.log('|---|---|---|');
console.log(rows.join('\n'));
console.log('');
for (const note of notes) console.log(`${note}\n`);
console.log('The core is the entry plus everything statically reachable from it: what a');
console.log('consumer loads before calling anything. The WebP WASM is excluded because it is');
console.log('reached through a dynamic `import()` and only fetched if a WebP is touched.');
