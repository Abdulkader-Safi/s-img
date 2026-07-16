import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crop } from '../../../src/core/transform/crop.ts';
import { flip } from '../../../src/core/transform/flip.ts';
import { rotate90 } from '../../../src/core/transform/rotate90.ts';
import { InvalidOptionError } from '../../../src/core/errors.ts';
import { createImage, type RawImage } from '../../../src/core/image.ts';

// features/crop.md, features/flip.md, features/rotate-90.md.
//
// All three are exact: every output pixel is exactly one input pixel, moved. No
// resampling, no interpolation, no arithmetic on channel values. That is the contract,
// and it is why rotate90(90) must never touch the resampler -- routing an exact
// operation through a bilinear filter would blur an image for no reason.

/**
 * An image whose every pixel is uniquely identifiable from its value, so a transform
 * that moves a pixel to the wrong place cannot hide behind a symmetric fixture.
 * R = x, G = y, B = a constant, A = opaque.
 */
function grid(width: number, height: number): RawImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      img.data.set([x + 1, y + 1, 42, 255], (y * width + x) * 4);
    }
  }
  return img;
}

/** The (r,g) identity of the pixel at (x,y): tells you where it came from. */
function at(img: RawImage, x: number, y: number): [number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!];
}

// --- crop --------------------------------------------------------------------------

test('crop cuts the requested rectangle', () => {
  const out = crop(grid(4, 4), { x: 1, y: 2, width: 2, height: 2 });

  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.deepEqual(at(out, 0, 0), [2, 3], 'top-left of the crop is source (1,2)');
  assert.deepEqual(at(out, 1, 1), [3, 4]);
});

test('crop to the full image returns an equal but separate image', () => {
  const src = grid(3, 3);
  const out = crop(src, { x: 0, y: 0, width: 3, height: 3 });

  assert.deepEqual(Array.from(out.data), Array.from(src.data));
  assert.notEqual(out.data, src.data, 'always a copy: an operation that sometimes aliases is a worse contract');
});

test('crop resets the coordinate origin', () => {
  // features/crop.md: after cropping, the origin IS the crop rectangle's top-left, so a
  // later rotate spins around the cropped frame. Cropping then rotating must equal
  // rotating the already-cropped image.
  const src = grid(6, 5);
  const rect = { x: 2, y: 1, width: 3, height: 3 };

  const a = rotate90(crop(src, rect), 90);
  const b = rotate90(crop(src, rect), 90);

  assert.deepEqual(Array.from(a.data), Array.from(b.data));
  assert.equal(a.width, 3);
});

test('crop rejects a rectangle outside the image', () => {
  const src = grid(4, 4);

  // A crop that silently shrinks returns a different size than asked for, and every
  // downstream calculation is then quietly wrong.
  assert.throws(() => crop(src, { x: 3, y: 0, width: 2, height: 1 }), InvalidOptionError);
  assert.throws(() => crop(src, { x: 0, y: 3, width: 1, height: 2 }), InvalidOptionError);
  assert.throws(() => crop(src, { x: -1, y: 0, width: 1, height: 1 }), InvalidOptionError);
  assert.throws(() => crop(src, { x: 0, y: 0, width: 0, height: 1 }), InvalidOptionError);
  assert.throws(() => crop(src, { x: 0, y: 0, width: 1, height: 0 }), InvalidOptionError);
});

test('crop names the offending field and the real bound', () => {
  try {
    crop(grid(4, 4), { x: 3, y: 0, width: 2, height: 1 });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof InvalidOptionError);
    assert.equal(e.option, 'crop.width');
    assert.match(e.message, /4/, 'the actual bound belongs in the message');
  }
});

test('crop rejects fractional coordinates', () => {
  // The library does not decide whether the caller meant floor or round.
  assert.throws(() => crop(grid(4, 4), { x: 0.5, y: 0, width: 1, height: 1 }), InvalidOptionError);
  assert.throws(() => crop(grid(4, 4), { x: 0, y: 0, width: 1.5, height: 1 }), InvalidOptionError);
});

test('crop of a 1x1 region works', () => {
  assert.deepEqual(at(crop(grid(4, 4), { x: 3, y: 3, width: 1, height: 1 }), 0, 0), [4, 4]);
});

// --- flip --------------------------------------------------------------------------

test('flip horizontal mirrors left to right', () => {
  const out = flip(grid(4, 1), { horizontal: true });

  assert.deepEqual(
    [0, 1, 2, 3].map((x) => at(out, x, 0)[0]),
    [4, 3, 2, 1],
  );
});

test('flip horizontal on an odd width keeps the centre column', () => {
  // A loop bound that is off by one here double-swaps and silently undoes the flip.
  const out = flip(grid(5, 1), { horizontal: true });

  assert.deepEqual(
    [0, 1, 2, 3, 4].map((x) => at(out, x, 0)[0]),
    [5, 4, 3, 2, 1],
  );
});

test('flip vertical mirrors top to bottom', () => {
  const out = flip(grid(1, 3), { vertical: true });

  assert.deepEqual(
    [0, 1, 2].map((y) => at(out, 0, y)[1]),
    [3, 2, 1],
  );
});

test('flipping twice on either axis returns the original', () => {
  const src = grid(5, 4);

  for (const axis of [{ horizontal: true }, { vertical: true }] as const) {
    assert.deepEqual(Array.from(flip(flip(src, axis), axis).data), Array.from(src.data));
  }
});

test('flip on both axes equals a 180 rotation', () => {
  // Not a coincidence to assert for its own sake: it is a free cross-check that catches
  // an axis mix-up in either implementation.
  const src = grid(5, 3);

  assert.deepEqual(
    Array.from(flip(src, { horizontal: true, vertical: true }).data),
    Array.from(rotate90(src, 180).data),
  );
});

test('flip with no axis is a no-op', () => {
  // The plugin passes {horizontal: false, vertical: false} when the user has toggled
  // nothing. That must be cheap, not an error.
  const src = grid(3, 3);
  assert.deepEqual(Array.from(flip(src, {}).data), Array.from(src.data));
  assert.deepEqual(Array.from(flip(src, { horizontal: false, vertical: false }).data), Array.from(src.data));
});

test('flip never changes dimensions', () => {
  const out = flip(grid(7, 3), { horizontal: true, vertical: true });
  assert.equal(out.width, 7);
  assert.equal(out.height, 3);
});

// --- rotate90 ----------------------------------------------------------------------

test('rotate 90 turns clockwise and swaps dimensions', () => {
  // Positive is clockwise. Stated once, never wavered from.
  const out = rotate90(grid(3, 5), 90);

  assert.equal(out.width, 5, 'dimensions swap');
  assert.equal(out.height, 3);
  // Source top-left (0,0) lands top-right after a clockwise turn.
  assert.deepEqual(at(out, 4, 0), [1, 1]);
  assert.deepEqual(at(out, 0, 0), [1, 5], 'source bottom-left is now top-left');
});

test('rotate -90 turns counter-clockwise', () => {
  const out = rotate90(grid(3, 5), -90);

  assert.equal(out.width, 5);
  assert.equal(out.height, 3);
  assert.deepEqual(at(out, 0, 2), [1, 1], 'source top-left lands bottom-left');
});

test('rotate 180 keeps dimensions and reverses', () => {
  const out = rotate90(grid(3, 2), 180);

  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.deepEqual(at(out, 2, 1), [1, 1]);
});

test('four 90 rotations return the original, byte for byte', () => {
  // The single test that catches almost every index bug in a rotation.
  const src = grid(3, 5);
  const out = rotate90(rotate90(rotate90(rotate90(src, 90), 90), 90), 90);

  assert.equal(out.width, 3);
  assert.equal(out.height, 5);
  assert.deepEqual(Array.from(out.data), Array.from(src.data));
});

test('rotate 90 then -90 returns the original', () => {
  const src = grid(4, 2);
  assert.deepEqual(Array.from(rotate90(rotate90(src, 90), -90).data), Array.from(src.data));
});

test('rotate 180 twice returns the original', () => {
  const src = grid(4, 3);
  assert.deepEqual(Array.from(rotate90(rotate90(src, 180), 180).data), Array.from(src.data));
});

test('rotate normalises angles beyond one turn', () => {
  const src = grid(3, 4);

  assert.deepEqual(Array.from(rotate90(src, 450).data), Array.from(rotate90(src, 90).data));
  assert.deepEqual(Array.from(rotate90(src, -270).data), Array.from(rotate90(src, 90).data));
  assert.deepEqual(Array.from(rotate90(src, 270).data), Array.from(rotate90(src, -90).data));
});

test('rotate 0 and 360 are no-ops', () => {
  const src = grid(3, 4);
  assert.deepEqual(Array.from(rotate90(src, 0).data), Array.from(src.data));
  assert.deepEqual(Array.from(rotate90(src, 360).data), Array.from(src.data));
});

test('rotate90 rejects an angle that is not a right angle', () => {
  // The dispatcher in features/rotate.md routes those to the resampled path; this
  // function must never silently approximate one.
  assert.throws(() => rotate90(grid(2, 2), 45), InvalidOptionError);
  assert.throws(() => rotate90(grid(2, 2), 90.0001), InvalidOptionError);
});

test('rotate 90 handles 1xN and Nx1', () => {
  const out = rotate90(grid(1, 4), 90);
  assert.equal(out.width, 4);
  assert.equal(out.height, 1);
});

test('rotate preserves alpha exactly', () => {
  const src = createImage(2, 1, [10, 20, 30, 0]);
  const out = rotate90(src, 90);
  assert.deepEqual(Array.from(out.data.subarray(0, 4)), [10, 20, 30, 0]);
});
