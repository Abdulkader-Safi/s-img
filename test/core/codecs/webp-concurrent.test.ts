import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// features/codec-webp.md: "30 concurrent WebP decodes trigger exactly one module load."
//
// Its own file because it needs a COLD module: node --test gives each file a process, and
// once the memo is warm the thing being tested has already happened.
//
// COUNTED, not timed. The first version of this measured wall time on the theory that 30
// loads would be visibly slower than one. Measured: 37ms against 10ms. V8 caches the
// compiled module for identical bytes, so 29 of the 30 "loads" are nearly free and no
// honest threshold separates them -- the mutant that deletes the memo entirely survived a
// 2000ms bound comfortably.
//
// So instead: every load must read WASM_BASE64 exactly once to get its bytes. Counting the
// reads counts the loads, exactly, with no timing and no test-only hook in the codec.

const DIR = new URL('../../fixtures/webp/', import.meta.url).pathname;
const lossless = new Uint8Array(readFileSync(`${DIR}lossless.webp`));

test('30 concurrent decodes from cold trigger exactly one load', async () => {
  // The batch case: "save all" over a folder of WebP files fires these together, and 30
  // parallel instantiations of a 337 KB module would be a real memory spike.
  //
  // The real base64 has to be captured BEFORE the mock is installed, so the getter can
  // hand back genuine bytes and the decodes actually succeed. A mock that broke the decode
  // would count reads on a code path that never ran.
  const real = (await import('../../../src/core/codecs/webp-wasm-dec.ts')).WASM_BASE64;

  let reads = 0;
  mock.module('../../../src/core/codecs/webp-wasm-dec.ts', {
    namedExports: {
      get WASM_BASE64(): string {
        reads++;
        return real;
      },
    },
  });

  const { decodeWebp } = await import('../../../src/core/codecs/webp.ts');
  const results = await Promise.all(Array.from({ length: 30 }, () => decodeWebp(lossless)));

  for (const img of results) {
    assert.deepEqual([img.width, img.height], [24, 16], 'every decode still produced a real image');
  }
  // The distinction this pins: memoising the RESULT means all 30 see an empty cache and
  // all 30 start a load. Memoising the PROMISE means 29 of them await the first.
  assert.equal(reads, 1, `the module was loaded ${reads} times`);
});
