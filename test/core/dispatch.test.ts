import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decode, encode } from '../../src/core/dispatch.ts';
import { SImgError } from '../../src/core/errors.ts';
import { createImage, type RawImage } from '../../src/core/image.ts';
import { maxLongEdge as capLongEdge } from '../../src/core/transform/resize.ts';
import { encodeBmp } from '../../src/core/codecs/bmp.ts';
import { decodeJpeg, encodeJpeg, readExifOrientation } from '../../src/core/codecs/jpeg.ts';
import { rotate90 } from '../../src/core/transform/rotate90.ts';
import { encodePng } from '../../src/core/codecs/png.ts';
import type { Format } from '../../src/core/formats.ts';

// features/decode.md and features/encode.md. Two views of one dispatch table: sniff the
// format, guard the size, call the codec. The interesting code here is the boundary --
// the size guard and the EXIF orientation -- not the switch.

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const read = (path: string) => new Uint8Array(readFileSync(`${FIXTURES}${path}`));

/** Assert an SImgError with a specific code, and return it for further inspection. */
async function rejects(fn: () => Promise<unknown>, code: string): Promise<SImgError> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SImgError, `expected an SImgError, got ${String(err)}`);
  assert.equal(err.code, code);
  return err;
}

// --- dispatch -----------------------------------------------------------------------

/** One real file per pure-TS codec, with the dimensions its own fixtures already pin. */
const FILES: readonly (readonly [format: Format, path: string, w: number, h: number])[] = [
  ['png', 'png/rgba8.png', 16, 16],
  ['jpeg', 'jpeg/s420.jpg', 32, 32],
  ['gif', 'gif/basic.gif', 32, 32],
  ['bmp', 'bmp/rgb24.bmp', 16, 16],
  ['tiff', 'tiff/rgb-none.tif', 16, 16],
  ['webp', 'webp/lossless.webp', 24, 16],
];

for (const [format, path, width, height] of FILES) {
  test(`decode dispatches ${format} on magic bytes alone`, async () => {
    const img = await decode(read(path));
    assert.equal(img.width, width);
    assert.equal(img.height, height);
    // Not a buffer of zeros: the codec really ran.
    assert.ok(img.data.some((v, i) => i % 4 !== 3 && v !== 0), 'decoded pixels');
  });
}

test('decode trusts the header over any caller-supplied name or extension', async () => {
  // The whole point of sniffing. A vault holds `.png` files that are really JPEGs; decode
  // never sees the filename, so the JPEG magic is all there is and it must win.
  const img = await decode(read('jpeg/s420.jpg'));
  assert.equal(img.width, 32);
});

test('decode rejects bytes that match no signature', async () => {
  const err = await rejects(() => decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), 'UNSUPPORTED_FORMAT');
  assert.match(err.message, /01 02 03/, 'the error shows the bytes we saw');
});

test('decode rejects an empty input without the magic-byte read throwing', async () => {
  await rejects(() => decode(new Uint8Array(0)), 'UNSUPPORTED_FORMAT');
});

test('decode surfaces a recognised-but-broken file as CORRUPT_IMAGE, not UNSUPPORTED_FORMAT', async () => {
  // The sniff is a first pass; the codec's header parse is the real validation. Keeping
  // these two errors distinct is the reason the split exists at all: "we cannot read this
  // kind of file" and "this file is damaged" send a user to different places.
  const truncated = read('png/rgba8.png').subarray(0, 20);
  await rejects(() => decode(truncated), 'CORRUPT_IMAGE');
});

test('decode ignores trailing bytes after the image', async () => {
  // Common and harmless: appended thumbnails, junk from a bad exporter.
  const padded = new Uint8Array([...read('png/rgba8.png'), ...new Array(64).fill(0xab)]);
  const img = await decode(padded);
  assert.equal(img.width, 16);
});

// --- the format escape hatch --------------------------------------------------------

test('decode accepts opts.format when it agrees with the header', async () => {
  const img = await decode(read('png/rgba8.png'), { format: 'png' });
  assert.equal(img.width, 16);
});

test('decode throws FORMAT_MISMATCH when opts.format contradicts the header', async () => {
  // Neither one silently wins. A caller forcing a codec against the header is doing
  // something exotic enough to deserve the error first.
  const err = await rejects(() => decode(read('png/rgba8.png'), { format: 'jpeg' }), 'FORMAT_MISMATCH');
  assert.match(err.message, /jpeg/);
  assert.match(err.message, /png/);
});

test('decode throws FORMAT_MISMATCH rather than UNSUPPORTED_FORMAT when the header is unknown', async () => {
  // opts.format cannot rescue bytes we failed to identify: forcing a codec at unknown
  // bytes is exactly the case where the mismatch is worth saying out loud.
  await rejects(() => decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { format: 'png' }), 'FORMAT_MISMATCH');
});

// --- the size guard, the trust boundary ---------------------------------------------

test('decode throws IMAGE_TOO_LARGE on a hostile header, before allocating', async () => {
  // A 30-byte BMP header claiming 60000x60000 is 14.4 GB of RGBA. A decoder that
  // allocates first and validates second is a one-line denial of service against anyone
  // who opens an attachment folder.
  const bmp = read('bmp/rgb24.bmp').slice();
  const view = new DataView(bmp.buffer, bmp.byteOffset);
  view.setInt32(18, 60000, true); // width
  view.setInt32(22, 60000, true); // height

  const before = process.memoryUsage().heapTotal;
  const err = await rejects(() => decode(bmp), 'IMAGE_TOO_LARGE');
  const growth = process.memoryUsage().heapTotal - before;

  assert.match(err.message, /60000/);
  // The guard is worthless if it throws *after* the allocation it exists to prevent.
  assert.ok(growth < 100 * 1024 * 1024, `heap grew ${Math.round(growth / 1e6)} MB`);
});

test('decode honours a custom maxPixels', async () => {
  const err = await rejects(() => decode(read('png/rgba8.png'), { maxPixels: 100 }), 'IMAGE_TOO_LARGE');
  assert.match(err.message, /100/);
  // ...and the same file passes under the default.
  assert.equal((await decode(read('png/rgba8.png'))).width, 16);
});

test('the size guard admits an image of exactly maxPixels', async () => {
  // "Refuse to allocate LARGER than this", so the cap itself is allowed. Off by one here
  // and a caller who sizes maxPixels to their own buffer gets a rejection on the exact
  // image they provisioned for.
  const img = await decode(read('png/rgba8.png'), { maxPixels: 16 * 16 });
  assert.equal(img.width, 16);
  await rejects(() => decode(read('png/rgba8.png'), { maxPixels: 16 * 16 - 1 }), 'IMAGE_TOO_LARGE');
});

test('the size guard measures the declared header, not the decoded result', async () => {
  // maxLongEdge shrinks the output, so a guard applied to the *result* would let a
  // hostile header through whenever the caller happened to ask for a preview.
  const bmp = read('bmp/rgb24.bmp').slice();
  const view = new DataView(bmp.buffer, bmp.byteOffset);
  view.setInt32(18, 60000, true);
  view.setInt32(22, 60000, true);
  await rejects(() => decode(bmp, { hintMaxLongEdge: 64 }), 'IMAGE_TOO_LARGE');
});

// --- EXIF orientation ---------------------------------------------------------------

// The reason decode exists as a layer rather than a re-export of the codecs. An iPhone
// stores a landscape JPEG with a tag saying "rotate 90"; ignore it and every phone photo
// is sideways and the user's crop coordinates mean nothing.
const ORIENTATIONS: readonly (readonly [name: string, why: string])[] = [
  ['orient-1', 'no transform'],
  ['orient-2', 'mirror horizontal'],
  ['orient-3', 'rotate 180'],
  ['orient-4', 'mirror vertical'],
  ['orient-5', 'transpose: mirror then rotate 270'],
  ['orient-6', 'rotate 90 CW, what an iPhone writes held upright'],
  ['orient-7', 'transverse: mirror then rotate 90'],
  ['orient-8', 'rotate 270 CW'],
  ['orient-6-mm', 'orientation 6 in a big-endian EXIF block, as iPhones write it'],
];

for (const [name, why] of ORIENTATIONS) {
  test(`decode applies EXIF orientation: ${name}, ${why}`, async () => {
    const img = await decode(read(`exif/${name}.jpg`));
    const expected = read(`exif/${name}.rgba`);

    // The .rgba is ImageMagick's own -auto-orient output, so this is a real comparison
    // against how the rest of the world reads the tag, not against our own arithmetic.
    assert.equal(img.data.length, expected.length, 'pixel buffer size');
    assert.deepEqual(img.data, new Uint8ClampedArray(expected));
  });
}

test('decode swaps the dimensions for the orientations that rotate', async () => {
  // The single most visible half of the tag, and the half a wrong transform still passes
  // if the fixture is square. These are stored 24x16.
  for (const n of [1, 2, 3, 4]) {
    const img = await decode(read(`exif/orient-${n}.jpg`));
    assert.deepEqual([img.width, img.height], [24, 16], `orientation ${n}`);
  }
  for (const n of [5, 6, 7, 8]) {
    const img = await decode(read(`exif/orient-${n}.jpg`));
    assert.deepEqual([img.width, img.height], [16, 24], `orientation ${n}`);
  }
});

test('no non-JPEG format carries an orientation the EXIF reader can see', async () => {
  // Why decode's orientation step is guarded on 'jpeg'. The guard is for cost and clarity
  // and NOT for behaviour: readExifOrientation parses JPEG APP1 markers, so on any other
  // container it finds nothing and reports 1, and applying it would be a no-op.
  //
  // Worth pinning, because TIFF has an Orientation tag of its own -- the same tag number,
  // 274, in its IFD rather than in an APP1 -- and it would be easy to assume this code
  // path already covers it. It does not. See features/index.md.
  for (const path of ['png/rgba8.png', 'gif/basic.gif', 'bmp/rgb24.bmp', 'tiff/rgb-none.tif']) {
    assert.equal(readExifOrientation(read(path)), 1, path);
  }
});

test('decode ignores an out-of-range orientation rather than throwing', async () => {
  // Real files carry 0 and 9. Neither is a reason to refuse a photo the user can see.
  const bytes = read('exif/orient-6.jpg').slice();
  const at = bytes.indexOf(0x45); // the "E" of "Exif"
  bytes[at + 24] = 9; // the entry's inline value: 6 for "Exif\0\0" + 18 into the TIFF block
  const img = await decode(bytes);
  assert.deepEqual([img.width, img.height], [24, 16], 'left as stored');
});

test('decode applies orientation before the cap, so the cap lands on the displayed edge', async () => {
  // Order matters: 24x16 tagged "rotate 90" displays as 16x24, whose long edge is the 24.
  //
  // Dimensions alone CANNOT catch the wrong order here, which is the trap: a 90 degree
  // rotation is a transpose, so capping first and rotating after lands on the same 8x12 for
  // every cap value. Only the pixels differ (51 of 384 channels, by 1, from resampling on
  // the untransposed grid). So this hand-composes the three steps from primitives the
  // dispatcher does not own -- the codec, rotate90, and the cap -- and asserts the
  // dispatcher agrees. Comparing dispatch against dispatch would compare an order to
  // itself and pass whatever the order was.
  //
  // Composed rather than compared against a full-resolution decode, which is what this used
  // to do: a hint of 12 on a 24px source now scales during the DCT, and DCT downsampling is
  // not bilinear downsampling, so the pixels legitimately differ by ~7 and the assertion
  // went red. A tolerance would not save it -- the wrong ORDER only moves 51 channels by 1,
  // so any tolerance loose enough to admit the DCT difference admits the bug too.
  const bytes = read('exif/orient-6.jpg');
  const capped = await decode(bytes, { hintMaxLongEdge: 12 });
  const expected = capLongEdge(rotate90(decodeJpeg(bytes, { hintMaxLongEdge: 12 }), 90), 12);

  assert.deepEqual([capped.width, capped.height], [8, 12]);
  assert.deepEqual(readExifOrientation(bytes), 6, 'the fixture stopped being the one this composes by hand');
  assert.deepEqual(capped.data, expected.data);
});

// --- maxLongEdge --------------------------------------------------------------------

test('decode caps the long edge when asked', async () => {
  const img = await decode(read('jpeg/s420.jpg'), { hintMaxLongEdge: 16 });
  assert.deepEqual([img.width, img.height], [16, 16]);
});

test('decode leaves an image already under maxLongEdge alone', async () => {
  const img = await decode(read('jpeg/s420.jpg'), { hintMaxLongEdge: 4096 });
  assert.deepEqual([img.width, img.height], [32, 32]);
});

// --- encode -------------------------------------------------------------------------

for (const [format] of FILES) {
  test(`encode ${format} produces bytes decode can read back`, async () => {
    const src = await decode(read('png/rgba8.png'));
    const bytes = await encode(src, format);
    const round = await decode(bytes);

    assert.deepEqual([round.width, round.height], [src.width, src.height]);
  });

  test(`encode ${format} round-trips a 1x1`, async () => {
    // JPEG's MCU padding and GIF's LZW minimum code size both have degenerate paths at
    // this size, and both are easy to get wrong.
    const one = createImage(1, 1);
    one.data.set([200, 100, 50, 255]);
    const round = await decode(await encode(one, format));
    assert.deepEqual([round.width, round.height], [1, 1]);
  });
}

test('encode rejects a format it does not know', async () => {
  await rejects(() => encode(createImage(2, 2), 'heic' as Format), 'UNSUPPORTED_FORMAT');
});

test('encode wraps a codec failure in ENCODE_FAILED with the cause attached', async () => {
  // Never let a raw RangeError from a typed-array write escape the boundary.
  const broken: RawImage = { width: 4, height: 4, data: new Uint8ClampedArray(2) };
  const err = await rejects(() => encode(broken, 'png'), 'ENCODE_FAILED');
  assert.ok(err.cause instanceof Error, 'the original error survives as `cause`');
});

test('encode lets a codec\'s own option error through instead of burying it in ENCODE_FAILED', async () => {
  // The codecs validate their options and throw InvalidOptionError. Wrapping that in
  // ENCODE_FAILED would trade a precise "quality must be 1-100" for a vague "encoding
  // failed", which is the error a user can do least with.
  const img = createImage(4, 4);
  await rejects(() => encode(img, 'jpeg', { quality: 0 }), 'INVALID_OPTION');
  await rejects(() => encode(img, 'jpeg', { quality: 101 }), 'INVALID_OPTION');
  await rejects(() => encode(img, 'gif', { colors: 1 }), 'INVALID_OPTION');
});

test('encode composites transparency onto white for the formats with no alpha', async () => {
  const img = createImage(4, 4); // createImage zeroes, so this is fully transparent
  for (const format of ['jpeg', 'bmp'] as const) {
    const round = await decode(await encode(img, format));
    assert.deepEqual(
      [...round.data.subarray(0, 4)],
      [255, 255, 255, 255],
      `${format} defaults transparency to white`,
    );
  }
});

test('encode honours the background colour when flattening', async () => {
  const img = createImage(4, 4);
  const round = await decode(await encode(img, 'bmp', { background: [255, 0, 0, 255] }));
  assert.deepEqual([...round.data.subarray(0, 4)], [255, 0, 0, 255]);
});

test('encode passes format options through to the codec', async () => {
  // The dispatch layer must not swallow the options: same image, two qualities, and the
  // low one has to be meaningfully smaller or nothing is reaching the encoder.
  const img = await decode(read('jpeg/photo.jpg'));
  const high = await encode(img, 'jpeg', { quality: 95 });
  const low = await encode(img, 'jpeg', { quality: 20 });
  assert.ok(low.length < high.length * 0.6, `q20 ${low.length} vs q95 ${high.length}`);
});

test('encode returns a Uint8Array, not a Buffer', async () => {
  // The core stays runtime-neutral; the fs boundary converts if it wants to. Buffer IS a
  // Uint8Array, so this needs the stricter check.
  const bytes = await encode(createImage(2, 2), 'png');
  assert.equal(bytes.constructor, Uint8Array);
});

// --- the pair -----------------------------------------------------------------------

test('decode then encode converts between formats with no source format left over', async () => {
  // The thing that makes conversion fall out for free: after the decode boundary, the
  // source format does not exist.
  const tiff = await decode(read('tiff/rgb-none.tif'));
  const asPng = await decode(await encode(tiff, 'png'));
  assert.deepEqual(asPng.data, tiff.data, 'lossless the whole way');
});

test('encode drops the EXIF orientation it applied on decode', async () => {
  // Carrying the tag forward would double-rotate: decode already baked the rotation into
  // the pixels, so a viewer applying the tag again would turn the photo a second time.
  const img = await decode(read('exif/orient-6.jpg'));
  const bytes = await encode(img, 'jpeg');
  for (let i = 0; i + 1 < bytes.length; i++) {
    assert.ok(!(bytes[i] === 0xff && bytes[i + 1] === 0xe1), `an APP1/EXIF segment at ${i}`);
  }
  assert.deepEqual([img.width, img.height], [16, 24], 'the rotation is in the pixels instead');
});

// --- guards against the codecs drifting apart ---------------------------------------

test('every format in FORMATS round-trips through the dispatch table', async () => {
  // A new codec added to FORMATS but not wired into the table would otherwise fail only
  // at the call site that happened to ask for it.
  const img = createImage(4, 4);
  img.data.fill(128);
  for (const format of FILES.map(([f]) => f)) {
    const bytes = await encode(img, format);
    assert.ok(bytes.length > 0, format);
  }
});

test('the sniffer and the codecs agree: each encoder emits bytes its own signature matches', async () => {
  // encodeBmp/encodeJpeg/encodePng called directly, so this fails if a codec's output
  // ever stops matching the magic bytes the sniffer looks for.
  const img = createImage(4, 4);
  const cases = [
    ['png', encodePng(img)],
    ['jpeg', encodeJpeg(img)],
    ['bmp', encodeBmp(img)],
  ] as const;
  for (const [format, bytes] of cases) {
    const round = await decode(bytes);
    assert.ok(round.width === 4, `${format} decoded back through the sniffer`);
  }
});
