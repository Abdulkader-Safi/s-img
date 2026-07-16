import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SImg } from '../../src/core/simg.ts';
import { isWebpLoaded } from '../../src/core/codecs/webp.ts';

// features/api-surface.md: ".toFormat('webp') on a chain never loads the WASM until
// .toBuffer() is awaited."
//
// Its own file for the usual reason: "has not loaded yet" is only observable in a process
// where nothing has, and node --test gives each file its own. This lived in simg.test.ts
// first, where the PRD-example test encodes a WebP three tests earlier and warmed the
// module -- the assertion failed for a reason that had nothing to do with the chain.

const photo = new Uint8Array(readFileSync(new URL('../fixtures/jpeg/photo.jpg', import.meta.url).pathname));

test('toFormat("webp") does not load the WASM until toBuffer is awaited', async () => {
  // The chain must not front-run preload(): the whole point of a lazy chain is that
  // building one is free, and 300 KB of WASM instantiation is not free.
  const chain = SImg.fromBuffer(photo).toFormat('webp', { quality: 80 });
  assert.equal(isWebpLoaded(), false, 'building the chain loaded the WASM');

  await chain.toBuffer();
  assert.equal(isWebpLoaded(), true, 'and awaiting it does load the WASM');
});
