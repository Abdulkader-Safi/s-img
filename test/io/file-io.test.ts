import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromFile, toFile } from '../../src/io/index.ts';
import { decode } from '../../src/core/dispatch.ts';

// features/file-io.md. Ten lines of module, so the tests are mostly about the BOUNDARY
// rather than the code: that the core stays clean, that Node's errors come through
// unwrapped, and that no conversion happens on the way out.
//
// The mechanical half of this feature -- no node: imports under src/core -- is enforced by
// scripts/guards.mjs and tested in test/guards.test.ts, which watches the guard fail on a
// real violation rather than trusting it.

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 's-img-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('fromFile reads a file and starts a chain', async () => {
  const out = await (await fromFile(`${FIXTURES}png/rgba8.png`)).resize({ width: 8 }).toFormat('png').toBuffer();
  assert.equal((await decode(out)).width, 8);
});

test('toFile writes bytes that read back identically', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'out.png');
    const bytes = await (await fromFile(`${FIXTURES}jpeg/photo.jpg`)).maxLongEdge(20).toFormat('png').toBuffer();
    await toFile(bytes, path);

    assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
    const round = await decode(new Uint8Array(await readFile(path)));
    assert.deepEqual([round.width, round.height], [20, 14]);
  });
});

test('the round trip works end to end, file in, file out', async () => {
  // features/file-io.md's acceptance: fromFile('x.png').crop(...).toBuffer() on Node.
  await withTempDir(async (dir) => {
    const path = join(dir, 'cropped.webp');
    const chain = await fromFile(`${FIXTURES}png/rgba8.png`);
    await toFile(await chain.crop({ x: 2, y: 2, width: 10, height: 8 }).toFormat('webp').toBuffer(), path);

    const img = await decode(new Uint8Array(await readFile(path)));
    assert.deepEqual([img.width, img.height], [10, 8]);
  });
});

test('a missing file throws Node ENOENT, unwrapped', async () => {
  // The one place the "only ever throws SImgError" rule bends, deliberately. A missing file
  // is not an image error, and Node's message is better than anything we would write over
  // the top of it.
  const err = await fromFile('/nope/not/here.png').then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT');
  assert.ok(!(err as Error).name.startsWith('SImg'), 'the fs error was wrapped');
});

test('the output is a Uint8Array, and Buffer.from over it is zero-copy', async () => {
  // features/file-io.md's acceptance criterion, and the reason the core never returns a
  // Buffer: a Node caller who wants Buffer methods gets them for free, and a browser build
  // does not have to care.
  const bytes = await (await fromFile(`${FIXTURES}png/rgba8.png`)).toFormat('png').toBuffer();
  assert.equal(bytes.constructor, Uint8Array, 'a Buffer leaked out of the core');

  const asBuffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(asBuffer.buffer, bytes.buffer, 'the view was copied rather than shared');
  assert.deepEqual(new Uint8Array(asBuffer), bytes);
});

test('io is a shim over the same chain, not a second implementation', async () => {
  // fromFile is SImg.fromBuffer with a read in front. If these ever diverge, io has grown
  // logic it should not have.
  const { SImg } = await import('../../src/core/simg.ts');
  const path = `${FIXTURES}jpeg/photo.jpg`;
  const viaFile = await (await fromFile(path)).rotate(15).toFormat('png').toBuffer();
  const viaBuffer = await SImg.fromBuffer(new Uint8Array(await readFile(path))).rotate(15).toFormat('png').toBuffer();
  assert.deepEqual(viaFile, viaBuffer);
});
