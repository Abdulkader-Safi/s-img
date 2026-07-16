// The Bun half of the parity claim. Run with `pnpm test:bun`.
//
// Deliberately NOT the full suite. Bun's node:test support has gaps that aren't
// worth fighting, and running the same 200 codec tests twice proves little that
// this doesn't: the built package resolves and works under Bun.
//
// It grows a real round-trip when PNG lands. Today it proves the ESM output loads,
// which is the foundation the rest of the parity claim sits on.

import assert from 'node:assert/strict';

const mod = await import('../src/index.ts');
assert.ok(mod, 'src/index.ts should import under Bun');

// ponytail: no @types/bun just to read Bun.version in a log line.
console.log('bun: package loads');
