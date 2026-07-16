import { test } from 'node:test';
import assert from 'node:assert/strict';

import { supportedFormats } from '../../src/core/supported.ts';
import { preload } from '../../src/core/dispatch.ts';
import { FORMATS } from '../../src/core/formats.ts';

// features/supported-formats.md.
//
// Order-dependent, like the other WebP-state files, and for the same reason: "before
// anything loaded" is only observable in a process where nothing has. The failure case
// needs a process where the load fails, so it lives in supported-failure.test.ts.

test('reports all six formats readable and writable on a fresh process', () => {
  const { read, write } = supportedFormats();
  assert.deepEqual(read, ['png', 'jpeg', 'gif', 'bmp', 'tiff', 'webp']);
  assert.deepEqual(write, ['png', 'jpeg', 'gif', 'bmp', 'tiff', 'webp']);
});

test('webp is listed before it has loaded, and is also pending', () => {
  // The semantics that matter, and the trap the spec calls "a deadlock made of semantics":
  // report only what is loaded RIGHT NOW and the plugin builds its dropdown at startup,
  // sees no WebP, never offers it, so nothing ever triggers the lazy load. WebP is
  // therefore listed unless we KNOW it is broken.
  const { read, write, pending } = supportedFormats();
  assert.ok(read.includes('webp'));
  assert.ok(write.includes('webp'));
  assert.deepEqual(pending, ['webp']);
});

test('the five pure-JS formats are never pending and never unavailable', () => {
  // They are statically imported. If they are missing, the bundle is broken and a runtime
  // report is not the thing that will tell you.
  const { pending, unavailable } = supportedFormats();
  for (const format of ['png', 'jpeg', 'gif', 'bmp', 'tiff'] as const) {
    assert.ok(!pending.includes(format), `${format} was pending`);
    assert.ok(!unavailable.some((u) => u.format === format), `${format} was unavailable`);
  }
});

test('nothing is unavailable until a load actually fails', () => {
  assert.deepEqual(supportedFormats().unavailable, []);
});

test('the arrays are stable across calls, so a dropdown does not shuffle', () => {
  const a = supportedFormats();
  const b = supportedFormats();
  assert.deepEqual(a, b);
  assert.deepEqual(a.read, [...FORMATS], 'and the order is the documented one');
});

test('mutating the returned arrays cannot affect the library', () => {
  // A caller sorting the dropdown in place must not rewrite what the next caller sees.
  const first = supportedFormats();
  first.read.push('heic' as never);
  first.pending.length = 0;
  first.unavailable.push({ format: 'png', reason: 'nonsense' });

  const second = supportedFormats();
  assert.deepEqual(second.read, [...FORMATS]);
  assert.deepEqual(second.pending, ['webp']);
  assert.deepEqual(second.unavailable, []);
});

test('read and write are separate arrays, because one day they will differ', () => {
  // Identical today; the type must not collapse to one list. HEIC is the plausible case:
  // decoding it is one problem, encoding it is a much worse one nobody wants.
  const { read, write } = supportedFormats();
  assert.notEqual(read, write, 'the same array instance was returned for both');
});

test('after a successful load webp leaves pending and stays readable', async () => {
  // Last, because it is the one that warms the module.
  await preload('webp');
  const { read, write, pending, unavailable } = supportedFormats();
  assert.ok(read.includes('webp'));
  assert.ok(write.includes('webp'));
  assert.deepEqual(pending, [], 'nothing is pending once it is loaded');
  assert.deepEqual(unavailable, []);
});
