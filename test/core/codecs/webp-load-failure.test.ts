import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SImgError } from '../../../src/core/errors.ts';

// features/codec-webp.md: "A simulated import failure produces CodecLoadError with cause
// intact." Never a bare rejection, never a silent fall back to another format.
//
// The real cases this stands in for: WASM disabled or blocked in a hardened Electron
// config, and a bundler that dropped the chunk. Both surface as the dynamic import
// rejecting, which is exactly what is faked here.
//
// Needs --experimental-test-module-mocks (set in the test script) and its own cold
// process, since the mock has to be in place before the module memoises a real load.

const DIR = new URL('../../fixtures/webp/', import.meta.url).pathname;

test('a failed WASM import surfaces as CODEC_LOAD_FAILED with the cause attached', async () => {
  const boom = new Error('WebAssembly is disabled by policy');
  mock.module('../../../src/core/codecs/webp-wasm-dec.ts', {
    namedExports: {
      get WASM_BASE64(): string {
        throw boom;
      },
    },
  });

  const { decodeWebp } = await import('../../../src/core/codecs/webp.ts');
  const err = await decodeWebp(new Uint8Array(readFileSync(`${DIR}lossless.webp`))).then(
    () => undefined,
    (e: unknown) => e,
  );

  assert.ok(err instanceof SImgError, `expected an SImgError, got ${String(err)}`);
  assert.equal(err.code, 'CODEC_LOAD_FAILED');
  // The cause is the whole value of the wrapper: "the WebP decoder could not be loaded" is
  // useless on its own, and the reason underneath is what a user can act on.
  assert.equal(err.cause, boom);
  assert.match(err.message, /disabled by policy/);
});
