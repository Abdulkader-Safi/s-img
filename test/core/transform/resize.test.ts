import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resize, maxLongEdge } from '../../../src/core/transform/resize.ts';
import { InvalidOptionError } from '../../../src/core/errors.ts';
import { createImage, type RawImage } from '../../../src/core/image.ts';

// features/resize.md, features/resampling.md, features/max-long-edge.md.

/** A horizontal black-to-white ramp: monotonic, so banding and aliasing show up. */
function ramp(width: number, height = 1): RawImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      img.data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return img;
}

/** A 1px checkerboard: the highest frequency an image can hold. Aliases if undersampled. */
function checkerboard(size: number): RawImage {
  const img = createImage(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x + y) % 2 === 0 ? 0 : 255;
      img.data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return img;
}

const red = (img: RawImage, x: number, y = 0): number => img.data[(y * img.width + x) * 4]!;

// --- dimensions --------------------------------------------------------------------

test('width alone preserves the aspect ratio', () => {
  const out = resize(createImage(400, 300), { width: 200 });
  assert.equal(out.width, 200);
  assert.equal(out.height, 150);
});

test('height alone preserves the aspect ratio', () => {
  const out = resize(createImage(400, 300), { height: 150 });
  assert.equal(out.width, 200);
  assert.equal(out.height, 150);
});

test('both dimensions stretch by default', () => {
  // fit: 'fill' is the default because a caller who passed both numbers explicitly
  // asked for both numbers.
  const out = resize(createImage(400, 300), { width: 100, height: 100 });
  assert.equal(out.width, 100);
  assert.equal(out.height, 100);
});

test('every fit mode produces exactly the requested size', () => {
  // The whole point of the option: "sometimes you get a different size" would make it
  // useless for a layout.
  for (const fit of ['fill', 'contain', 'cover'] as const) {
    const out = resize(createImage(400, 300), { width: 120, height: 90, fit });
    assert.equal(out.width, 120, fit);
    assert.equal(out.height, 90, fit);
  }
});

test('contain pads with the background colour', () => {
  const out = resize(createImage(100, 50, [255, 0, 0, 255]), {
    width: 50,
    height: 50,
    fit: 'contain',
    background: [0, 0, 255, 255],
  });

  // The image scales to 50x25 and centres, so the top row is padding.
  assert.deepEqual(Array.from(out.data.subarray(0, 4)), [0, 0, 255, 255], 'top row is padding');
  assert.deepEqual(Array.from(out.data.subarray(25 * 50 * 4, 25 * 50 * 4 + 4)), [255, 0, 0, 255], 'middle is image');
});

test('cover centre-crops the overflow', () => {
  const out = resize(ramp(100, 100), { width: 50, height: 25, fit: 'cover' });
  assert.equal(out.width, 50);
  assert.equal(out.height, 25);
});

test('resize with no target throws', () => {
  // A resize with no target is a caller bug, not a no-op.
  assert.throws(() => resize(createImage(10, 10), {}), InvalidOptionError);
});

test('resize to the same size short-circuits without resampling', () => {
  // Prevents a needless full-image resample and the sub-pixel drift that comes with it.
  const src = ramp(64);
  const out = resize(src, { width: 64 });
  assert.deepEqual(Array.from(out.data), Array.from(src.data));
});

// --- clamping ----------------------------------------------------------------------

test('rejects a target outside 1 to 20000', () => {
  // Throw rather than clamp: silently returning 20000 when the caller asked for 50000
  // means their aspect-ratio maths is wrong and nobody finds out.
  const src = createImage(10, 10);
  assert.throws(() => resize(src, { width: 0 }), InvalidOptionError);
  assert.throws(() => resize(src, { width: -5 }), InvalidOptionError);
  assert.throws(() => resize(src, { width: 20001 }), InvalidOptionError);
  assert.throws(() => resize(src, { height: 20001 }), InvalidOptionError);
});

test('rejects a fractional target', () => {
  assert.throws(() => resize(createImage(10, 10), { width: 800.5 }), InvalidOptionError);
});

test('a derived dimension floors at 1, never 0', () => {
  // 1200x1 asked to fit width 100 gives 100x1, not 100x0: a zero-dimension image is
  // invalid (features/raw-image.md).
  const out = resize(createImage(1200, 1), { width: 100 });
  assert.equal(out.width, 100);
  assert.equal(out.height, 1);
});

// --- upscale -----------------------------------------------------------------------

test('upscaling is allowed by default', () => {
  // The plugin's percentage chips go to 200%, so no silent never-enlarge assumption.
  const out = resize(createImage(100, 100), { width: 200 });
  assert.equal(out.width, 200);
  assert.equal(out.height, 200);
});

test('upscale false leaves a smaller image completely untouched', () => {
  // Not "scale to the largest allowed size" -- unchanged. Any partial-scaling reading
  // would surprise a caller who wanted "shrink if needed".
  const src = ramp(50);
  const out = resize(src, { width: 200, upscale: false });

  assert.equal(out.width, 50);
  assert.deepEqual(Array.from(out.data), Array.from(src.data));
});

test('upscale false still shrinks', () => {
  assert.equal(resize(createImage(100, 100), { width: 50, upscale: false }).width, 50);
});

// --- resampling quality ------------------------------------------------------------

test('nearest neighbour produces exact blocks with no intermediate values', () => {
  const src = createImage(2, 1);
  src.data.set([0, 0, 0, 255, 255, 255, 255, 255]);

  const out = resize(src, { width: 8, resampling: 'nearest' });

  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((x) => red(out, x)),
    [0, 0, 0, 0, 255, 255, 255, 255],
    'nearest must never invent an in-between value',
  );
});

test('bilinear upscale of a ramp stays monotonic', () => {
  const out = resize(ramp(8), { width: 32, resampling: 'bilinear' });

  for (let x = 1; x < out.width; x++) {
    assert.ok(red(out, x) >= red(out, x - 1), `not monotonic at x=${x}`);
  }
});

test('a lone bright pixel survives an 8x downscale', () => {
  // THE test for the box prefilter, and it has to be this rather than a checkerboard.
  // Plain bilinear reads only its ~2 nearest neighbours, so an 8x downscale never looks
  // at 90% of the source and isolated detail vanishes outright.
  //
  // A checkerboard cannot show this: any 2x2 region of one holds exactly two black and
  // two white pixels, so even a too-narrow separable filter averages to 128 by accident
  // and the test passes while the bug ships. Measured: with the widening disabled, this
  // assertion fails and the checkerboard one does not.
  const src = createImage(64, 1);
  for (let x = 0; x < 64; x++) src.data.set([0, 0, 0, 255], x * 4);
  src.data.set([255, 255, 255, 255], 0); // one white pixel, at x=0

  const out = resize(src, { width: 8, resampling: 'bilinear' });

  // Averaged over the 8 source pixels it covers, output pixel 0 should be about 255/8.
  assert.ok(red(out, 0) > 8, `the lone bright pixel was dropped entirely: got ${red(out, 0)}`);
});

test('downscaling preserves overall brightness', () => {
  // The same property, stated as energy: a filter that ignores most of its input loses
  // the image's mean.
  const src = createImage(64, 64);
  for (let i = 0; i < src.data.length; i += 4) {
    // Fine stripes: high frequency, and a phase a narrow filter will sample wrong.
    const v = Math.floor(i / 4) % 4 < 1 ? 255 : 0;
    src.data.set([v, v, v, 255], i);
  }
  const mean = (img: RawImage): number => {
    let sum = 0;
    for (let i = 0; i < img.data.length; i += 4) sum += img.data[i]!;
    return sum / (img.data.length / 4);
  };

  const out = resize(src, { width: 8, height: 8, resampling: 'bilinear' });

  assert.ok(
    Math.abs(mean(out) - mean(src)) < 12,
    `mean drifted from ${mean(src).toFixed(1)} to ${mean(out).toFixed(1)}: the filter is ignoring most of its input`,
  );
});

test('a checkerboard downscales to flat grey', () => {
  // Kept as a sanity check, not as the aliasing test: see above for why it cannot fail.
  const out = resize(checkerboard(64), { width: 8, height: 8, resampling: 'bilinear' });

  for (let i = 0; i < out.data.length; i += 4) {
    assert.ok(Math.abs(out.data[i]! - 128) <= 24, `expected mid-grey, got ${out.data[i]}`);
  }
});

test('lanczos is sharper than bilinear on an edge', () => {
  const src = createImage(32, 1);
  for (let x = 0; x < 32; x++) {
    const v = x < 16 ? 0 : 255;
    src.data.set([v, v, v, 255], x * 4);
  }

  const gradient = (img: RawImage): number => {
    let max = 0;
    for (let x = 1; x < img.width; x++) max = Math.max(max, Math.abs(red(img, x) - red(img, x - 1)));
    return max;
  };

  const bilinear = resize(src, { width: 64, resampling: 'bilinear' });
  const lanczos = resize(src, { width: 64, resampling: 'lanczos3' });

  assert.ok(
    gradient(lanczos) > gradient(bilinear),
    `lanczos should hold the edge harder: ${gradient(lanczos)} vs ${gradient(bilinear)}`,
  );
});

test('an edge against coloured transparency shows no bleed', () => {
  // THE premultiply test. Averaging non-premultiplied RGBA drags a transparent pixel's
  // RGB into its opaque neighbour, giving a halo around every soft edge.
  //
  // The transparent region MUST carry a colour of its own. An earlier version used
  // transparent black, which is exactly the case where premultiplying changes nothing:
  // the un-premultiply at the end divides by the same alpha and cancels the error out,
  // so deleting premultiply failed no test. Real files carry colour under their
  // transparency, so this uses magenta.
  const src = createImage(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
      src.data.set(inside ? [30, 30, 30, 255] : [255, 0, 255, 0], (y * 8 + x) * 4);
    }
  }

  const out = resize(src, { width: 32, height: 32, resampling: 'bilinear' });

  for (let i = 0; i < out.data.length; i += 4) {
    const [r, g, b, a] = [out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, out.data[i + 3]!];
    // Wherever anything is visible, it must still be the dark grey. Magenta creeping in
    // shows up as red and blue rising away from green.
    if (a > 24) {
      // Bounded on both sides, deliberately. Too high means magenta bled in (no
      // premultiply). Too low means the colour stayed premultiplied (no un-premultiply),
      // which darkens edges toward zero as alpha falls. A one-sided assertion misses
      // the second entirely.
      assert.ok(
        Math.abs(r - 30) <= 25 && Math.abs(b - 30) <= 25,
        `edge colour wrong: rgba(${r},${g},${b},${a}) should be near (30,30,30) at any alpha`,
      );
    }
  }
});

test('a fully opaque image round-trips alpha untouched', () => {
  const out = resize(ramp(16), { width: 8 });
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255);
});

// --- maxLongEdge -------------------------------------------------------------------

test('maxLongEdge shrinks a landscape image by its long edge', () => {
  const out = maxLongEdge(createImage(2000, 1000), 1600);
  assert.equal(out.width, 1600);
  assert.equal(out.height, 800);
});

test('maxLongEdge shrinks a portrait image by its long edge', () => {
  // THE test that proves this method earns its existence. A width-based API would make
  // the caller branch on orientation per file, and that branch would end up
  // copy-pasted into the plugin.
  const out = maxLongEdge(createImage(1000, 2000), 1600);
  assert.equal(out.width, 800);
  assert.equal(out.height, 1600);
});

test('maxLongEdge leaves an already-small image bit-identical', () => {
  // Capping a folder where most files are already small must cost almost nothing.
  const src = ramp(80, 60);
  const out = maxLongEdge(src, 1600);

  assert.equal(out.width, 80);
  assert.equal(out.height, 60);
  assert.deepEqual(Array.from(out.data), Array.from(src.data));
});

test('maxLongEdge on a square scales both edges', () => {
  const out = maxLongEdge(createImage(1000, 1000), 400);
  assert.equal(out.width, 400);
  assert.equal(out.height, 400);
});

test('maxLongEdge never produces a zero dimension', () => {
  const out = maxLongEdge(createImage(20000, 3), 100);
  assert.equal(out.width, 100);
  assert.equal(out.height, 1, 'the short edge floors at 1, not 0');
});

test('maxLongEdge never enlarges, for any input', () => {
  // A property, not an example: this is the method's entire contract.
  for (const [w, h, cap] of [
    [10, 10, 5000],
    [1, 9000, 100],
    [9000, 1, 100],
    [640, 480, 640],
    [3, 3, 4],
  ] as const) {
    const out = maxLongEdge(createImage(w, h), cap);
    assert.ok(out.width <= w && out.height <= h, `${w}x${h} cap ${cap} grew to ${out.width}x${out.height}`);
    assert.ok(Math.max(out.width, out.height) <= Math.max(cap, 1));
  }
});

test('maxLongEdge rejects a size outside 1 to 20000', () => {
  assert.throws(() => maxLongEdge(createImage(10, 10), 0), InvalidOptionError);
  assert.throws(() => maxLongEdge(createImage(10, 10), 20001), InvalidOptionError);
});
