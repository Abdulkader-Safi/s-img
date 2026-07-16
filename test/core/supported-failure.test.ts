import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// features/supported-formats.md: "After a simulated failed load, webp is in unavailable
// with a readable reason and is gone from read and write."
//
// The case the whole feature exists for. A plugin whose dropdown offers WebP on a runtime
// where WebAssembly is blocked is a user picking WebP, hitting save, and getting an error
// on 30 files. Its own process, since the mock must be in place before anything loads.

/** Every read of the base64 is one load attempt, so this counts attempts exactly. */
let attempts = 0;
const blocked = {
  namedExports: {
    get WASM_BASE64(): string {
      attempts++;
      throw new Error('WebAssembly is disabled by policy');
    },
  },
};

test('a failed WebP load moves it to unavailable and out of read and write', async () => {
  mock.module('../../src/core/codecs/webp-wasm-dec.ts', blocked);
  mock.module('../../src/core/codecs/webp-wasm-enc.ts', blocked);

  const { preload } = await import('../../src/core/dispatch.ts');
  const { supportedFormats } = await import('../../src/core/supported.ts');

  assert.ok(supportedFormats().read.includes('webp'), 'listed before the load is attempted');

  await preload('webp').then(
    () => assert.fail('preload should have rejected'),
    () => undefined,
  );

  const { read, write, pending, unavailable } = supportedFormats();
  assert.ok(!read.includes('webp'), 'webp is still offered for reading after a failed load');
  assert.ok(!write.includes('webp'), 'webp is still offered for writing after a failed load');
  assert.deepEqual(pending, [], 'a format that failed is not still pending');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0]?.format, 'webp');
  // Readable, because it goes in a tooltip next to a greyed-out menu item.
  assert.match(unavailable[0]?.reason ?? '', /disabled by policy/);

  // The five pure-JS formats are untouched by any of this.
  assert.deepEqual(read, ['png', 'jpeg', 'gif', 'bmp', 'tiff']);
});

test('a failed load is permanent, rather than retried on every file in a batch', async () => {
  // features/supported-formats.md is explicit: the memoised promise caches the rejection,
  // so the failure sticks for the process. Retrying a WASM instantiation 30 times during a
  // batch is worse than failing once, and a runtime that blocks WebAssembly will block it
  // again. The first version of the loader cleared the memo on failure; this is the test
  // that would have caught that.
  const { preload } = await import('../../src/core/dispatch.ts');
  const { supportedFormats } = await import('../../src/core/supported.ts');

  // The test above already attempted the load once, reading each module's base64 once.
  const before = attempts;

  for (let i = 0; i < 3; i++) {
    await preload('webp').then(
      () => assert.fail('preload should still reject'),
      (e: unknown) => assert.match(String(e), /disabled by policy/, `attempt ${i}`),
    );
  }

  // Counted, not inferred. Asserting "one failure is recorded" would pass even if the
  // module were reloaded three times, because the reason is only recorded the first time.
  // The retry is only visible by watching the load itself.
  assert.equal(attempts, before, `the module was re-loaded ${attempts - before} more times`);
  assert.equal(supportedFormats().unavailable.length, 1, 'still exactly one failure recorded');
});
