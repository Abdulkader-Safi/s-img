import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createImage,
  assertValidImage,
  copyImage,
  type RawImage,
  type RGBA,
} from '../../src/core/image.ts';
import { InvalidOptionError, CorruptImageError } from '../../src/core/errors.ts';

// features/raw-image.md. One flat struct that every decoder produces, every transform
// consumes and produces, and every encoder takes. The only currency in the library.

/** A hand-built 2x2: red, green / blue, transparent. Small enough to assert byte by byte. */
function fixture(): RawImage {
  return {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 0, 0, 255, /**/ 0, 255, 0, 255,
      0, 0, 255, 255, /**/ 0, 0, 0, 0,
    ]),
  };
}

test('createImage allocates a transparent canvas by default', () => {
  const img = createImage(3, 2);

  assert.equal(img.width, 3);
  assert.equal(img.height, 2);
  assert.equal(img.data.length, 3 * 2 * 4, 'RGBA: width * height * 4');
  assert.ok(
    img.data.every((b) => b === 0),
    'an unfilled canvas is transparent black',
  );
});

test('createImage flood-fills when given a colour', () => {
  // rotate's grown canvas needs this: the corners that had no source.
  const img = createImage(2, 1, [255, 128, 0, 255]);

  assert.deepEqual(Array.from(img.data), [255, 128, 0, 255, 255, 128, 0, 255]);
});

test('createImage fills every pixel on awkward sizes', () => {
  // createImage fills by doubling a memmove rather than looping per pixel, because
  // rotate's grown canvas is large and the naive loop costs ~29ms of a frame budget
  // there. Doubling is easy to get subtly wrong on sizes that aren't powers of two,
  // and a 2x1 test would never show it.
  const fill: RGBA = [255, 128, 0, 254];

  for (const [w, h] of [
    [1, 1],
    [3, 1],
    [5, 7],
    [13, 13],
    [17, 3],
    [999, 1],
  ] as const) {
    const img = createImage(w, h, fill);
    assert.equal(img.data.length, w * h * 4);

    for (let i = 0; i < img.data.length; i += 4) {
      assert.deepEqual(
        Array.from(img.data.subarray(i, i + 4)),
        Array.from(fill),
        `${w}x${h}: pixel at byte ${i} was not filled`,
      );
    }
  }
});

test('createImage treats a transparent-black fill as no fill', () => {
  // [0,0,0,0] is what a fresh buffer already holds, so the fill loop is skipped.
  // Same observable result either way -- this pins that they agree.
  const explicit = createImage(3, 3, [0, 0, 0, 0]);
  assert.ok(explicit.data.every((b) => b === 0));
});

test('createImage rejects a zero dimension', () => {
  // There is no meaningful 0-pixel image, and allowing one means every downstream
  // loop needs a guard.
  assert.throws(() => createImage(0, 5), InvalidOptionError);
  assert.throws(() => createImage(5, 0), InvalidOptionError);
});

test('createImage rejects a non-integer dimension', () => {
  // A fractional pixel count means the caller's maths is wrong. Don't round for them.
  assert.throws(() => createImage(2.5, 5), InvalidOptionError);
});

test('createImage names the offending dimension', () => {
  try {
    createImage(5, -1);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof InvalidOptionError);
    assert.equal(e.option, 'height');
    assert.equal(e.value, -1);
  }
});

test('assertValidImage accepts a well-formed image', () => {
  assert.doesNotThrow(() => assertValidImage(fixture()));
});

test('assertValidImage rejects a mismatched buffer length', () => {
  // A codec that returns a wrong-length buffer is a bug we want caught at the seam,
  // not three transforms later as a garbage image.
  const short: RawImage = { width: 2, height: 2, data: new Uint8ClampedArray(15) };
  assert.throws(() => assertValidImage(short), CorruptImageError);
});

test('assertValidImage reports both lengths', () => {
  const short: RawImage = { width: 2, height: 2, data: new Uint8ClampedArray(15) };
  try {
    assertValidImage(short);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof CorruptImageError);
    assert.match(e.message, /16/, 'the expected length');
    assert.match(e.message, /15/, 'the actual length');
  }
});

test('assertValidImage rejects a zero dimension', () => {
  const zero: RawImage = { width: 0, height: 2, data: new Uint8ClampedArray(0) };
  assert.throws(() => assertValidImage(zero), CorruptImageError);
});

test('assertValidImage rejects a non-integer dimension', () => {
  const frac: RawImage = { width: 2.5, height: 2, data: new Uint8ClampedArray(20) };
  assert.throws(() => assertValidImage(frac), CorruptImageError);
});

test('copyImage round-trips byte-identically', () => {
  const src = fixture();
  const copy = copyImage(src);

  assert.equal(copy.width, src.width);
  assert.equal(copy.height, src.height);
  assert.deepEqual(Array.from(copy.data), Array.from(src.data));
});

test('copyImage is a deep copy, not an alias', () => {
  // Transforms allocate and return new images rather than mutating. An aliasing copy
  // would defeat that entirely.
  const src = fixture();
  const copy = copyImage(src);

  assert.notEqual(copy, src, 'a new object');
  assert.notEqual(copy.data, src.data, 'a new buffer');
  assert.notEqual(copy.data.buffer, src.data.buffer, 'a new ArrayBuffer, not a view');

  copy.data[0] = 1;
  assert.equal(src.data[0], 255, 'writing to the copy must not touch the source');
});

test('data is a Uint8ClampedArray, and it clamps', () => {
  // Not decoration. A Lanczos kernel writing -3 or 280 must saturate to 0 or 255
  // rather than wrap: that is the difference between a clean edge and black speckles
  // in the highlights.
  const img = createImage(1, 1);

  img.data[0] = -3;
  img.data[1] = 280;

  assert.equal(img.data[0], 0, 'negative saturates to 0, does not wrap to 253');
  assert.equal(img.data[1], 255, 'over-range saturates to 255, does not wrap to 24');
});
