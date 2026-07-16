import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decode, probe } from '../../src/core/dispatch.ts';
import { createImage } from '../../src/core/image.ts';
import { blockSizeFor, inverseDctScaled } from '../../src/core/codecs/jpeg-dct-scaled.ts';
import { encodeJpeg } from '../../src/core/codecs/jpeg.ts';
import { crop } from '../../src/core/transform/crop.ts';

// features/fast-decode.md. "A hard performance requirement, not a nice-to-have" -- the
// PRD measured a ~260ms full-resolution rotate causing visible stutter, and the preview
// path is the fix.
//
// The instrumented-counter test lives in fast-decode-counter.test.ts, in its own file
// because mocking a module the rest of this one imports statically cannot work.

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

/** A photo big enough for the DCT to have somewhere to go, built rather than committed. */
function photo(width: number, height: number): Uint8Array {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      // Gradients plus a coarse checker: smooth enough to survive downsampling, structured
      // enough that a region is identifiable after it.
      img.data[at] = (x * 255) / width;
      img.data[at + 1] = (y * 255) / height;
      img.data[at + 2] = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? 200 : 40;
      img.data[at + 3] = 255;
    }
  }
  return encodeJpeg(img, { quality: 90 });
}

// --- the scale the DCT can actually give ------------------------------------------------

test('blockSizeFor takes the largest scale that stays at or under the cap', () => {
  // features/fast-decode.md's worked example, verbatim: "a 4000px image capped at 1600
  // decodes at 1000px (1/4), not 1600 -- because 1/2 gives 2000, which is over."
  assert.equal(blockSizeFor(4000, 3000, 1600), 2, '1/4 scale: 2 of the 8 coefficients per axis');
  assert.equal(blockSizeFor(4000, 3000, 2000), 4, 'exactly 1/2 fits, so take it');
  assert.equal(blockSizeFor(4000, 3000, 1999), 2, 'one pixel over the cap is over the cap');
  assert.equal(blockSizeFor(4000, 3000, 4000), 8, 'already under: no downsample at all');
  assert.equal(blockSizeFor(4000, 3000, 99_999), 8, 'a cap larger than the image is not a reason to scale');
});

test('a cap below 1/8 of the image takes the smallest scale, not the largest', () => {
  // The fall-through bug, pinned. Returning 8 here -- which the first draft did -- means a
  // hint of 200 on a 12MP photo decodes at FULL RESOLUTION: the exact opposite of the ask,
  // and worse than not having the feature. The caller's resize covers the rest.
  assert.equal(blockSizeFor(4000, 3000, 200), 1);
  assert.equal(blockSizeFor(4000, 3000, 1), 1, 'hintMaxLongEdge: 1 is legal, silly but not an error');
});

test('the long edge decides, whichever axis it is on', () => {
  assert.equal(blockSizeFor(3000, 4000, 1600), 2, 'portrait scales by its height');
});

// --- what decode actually returns -------------------------------------------------------

test('a JPEG hinted smaller comes back at or under the hint, and says what it did', async () => {
  // The contract the plugin's coordinate maths depends on: never over. The real dimensions
  // are read off the RESULT, never computed from the hint.
  const bytes = photo(400, 300);
  for (const hint of [400, 300, 200, 160, 100, 50, 25, 7, 1]) {
    const img = await decode(bytes, { hintMaxLongEdge: hint });
    assert.ok(Math.max(img.width, img.height) <= hint, `hint ${hint} produced ${img.width}x${img.height}, over the cap`);
    assert.ok(img.width >= 1 && img.height >= 1, `hint ${hint} produced an empty image`);
    assert.equal(img.data.length, img.width * img.height * 4, `hint ${hint} produced a buffer that does not match its dimensions`);
  }
});

test('the DCT lands on a power of two, and the cap does the rest', async () => {
  // Both halves of the contract in one assertion. 400px hinted at 160 is 1/4 -> 100px,
  // which is UNDER 160 and stays there: no resize, because resizing 100 up to 160 would be
  // inventing pixels the caller did not ask for.
  assert.deepEqual(dims(await decode(photo(400, 300), { hintMaxLongEdge: 160 })), [100, 75]);

  // 25 is below 1/8 (50px), so the DCT gets as close as it can and the resize finishes it.
  assert.deepEqual(dims(await decode(photo(400, 300), { hintMaxLongEdge: 25 })), [25, 19]);
});

test('an image already under the hint is decoded normally and returned as-is', async () => {
  // Edge case from the spec. Not "resized up to the cap", not "scaled to 1/1 explicitly":
  // untouched, byte for byte with the same decode without a hint.
  const bytes = read('jpeg/s420.jpg');
  const hinted = await decode(bytes, { hintMaxLongEdge: 4096 });
  assert.deepEqual(dims(hinted), [32, 32]);
  assert.deepEqual(hinted.data, (await decode(bytes)).data, 'a hint bigger than the image changed the pixels');
});

test('the hint does not disturb the full-resolution path', async () => {
  // The save path is the one that must stay bit-exact with libjpeg, and it is the reason
  // the reduced IDCT is a separate function rather than a special case inside the fast one.
  const bytes = read('jpeg/s444.jpg');
  assert.deepEqual((await decode(bytes)).data, new Uint8ClampedArray(readFileSync(new URL('../fixtures/jpeg/s444.rgba', import.meta.url))));
});

test('the DCT-scaled preview looks like the full-resolution image, not like noise', async () => {
  // A reduced IDCT with the normalisation wrong produces a perfectly plausible image that
  // is uniformly too dark or too bright, and next to a thumbnail nobody notices. Compared
  // against the full decode resized down: different algorithms, so not equal, but a preview
  // that does not track the real thing within a few levels is broken.
  const bytes = photo(256, 192);
  const preview = await decode(bytes, { hintMaxLongEdge: 64 });
  const reference = await decode(bytes, { hintMaxLongEdge: 999 }).then((full) => resizeTo(full, preview.width, preview.height));

  let total = 0;
  for (let i = 0; i < preview.data.length; i++) total += Math.abs(preview.data[i]! - reference.data[i]!);
  const mean = total / preview.data.length;
  assert.ok(mean < 12, `the scaled decode is ${mean.toFixed(1)} levels off the full decode on average, which is not the same picture`);
});

// --- the transform itself ---------------------------------------------------------------

test('the separable reduced IDCT equals the textbook definition, at every scale', () => {
  // The test that actually pins the maths, and the one that was missing: three mutants
  // survived the end-to-end tests -- a wrong cosine table (2x+1 -> 2x), a wrong DC scale
  // (/8 -> /4), and a dropped 1/sqrt2 -- because "the preview roughly resembles the photo"
  // is not a statement about arithmetic. It is possible to be visibly plausible and wrong.
  //
  // So compare against the definition itself, written out as the naive double sum. Two
  // genuinely independent implementations: this one is O(N^4) and structured nothing like
  // the separable rows-then-columns version under test, so they cannot share a mistake.
  // (That O(N^4) cost is exactly why the real one is separable -- for n=4 the naive form is
  // ~256 multiplies against ~176 for the full 8x8 fast path it is supposed to beat, so the
  // "optimisation" would be slower than what it replaces.)
  const quant = new Uint16Array(64).fill(1);
  for (let i = 0; i < 64; i++) quant[i] = 1 + (i % 7); // non-uniform: dequantisation must happen

  for (const n of [1, 2, 4] as const) {
    for (const seed of [1, 7, 99]) {
      const coef = new Int16Array(64);
      for (let i = 0; i < 64; i++) coef[i] = ((seed * (i + 3) * 37) % 511) - 255;

      const out = new Uint8ClampedArray(n * n);
      inverseDctScaled(coef, 0, quant, out, 0, n, n);

      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          // Within 1, not equal, and the reason is worth writing down rather than
          // loosening quietly: at n=2 seed=99 the true value of one pixel is exactly
          // 197.5. Summing in a different order puts the float a half-ulp either side of
          // that tie, so one implementation rounds to 198 and the other to 197. Both are
          // right. Chasing bit-exactness between two float summation orders is not a
          // real goal -- bit-exactness with libjpeg is, and that lives on the
          // full-resolution path, which is a separate integer transform for this reason.
          //
          // A tolerance of 1 is still tight enough to be worth having: every mutant this
          // test exists to catch (a wrong cosine table, a dropped 1/sqrt2, the DC scale
          // off by 2x) moves pixels by tens of levels, not one.
          const got = out[y * n + x]!;
          const want = naiveIdct(coef, quant, n, x, y);
          assert.ok(Math.abs(got - want) <= 1, `n=${n} seed=${seed} at ${x},${y}: got ${got}, the definition says ${want}`);
        }
      }
    }
  }
});

test('a flat block comes out at its own mean, at every scale', () => {
  // Downsampling cannot change a mean, and the normalisation is the same constant whatever
  // n is -- which is not obvious, and is why getting it wrong produces a preview that is
  // uniformly too dark next to the full-resolution version. A DC-only block is the whole
  // statement in one case.
  const quant = new Uint16Array(64).fill(1);
  quant[0] = 4;

  for (const n of [1, 2, 4] as const) {
    const coef = new Int16Array(64);
    coef[0] = 200; // DC only: a flat block of 200 * 4 / 8 + 128 = 228.
    const out = new Uint8ClampedArray(n * n);
    inverseDctScaled(coef, 0, quant, out, 0, n, n);
    for (let i = 0; i < n * n; i++) assert.equal(out[i], 228, `n=${n} put a flat block at the wrong level`);
  }
});

/**
 * The reduced IDCT as the standard writes it: the top-left n x n coefficients, double sum,
 * no factoring. Slow and obviously correct, which is the entire job of a reference.
 */
function naiveIdct(coef: Int16Array, quant: Uint16Array, n: number, x: number, y: number): number {
  let sum = 0;
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      sum += cu * cv * coef[v * 8 + u]! * quant[v * 8 + u]! * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n)) * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * n));
    }
  }
  return Math.min(255, Math.max(0, Math.round(sum / 4) + 128));
}

// --- the fallback -----------------------------------------------------------------------

test('formats that cannot downsample natively still return the right dimensions', async () => {
  // "The decode itself is not faster, and the docs should say so rather than implying a
  // uniform win." What they must NOT do is ignore the hint and hand back a full-size image,
  // because the caller sized its canvas from the result.
  for (const name of ['png/rgba8.png', 'gif/basic.gif', 'bmp/rgb24.bmp', 'tiff/rgb-none.tif', 'webp/lossy.webp']) {
    const img = await decode(read(name), { hintMaxLongEdge: 8 });
    assert.ok(Math.max(img.width, img.height) <= 8, `${name} ignored the hint: ${img.width}x${img.height}`);
  }
});

test('a scaled decode of odd dimensions rounds up, and never loses a column', async () => {
  // 17x13 at 1/2 is 8.5 x 6.5. Rounding DOWN drops the last column and row of the image --
  // a real one-pixel crop, not a rounding detail -- and every test using a nicely divisible
  // 400x300 photo passes straight through it, which is how the floor mutant survived.
  const img = await decode(read('jpeg/odd-17x13.jpg'), { hintMaxLongEdge: 9 });
  assert.deepEqual(dims(img), [9, 7], 'ceil: a partial pixel is still a pixel');
  assert.equal(img.data.length, 9 * 7 * 4);
});

// --- probe ------------------------------------------------------------------------------

test('probe reports real dimensions for every format', async () => {
  // "One export, no new code, removes a whole class of scaling bug. Do it."
  for (const name of ['png/rgba8.png', 'jpeg/s420.jpg', 'gif/basic.gif', 'bmp/rgb24.bmp', 'tiff/rgb-none.tif', 'webp/lossy.webp']) {
    const full = await decode(read(name));
    assert.deepEqual(probe(read(name)), { width: full.width, height: full.height }, `probe disagrees with decode on ${name}`);
  }
});

test('probe reads the stored dimensions, before orientation', async () => {
  // A real trap, and the reason this is documented rather than "fixed": decode() applies
  // EXIF orientation and probe() does not, so a rotated photo's probe is transposed
  // relative to its decode. Scaling is a ratio, so it comes out right either way -- but
  // only because both edges scale by the same factor. Pinned so the asymmetry is deliberate.
  assert.deepEqual(probe(read('exif/orient-6.jpg')), { width: 24, height: 16 }, 'as stored');
  assert.deepEqual(dims(await decode(read('exif/orient-6.jpg'))), [16, 24], 'as displayed');
});

test('probe does not allocate a pixel buffer', () => {
  // The whole point: microseconds, not milliseconds. A probe that decodes is a probe that
  // is useless in the preview loop, and the only honest way to check "did not allocate" is
  // to measure it -- so measure something with enough headroom that it cannot be flaky.
  const bytes = photo(1200, 900);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) probe(bytes);
  const grew = process.memoryUsage().heapUsed - before;

  // 200 decodes would be 200 * 1200 * 900 * 4 = 864 MB. 20 MB of headroom for the parse
  // itself, GC timing and whatever else the heap is doing.
  assert.ok(grew < 20_000_000, `probing 200 times grew the heap by ${(grew / 1e6).toFixed(0)} MB, which is a decode`);
});

test('probe rejects what decode rejects, rather than guessing', async () => {
  await assert.rejects(() => decode(new Uint8Array([1, 2, 3, 4])), { name: 'UnsupportedFormatError' });
  assert.throws(() => probe(new Uint8Array([1, 2, 3, 4])), { name: 'UnsupportedFormatError' });
  assert.throws(() => probe(read('jpeg/s420.jpg').slice(0, 4)), { name: 'CorruptImageError' }, 'a truncated header is corrupt, not unsupported');
});

// --- the coordinate-drift test ----------------------------------------------------------

test('a crop drawn in preview coordinates lands on the same region at full resolution', async () => {
  // "This is the coordinate-drift test and it is the one that catches the real bug."
  //
  // The whole two-pass design in one test. The user drags a rectangle over a 1600px
  // preview; the save path has to crop the SAME region out of the 4000px source. Get the
  // scale from `source.width / preview.width` -- read off the results, never assumed --
  // and the two agree. Assume `hint / longEdge` instead and you are off by 1.6x, silently,
  // on every JPEG, because the DCT only does powers of two.
  const bytes = photo(256, 192);

  const preview = await decode(bytes, { hintMaxLongEdge: 100 });
  assert.deepEqual(dims(preview), [64, 48], '1/4: the scale is 4, and it is NOT 256/100 = 2.56');

  // What a plugin does: a rectangle in preview pixels.
  const drawn = { x: 16, y: 12, width: 32, height: 24 };
  const scale = 256 / preview.width;
  const source = { x: drawn.x * scale, y: drawn.y * scale, width: drawn.width * scale, height: drawn.height * scale };

  const fromSource = crop(await decode(bytes), source);
  const fromPreview = crop(preview, drawn);

  // Same region of the same picture, at two resolutions. Compare the content by
  // downsampling the full-res crop to the preview crop's size: if the rectangle landed
  // somewhere else, the checker squares are offset and this is nowhere near.
  assert.deepEqual(dims(fromSource), [128, 96]);
  const shrunk = resizeTo(fromSource, fromPreview.width, fromPreview.height);

  let worst = 0;
  for (let i = 0; i < shrunk.data.length; i++) worst = Math.max(worst, Math.abs(shrunk.data[i]! - fromPreview.data[i]!));
  assert.ok(worst < 60, `the two crops are ${worst} levels apart at worst, so they are not the same region`);
});

test('the scale is exact, so the crop does not drift across the image', async () => {
  // Rounding drift "accumulates over the two passes" -- and it shows up at the FAR edge,
  // not the near one, so a test that only checks the top-left corner passes while the
  // bottom-right is a dozen pixels out. This walks the rectangle across the image.
  const bytes = photo(256, 192);
  const preview = await decode(bytes, { hintMaxLongEdge: 100 });
  const full = await decode(bytes);
  const scale = full.width / preview.width;

  for (const x of [0, 8, 24, 48, 56]) {
    const drawn = { x, y: 8, width: 8, height: 8 };
    const a = crop(preview, drawn);
    const b = resizeTo(crop(full, { x: x * scale, y: 8 * scale, width: 8 * scale, height: 8 * scale }), 8, 8);

    let worst = 0;
    for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i]! - b.data[i]!));
    assert.ok(worst < 60, `at x=${x} the crops are ${worst} levels apart: the scale drifted`);
  }
});

function dims(image: { width: number; height: number }): [number, number] {
  return [image.width, image.height];
}

/** Box-average down to an exact size. Independent of anything under test, on purpose. */
function resizeTo(image: { width: number; height: number; data: Uint8ClampedArray }, width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } {
  const out = createImage(width, height);
  const fx = image.width / width;
  const fy = image.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      let n = 0;
      for (let sy = Math.floor(y * fy); sy < Math.min(image.height, Math.ceil((y + 1) * fy)); sy++) {
        for (let sx = Math.floor(x * fx); sx < Math.min(image.width, Math.ceil((x + 1) * fx)); sx++) {
          for (let c = 0; c < 4; c++) sums[c]! += image.data[(sy * image.width + sx) * 4 + c]!;
          n++;
        }
      }
      for (let c = 0; c < 4; c++) out.data[(y * width + x) * 4 + c] = sums[c]! / n;
    }
  }
  return out;
}
