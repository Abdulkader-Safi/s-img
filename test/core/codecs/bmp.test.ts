import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodeBmp, encodeBmp, probeBmp } from '../../../src/core/codecs/bmp.ts';
import { CorruptImageError } from '../../../src/core/errors.ts';
import { createImage } from '../../../src/core/image.ts';

// features/codec-bmp.md. Trivial once the pixel pipeline exists: a header, then the
// pixels. Mostly a read-side compatibility feature -- nobody chooses BMP as an output
// format on purpose -- with the write side thrown in because the encoder is 40 lines.

const DIR = new URL('../../fixtures/bmp/', import.meta.url).pathname;

function load(name: string): { bmp: Uint8Array; expected: Uint8Array } {
  return {
    bmp: new Uint8Array(readFileSync(`${DIR}${name}.bmp`)),
    expected: new Uint8Array(readFileSync(`${DIR}${name}.rgba`)),
  };
}

/** Every fixture, and the trap it exists to catch. */
const CASES: readonly (readonly [name: string, why: string])[] = [
  ['rgb24', '24-bit BI_RGB: the overwhelmingly common case'],
  ['pad-3w', 'width 3: rows pad to a 4-byte boundary'],
  ['pad-5w', 'width 5: a different padding remainder'],
  ['pad-7w', 'width 7: another'],
  ['palette8', '4-bit palette, which is what ImageMagick emits for 16 colours'],
  ['rgb565', '16-bit, where the channel masks are not byte-aligned'],
  ['rgba32', '32-bit BITMAPV5HEADER with BI_BITFIELDS, real alpha'],
  ['photo-17x13', 'odd dimensions, photo-like noise'],
];

for (const [name, why] of CASES) {
  test(`decodes ${name} exactly as ImageMagick does (${why})`, () => {
    const { bmp, expected } = load(name);
    const img = decodeBmp(bmp);

    assert.equal(img.data.length, expected.length, 'pixel buffer size');

    for (let i = 0; i < expected.length; i++) {
      if (img.data[i] !== expected[i]) {
        const p = Math.floor(i / 4);
        assert.fail(
          `${name}: byte ${i} (pixel ${p % img.width},${Math.floor(p / img.width)}, ` +
            `channel ${'rgba'[i % 4]}) is ${img.data[i]}, ImageMagick says ${expected[i]}`,
        );
      }
    }
  });
}

test('channel order is BGR, not RGB', () => {
  // Getting this backwards makes every red image blue, and a symmetric fixture would
  // never show it.
  const { bmp } = load('rgb24');
  const img = decodeBmp(bmp);
  const { expected } = load('rgb24');

  assert.deepEqual(Array.from(img.data.subarray(0, 4)), Array.from(expected.subarray(0, 4)));
});

test('a padded row does not shear the image', () => {
  // A 3-pixel-wide 24-bit image has 9 bytes of pixels and 3 bytes of padding per row.
  // Ignoring the pad shifts each row by 3 bytes and the image shears diagonally.
  for (const name of ['pad-3w', 'pad-5w', 'pad-7w']) {
    const { bmp, expected } = load(name);
    assert.deepEqual(Array.from(decodeBmp(bmp).data), Array.from(expected), name);
  }
});

test('probe agrees with the decoded size on every fixture', () => {
  for (const [name] of CASES) {
    const { bmp } = load(name);
    const img = decodeBmp(bmp);
    assert.deepEqual(probeBmp(bmp), { width: img.width, height: img.height }, name);
  }
});

// --- row order ----------------------------------------------------------------------

test('a negative height means top-down rows', () => {
  // The classic. Positive height stores rows bottom-up; negative stores them top-down,
  // and the sign IS the flag.
  const { bmp } = load('rgb24');
  const bottomUp = decodeBmp(bmp);

  // Flip the stored rows and negate the height: the same image, expressed the other way.
  const topDown = bmp.slice();
  const view = new DataView(topDown.buffer, topDown.byteOffset, topDown.byteLength);
  const height = view.getInt32(22, true);
  view.setInt32(22, -height, true);

  const offset = view.getUint32(10, true);
  const stride = Math.ceil((bottomUp.width * 3) / 4) * 4;
  for (let y = 0; y < height; y++) {
    const from = bmp.subarray(offset + (height - 1 - y) * stride, offset + (height - y) * stride);
    topDown.set(from, offset + y * stride);
  }

  assert.deepEqual(Array.from(decodeBmp(topDown).data), Array.from(bottomUp.data));
});

// --- alpha --------------------------------------------------------------------------

test('a 32-bit BMP whose alpha channel is all zero is opaque', () => {
  // Common, and it means "no alpha", not "fully invisible". Trusting the zeros makes a
  // perfectly good BMP decode to an invisible image -- a real bug in real libraries.
  const src = createImage(4, 4, [10, 20, 30, 255]);
  const bytes = encodeBmp(src);

  // Rebuild it as 32-bit BI_RGB with a zeroed alpha byte per pixel, the way old tools do.
  const with32 = to32BitZeroAlpha(bytes, 4, 4);
  const img = decodeBmp(with32);

  for (let i = 3; i < img.data.length; i += 4) {
    assert.equal(img.data[i], 255, 'an all-zero alpha channel must be read as opaque');
  }
});

/** Repack a 24-bit BMP as 32-bit BI_RGB with every alpha byte zero. */
function to32BitZeroAlpha(bmp: Uint8Array, width: number, height: number): Uint8Array {
  const src = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const offset = src.getUint32(10, true);
  const srcStride = Math.ceil((width * 3) / 4) * 4;

  const out = new Uint8Array(54 + width * height * 4);
  out.set(bmp.subarray(0, 54));
  const view = new DataView(out.buffer);
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint16(28, 32, true); // bpp
  view.setUint32(30, 0, true); // BI_RGB
  view.setUint32(34, width * height * 4, true);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = offset + y * srcStride + x * 3;
      const to = 54 + (y * width + x) * 4;
      out[to] = bmp[from]!;
      out[to + 1] = bmp[from + 1]!;
      out[to + 2] = bmp[from + 2]!;
      out[to + 3] = 0; // the whole point
    }
  }
  return out;
}

// --- validation ---------------------------------------------------------------------

test('rejects a file that is not a BMP', () => {
  assert.throws(() => decodeBmp(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), CorruptImageError);
});

test('rejects a file whose only fault is the signature', () => {
  // The short case above is caught by the length check alone, so it passes with the
  // signature check deleted. This one is a byte-for-byte valid BMP with two bytes
  // changed, so nothing else can catch it and the check has to do the work itself.
  const { bmp } = load('rgb24');
  const bad = bmp.slice();
  bad[0] = 0x42; // B
  bad[1] = 0x41; // A, not M

  assert.throws(
    () => decodeBmp(bad),
    (e: unknown) => e instanceof CorruptImageError && /signature/i.test(e.message),
  );
});

test('rejects an empty file', () => {
  assert.throws(() => decodeBmp(new Uint8Array()), CorruptImageError);
});

test('rejects a truncated file', () => {
  const { bmp } = load('rgb24');
  assert.throws(() => decodeBmp(bmp.subarray(0, 60)), CorruptImageError);
});

test('rejects a zero dimension', () => {
  const { bmp } = load('rgb24');
  const bad = bmp.slice();
  new DataView(bad.buffer).setInt32(18, 0, true);
  assert.throws(() => probeBmp(bad), CorruptImageError);
});

test('rejects RLE compression with a readable message', () => {
  const { bmp } = load('rgb24');
  const bad = bmp.slice();
  new DataView(bad.buffer).setUint32(30, 1, true); // BI_RLE8

  // Specifically /RLE/, not /compression/: the generic "method 1 is not supported"
  // fallback would satisfy the looser regex, and then the branch that exists purely to
  // name the format could be deleted without a test noticing.
  assert.throws(
    () => decodeBmp(bad),
    (e: unknown) => e instanceof CorruptImageError && /RLE/i.test(e.message),
  );
});

test('reads the channel masks rather than assuming BGRA', () => {
  // Our 32-bit fixture happens to carry the standard BGRA masks, which are exactly what
  // the maskless BI_RGB path assumes -- so ignoring the masks entirely decodes it
  // perfectly. Swap two masks and only a decoder that actually reads them survives.
  const { bmp, expected } = load('rgba32');
  const swapped = bmp.slice();
  const view = new DataView(swapped.buffer);

  const red = view.getUint32(54, true);
  const blue = view.getUint32(62, true);
  view.setUint32(54, blue, true);
  view.setUint32(62, red, true);

  // Swapping the red and blue masks must swap red and blue in the output, and nothing else.
  const img = decodeBmp(swapped);
  for (let i = 0; i < expected.length; i += 4) {
    assert.equal(img.data[i], expected[i + 2], `pixel ${i / 4}: red should now read the blue field`);
    assert.equal(img.data[i + 2], expected[i], `pixel ${i / 4}: blue should now read the red field`);
    assert.equal(img.data[i + 1], expected[i + 1], `pixel ${i / 4}: green is untouched`);
    assert.equal(img.data[i + 3], expected[i + 3], `pixel ${i / 4}: alpha is untouched`);
  }
});

test('trusts the pixel data offset rather than assuming it follows the header', () => {
  // The offset is authoritative and there can be a gap. Assuming pixels start right
  // after the header decodes garbage on any file with one.
  const { bmp, expected } = load('rgb24');
  const gap = 16;
  const shifted = new Uint8Array(bmp.length + gap);
  const view = new DataView(shifted.buffer);

  const oldOffset = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength).getUint32(10, true);
  shifted.set(bmp.subarray(0, oldOffset));
  shifted.set(bmp.subarray(oldOffset), oldOffset + gap);
  view.setUint32(10, oldOffset + gap, true);

  assert.deepEqual(Array.from(decodeBmp(shifted).data), Array.from(expected));
});

test('ignores a file size field that disagrees with reality', () => {
  const { bmp, expected } = load('rgb24');
  const lying = bmp.slice();
  new DataView(lying.buffer).setUint32(2, 999999, true);

  assert.deepEqual(Array.from(decodeBmp(lying).data), Array.from(expected));
});

// --- encode -------------------------------------------------------------------------

test('encode round-trips through our own decoder', () => {
  const src = createImage(17, 13);
  for (let i = 0; i < src.data.length; i += 4) {
    src.data.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i);
  }

  const round = decodeBmp(encodeBmp(src));

  assert.equal(round.width, 17);
  assert.equal(round.height, 13);
  assert.deepEqual(Array.from(round.data), Array.from(src.data));
});

test('encode composites alpha onto the background', () => {
  // BMP has no alpha here: we write 24-bit, because 32-bit alpha support across viewers
  // is a mess. So transparency must be composited, not silently dropped to black.
  const src = createImage(2, 1, [255, 0, 0, 0]);
  const img = decodeBmp(encodeBmp(src, { background: [0, 255, 0, 255] }));

  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [0, 255, 0, 255]);
});

test('encode composites half-transparent pixels proportionally', () => {
  const src = createImage(1, 1, [255, 0, 0, 128]);
  const img = decodeBmp(encodeBmp(src, { background: [255, 255, 255, 255] }));

  const [r, g, b] = [img.data[0]!, img.data[1]!, img.data[2]!];
  assert.ok(r > 250, `red should stay high, got ${r}`);
  assert.ok(g > 100 && g < 155, `green should be about half, got ${g}`);
  assert.ok(b > 100 && b < 155, `blue should be about half, got ${b}`);
});

test('encode defaults the background to white', () => {
  const img = decodeBmp(encodeBmp(createImage(1, 1, [0, 0, 0, 0])));
  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [255, 255, 255, 255]);
});

test('encode round-trips widths that need padding', () => {
  for (const w of [1, 2, 3, 5, 7, 13]) {
    const src = createImage(w, 2, [12, 34, 56, 255]);
    const round = decodeBmp(encodeBmp(src));
    assert.equal(round.width, w);
    assert.deepEqual(Array.from(round.data), Array.from(src.data), `width ${w}`);
  }
});

test('ImageMagick can read what we write', () => {
  // A round-trip through our own decoder would pass even if we invented a private
  // dialect of BMP. This is checked against a real third party in the branch's
  // verification, and pinned here on the container shape.
  const bytes = encodeBmp(createImage(4, 4, [1, 2, 3, 255]));

  assert.equal(bytes[0], 0x42, 'B');
  assert.equal(bytes[1], 0x4d, 'M');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(2, true), bytes.length, 'file size field must be honest');
  assert.equal(view.getUint32(14, true), 40, 'BITMAPINFOHEADER');
  assert.equal(view.getUint16(28, true), 24, '24-bit');
  assert.equal(view.getUint32(30, true), 0, 'BI_RGB');
});
