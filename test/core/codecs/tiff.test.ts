import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodeTiff, encodeTiff, probeTiff } from '../../../src/core/codecs/tiff.ts';
import { CorruptImageError, ImageTooLargeError, UnsupportedFormatError } from '../../../src/core/errors.ts';
import { createImage, type RawImage } from '../../../src/core/image.ts';

// features/codec-tiff.md. TIFF is not a format, it is a container spec with a tag system,
// and "a TIFF" can be almost anything. The scope discipline matters more than the code:
// each fixture below pins one variant we claim to read, and each unsupported variant gets
// a specific error naming what it is.
//
// Everything supported here is lossless, so these are byte-exact against ImageMagick.

const DIR = new URL('../../fixtures/tiff/', import.meta.url).pathname;

const tif = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}${name}.tif`));
const rgba = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}${name}.rgba`));

/** Every fixture that must decode, its size, and the trap it exists to catch. */
const CASES: readonly (readonly [name: string, width: number, height: number, why: string])[] = [
  ['rgb-none', 16, 16, 'uncompressed RGB'],
  ['rgb-lzw', 16, 16, "LZW with predictor 1: TIFF's LZW is not GIF's"],
  ['rgb-lzw-pred', 32, 32, 'LZW with predictor 2, horizontal differencing'],
  ['rgb-packbits', 16, 16, 'PackBits RLE'],
  ['rgb-be', 16, 16, 'big-endian, the classic hardcoded-LE bug'],
  ['grey', 16, 16, 'greyscale, one sample per pixel'],
  ['grey16', 16, 16, '16 bits per sample, truncated to 8'],
  ['rgb16', 16, 16, '16-bit RGB, truncated to 8'],
  ['rgb16-be', 16, 16, '16-bit RGB big-endian: the high byte moves ends'],
  ['grey-wiz', 16, 16, 'WhiteIsZero: an inverted greyscale'],
  ['bilevel', 16, 16, '1 bit per sample, a scan'],
  ['palette', 16, 16, 'a palette, which ImageMagick packs into 4 bits'],
  ['rgba', 16, 16, 'RGBA with ExtraSamples'],
  ['multistrip', 32, 64, 'eight strips, the normal case'],
  ['multistrip-odd', 32, 60, 'a height that is not a multiple of RowsPerStrip'],
  ['multipage', 16, 16, 'page 0 of a multi-page file'],
];

for (const [name, width, height, why] of CASES) {
  test(`decodes ${name} exactly as ImageMagick does (${why})`, () => {
    const img = decodeTiff(tif(name));

    assert.equal(img.width, width, 'width');
    assert.equal(img.height, height, 'height');
    assert.equal(img.data.length, rgba(name).length, 'pixel buffer size');

    const expected = rgba(name);
    for (let i = 0; i < expected.length; i++) {
      if (img.data[i] !== expected[i]) {
        const p = Math.floor(i / 4);
        assert.fail(
          `${name}: byte ${i} (pixel ${p % width},${Math.floor(p / width)}, ` +
            `channel ${'rgba'[i % 4]}) is ${img.data[i]}, ImageMagick says ${expected[i]}`,
        );
      }
    }
  });
}

test('probe agrees with the decoded size on every fixture', () => {
  for (const [name, width, height] of CASES) {
    assert.deepEqual(probeTiff(tif(name)), { width, height }, name);
  }
});

// --- the fixtures are what they claim ------------------------------------------------

/**
 * Read the first value of an IFD0 tag, respecting the file's byte order.
 *
 * Follows the value-vs-offset rule rather than always reading the entry inline: with three
 * samples, BitsPerSample does not fit in four bytes and those bytes are an OFFSET. Reading
 * them as the value gives a plausible-looking number (962) and quietly asserts nothing.
 */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

function tag(bytes: Uint8Array, wanted: number): number | undefined {
  const le = bytes[0] === 0x49;
  const read = (at: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v |= bytes[at + (le ? i : size - 1 - i)]! << (8 * i);
    return v >>> 0;
  };

  const ifd = read(4, 4);
  const count = read(ifd, 2);

  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (read(entry, 2) !== wanted) continue;

    const type = read(entry + 2, 2);
    const n = read(entry + 4, 4);
    const size = TYPE_SIZE[type] ?? 1;
    const at = n * size <= 4 ? entry + 8 : read(entry + 8, 4);
    return read(at, size);
  }
  return undefined;
}

test('the fixtures actually exercise the variants they are named for', () => {
  // ImageMagick will happily hand back a different variant than the one you asked for, and
  // a fixture that silently tests the wrong thing is worse than no fixture. Every one of
  // these was wrong on the first attempt: rgb-lzw came out with predictor 2 (ImageMagick's
  // default), grey came out 16-bit, and bilevel came out 16-bit despite -monochrome.
  assert.equal(tag(tif('rgb-none'), 259), 1, 'rgb-none must be uncompressed');
  assert.equal(tag(tif('rgb-lzw'), 259), 5, 'rgb-lzw must be LZW');
  assert.equal(tag(tif('rgb-lzw'), 317), 1, 'rgb-lzw must use predictor 1');
  assert.equal(tag(tif('rgb-lzw-pred'), 317), 2, 'rgb-lzw-pred must use predictor 2');
  assert.equal(tag(tif('rgb-packbits'), 259), 32773, 'rgb-packbits must be PackBits');
  assert.equal(tif('rgb-be')[0], 0x4d, 'rgb-be must be big-endian');
  // Every fixture's depth is checked, not just the ones with a depth in the name. All of
  // these came out 16-bit at first -- ImageMagick's default for RGB as well as greyscale --
  // which left the whole 8-bit path untested while the suite looked green.
  for (const name of ['rgb-none', 'rgb-lzw', 'rgb-lzw-pred', 'rgb-packbits', 'rgb-be', 'grey', 'rgba', 'multistrip']) {
    assert.equal(tag(tif(name), 258), 8, `${name} must be 8-bit`);
  }
  assert.equal(tag(tif('grey16'), 258), 16, 'grey16 must be 16-bit');
  assert.equal(tag(tif('rgb16'), 258), 16, 'rgb16 must be 16-bit');
  assert.equal(tag(tif('rgb16-be'), 258), 16, 'rgb16-be must be 16-bit');
  assert.equal(tif('rgb16-be')[0], 0x4d, 'rgb16-be must be big-endian');
  assert.equal(tag(tif('grey-wiz'), 262), 0, 'grey-wiz must be WhiteIsZero');
  assert.equal(tag(tif('bilevel'), 258), 1, 'bilevel must be 1-bit');
  assert.equal(tag(tif('palette'), 262), 3, 'palette must be palette-coloured');
  assert.equal(tag(tif('rgba'), 277), 4, 'rgba must have 4 samples per pixel');
  assert.equal(tag(tif('multistrip'), 278), 8, 'multistrip must have 8 rows per strip');
  assert.equal(tag(tif('multistrip-odd'), 278), 8, 'multistrip-odd must have 8 rows per strip');
  assert.equal(tag(tif('multistrip-odd'), 257), 60, 'multistrip-odd must not divide evenly by 8');
});

test('big-endian and little-endian files of the same image agree', () => {
  // The single most likely TIFF bug: a reader that hardcodes little-endian works on most
  // files and produces garbage on the rest. Both fixtures are the same plasma at the same
  // size, so if the byte order is being honoured they decode identically.
  assert.deepEqual(Array.from(decodeTiff(tif('rgb-be')).data), Array.from(rgba('rgb-be')));
  assert.equal(tif('rgb-none')[0], 0x49, 'the LE fixture must be II');
  assert.equal(tif('rgb-be')[0], 0x4d, 'the BE fixture must be MM');
});

test('predictor 2 is undone', () => {
  // Horizontal differencing stores each sample as its difference from the one to its left.
  // Leave it applied and the image is a smear -- and a predictor-1 file decodes perfectly
  // without the code, so only this fixture catches it.
  assert.deepEqual(Array.from(decodeTiff(tif('rgb-lzw-pred')).data), Array.from(rgba('rgb-lzw-pred')));
});

test('a multi-strip file is not assembled out of order', () => {
  // RowsPerStrip is often 8 or 16, so a tall image has hundreds of strips. A decoder that
  // assumes one strip passes its own fixtures and fails on everything real. This fixture
  // is 64 rows in 8 strips of 8.
  const img = decodeTiff(tif('multistrip'));
  assert.deepEqual(Array.from(img.data), Array.from(rgba('multistrip')));
});

test('the last strip of an image that does not divide evenly is a short one', () => {
  // 64 rows in strips of 8 divides exactly, so the "how many rows are left in this strip"
  // clamp never fires and can be deleted with every other test still passing. 60 rows
  // leaves a final strip of 4.
  const img = decodeTiff(tif('multistrip-odd'));

  assert.equal(img.height, 60);
  assert.deepEqual(Array.from(img.data), Array.from(rgba('multistrip-odd')));
});

test('associated (premultiplied) alpha is un-multiplied on the way in', () => {
  // ExtraSamples 1 means the RGB is already multiplied by alpha; 2 means it is not.
  // RawImage is non-premultiplied, so a 1 has to be undone at this boundary. ImageMagick
  // only ever writes 2, so the fixture is our own RGBA output with the tag flipped -- the
  // same bytes, declared the other way -- and the colours must come back brighter.
  const src = createImage(4, 1);
  src.data.set([64, 32, 16, 128], 0); // as if 128,64,32 premultiplied by 50% alpha
  for (let x = 1; x < 4; x++) src.data.set([64, 32, 16, 128], x * 4);

  const unassociated = encodeTiff(src, { compression: 'none' });
  assert.equal(tag(unassociated, 338), 2, 'we write unassociated alpha');
  assert.deepEqual(Array.from(decodeTiff(unassociated).data.subarray(0, 4)), [64, 32, 16, 128]);

  const associated = withTag(unassociated, 338, 1);
  const img = decodeTiff(associated);

  // 64 at 50% alpha un-multiplies to ~128.
  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [128, 64, 32, 128]);
});

test('WhiteIsZero decodes to the same thing ImageMagick sees', () => {
  // PhotometricInterpretation 0 inverts the greyscale. Ignoring it gives a negative image:
  // every pixel exactly 255 out.
  const img = decodeTiff(tif('grey-wiz'));
  const expected = rgba('grey-wiz');

  assert.deepEqual(Array.from(img.data), Array.from(expected));
  // And prove the fixture could tell: an un-inverted read differs on nearly every pixel.
  const differs = Array.from({ length: 256 }, (_, p) => Math.abs(expected[p * 4]! - (255 - expected[p * 4]!)) > 8);
  assert.ok(differs.filter(Boolean).length > 200, 'the fixture is too close to mid-grey to catch an inversion');
});

test('every decoded pixel of an opaque fixture is opaque', () => {
  for (const [name] of CASES) {
    if (name === 'rgba') continue;
    const img = decodeTiff(tif(name));
    for (let i = 3; i < img.data.length; i += 4) {
      assert.equal(img.data[i], 255, `${name}: pixel ${(i - 3) / 4} is not opaque`);
    }
  }
});

test('RGBA keeps its alpha channel', () => {
  const img = decodeTiff(tif('rgba'));
  for (let i = 3; i < img.data.length; i += 4) {
    assert.ok(img.data[i]! > 100 && img.data[i]! < 160, `expected ~50% alpha, got ${img.data[i]}`);
  }
});

test('a multi-page TIFF decodes page 0 with no error', () => {
  // Same reasoning as animated GIF: page 0 beats refusing the file.
  const img = decodeTiff(tif('multipage'));
  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [255, 0, 0, 255], 'page 0 is red');
});

// --- what we deliberately do not support --------------------------------------------

const UNSUPPORTED: readonly (readonly [name: string, pattern: RegExp])[] = [
  ['jpeg-in-tiff', /JPEG/i],
  ['tiled', /tiled/i],
  ['ccitt', /CCITT|fax|group/i],
];

for (const [name, pattern] of UNSUPPORTED) {
  test(`${name} throws a specific error naming what is unsupported`, () => {
    // Each of these has to say what it is. "Corrupt" would send someone hunting a bug in
    // their file that is not there.
    assert.throws(
      () => decodeTiff(tif(name)),
      (e: unknown) => e instanceof UnsupportedFormatError && pattern.test(e.message),
      `${name} should throw an UnsupportedFormatError matching ${pattern}`,
    );
  });
}

test('BigTIFF throws a specific error', () => {
  // Magic 43 instead of 42, and 64-bit offsets throughout. A different format wearing the
  // same signature.
  const bad = tif('rgb-none').slice();
  bad[2] = 43;

  assert.throws(
    () => decodeTiff(bad),
    (e: unknown) => e instanceof UnsupportedFormatError && /BigTIFF/i.test(e.message),
  );
});

// --- validation ---------------------------------------------------------------------

test('rejects a file that is not a TIFF', () => {
  const png = new Uint8Array(200);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => decodeTiff(png), CorruptImageError);
});

test('rejects an empty file', () => {
  assert.throws(() => decodeTiff(new Uint8Array()), CorruptImageError);
});

test('rejects a file whose only fault is the byte-order mark', () => {
  const bad = tif('rgb-none').slice();
  bad[0] = 0x58; // neither II nor MM
  bad[1] = 0x58;

  assert.throws(
    () => decodeTiff(bad),
    (e: unknown) => e instanceof CorruptImageError && /byte order|II|MM/i.test(e.message),
  );
});

test('rejects a bad magic number', () => {
  const bad = tif('rgb-none').slice();
  bad[2] = 99;

  assert.throws(() => decodeTiff(bad), CorruptImageError);
});

test('rejects a truncated file', () => {
  const full = tif('rgb-none');
  assert.throws(() => decodeTiff(full.subarray(0, 40)), CorruptImageError);
});

test('rejects an IFD offset that points past the end of the file', () => {
  const bad = tif('rgb-none').slice();
  new DataView(bad.buffer).setUint32(4, 0xfffff0, true);

  assert.throws(() => decodeTiff(bad), CorruptImageError);
});

test('refuses dimensions larger than the pixel cap', () => {
  // The guard fires off the tag, before allocation.
  const bad = withTag(tif('rgb-none'), 256, 65535);
  const worse = withTag(bad, 257, 65535);

  assert.throws(() => decodeTiff(worse), ImageTooLargeError);
});

/** Rewrite an IFD0 tag's inline value. Little-endian fixtures only. */
function withTag(bytes: Uint8Array, wanted: number, value: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);

  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry, true) === wanted) {
      view.setUint32(entry + 8, value, true);
      return out;
    }
  }
  throw new Error(`tag ${wanted} not found`);
}

test('rejects a strip that runs past the end of the file', () => {
  // The message has to name the strip. Without the bounds check the read just comes back
  // empty and the "decoded 0 of N bytes" guard catches it -- still a CorruptImageError, so
  // a bare `throws` assertion cannot tell the two apart, and the specific check could be
  // deleted with nothing failing.
  const bad = withTag(tif('rgb-none'), 273, 0xfffff0); // StripOffsets

  assert.throws(
    () => decodeTiff(bad),
    (e: unknown) => e instanceof CorruptImageError && /strip 0 runs past/i.test(e.message),
  );
});

test('a PackBits no-op byte is skipped, not treated as a run', () => {
  // -128 is defined as "do nothing". Read it as a repeat count and it inflates into 129
  // copies of the next byte, shredding everything after it.
  //
  // No encoder emits one, so ImageMagick cannot produce this fixture: it is built by hand
  // from an uncompressed TIFF, re-declared as PackBits with a stream that opens with the
  // no-op. Every real byte after it must still land.
  const pixels = [10, 20, 30, 40, 50, 60]; // two RGB pixels
  const packed = [
    0x80, // -128: the no-op
    5, // a literal run of 6 bytes
    ...pixels,
  ];

  const bytes = withPackBits(2, 1, packed);
  const img = decodeTiff(bytes);

  assert.equal(img.width, 2);
  assert.deepEqual(Array.from(img.data), [10, 20, 30, 255, 40, 50, 60, 255]);
});

test('a PackBits repeat run expands to the right length', () => {
  // -3 means "the next byte, four times": 1 - (-3). Off by one and every run is short.
  const packed = [
    0xfd, // -3: repeat the next byte 4 times
    77,
    1, // a literal run of 2 bytes
    88,
    99,
  ];

  const img = decodeTiff(withPackBits(2, 1, packed));
  assert.deepEqual(Array.from(img.data), [77, 77, 77, 255, 77, 88, 99, 255]);
});

/** An uncompressed TIFF of our own, re-declared as PackBits with a hand-built strip. */
function withPackBits(width: number, height: number, packed: number[]): Uint8Array {
  const base = encodeTiff(createImage(width, height, [0, 0, 0, 255]), { compression: 'none' });
  const view = new DataView(base.buffer);

  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);

  let stripOffsetEntry = -1;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const t = view.getUint16(entry, true);
    if (t === 259) view.setUint16(entry + 8, 32773, true); // Compression -> PackBits
    if (t === 273) stripOffsetEntry = entry;
    if (t === 279) view.setUint32(entry + 8, packed.length, true); // StripByteCounts
  }
  assert.ok(stripOffsetEntry > 0, 'StripOffsets not found');

  const stripAt = view.getUint32(stripOffsetEntry + 8, true);
  const out = new Uint8Array(stripAt + packed.length);
  out.set(base.subarray(0, stripAt));
  out.set(packed, stripAt);
  return out;
}

// --- encode -------------------------------------------------------------------------

/** A deterministic image with alpha and plenty of colour. */
function sample(width: number, height: number, alpha = 255): RawImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      img.data.set(
        [(x * 7 + y * 3) % 256, (x * 13) % 256, (x * x + y) % 256, alpha],
        (y * width + x) * 4,
      );
    }
  }
  return img;
}

test('encode round-trips byte-exactly, uncompressed and LZW', () => {
  // TIFF is lossless in both modes, so anything short of byte-exact is a bug.
  for (const compression of ['none', 'lzw'] as const) {
    const src = sample(23, 17);
    const round = decodeTiff(encodeTiff(src, { compression }));

    assert.equal(round.width, 23, compression);
    assert.equal(round.height, 17, compression);
    assert.deepEqual(Array.from(round.data), Array.from(src.data), compression);
  }
});

test('encode preserves alpha', () => {
  // Alpha IS supported here, unlike BMP: SamplesPerPixel 4 plus ExtraSamples 2
  // (unassociated / non-premultiplied), which is exactly how RawImage stores it.
  const src = createImage(8, 8);
  for (let i = 0; i < src.data.length; i += 4) src.data.set([200, 100, 50, (i * 3) % 256], i);

  for (const compression of ['none', 'lzw'] as const) {
    const round = decodeTiff(encodeTiff(src, { compression }));
    assert.deepEqual(Array.from(round.data), Array.from(src.data), compression);
  }
});

test('an opaque image is written as RGB, not RGBA', () => {
  // A wholly opaque alpha channel is a quarter of the file for no information.
  const bytes = encodeTiff(sample(8, 8));
  assert.equal(tag(bytes, 277), 3, 'SamplesPerPixel should be 3 for an opaque image');
  assert.equal(tag(bytes, 338), undefined, 'ExtraSamples should be absent without alpha');
});

test('an image with alpha is written as RGBA with ExtraSamples', () => {
  const src = sample(8, 8, 128);
  const bytes = encodeTiff(src);

  assert.equal(tag(bytes, 277), 4, 'SamplesPerPixel');
  assert.equal(tag(bytes, 338), 2, 'ExtraSamples 2: unassociated, non-premultiplied');
});

test('LZW is the default', () => {
  assert.equal(tag(encodeTiff(sample(16, 16)), 259), 5);
  assert.deepEqual(
    Array.from(encodeTiff(sample(16, 16))),
    Array.from(encodeTiff(sample(16, 16), { compression: 'lzw' })),
  );
});

test('LZW actually makes a compressible image smaller', () => {
  // Round-tripping through our own decoder would pass even if "LZW" wrote the bytes
  // straight through. A flat image has to compress hard.
  const flat = createImage(64, 64, [10, 20, 30, 255]);

  const none = encodeTiff(flat, { compression: 'none' }).length;
  const lzw = encodeTiff(flat, { compression: 'lzw' }).length;

  assert.ok(lzw < none / 4, `LZW gave ${lzw} bytes against ${none} uncompressed: it is not compressing`);
});

test('encode writes a minimal tag set and no metadata', () => {
  // No EXIF IFD, no ICC, no software tag -- which is what makes strip-metadata.md satisfied
  // by construction on this codec, as long as this never grows.
  const bytes = encodeTiff(sample(8, 8));

  assert.equal(bytes[0], 0x49, 'II: little-endian');
  assert.equal(bytes[1], 0x49);
  assert.equal(tag(bytes, 256), 8, 'ImageWidth');
  assert.equal(tag(bytes, 257), 8, 'ImageLength');
  assert.equal(tag(bytes, 262), 2, 'PhotometricInterpretation: RGB');
  assert.equal(tag(bytes, 317), undefined, 'no Predictor tag: we write predictor 1');
  assert.equal(tag(bytes, 34665), undefined, 'no EXIF IFD');
  assert.equal(tag(bytes, 34675), undefined, 'no ICC profile');
  assert.equal(tag(bytes, 305), undefined, 'no Software tag');
});

test('encode writes exactly one IFD', () => {
  // The next-IFD offset must be 0, or a reader goes hunting for a second page.
  const bytes = encodeTiff(sample(8, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  assert.equal(view.getUint32(ifd + 2 + count * 12, true), 0, 'next-IFD offset must be 0');
});

test('encode round-trips a range of sizes', () => {
  // Row padding, strip sizing and LZW bit alignment all depend on the exact dimensions.
  for (const width of [1, 2, 3, 7, 15, 31]) {
    for (const height of [1, 2, 5]) {
      const src = sample(width, height);
      const round = decodeTiff(encodeTiff(src));

      assert.equal(round.width, width, `${width}x${height}`);
      assert.equal(round.height, height, `${width}x${height}`);
      assert.deepEqual(Array.from(round.data), Array.from(src.data), `${width}x${height}`);
    }
  }
});

test('a 1x1 round-trips', () => {
  const round = decodeTiff(encodeTiff(createImage(1, 1, [200, 100, 50, 255])));
  assert.deepEqual(Array.from(round.data), [200, 100, 50, 255]);
});
