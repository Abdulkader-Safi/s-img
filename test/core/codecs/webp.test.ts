import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodeWebp, encodeWebp, probeWebp } from '../../../src/core/codecs/webp.ts';
import { CorruptImageError, SImgError } from '../../../src/core/errors.ts';
import { createImage } from '../../../src/core/image.ts';

// features/codec-webp.md. The only non-pure-JS codec, and the only one that can push the
// library past its size budget.
//
// No byte-for-byte comparison against ImageMagick on the LOSSY path: ImageMagick and we
// both call libwebp, so that test would be libwebp against itself and would pass however
// wrong our wiring was. The lossless fixtures do get one, because lossless means exact.

const DIR = new URL('../../fixtures/webp/', import.meta.url).pathname;
const load = (name: string) => new Uint8Array(readFileSync(`${DIR}${name}.webp`));
const expected = (name: string) => new Uint8ClampedArray(readFileSync(`${DIR}${name}.rgba`));

// --- probe: pure TypeScript, no WASM -------------------------------------------------

/** Every chunk type, because each stores its dimensions somewhere different. */
const PROBES: readonly (readonly [name: string, w: number, h: number, why: string])[] = [
  ['lossy', 24, 16, 'VP8: 14 bits in the keyframe header, after a 3-byte start code'],
  ['lossless', 24, 16, 'VP8L: 14 bits each, bit-packed after a 0x2f signature'],
  ['alpha', 24, 16, 'VP8L again, this time with alpha in use'],
  ['vp8x-alpha', 24, 16, 'VP8X: a 24-bit canvas size, stored MINUS ONE'],
  ['tiny-1x1', 1, 1, 'where "minus one" is zero, and a decoder reading 0 as absent breaks'],
];

for (const [name, w, h, why] of PROBES) {
  test(`probes ${name} without loading the WASM (${why})`, () => {
    assert.deepEqual(probeWebp(load(name)), { width: w, height: h });
  });
}

test('probe is synchronous and pure, so the size guard can run before any WASM exists', () => {
  // The reason probe is hand-written rather than delegated to libwebp: features/decode.md
  // must reject a hostile header BEFORE handing bytes to a WASM heap that grows in pages
  // and fails ungracefully. A probe that needed the module could not do that.
  const result = probeWebp(load('lossy'));
  assert.equal(typeof result.width, 'number');
  assert.ok(!(result instanceof Promise));
});

test('a truncated WebP is CORRUPT_IMAGE, not a crash', () => {
  for (const cut of [4, 12, 16, 20, 24]) {
    assert.throws(() => probeWebp(load('lossy').subarray(0, cut)), CorruptImageError, `cut at ${cut}`);
  }
});

test('a RIFF that is not a WebP is rejected', () => {
  // "RIFF" alone is also WAV and AVI. The sniffer checks bytes 8-11 for "WEBP", and probe
  // must not assume the sniffer ran.
  const wav = load('lossy').slice();
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  assert.throws(() => probeWebp(wav), CorruptImageError);
});

test('bytes that are not a RIFF at all are rejected', () => {
  // probe is exported and reachable without the sniffer, so it does its own container
  // check rather than trusting that someone else already did.
  const notRiff = load('lossy').slice();
  notRiff.set([0x4d, 0x4d, 0x00, 0x2a], 0); // a TIFF header
  assert.throws(() => probeWebp(notRiff), { name: 'CorruptImageError', message: /RIFF/ });
});

test('a truncated header says so, rather than reporting a nonsense chunk name', () => {
  // Without the length check the reads run past the end, produce "\0\0\0\0" as a fourcc,
  // and the file is reported as "not a RIFF container" -- which sends someone looking for
  // the wrong bug. Same error type, useless message.
  assert.throws(() => probeWebp(load('lossy').subarray(0, 12)), { name: 'CorruptImageError', message: /truncated/ });
});

test('a VP8L with a corrupt signature is rejected', () => {
  // 0x2f. Skip the check and the dimension bits are read from whatever follows.
  const bytes = load('lossless').slice();
  bytes[20] = 0x00;
  assert.throws(() => probeWebp(bytes), { name: 'CorruptImageError', message: /VP8L signature/ });
});

test('a VP8 scale hint does not leak into the width', () => {
  // The top 2 bits of each 16-bit field are a scaling hint, not part of the dimension.
  // Every fixture here is small enough that those bits are zero, so dropping the & 0x3fff
  // mask passes the whole suite -- this is the only test that fails.
  //
  // Hand-built rather than generated: ImageMagick has no way to ask libwebp for a scaled
  // frame header, and the bits are legal, so a real file with them set is rare and a
  // decoder that misreads them reports a width in the tens of thousands.
  const bytes = load('lossy').slice();
  bytes[27] = bytes[27]! | 0xc0; // both scale bits of the width
  bytes[29] = bytes[29]! | 0xc0; // and of the height
  assert.deepEqual(probeWebp(bytes), { width: 24, height: 16 }, 'the hint was read as part of the size');
});

test('an unknown chunk type is rejected rather than guessed at', () => {
  const bytes = load('lossy').slice();
  bytes.set([0x56, 0x50, 0x39, 0x20], 12); // "VP9 ", which does not exist
  assert.throws(() => probeWebp(bytes), CorruptImageError);
});

test('a VP8 frame with the wrong start code is rejected', () => {
  // 0x9d 0x01 0x2a. Without checking it, a corrupt file reads two arbitrary bytes as a
  // dimension and the size guard is handed a number that means nothing.
  const bytes = load('lossy').slice();
  bytes[23] = 0x00; // the start code sits at 20 + 3
  assert.throws(() => probeWebp(bytes), CorruptImageError);
});

// --- decode --------------------------------------------------------------------------

test('decodes a lossless WebP exactly as ImageMagick does', async () => {
  // Lossless, so this is a real byte target rather than libwebp checking its own work.
  const img = await decodeWebp(load('lossless'));
  assert.deepEqual([img.width, img.height], [24, 16]);
  assert.deepEqual(img.data, expected('lossless'));
});

test('decodes alpha natively, with nothing composited', async () => {
  // WebP has real alpha, unlike JPEG and BMP. 50% of 255 is 128 (ImageMagick rounds up).
  const img = await decodeWebp(load('alpha'));
  assert.deepEqual(img.data, expected('alpha'));
  assert.equal(img.data[3], 128, 'the alpha channel survived');
});

test('decodes a 1x1', async () => {
  const img = await decodeWebp(load('tiny-1x1'));
  assert.deepEqual([img.width, img.height], [1, 1]);
  assert.deepEqual(img.data, expected('tiny-1x1'));
});

test('decodes a lossy WebP to plausible pixels', async () => {
  // Not byte-compared, for the reason at the top. Asserted structurally instead: the right
  // size, opaque, and not the buffer of zeros a broken wiring would produce.
  const img = await decodeWebp(load('lossy'));
  assert.deepEqual([img.width, img.height], [24, 16]);
  assert.ok(img.data.some((v, i) => i % 4 !== 3 && v !== 0), 'decoded actual pixels');
  assert.ok([...img.data].filter((_, i) => i % 4 === 3).every((a) => a === 255), 'opaque');
});

test('decodes the extended VP8X form', async () => {
  const img = await decodeWebp(load('vp8x-alpha'));
  assert.deepEqual([img.width, img.height], [24, 16]);
  assert.ok(img.data[3]! < 255, 'the ALPH chunk was applied');
});

test('a corrupt WebP fails as CORRUPT_IMAGE rather than an emscripten abort', async () => {
  // libwebp inside a WASM heap does not throw an SImgError on its own, and a bare
  // emscripten abort escaping the boundary is exactly what errors.md forbids.
  const bytes = load('lossy').slice();
  bytes.fill(0xff, 30, 200);
  const err = await decodeWebp(bytes).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SImgError, `expected SImgError, got ${String(err)}`);
  assert.equal(err.code, 'CORRUPT_IMAGE');
});

// --- encode --------------------------------------------------------------------------

test('encodes and round-trips through our own decoder', async () => {
  const src = await decodeWebp(load('lossless'));
  const out = await encodeWebp(src, { lossless: true });
  const round = await decodeWebp(out);
  assert.deepEqual([round.width, round.height], [24, 16]);
  assert.deepEqual(round.data, src.data, 'lossless means lossless');
});

test('encodes lossless output that ImageMagick agrees with', async () => {
  // An outside reader, so "lossless" is not just our decoder agreeing with our encoder.
  const src = await decodeWebp(load('lossless'));
  const out = await encodeWebp(src, { lossless: true });
  assert.deepEqual([...out.subarray(0, 4)], [0x52, 0x49, 0x46, 0x46], 'a RIFF container');
  assert.deepEqual([...out.subarray(8, 12)], [0x57, 0x45, 0x42, 0x50], 'a WEBP');
  assert.deepEqual(probeWebp(out), { width: 24, height: 16 }, 'our own probe reads it back');
});

test('encodes alpha without compositing', async () => {
  const img = createImage(4, 4);
  img.data.fill(128); // half-transparent grey
  const round = await decodeWebp(await encodeWebp(img, { lossless: true }));
  assert.equal(round.data[3], 128, 'alpha survived the encoder');
});

test('quality changes the size, and lossless ignores it by throwing', async () => {
  const src = await decodeWebp(load('lossy'));
  const low = await encodeWebp(src, { quality: 20 });
  const high = await encodeWebp(src, { quality: 95 });
  assert.ok(low.length < high.length, `q20 ${low.length} vs q95 ${high.length}`);
});

test('lossless plus an explicit quality is INVALID_OPTION, not a silent ignore', async () => {
  // format-quality.md: if it is worth throwing over, it is worth being explicit about.
  // The alternative is an option that silently does nothing under another option.
  const img = createImage(2, 2);
  const err = await encodeWebp(img, { lossless: true, quality: 80 }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SImgError);
  assert.equal(err.code, 'INVALID_OPTION');
  // ...and each on its own is fine.
  assert.ok((await encodeWebp(img, { lossless: true })).length > 0);
  assert.ok((await encodeWebp(img, { quality: 80 })).length > 0);
});

test('encodes a 1x1', async () => {
  const one = createImage(1, 1);
  one.data.set([200, 100, 50, 255]);
  const round = await decodeWebp(await encodeWebp(one, { lossless: true }));
  assert.deepEqual([...round.data], [200, 100, 50, 255]);
});

test('quality outside 1-100 is INVALID_OPTION', async () => {
  for (const quality of [0, 101, -1, NaN]) {
    const err = await encodeWebp(createImage(2, 2), { quality }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof SImgError, `quality ${quality}`);
    assert.equal(err.code, 'INVALID_OPTION');
  }
});

// --- metadata: the one codec whose output bytes we do not write ----------------------

test('encoded WebP carries no EXIF and no ICC chunk', async () => {
  // strip-metadata.md's guarantee is an ASSUMPTION here until proven: libwebp can write
  // EXIF and ICCP chunks, and we are not the ones writing the bytes.
  const src = await decodeWebp(load('lossless'));
  const out = await encodeWebp(src, { quality: 80 });
  const text = Buffer.from(out).toString('latin1');
  for (const chunk of ['EXIF', 'ICCP', 'XMP ']) {
    assert.ok(!text.includes(chunk), `libwebp wrote a ${chunk} chunk`);
  }
});
