import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decode, encode, preload } from '../../../src/core/dispatch.ts';
import { isWebpLoaded } from '../../../src/core/codecs/webp.ts';
import { SImgError } from '../../../src/core/errors.ts';

// features/codec-webp.md's laziness acceptance criteria.
//
// THIS FILE IS ORDER-DEPENDENT, which is normally a smell and here is the point: the
// module memoises its load for the process lifetime, so "not loaded yet" can only be
// asserted before anything loads it. node --test gives each FILE its own process, which is
// the only reason a cold start is observable at all. The concurrency and load-failure
// cases each need their own cold process and so live in their own files.

const FIXTURES = new URL('../../fixtures/', import.meta.url).pathname;
const read = (path: string) => new Uint8Array(readFileSync(`${FIXTURES}${path}`));

test('the WASM is not loaded before anything asks for it', () => {
  assert.equal(isWebpLoaded(), false);
});

test('a PNG-only pipeline never touches the WebP module', async () => {
  // The whole justification for the lazy import: 300 KB of WASM instantiation is a visible
  // stall, and a user who only ever opens PNGs should never pay it.
  const img = await decode(read('png/rgba8.png'));
  await encode(img, 'png');
  await encode(await decode(read('jpeg/s420.jpg')), 'jpeg');
  assert.equal(isWebpLoaded(), false, 'a non-WebP pipeline loaded the WebP WASM');
});

test('the size guard rejects a hostile WebP before the WASM ever sees the bytes', async () => {
  // A WASM heap grows in pages and fails ungracefully; the guard exists so libwebp is
  // never handed a file claiming 16383x16383. Asserting the guard is what throws, and
  // that it threw without loading the module, is the whole point of a synchronous probe.
  const bytes = read('webp/lossy.webp').slice();
  // VP8 dimensions: 14 bits each, at payload offset 6 and 8. 0x3fff is the largest legal.
  bytes[26] = 0xff;
  bytes[27] = 0x3f;
  bytes[28] = 0xff;
  bytes[29] = 0x3f;

  const err = await decode(bytes).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SImgError, `expected an SImgError, got ${String(err)}`);
  assert.equal(err.code, 'IMAGE_TOO_LARGE');
  assert.equal(isWebpLoaded(), false, 'the WASM loaded despite the guard firing');
});

test('preload warms the module, and only then is it loaded', async () => {
  // Why it exists: the plugin knows at startup whether WebP is in its preset list, and
  // paying the instantiation on the first image open is a stall the user sees.
  await preload('webp');
  assert.equal(isWebpLoaded(), true);
});

test('preload is a no-op for the formats that have nothing to load', async () => {
  // So a plugin can warm its whole preset list without knowing which formats are
  // WASM-backed. Throwing here would push that knowledge into every caller.
  for (const format of ['png', 'jpeg', 'gif', 'bmp', 'tiff'] as const) {
    await preload(format);
  }
});

test('preload is idempotent', async () => {
  await preload('webp');
  await preload('webp');
  assert.equal(isWebpLoaded(), true);
});
