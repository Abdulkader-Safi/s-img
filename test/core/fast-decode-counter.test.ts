import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// features/fast-decode.md: "The DCT-scaled decode never inverse-transforms the full
// coefficient set. Assert with an instrumented counter, not a stopwatch -- a stopwatch test
// is flaky and this fact is not."
//
// Its own file, and no static import of the JPEG codec anywhere in it. mock.module only
// intercepts imports that happen AFTER it is installed, so a static import at the top would
// resolve the real module first and the mock would silently do nothing -- leaving a test
// that passes because it is measuring the wrong thing, which is worse than no test.
//
// This is the acceptance criterion that says the optimisation is REAL rather than
// apparently-real: dimensions alone cannot tell "scaled during the DCT" from "decoded fully
// and resized after", and those have identical output and completely different cost.

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

/** Fresh module graph per call, so the counters start at zero and the mock is in place. */
async function decodeCounting(bytes: Uint8Array, hint?: number): Promise<{ full: number; scaled: number; width: number }> {
  const real = await import('../../src/core/codecs/jpeg-dct.ts');
  const realScaled = await import('../../src/core/codecs/jpeg-dct-scaled.ts');
  let full = 0;
  let scaled = 0;

  mock.module('../../src/core/codecs/jpeg-dct.ts', {
    namedExports: {
      ...real,
      inverseDct: (...args: Parameters<typeof real.inverseDct>) => {
        full++;
        return real.inverseDct(...args);
      },
    },
  });
  mock.module('../../src/core/codecs/jpeg-dct-scaled.ts', {
    namedExports: {
      ...realScaled,
      inverseDctScaled: (...args: Parameters<typeof realScaled.inverseDctScaled>) => {
        scaled++;
        return realScaled.inverseDctScaled(...args);
      },
    },
  });

  // Cache-busted so the codec re-imports and picks the mocks up.
  const { decodeJpeg } = await import(`../../src/core/codecs/jpeg.ts?count=${full}${scaled}${Math.trunc(performance.now() * 1000)}`);
  const image = decodeJpeg(bytes, hint === undefined ? {} : { hintMaxLongEdge: hint });
  mock.reset();
  return { full, scaled, width: image.width };
}

test('the mock is actually installed, so the counts mean something', async () => {
  // The self-check. Everything below asserts a count is ZERO, and a count is also zero when
  // the mock never took effect -- so the suite would pass just as happily against a broken
  // harness. Prove the counter moves before trusting it not to.
  const counted = await decodeCounting(read('jpeg/s420.jpg'));
  assert.ok(counted.full > 0, 'the full IDCT was never called on a full-resolution decode, so the mock is not wired up');
  assert.equal(counted.width, 32);
});

test('a scaled decode never runs the full inverse DCT', async () => {
  // 32x32 hinted at 16: 1/2 scale. The full transform must not run AT ALL -- not "less
  // often". If it runs even once per block, the decode is doing the expensive thing and
  // then throwing the result away, which is the exact failure the feature exists to avoid.
  const counted = await decodeCounting(read('jpeg/s420.jpg'), 16);
  assert.equal(counted.full, 0, 'the full 8x8 inverse DCT ran during a scaled decode');
  assert.ok(counted.scaled > 0, 'nothing was transformed at all, so this is not measuring a decode');
  assert.equal(counted.width, 16);
});

test('every scale below 1/1 uses the reduced transform, and 1/1 uses the full one', async () => {
  // The boundary. A hint at or above the image's own size is not a downsample, and must not
  // quietly route through the reduced path -- that path is not bit-exact with libjpeg, and
  // the full-resolution save is the one thing that has to be.
  for (const [hint, expectFull] of [
    [8, false],
    [16, false],
    [31, false],
    [32, true],
    [4096, true],
  ] as const) {
    const counted = await decodeCounting(read('jpeg/s420.jpg'), hint);
    assert.equal(counted.full > 0, expectFull, `hint ${hint} took the ${expectFull ? 'reduced' : 'full'} path`);
    assert.equal(counted.scaled > 0, !expectFull, `hint ${hint} disagrees on the reduced path`);
  }
});

test('the transform count drops with the scale, block for block', async () => {
  // The count is per block, so it does NOT drop with the hint -- the same 8x8 blocks are
  // still visited, each one just transforms a smaller corner. Worth pinning, because
  // "fewer blocks" would mean the decoder was skipping entropy-coded data it cannot skip:
  // JPEG's Huffman stream has to be walked in full whatever size you want out of it.
  //
  // That is also the honest ceiling on this optimisation. The DCT gets cheaper; the
  // entropy decode does not, and at 1/8 it is most of what is left.
  const a = await decodeCounting(read('jpeg/s420.jpg'), 16);
  const b = await decodeCounting(read('jpeg/s420.jpg'), 4);
  assert.equal(a.scaled, b.scaled, 'the block count changed with the hint, so blocks are being skipped');
});
