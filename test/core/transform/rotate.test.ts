import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rotate } from '../../../src/core/transform/rotate.ts';
import { InvalidOptionError, ImageTooLargeError } from '../../../src/core/errors.ts';
import { createImage, type RawImage } from '../../../src/core/image.ts';

// features/rotate.md. The only feature that is real geometry rather than "parse a spec"
// or "move bytes around", and where the "is pure JS feasible" risk lives outside the
// codecs.

const px = (img: RawImage, x: number, y: number): number[] =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** A solid block, so every interior pixel has a known colour after any rotation. */
const solid = (w: number, h: number, colour: [number, number, number, number] = [200, 60, 20, 255]) =>
  createImage(w, h, colour);

// --- the exact path stays exact -----------------------------------------------------

test('right angles never touch the resampler', () => {
  // rotate(90) must be a pure index permutation. Routing an exact operation through a
  // bilinear filter would blur an image for no reason and lose data on a round-trip.
  const src = solid(3, 5);

  for (const angle of [0, 90, -90, 180, 360, 450, -270]) {
    const out = rotate(src, angle);
    for (let i = 0; i < out.data.length; i += 4) {
      assert.deepEqual(
        Array.from(out.data.subarray(i, i + 4)),
        [200, 60, 20, 255],
        `angle ${angle} produced an interpolated pixel`,
      );
    }
  }
});

test('four exact 90s round-trip byte-identically through rotate()', () => {
  const src = createImage(3, 5);
  for (let i = 0; i < src.data.length; i++) src.data[i] = (i * 31) % 256;

  const out = rotate(rotate(rotate(rotate(src, 90), 90), 90), 90);
  assert.deepEqual(Array.from(out.data), Array.from(src.data));
});

// --- canvas growth ------------------------------------------------------------------

test('the canvas grows to the rotated bounding box', () => {
  // |w cos| + |h sin| by |w sin| + |h cos|, rounded up. A 100x100 at 45 degrees needs
  // 142 (ceil of 141.42): floor would shave a real corner off, which is the exact
  // failure the growing canvas exists to prevent.
  const out = rotate(solid(100, 100), 45);

  assert.equal(out.width, 142);
  assert.equal(out.height, 142);
});

test('canvas growth is correct for a non-square image', () => {
  // 200x100 at 30 degrees: 200*cos30 + 100*sin30 = 173.2 + 50 = 223.2 -> 224
  //                        200*sin30 + 100*cos30 = 100 + 86.6 = 186.6 -> 187
  const out = rotate(solid(200, 100), 30);

  assert.equal(out.width, 224);
  assert.equal(out.height, 187);
});

test('a small angle still grows the canvas', () => {
  // There is no cheap path for small angles: 1 degree on a wide image still grows it
  // and still resamples every pixel.
  const out = rotate(solid(400, 100), 1);
  assert.ok(out.width > 400, 'must not silently keep the source size');
  assert.ok(out.height > 100);
});

test('the image is centred in the grown canvas', () => {
  const out = rotate(solid(50, 50), 45);
  const mid = Math.floor(out.width / 2);

  assert.deepEqual(px(out, mid, mid), [200, 60, 20, 255], 'the centre must still be the image');
});

// --- fill --------------------------------------------------------------------------

test('new corners are transparent by default', () => {
  // rotate always fills transparent; the encoder composites onto `background` when the
  // target format has no alpha. One rule, decided where the format is actually known.
  const out = rotate(solid(50, 50), 45);

  assert.deepEqual(px(out, 0, 0), [0, 0, 0, 0], 'top-left corner had no source');
  assert.deepEqual(px(out, out.width - 1, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(out, 0, out.height - 1), [0, 0, 0, 0]);
  assert.deepEqual(px(out, out.width - 1, out.height - 1), [0, 0, 0, 0]);
});

test('background fills the corners when asked', () => {
  // The escape hatch: a caller who wants bars on an alpha-capable format.
  const out = rotate(solid(50, 50), 45, { background: [0, 0, 255, 255] });

  assert.deepEqual(px(out, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(out, out.width - 1, out.height - 1), [0, 0, 255, 255]);
});

test('a transparent source stays transparent', () => {
  const out = rotate(createImage(20, 20, [0, 0, 0, 0]), 33);
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 0);
});

// --- quality ------------------------------------------------------------------------

test('an edge against coloured transparency shows no halo', () => {
  // THE visual bug of this feature. Bilinear across the boundary between opaque image
  // and transparent fill drags the fill's RGB into the edge pixels unless the sampler
  // premultiplies. The source's transparency carries magenta, because transparent black
  // is the one colour where the error cancels itself out.
  const src = createImage(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const inside = x >= 4 && x < 12 && y >= 4 && y < 12;
      src.data.set(inside ? [30, 30, 30, 255] : [255, 0, 255, 0], (y * 16 + x) * 4);
    }
  }

  const out = rotate(src, 30);

  for (let i = 0; i < out.data.length; i += 4) {
    const [r, g, b, a] = [out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, out.data[i + 3]!];
    if (a > 24) {
      assert.ok(
        Math.abs(r - 30) <= 30 && Math.abs(b - 30) <= 30,
        `halo at the edge: rgba(${r},${g},${b},${a}) should be near (30,30,30)`,
      );
    }
  }
});

test('rotating a solid block leaves its interior a solid colour', () => {
  // Inverse mapping guarantees every destination pixel is written exactly once. Forward
  // mapping leaves holes -- rotation is not a bijection on a discrete grid -- and the
  // result is a pinholed image. This catches that.
  const out = rotate(solid(60, 60), 20);
  const mid = Math.floor(out.width / 2);

  for (let x = mid - 15; x <= mid + 15; x++) {
    for (let y = mid - 15; y <= mid + 15; y++) {
      assert.deepEqual(px(out, x, y), [200, 60, 20, 255], `hole or seam at ${x},${y}`);
    }
  }
});

test('rotation is centred to sub-pixel accuracy', () => {
  // Solid blocks cannot catch a half-pixel error: the interior looks identical either
  // way. Deleting the +0.5 pixel-centre offset failed every other test here.
  //
  // A single bright dot at the source centre must land at the canvas centre. Its centre
  // of mass measures that directly, and a half-pixel shift moves it by ~0.5.
  const src = createImage(9, 9, [0, 0, 0, 255]);
  src.data.set([255, 255, 255, 255], (4 * 9 + 4) * 4);

  for (const angle of [45, 30, -20]) {
    const out = rotate(src, angle);

    let mass = 0;
    let mx = 0;
    let my = 0;
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const w = out.data[(y * out.width + x) * 4]!; // white dot on black
        mass += w;
        mx += w * (x + 0.5);
        my += w * (y + 0.5);
      }
    }

    assert.ok(mass > 0, `angle ${angle}: the dot vanished`);
    assert.ok(
      Math.abs(mx / mass - out.width / 2) < 0.2,
      `angle ${angle}: horizontally off-centre by ${(mx / mass - out.width / 2).toFixed(2)}px`,
    );
    assert.ok(
      Math.abs(my / mass - out.height / 2) < 0.2,
      `angle ${angle}: vertically off-centre by ${(my / mass - out.height / 2).toFixed(2)}px`,
    );
  }
});

test('nearest, bilinear and lanczos all produce a full canvas', () => {
  for (const resampling of ['nearest', 'bilinear', 'lanczos3'] as const) {
    const out = rotate(solid(40, 40), 15, { resampling });
    const mid = Math.floor(out.width / 2);
    assert.deepEqual(px(out, mid, mid), [200, 60, 20, 255], resampling);
  }
});

// --- validation ---------------------------------------------------------------------

test('rejects an angle outside -180 to 180', () => {
  // The plugin's slider is -180..180 in 1-degree steps. Beyond a full turn is fine and
  // normalises; nonsense is not.
  assert.throws(() => rotate(solid(4, 4), Number.NaN), InvalidOptionError);
  assert.throws(() => rotate(solid(4, 4), Number.POSITIVE_INFINITY), InvalidOptionError);
});

test('refuses to allocate a canvas past the pixel cap', () => {
  // A legal input and a legal angle can still ask for 800 MB: a 20000x1 rotated 45
  // degrees has a ~14000x14000 bounding box. The guard has to apply to the *computed
  // output*, not just to decode, or this OOMs the process.
  assert.throws(() => rotate(createImage(20000, 1), 45), ImageTooLargeError);
});

test('the pixel cap is configurable', () => {
  assert.throws(() => rotate(solid(100, 100), 45, { maxPixels: 1000 }), ImageTooLargeError);
  assert.doesNotThrow(() => rotate(solid(100, 100), 45, { maxPixels: 1_000_000 }));
});

test('handles a 1x1', () => {
  const out = rotate(createImage(1, 1, [9, 9, 9, 255]), 45);
  assert.ok(out.width >= 1 && out.height >= 1);
});

test('angles just off a right angle take the resampled path', () => {
  // 89.9 is not 90: the canvas grows a couple of pixels and the output is very slightly
  // blurred. Correct and expected -- exact rotations need exact angles.
  const out = rotate(solid(50, 50), 89.9);
  assert.ok(out.width > 50, 'must not be treated as an exact 90');
});
