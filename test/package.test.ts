import { test } from 'node:test';
import assert from 'node:assert/strict';

// The Node half of the PRD's "runs identically on Node.js and Bun" claim.
// test/smoke.bun.ts is the other half, and it asserts the same thing.
//
// Thin today: the package exports nothing yet. It grows a decode -> transform ->
// encode round-trip when PNG lands (features/codec-png.md). What it proves right
// now is still real: the ESM output resolves and loads.

test('the package loads as ESM', async () => {
  const mod = await import('../src/index.ts');
  assert.ok(mod, 'src/index.ts should import');
});
