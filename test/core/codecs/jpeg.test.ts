import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  decodeJpeg,
  encodeJpeg,
  probeJpeg,
  readExifOrientation,
} from '../../../src/core/codecs/jpeg.ts';
import {
  CorruptImageError,
  ImageTooLargeError,
  InvalidOptionError,
  UnsupportedFormatError,
} from '../../../src/core/errors.ts';
import { createImage } from '../../../src/core/image.ts';

// features/codec-jpeg.md. The biggest, gnarliest codec in the set, and the one that
// matters most: a vault is mostly photos and photos are mostly JPEG.
//
// JPEG is lossy and the IDCT is specified to a tolerance rather than to the bit, so the
// spec only asked for "within a small per-channel delta of a reference decoder". We do
// better: our decode is BYTE-IDENTICAL to libjpeg on every fixture, because the choices
// were made to make it so -- the islow integer IDCT and the fancy upsampler are libjpeg's
// own algorithms, so there is nothing left to disagree about.
//
// So these assert exact equality. A delta of "a couple of units" is exactly the width a
// real bug hides in: an off-by-one in the upsampler, a rounding bias in the colour
// transform, a chroma plane half a pixel out. None of those move a channel by more than a
// unit or two, and all of them are wrong. If this ever starts failing by 1, that is a
// regression to find, not a tolerance to widen.

const DIR = new URL('../../fixtures/jpeg/', import.meta.url).pathname;

const jpg = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}${name}.jpg`));
const rgba = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}${name}.rgba`));

/** Assert a decode matches ImageMagick byte for byte, reporting the first pixel that does not. */
function matchesReference(name: string, actual: Uint8ClampedArray, width: number): void {
  const expected = rgba(name);
  assert.equal(actual.length, expected.length, `${name}: pixel buffer size`);

  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      const p = Math.floor(i / 4);
      assert.fail(
        `${name}: byte ${i} (pixel ${p % width},${Math.floor(p / width)}, channel ${'rgba'[i % 4]}) ` +
          `is ${actual[i]}, libjpeg says ${expected[i]}`,
      );
    }
  }
}

// --- decode -------------------------------------------------------------------------

/** Every fixture that must decode, and the trap it exists to catch. */
const CASES: readonly (readonly [name: string, width: number, height: number, why: string])[] = [
  ['s420', 32, 32, '4:2:0, the overwhelmingly common case'],
  ['s422', 32, 32, '4:2:2, horizontal-only subsampling'],
  ['s444', 32, 32, '4:4:4, no subsampling'],
  ['odd-17x13', 17, 13, 'dimensions off the MCU boundary'],
  ['noninter', 24, 24, 'each component in its own scan, not one interleaved scan'],
  ['tiny-1x1', 1, 1, 'one MCU, almost entirely padding'],
  ['grey', 24, 24, 'a single component'],
  ['restart', 48, 48, 'DRI/RSTn restart markers'],
  ['photo', 40, 28, 'real high-frequency content'],
];

for (const [name, width, height, why] of CASES) {
  test(`decodes ${name} exactly as libjpeg does (${why})`, () => {
    const img = decodeJpeg(jpg(name));

    assert.equal(img.width, width, 'width');
    assert.equal(img.height, height, 'height');
    matchesReference(name, img.data, width);
  });
}

test('every decoded pixel is fully opaque', () => {
  // JPEG has no alpha. Leaving the channel at zero decodes every photo to nothing.
  for (const [name] of CASES) {
    const img = decodeJpeg(jpg(name));
    for (let i = 3; i < img.data.length; i += 4) {
      assert.equal(img.data[i], 255, `${name}: pixel ${(i - 3) / 4} is not opaque`);
    }
  }
});

test('greyscale expands to RGBA with R === G === B', () => {
  const img = decodeJpeg(jpg('grey'));
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i], img.data[i + 1], `pixel ${i / 4}: R !== G`);
    assert.equal(img.data[i + 1], img.data[i + 2], `pixel ${i / 4}: G !== B`);
  }
});

test('an image off the MCU boundary has no garbage strip at its edges', () => {
  // The encoder pads 17x13 out to 24x16 and the decoder crops back. Getting the crop
  // wrong shows ONLY on sizes that are not round numbers, which is to say: never on a
  // fixture unless you deliberately add one.
  //
  // The source is a smooth gradient, so a padded column leaking in is a discontinuity.
  // Every horizontal neighbour must stay close.
  const img = decodeJpeg(jpg('odd-17x13'));

  for (let y = 0; y < img.height; y++) {
    for (let x = 1; x < img.width; x++) {
      const a = (y * img.width + x) * 4;
      const b = (y * img.width + x - 1) * 4;
      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(img.data[a + c]! - img.data[b + c]!) < 60,
          `discontinuity at ${x},${y} channel ${c}: ${img.data[b + c]} then ${img.data[a + c]}`,
        );
      }
    }
  }
});

test('restart markers are honoured', () => {
  // Without DRI/RSTn handling the bitstream desynchronises and everything after the first
  // restart interval decodes as noise. The delta check above would catch it, but this
  // pins the reason: the bottom of the image must be as accurate as the top.
  const img = decodeJpeg(jpg('restart'));
  const expected = rgba('restart');

  const half = Math.floor(img.height / 2) * img.width * 4;
  for (let i = half; i < expected.length; i++) {
    assert.equal(img.data[i], expected[i], `byte ${i}: restart intervals are being ignored`);
  }
});

test('a component sent in its own scan is not left blank', () => {
  // Baseline is usually ONE interleaved scan, and a decoder that assumes so stops at the
  // first SOS: the luma decodes, both chroma planes stay at zero, and the image comes out
  // vividly green. ImageMagick will not produce such a file, so the fixture is built with
  // cjpeg and a scan script -- without it this bug ships.
  //
  // Zero chroma means Cb = Cr = 0, which is a strong green. If any pixel is that, the
  // later scans were dropped.
  const img = decodeJpeg(jpg('noninter'));

  let green = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i]! < 40 && img.data[i + 1]! > 130 && img.data[i + 2]! < 40) green++;
  }
  assert.equal(green, 0, `${green} pixels decoded as chroma-less green: a later scan was dropped`);
});

test('rejects a file that never sends a scan for one of its components', () => {
  // Now that several scans are allowed, "I saw a scan" is no longer proof every component
  // has one. Truncating after the first of three leaves two planes undecoded.
  const bytes = jpg('noninter');
  const secondSos = indexOfMarker(bytes, 0xda, indexOfMarker(bytes, 0xda, 2) + 2);

  const short = new Uint8Array(secondSos + 2);
  short.set(bytes.subarray(0, secondSos));
  short.set([0xff, 0xd9], secondSos); // EOI, straight after the first scan

  assert.throws(
    () => decodeJpeg(short),
    (e: unknown) => e instanceof CorruptImageError && /component/i.test(e.message),
  );
});

/** Byte offset of the next `FF <marker>` at or after `from`. */
function indexOfMarker(bytes: Uint8Array, marker: number, from: number): number {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === marker) return i;
  }
  throw new Error(`no marker ff${marker.toString(16)} after ${from}`);
}

test('probe reports the size without decoding the scan', () => {
  for (const [name, width, height] of CASES) {
    assert.deepEqual(probeJpeg(jpg(name)), { width, height }, name);
  }
});

// --- what we deliberately do not support --------------------------------------------

test('progressive JPEG throws a clear, specific error', () => {
  // Real files ARE progressive and this is a real gap. It closes before the plugin swap.
  // Until then the error has to name the format, because "corrupt" would send someone
  // hunting a bug in their file that is not there.
  assert.throws(
    () => decodeJpeg(jpg('progressive')),
    (e: unknown) =>
      e instanceof UnsupportedFormatError && /progressive/i.test(e.message) && /not supported/i.test(e.message),
  );
});

test('probe works on a progressive JPEG even though decode does not', () => {
  // The frame header is baseline-shaped either way, and a caller sizing a preview should
  // not need a decoder that can read the scan.
  assert.deepEqual(probeJpeg(jpg('progressive')), { width: 32, height: 32 });
});

// --- validation ---------------------------------------------------------------------

test('rejects a file that is not a JPEG', () => {
  const png = new Uint8Array(200);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => decodeJpeg(png), CorruptImageError);
});

test('rejects a file whose only fault is the SOI marker', () => {
  // The PNG above trips the "expected a marker" check a byte later, so it passes even with
  // the signature check deleted. This one is a valid JPEG with two bytes changed.
  const bad = jpg('s420').slice();
  bad[1] = 0xd7; // not SOI

  assert.throws(
    () => decodeJpeg(bad),
    (e: unknown) => e instanceof CorruptImageError && /SOI/i.test(e.message),
  );
});

test('refuses a header that declares more pixels than the cap allows', () => {
  // Two bytes of frame header can ask for 65535x65535: 4.3 billion pixels, 17 GB of RGBA,
  // from a file that fits in a tweet. The guard has to fire off the HEADER, before the
  // allocation, or the process is gone before anything else can check.
  const bad = jpg('s420').slice();
  const sof = indexOfMarker(bad, 0xc0, 2);
  new DataView(bad.buffer).setUint16(sof + 5, 65535); // height
  new DataView(bad.buffer).setUint16(sof + 7, 65535); // width

  assert.throws(() => decodeJpeg(bad), ImageTooLargeError);
});

test('rejects an empty file', () => {
  assert.throws(() => decodeJpeg(new Uint8Array()), CorruptImageError);
});

test('rejects truncated scan data rather than returning half an image', () => {
  // Many viewers show a partial image. We do not: a half-image silently saved over the
  // original is data loss.
  const full = jpg('photo');
  assert.throws(() => decodeJpeg(full.subarray(0, full.length - 40)), CorruptImageError);
});

test('rejects a file that ends before the scan starts', () => {
  const full = jpg('photo');
  assert.throws(() => decodeJpeg(full.subarray(0, 20)), CorruptImageError);
});

// --- encode -------------------------------------------------------------------------

test('encode produces a file our own decoder reads back', () => {
  const src = createImage(32, 32, [200, 100, 50, 255]);
  const round = decodeJpeg(encodeJpeg(src, { quality: 95 }));

  assert.equal(round.width, 32);
  assert.equal(round.height, 32);
  // A flat colour survives JPEG almost exactly; the tolerance is for the colour transform.
  for (let i = 0; i < round.data.length; i += 4) {
    assert.ok(Math.abs(round.data[i]! - 200) <= 3, `red drifted to ${round.data[i]}`);
    assert.ok(Math.abs(round.data[i + 1]! - 100) <= 3, `green drifted to ${round.data[i + 1]}`);
    assert.ok(Math.abs(round.data[i + 2]! - 50) <= 3, `blue drifted to ${round.data[i + 2]}`);
    assert.equal(round.data[i + 3], 255);
  }
});

test('encode round-trips a size off the MCU boundary without wrecking the edges', () => {
  // 17x13 pads out to 32x16. A flat colour cannot catch a bad pad: every invented pixel is
  // the same as every real one. This gradient can -- reading past the plane instead of
  // clamping puts zeros into the edge blocks, and the DCT smears them back inward.
  const src = createImage(17, 13);
  for (let y = 0; y < 13; y++) {
    for (let x = 0; x < 17; x++) src.data.set([x * 15, y * 19, 128, 255], (y * 17 + x) * 4);
  }

  const round = decodeJpeg(encodeJpeg(src, { quality: 95 }));

  assert.equal(round.width, 17);
  assert.equal(round.height, 13);

  // 10, not 2: the border blocks of ANY JPEG reproduce worse than the interior, because
  // half their context is padding, and this ramp climbs 15 a pixel. Measured, the honest
  // encoder lands within 4 inside and 8 at the rim. A bad pad blows well past 10.
  for (let i = 0; i < src.data.length; i += 4) {
    const p = i / 4;
    assert.ok(
      Math.abs(round.data[i]! - src.data[i]!) <= 10,
      `pixel ${p % 17},${Math.floor(p / 17)} red: ${round.data[i]} against ${src.data[i]}`,
    );
  }
});

test('the chroma downsampler averages each 2x2 rather than picking a corner', () => {
  // 4:2:0 throws away three quarters of the colour samples, and HOW it throws them away is
  // a real choice: averaging the 2x2 keeps the mean colour, taking one corner discards the
  // other three and aliases.
  //
  // Nothing else here can see the difference. On a flat or greyscale image every 2x2 is
  // identical, so the two agree exactly; even a real photo decoded from a 4:2:0 file has
  // chroma that is already smooth from the upsample, and barely separates them. This needs
  // a large source with fine detail: measured, box-averaging drifts 0.31 per channel and
  // corner-picking 0.61 -- so 0.45 sits with real margin on both sides.
  const src = decodeJpeg(jpg('qsource'));
  const round = decodeJpeg(encodeJpeg(src, { quality: 95 }));

  let drift = 0;
  for (let i = 0; i < src.data.length; i++) drift += Math.abs(round.data[i]! - src.data[i]!);
  drift /= src.data.length;

  assert.ok(drift < 0.45, `mean drift ${drift.toFixed(3)} at quality 95: the 2x2 is not being averaged`);
});

test('encode round-trips a 1x1', () => {
  const src = createImage(1, 1, [200, 100, 50, 255]);
  const round = decodeJpeg(encodeJpeg(src, { quality: 95 }));

  assert.equal(round.width, 1);
  assert.equal(round.height, 1);
  assert.ok(Math.abs(round.data[0]! - 200) <= 4);
});

test('encode composites alpha onto the background', () => {
  // JPEG has no alpha, so transparency must be composited rather than dropped to black.
  const src = createImage(16, 16, [255, 0, 0, 0]);
  const img = decodeJpeg(encodeJpeg(src, { background: [0, 255, 0, 255] }));

  assert.ok(Math.abs(img.data[0]! - 0) <= 4, `red should be 0, got ${img.data[0]}`);
  assert.ok(Math.abs(img.data[1]! - 255) <= 4, `green should be 255, got ${img.data[1]}`);
});

test('encode defaults the background to white', () => {
  const img = decodeJpeg(encodeJpeg(createImage(16, 16, [0, 0, 0, 0])));
  for (let c = 0; c < 3; c++) {
    assert.ok(img.data[c]! >= 250, `channel ${c} should be white, got ${img.data[c]}`);
  }
});

test('quality changes the file size in the right direction', () => {
  const src = decodeJpeg(jpg('photo'));

  const low = encodeJpeg(src, { quality: 20 }).length;
  const mid = encodeJpeg(src, { quality: 82 }).length;
  const high = encodeJpeg(src, { quality: 95 }).length;

  assert.ok(low < mid, `quality 20 (${low}) must be smaller than 82 (${mid})`);
  assert.ok(mid < high, `quality 82 (${mid}) must be smaller than 95 (${high})`);
});

test('higher quality is closer to the original', () => {
  // The size check alone passes if quality only ever touched the tables' magnitude
  // without the output tracking it. This is the check that quality means something.
  const src = decodeJpeg(jpg('photo'));

  const drift = (quality: number): number => {
    const round = decodeJpeg(encodeJpeg(src, { quality }));
    let total = 0;
    for (let i = 0; i < src.data.length; i++) total += Math.abs(round.data[i]! - src.data[i]!);
    return total / src.data.length;
  };

  assert.ok(drift(95) < drift(20), 'quality 95 must reproduce the source better than quality 20');
});

test('the default quality is 82', () => {
  // Named in the spec, and worth pinning: it is the number that decides whether every
  // user's expectation of "quality" matches the rest of the ecosystem.
  const src = decodeJpeg(jpg('photo'));
  assert.equal(encodeJpeg(src).length, encodeJpeg(src, { quality: 82 }).length);
});

test('quality 82 lands within 10% of libjpeg for the same pixels', () => {
  // THE check that the quantisation-table scaling is right, and the reason the scaling
  // formula is lifted from libjpeg rather than invented: `quality: 82` has to mean roughly
  // what 82 means in every other tool, or every user's expectation of the number is wrong.
  //
  // A round-trip through our own decoder cannot catch a wrong curve -- it would be
  // self-consistently wrong. Only a third party's file size can.
  const src = decodeJpeg(jpg('qsource'));
  const ours = encodeJpeg(src, { quality: 82 }).length;
  const libjpeg = jpg('qref-82').length;

  const drift = Math.abs(ours - libjpeg) / libjpeg;
  assert.ok(
    drift < 0.1,
    `${ours} bytes against libjpeg's ${libjpeg}: ${(drift * 100).toFixed(1)}% apart, over the 10% bar`,
  );
});

test('quality 20 lands within 10% of libjpeg too', () => {
  // libjpeg's curve has TWO branches: linear from 50 to 100, hyperbolic (5000/q) below 50.
  // A reference at 82 only checks the first, so the entire low-quality half of the scale
  // could be wrong -- and low quality is the preset pipeline's main job, shrinking a vault
  // attachment. Flattening the curve to one branch passes every other test here.
  const src = decodeJpeg(jpg('qsource'));
  const ours = encodeJpeg(src, { quality: 20 }).length;
  const libjpeg = jpg('qref-20').length;

  const drift = Math.abs(ours - libjpeg) / libjpeg;
  assert.ok(
    drift < 0.1,
    `${ours} bytes against libjpeg's ${libjpeg}: ${(drift * 100).toFixed(1)}% apart, over the 10% bar`,
  );
});

test('quality 100 produces a usable file', () => {
  // The edge of the curve: libjpeg's scale hits ZERO at quality 100, so every table entry
  // rounds to 0 and becomes a division by zero -- NaN coefficients and a garbage file --
  // unless the table is clamped to a floor of 1.
  const src = createImage(16, 16, [200, 100, 50, 255]);
  const round = decodeJpeg(encodeJpeg(src, { quality: 100 }));

  assert.equal(round.width, 16);
  for (let i = 0; i < round.data.length; i += 4) {
    assert.ok(Math.abs(round.data[i]! - 200) <= 2, `quality 100 produced ${round.data[i]}, not ~200`);
  }
});

test('rejects a quality outside 1 to 100', () => {
  const src = createImage(8, 8);
  for (const quality of [0, 101, -1, Number.NaN, 1.5]) {
    assert.throws(() => encodeJpeg(src, { quality }), InvalidOptionError, `quality ${quality}`);
  }
});

test('encode writes a JFIF APP0 and nothing else', () => {
  // No EXIF, no thumbnail, no ICC: a bare JFIF header. features/strip-metadata.md gets
  // this for free as long as the encoder never learns to write metadata.
  const bytes = encodeJpeg(createImage(8, 8));

  assert.equal(bytes[0], 0xff, 'SOI');
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[2], 0xff, 'APP0');
  assert.equal(bytes[3], 0xe0);
  assert.equal(String.fromCharCode(...bytes.subarray(6, 10)), 'JFIF');
  assert.equal(bytes[bytes.length - 2], 0xff, 'EOI');
  assert.equal(bytes[bytes.length - 1], 0xd9);

  // No APP1 (EXIF) anywhere in the header.
  for (let i = 0; i < 200 && i < bytes.length - 1; i++) {
    assert.ok(!(bytes[i] === 0xff && bytes[i + 1] === 0xe1), `an APP1/EXIF segment at ${i}`);
  }
});

test('the final entropy byte is padded with ones', () => {
  // T.81 F.1.2.3: pad the last partial byte with 1-bits. Zeros can form a valid Huffman
  // prefix, so a decoder that reads one bit too many gets a spurious coefficient rather
  // than a clean stop. Our own decoder never looks, which is exactly why nothing else here
  // would notice.
  const bytes = encodeJpeg(createImage(8, 8, [0, 0, 0, 255]), { quality: 82 });

  // The byte before EOI is the last entropy byte; the padding is its low bits.
  const last = bytes[bytes.length - 3]!;
  assert.ok((last & 1) === 1, `final entropy byte 0x${last.toString(16)} is zero-padded`);
});

// --- EXIF orientation ---------------------------------------------------------------

test('reads the EXIF orientation tag', () => {
  // The codec only READS it. Applying it needs rotate and flip, and a codec that imports
  // a transform is a dependency running the wrong way -- decode.md does the applying.
  const bytes = withOrientation(jpg('s420'), 6);
  assert.equal(readExifOrientation(bytes), 6);
});

test('orientation defaults to 1 when there is no EXIF', () => {
  assert.equal(readExifOrientation(jpg('s420')), 1);
  assert.equal(readExifOrientation(encodeJpeg(createImage(8, 8))), 1);
});

test('reads orientation from a big-endian EXIF block', () => {
  // TIFF headers inside EXIF come in both byte orders and iPhones write big-endian ("MM").
  // Assuming little-endian reads the tag count as 256 and finds nothing.
  assert.equal(readExifOrientation(withOrientation(jpg('s420'), 8, true)), 8);
});

test('a corrupt EXIF block reports no orientation rather than throwing', () => {
  // Metadata is not worth failing a decode over: the pixels are fine.
  const bytes = withOrientation(jpg('s420'), 6);
  const at = bytes.indexOf(0x45); // the 'E' of "Exif"
  bytes[at + 12] = 0xff; // scribble on the IFD offset

  assert.equal(readExifOrientation(bytes), 1);
});

test('an EXIF block claiming more entries than it holds reports no orientation', () => {
  // The nastier corruption: the IFD offset is perfectly valid, so the early bounds check
  // waves it through, and only the entry count is a lie. Walking 4000 entries out of a
  // 26-byte block reads whatever follows in the file as tags.
  const bytes = withOrientation(jpg('s420'), 6);
  const exif = bytes.indexOf(0x45); // the 'E' of "Exif"
  const tiff = exif + 6;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(tiff + 8, 4000, true);

  assert.equal(readExifOrientation(bytes), 1);
});

/** Splice a minimal APP1/EXIF block carrying just an orientation tag into a JPEG. */
function withOrientation(src: Uint8Array, orientation: number, bigEndian = false): Uint8Array {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  const le = !bigEndian;

  tiff[0] = tiff[1] = bigEndian ? 0x4d : 0x49; // "MM" or "II"
  view.setUint16(2, 42, le);
  view.setUint32(4, 8, le); // offset of IFD0, from the start of the TIFF header
  view.setUint16(8, 1, le); // one entry
  view.setUint16(10, 0x0112, le); // Orientation
  view.setUint16(12, 3, le); // SHORT
  view.setUint32(14, 1, le); // count
  view.setUint16(18, orientation, le); // value, inline
  view.setUint32(22, 0, le); // no IFD1

  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
  payload.set(tiff, 6);

  const out = new Uint8Array(src.length + 4 + payload.length);
  out.set(src.subarray(0, 2)); // SOI
  out.set([0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff], 2);
  out.set(payload, 6);
  out.set(src.subarray(2), 6 + payload.length);
  return out;
}
