import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { decodePng, encodePng, probePng } from '../../../src/core/codecs/png.ts';
import { CorruptImageError } from '../../../src/core/errors.ts';
import { createImage, type RawImage } from '../../../src/core/image.ts';
import {
  ColourType,
  Filter,
  chunk,
  concat,
  ihdr,
  png,
  unfilteredScanlines,
  PNG_SIGNATURE,
} from './png-fixtures.ts';

// features/codec-png.md. The easiest format in pure JS, because DEFLATE is node:zlib.
// Built first because it gives the pipeline a lossless round-trip to test against:
// every later feature is verified without a JPEG's lossy noise in the way.

/** Every pixel of an image, as [r,g,b,a] tuples. */
function pixels(img: RawImage): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < img.data.length; i += 4) out.push(Array.from(img.data.subarray(i, i + 4)));
  return out;
}

// --- signature and container -------------------------------------------------------

test('rejects a file that is not a PNG', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), CorruptImageError);
});

test('rejects an empty file without reading past the end', () => {
  assert.throws(() => decodePng(new Uint8Array()), CorruptImageError);
});

test('decodes 8-bit truecolour alpha', () => {
  const bytes = png({
    width: 2,
    height: 2,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: unfilteredScanlines([
      [255, 0, 0, 255, 0, 255, 0, 255],
      [0, 0, 255, 255, 0, 0, 0, 0],
    ]),
  });

  const img = decodePng(bytes);

  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  assert.deepEqual(pixels(img), [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [0, 0, 0, 0],
  ]);
});

test('expands truecolour to RGBA with opaque alpha', () => {
  const bytes = png({
    width: 2,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Truecolour,
    scanlines: unfilteredScanlines([[255, 0, 0, 0, 255, 0]]),
  });

  assert.deepEqual(pixels(decodePng(bytes)), [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ]);
});

test('expands greyscale to RGBA', () => {
  const bytes = png({
    width: 3,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Greyscale,
    scanlines: unfilteredScanlines([[0, 128, 255]]),
  });

  assert.deepEqual(pixels(decodePng(bytes)), [
    [0, 0, 0, 255],
    [128, 128, 128, 255],
    [255, 255, 255, 255],
  ]);
});

test('expands greyscale+alpha to RGBA', () => {
  const bytes = png({
    width: 2,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.GreyscaleAlpha,
    scanlines: unfilteredScanlines([[128, 255, 64, 0]]),
  });

  assert.deepEqual(pixels(decodePng(bytes)), [
    [128, 128, 128, 255],
    [64, 64, 64, 0],
  ]);
});

// --- palette -----------------------------------------------------------------------

test('expands a palette image', () => {
  const plte = chunk('PLTE', new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]));
  const bytes = png({
    width: 3,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Palette,
    extra: [plte],
    scanlines: unfilteredScanlines([[2, 0, 1]]),
  });

  assert.deepEqual(pixels(decodePng(bytes)), [
    [0, 0, 255, 255],
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ]);
});

test('applies per-entry palette transparency from tRNS', () => {
  const plte = chunk('PLTE', new Uint8Array([255, 0, 0, 0, 255, 0]));
  const trns = chunk('tRNS', new Uint8Array([0, 128])); // entry 0 clear, entry 1 half
  const bytes = png({
    width: 2,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Palette,
    extra: [plte, trns],
    scanlines: unfilteredScanlines([[0, 1]]),
  });

  assert.deepEqual(pixels(decodePng(bytes)), [
    [255, 0, 0, 0],
    [0, 255, 0, 128],
  ]);
});

test('palette entries beyond tRNS are opaque', () => {
  // tRNS may be shorter than PLTE; the rest default to fully opaque.
  const plte = chunk('PLTE', new Uint8Array([1, 2, 3, 4, 5, 6]));
  const trns = chunk('tRNS', new Uint8Array([0]));
  const bytes = png({
    width: 2,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Palette,
    extra: [plte, trns],
    scanlines: unfilteredScanlines([[0, 1]]),
  });

  assert.deepEqual(pixels(decodePng(bytes)), [
    [1, 2, 3, 0],
    [4, 5, 6, 255],
  ]);
});

test('rejects a palette index past the end of the palette', () => {
  const plte = chunk('PLTE', new Uint8Array([255, 0, 0]));
  const bytes = png({
    width: 1,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Palette,
    extra: [plte],
    scanlines: unfilteredScanlines([[5]]),
  });

  assert.throws(() => decodePng(bytes), CorruptImageError);
});

test('rejects a palette image with no PLTE', () => {
  const bytes = png({
    width: 1,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.Palette,
    scanlines: unfilteredScanlines([[0]]),
  });

  assert.throws(() => decodePng(bytes), CorruptImageError);
});

// --- bit depths --------------------------------------------------------------------

test('unpacks 1-bit greyscale', () => {
  // 8 pixels in one byte: 10110010 -> black white white black white white black black
  const bytes = png({
    width: 8,
    height: 1,
    bitDepth: 1,
    colourType: ColourType.Greyscale,
    scanlines: unfilteredScanlines([[0b10110010]]),
  });

  assert.deepEqual(
    pixels(decodePng(bytes)).map((p) => p[0]),
    [255, 0, 255, 255, 0, 0, 255, 0],
  );
});

test('unpacks 2-bit greyscale and scales to 0-255', () => {
  // 4 pixels per byte. Values 0..3 scale to 0, 85, 170, 255.
  const bytes = png({
    width: 4,
    height: 1,
    bitDepth: 2,
    colourType: ColourType.Greyscale,
    scanlines: unfilteredScanlines([[0b00011011]]),
  });

  assert.deepEqual(
    pixels(decodePng(bytes)).map((p) => p[0]),
    [0, 85, 170, 255],
  );
});

test('unpacks 4-bit greyscale and scales to 0-255', () => {
  const bytes = png({
    width: 2,
    height: 1,
    bitDepth: 4,
    colourType: ColourType.Greyscale,
    scanlines: unfilteredScanlines([[0x0f]]),
  });

  assert.deepEqual(
    pixels(decodePng(bytes)).map((p) => p[0]),
    [0, 255],
  );
});

test('truncates 16-bit to 8', () => {
  // features/raw-image.md: a documented, deliberate loss.
  const bytes = png({
    width: 2,
    height: 1,
    bitDepth: 16,
    colourType: ColourType.Greyscale,
    scanlines: unfilteredScanlines([[0xff, 0xff, 0x80, 0x00]]),
  });

  assert.deepEqual(
    pixels(decodePng(bytes)).map((p) => p[0]),
    [255, 128],
  );
});

test('a sub-byte row does not bleed into the next row', () => {
  // Each scanline starts on a byte boundary. A 3-pixel 1-bit image uses 3 bits and
  // pads the remaining 5; reading them as pixels is the classic bug here.
  const bytes = png({
    width: 3,
    height: 2,
    bitDepth: 1,
    colourType: ColourType.Greyscale,
    scanlines: unfilteredScanlines([[0b10100000], [0b01000000]]),
  });

  const img = decodePng(bytes);
  assert.equal(img.width, 3);
  assert.equal(img.height, 2);
  assert.deepEqual(
    pixels(img).map((p) => p[0]),
    [255, 0, 255, 0, 255, 0],
  );
});

// --- filters -----------------------------------------------------------------------

test('undoes every scanline filter', () => {
  // The filter loop is the one genuinely fiddly part of PNG decoding: a per-byte loop
  // with a data dependency on the previous pixel and the previous row. Each filter
  // below encodes the same 2x2 image a different way, so all five must agree.
  const expected = [
    [10, 20, 30, 255],
    [40, 50, 60, 255],
    [70, 80, 90, 255],
    [100, 110, 120, 255],
  ];

  const raw = [
    [10, 20, 30, 255, 40, 50, 60, 255],
    [70, 80, 90, 255, 100, 110, 120, 255],
  ];

  for (const [name, filter] of Object.entries(Filter)) {
    const bytes = png({
      width: 2,
      height: 2,
      bitDepth: 8,
      colourType: ColourType.TruecolourAlpha,
      scanlines: filterRows(raw, filter),
    });

    assert.deepEqual(pixels(decodePng(bytes)), expected, `filter ${name} did not round-trip`);
  }
});

/** Apply a PNG filter to raw rows, producing filter-prefixed scanlines. */
function filterRows(rows: number[][], filter: number): Uint8Array {
  const bpp = 4;
  const out: Uint8Array[] = [];
  let prior = new Array<number>(rows[0]!.length).fill(0);

  for (const row of rows) {
    const filtered = new Uint8Array(row.length + 1);
    filtered[0] = filter;

    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prior[i]!;
      const c = i >= bpp ? prior[i - bpp]! : 0;
      let value: number;

      switch (filter) {
        case Filter.None:
          value = row[i]!;
          break;
        case Filter.Sub:
          value = row[i]! - a;
          break;
        case Filter.Up:
          value = row[i]! - b;
          break;
        case Filter.Average:
          value = row[i]! - Math.floor((a + b) / 2);
          break;
        case Filter.Paeth:
          value = row[i]! - paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown filter ${filter}`);
      }
      filtered[i + 1] = value & 0xff;
    }

    out.push(filtered);
    prior = row;
  }
  return concat(out);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

test('rejects an unknown filter type', () => {
  const bytes = png({
    width: 1,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: new Uint8Array([9, 1, 2, 3, 4]), // filter 9 does not exist
  });

  assert.throws(() => decodePng(bytes), CorruptImageError);
});

// --- chunks ------------------------------------------------------------------------

test('concatenates IDAT split across many chunks', () => {
  // Normal and common: the DEFLATE stream spans them, so each chunk cannot be
  // inflated separately.
  const bytes = png({
    width: 8,
    height: 8,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: unfilteredScanlines(
      Array.from({ length: 8 }, () => Array.from({ length: 32 }, (_, i) => i * 7)),
    ),
    idatChunks: 5,
  });

  const img = decodePng(bytes);
  assert.equal(img.width, 8);
  assert.equal(img.data[0], 0);
  assert.equal(img.data[1], 7);
});

test('ignores ancillary chunks and anything after IEND', () => {
  const base = png({
    width: 1,
    height: 1,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: unfilteredScanlines([[1, 2, 3, 4]]),
    extra: [chunk('tEXt', new TextEncoder().encode('Comment\0hello'))],
  });

  const withTrailer = concat([base, new TextEncoder().encode('junk after the image')]);
  assert.deepEqual(pixels(decodePng(withTrailer)), [[1, 2, 3, 4]]);
});

test('rejects a corrupt CRC', () => {
  // A flipped bit is the difference between "this file is corrupt" and silently
  // editing garbage.
  //
  // The corruption goes in the IDAT payload, and the assertion names the checksum.
  // The first version of this test flipped a bit in IHDR's *height*, which throws for
  // an unrelated reason -- deleting the CRC check entirely failed zero tests. A test
  // that passes because something else happens to throw is worse than no test.
  const bytes = png({
    width: 4,
    height: 4,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: unfilteredScanlines(Array.from({ length: 4 }, () => new Array(16).fill(128))),
  });

  // Signature (8) + IHDR chunk (12 + 13 data) puts IDAT's length field at 33, its type
  // at 37, and its deflate payload at 41. Corrupt a byte in the middle of that payload:
  // only the CRC can notice. Picking an offset by eye lands in IEND's length field and
  // throws "chunk runs past the end" instead, which is how the first attempt at this
  // fix failed.
  const idatData = 8 + 12 + 13 + 8;
  const corrupt = bytes.slice();
  const at = idatData + 4;
  assert.ok(at < bytes.length - 12, 'the target must be inside IDAT, not IEND');
  corrupt[at] = corrupt[at]! ^ 0x40;

  assert.throws(
    () => decodePng(corrupt),
    (e: unknown) =>
      e instanceof CorruptImageError && /checksum|damaged/i.test(e.message),
    'must fail on the checksum specifically, not incidentally',
  );
});

test('rejects a file with no IDAT', () => {
  const bytes = concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr({ width: 1, height: 1, bitDepth: 8, colourType: ColourType.TruecolourAlpha }),
    chunk('IEND'),
  ]);

  assert.throws(() => decodePng(bytes), CorruptImageError);
});

test('rejects a truncated deflate stream', () => {
  const good = png({
    width: 4,
    height: 4,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: unfilteredScanlines(Array.from({ length: 4 }, () => new Array(16).fill(200))),
  });

  assert.throws(() => decodePng(good.subarray(0, good.length - 20)), CorruptImageError);
});

test('rejects scanline data shorter than the header promises', () => {
  // Inflates fine, but there are not enough rows. Must not return a half image with
  // garbage at the bottom: a truncated file silently saved over the original is data
  // loss. The assertion names the shortfall, because without it the decoder throws
  // "unknown filter type undefined" from reading past the end -- right outcome, wrong
  // reason, and it left the length guard untested.
  const bytes = concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr({ width: 2, height: 10, bitDepth: 8, colourType: ColourType.TruecolourAlpha }),
    chunk('IDAT', deflateSync(unfilteredScanlines([[1, 2, 3, 4, 5, 6, 7, 8]]))),
    chunk('IEND'),
  ]);

  assert.throws(
    () => decodePng(bytes),
    (e: unknown) => e instanceof CorruptImageError && /short|expected \d+ bytes/i.test(e.message),
    'must report the shortfall, not stumble into a filter error',
  );
});

// --- interlace ---------------------------------------------------------------------

test('decodes an Adam7 interlaced image', () => {
  // Seven passes with their own strides. Annoying, real, and a decoder that chokes on
  // it is a bug report waiting.
  const width = 8;
  const height = 8;
  const expected: number[][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) expected.push([x * 16, y * 16, 0, 255]);
  }

  assert.deepEqual(pixels(decodePng(adam7Png(width, height, expected))), expected);
});

/** Build an interlaced PNG by laying pixels into the seven Adam7 passes. */
function adam7Png(width: number, height: number, rgba: number[][]): Uint8Array {
  const PASSES = [
    { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
    { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
    { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
    { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
    { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
    { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
    { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
  ];

  const rows: Uint8Array[] = [];
  for (const { xStart, yStart, xStep, yStep } of PASSES) {
    for (let y = yStart; y < height; y += yStep) {
      const row: number[] = [];
      for (let x = xStart; x < width; x += xStep) row.push(...rgba[y * width + x]!);
      if (row.length > 0) rows.push(new Uint8Array([0, ...row]));
    }
  }

  return concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr({ width, height, bitDepth: 8, colourType: ColourType.TruecolourAlpha, interlace: 1 }),
    chunk('IDAT', deflateSync(concat(rows))),
    chunk('IEND'),
  ]);
}

test('rejects an unknown interlace method', () => {
  const bytes = concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr({ width: 1, height: 1, bitDepth: 8, colourType: ColourType.TruecolourAlpha, interlace: 7 }),
    chunk('IDAT', deflateSync(unfilteredScanlines([[1, 2, 3, 4]]))),
    chunk('IEND'),
  ]);

  assert.throws(() => decodePng(bytes), CorruptImageError);
});

// --- probe -------------------------------------------------------------------------

test('probe reads dimensions without decoding pixels', () => {
  // decode.md's size guard runs off this, before allocating anything.
  const bytes = png({
    width: 640,
    height: 480,
    bitDepth: 8,
    colourType: ColourType.TruecolourAlpha,
    scanlines: unfilteredScanlines(
      Array.from({ length: 480 }, () => new Array(640 * 4).fill(1)),
    ),
  });

  assert.deepEqual(probePng(bytes), { width: 640, height: 480 });
});

test('probe rejects a non-PNG', () => {
  assert.throws(() => probePng(new Uint8Array([1, 2, 3])), CorruptImageError);
});

test('rejects a zero dimension in IHDR', () => {
  const bytes = concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr({ width: 0, height: 5, bitDepth: 8, colourType: ColourType.TruecolourAlpha }),
    chunk('IEND'),
  ]);

  assert.throws(() => probePng(bytes), CorruptImageError);
});

test('rejects a bit depth the colour type does not allow', () => {
  // Truecolour is 8 or 16 only. 1-bit truecolour is not a thing.
  const bytes = concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr({ width: 1, height: 1, bitDepth: 1, colourType: ColourType.Truecolour }),
    chunk('IEND'),
  ]);

  assert.throws(() => probePng(bytes), CorruptImageError);
});

// --- encode ------------------------------------------------------------------------

test('encode produces a PNG our own decoder reads back byte-exactly', () => {
  const src = createImage(16, 9);
  for (let i = 0; i < src.data.length; i++) src.data[i] = (i * 37) % 256;

  const round = decodePng(encodePng(src));

  assert.equal(round.width, 16);
  assert.equal(round.height, 9);
  assert.deepEqual(Array.from(round.data), Array.from(src.data), 'PNG is lossless');
});

test('encode produces a PNG that zlib and the spec agree with', () => {
  // Checks the container independently of our decoder: signature, chunk order, and
  // that the IDAT payload is a real zlib stream.
  const bytes = encodePng(createImage(2, 2, [1, 2, 3, 4]));

  assert.deepEqual(Array.from(bytes.subarray(0, 8)), PNG_SIGNATURE);
  assert.deepEqual(Array.from(bytes.subarray(12, 16)), Array.from(new TextEncoder().encode('IHDR')));
  assert.deepEqual(Array.from(bytes.subarray(-8, -4)), Array.from(new TextEncoder().encode('IEND')));
});

test('encode round-trips transparency', () => {
  const src = createImage(2, 1, [255, 0, 0, 0]);
  assert.deepEqual(pixels(decodePng(encodePng(src))), [
    [255, 0, 0, 0],
    [255, 0, 0, 0],
  ]);
});

test('encode round-trips a 1x1', () => {
  const src = createImage(1, 1, [9, 8, 7, 6]);
  assert.deepEqual(pixels(decodePng(encodePng(src))), [[9, 8, 7, 6]]);
});

test('encode round-trips extreme aspect ratios', () => {
  for (const [w, h] of [
    [1, 300],
    [300, 1],
  ] as const) {
    const src = createImage(w, h, [4, 5, 6, 255]);
    const round = decodePng(encodePng(src));
    assert.equal(round.width, w);
    assert.equal(round.height, h);
    assert.deepEqual(Array.from(round.data), Array.from(src.data));
  }
});

test('encode writes no metadata chunks', () => {
  // features/strip-metadata.md: stripping is the default here, by construction. The
  // encoder writes IHDR, IDAT, IEND and nothing else.
  const bytes = encodePng(createImage(4, 4, [1, 2, 3, 4]));
  const text = new TextDecoder('latin1').decode(bytes);

  for (const ancillary of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'pHYs', 'gAMA', 'tIME']) {
    assert.ok(!text.includes(ancillary), `encoder must not write ${ancillary}`);
  }
});

test('encoded output is meaningfully compressed', () => {
  // A flat image should compress hard. If the filter or deflate level regressed, this
  // is where it shows.
  const src = createImage(200, 200, [7, 7, 7, 255]);
  const bytes = encodePng(src);

  assert.ok(
    bytes.length < src.data.length / 50,
    `expected heavy compression, got ${bytes.length} bytes from ${src.data.length}`,
  );
});
