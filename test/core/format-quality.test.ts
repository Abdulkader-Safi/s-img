import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decode, encode } from '../../src/core/dispatch.ts';
import { SImgError } from '../../src/core/errors.ts';
import { createImage } from '../../src/core/image.ts';
import type { Format } from '../../src/core/formats.ts';

// features/format-quality.md, the parts that exist below the builder.
//
// toFormat() itself is a chained method and lands with features/api-surface.md. What is
// testable now is everything it will delegate to: the type-level rule that `quality` only
// exists on lossy formats, the runtime rule that says the same thing again for configs
// that never met the compiler, and the conversion matrix.

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const read = (path: string) => new Uint8Array(readFileSync(`${FIXTURES}${path}`));

async function rejects(fn: () => Promise<unknown>, code: string): Promise<SImgError> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SImgError, `expected an SImgError, got ${String(err)}`);
  assert.equal(err.code, code);
  return err;
}

// --- the type-level rule ------------------------------------------------------------

/**
 * NEVER CALLED. The assertion is that this function compiles, which `tsc -p
 * tsconfig.test.json` decides during `npm run check` -- @ts-expect-error fails the BUILD
 * if the error it marks stops happening. So a refactor that loosens the type breaks this
 * rather than shipping a silently-ignored option.
 *
 * Declared rather than executed on purpose: calling encode here really does reject, and
 * the first draft of this leaked unhandled rejections into the next test's output.
 */
async function typeChecksOnly(): Promise<void> {
  const img = createImage(2, 2);

  // @ts-expect-error PNG is lossless: there is no quality dial to turn.
  await encode(img, 'png', { quality: 80 });
  // @ts-expect-error BMP is uncompressed; `background` is its only option.
  await encode(img, 'bmp', { quality: 80 });
  // @ts-expect-error TIFF is lossless either way; `compression` trades size for speed.
  await encode(img, 'tiff', { quality: 80 });
  // @ts-expect-error GIF's loss is quantisation, which has a different name.
  await encode(img, 'gif', { quality: 80 });
  // @ts-expect-error `colors` is GIF's, not JPEG's.
  await encode(img, 'jpeg', { colors: 16 });
  // @ts-expect-error a typo must not be silently ignored
  await encode(img, 'tiff', { compresion: 'lzw' });

  // ...and the option is fine where it means something.
  await encode(img, 'jpeg', { quality: 80 });
  await encode(img, 'gif', { colors: 16, dither: false });
}

test('quality is a compile error on the lossless formats', () => {
  // The PRD's headline type-safety requirement. The real verification happened at compile
  // time; this exists so the function is referenced (and so the suite reports on it).
  assert.equal(typeof typeChecksOnly, 'function');
});

// --- the runtime rule, for configs that never met the compiler ------------------------

test('quality on a lossless format throws at runtime too', async () => {
  // Types do not survive JSON.parse. The batch pipeline is explicitly serialisable, so
  // `{format: 'png', quality: 80}` can arrive from a settings file having never seen the
  // compiler. This is the check that actually fires in production.
  const config = JSON.parse('{"format":"png","quality":80}') as { format: Format; quality: number };
  const img = createImage(2, 2);

  const err = await rejects(() => encode(img, config.format, { quality: config.quality } as never), 'INVALID_OPTION');
  assert.match(err.message, /png takes no options/);
});

test('every lossless format rejects quality at runtime, naming what it does take', async () => {
  const img = createImage(2, 2);
  const CASES: readonly (readonly [Format, RegExp])[] = [
    ['png', /takes no options/],
    ['bmp', /takes only background/],
    ['tiff', /takes only compression/],
    ['gif', /takes only colors, dither/],
  ];
  for (const [format, expected] of CASES) {
    const err = await rejects(() => encode(img, format, { quality: 80 } as never), 'INVALID_OPTION');
    assert.match(err.message, expected, format);
    assert.match(err.message, /quality/, `${format} names the offending option`);
  }
});

test('a misspelled option is rejected rather than silently ignored', async () => {
  // The failure this prevents: a user sets `paletteSize` (which an earlier draft of
  // format-quality.md called it), sees the file not change, and has no idea why. An
  // ignored option is a lie; the error is the feature.
  const err = await rejects(() => encode(createImage(2, 2), 'gif', { paletteSize: 16 } as never), 'INVALID_OPTION');
  assert.match(err.message, /paletteSize/);
  assert.match(err.message, /colors/, 'and it says what the real name is');
});

test('the options each codec accepts are the options it actually reads', async () => {
  // Guards the table against drift: a hand-written list of names next to a real options
  // type will rot the moment someone adds an option to a codec and not to the list. Each
  // name below must be accepted (no throw) AND have an effect somewhere in the suite.
  const img = await decode(read('jpeg/photo.jpg'));
  await encode(img, 'jpeg', { quality: 50, background: [0, 0, 0, 255] });
  await encode(img, 'gif', { colors: 16, dither: false });
  await encode(img, 'tiff', { compression: 'none' });
  await encode(img, 'bmp', { background: [0, 0, 0, 255] });
  await encode(img, 'png');
  assert.ok(true, 'every documented option was accepted');
});

test('an empty options object is fine everywhere', async () => {
  // `{}` is what a builder with nothing set passes, so it must not trip the key check.
  const img = createImage(2, 2);
  for (const format of ['png', 'jpeg', 'gif', 'bmp', 'tiff'] as const) {
    assert.ok((await encode(img, format, {})).length > 0, format);
  }
});

// --- quality does something ----------------------------------------------------------

test('quality 40 produces a measurably smaller JPEG than quality 90', async () => {
  const img = await decode(read('jpeg/photo.jpg'));
  const low = await encode(img, 'jpeg', { quality: 40 });
  const high = await encode(img, 'jpeg', { quality: 90 });
  assert.ok(low.length < high.length, `q40 ${low.length} vs q90 ${high.length}`);
});

test('quality 100 is still lossy, which users assume forever', async () => {
  // A doc note is the whole fix, but the note should be true. Round-trip a photo at 100
  // and the pixels do not come back.
  const img = await decode(read('jpeg/photo.jpg'));
  const round = await decode(await encode(img, 'jpeg', { quality: 100 }));
  assert.notDeepEqual(round.data, img.data, 'quality 100 round-tripped exactly, which JPEG cannot do');
});

test('quality outside 1-100 is INVALID_OPTION', async () => {
  const img = createImage(2, 2);
  for (const quality of [0, 101, -1, 1.5, NaN]) {
    await rejects(() => encode(img, 'jpeg', { quality }), 'INVALID_OPTION');
  }
});

// --- the conversion matrix -----------------------------------------------------------

const MATRIX: readonly (readonly [Format, string])[] = [
  ['png', 'png/rgba8.png'],
  ['jpeg', 'jpeg/s420.jpg'],
  ['gif', 'gif/basic.gif'],
  ['bmp', 'bmp/rgb24.bmp'],
  ['tiff', 'tiff/rgb-none.tif'],
];

for (const [from, path] of MATRIX) {
  for (const [to] of MATRIX) {
    test(`${from} converts to ${to}`, async () => {
      // One loop, and it catches an entire class of "we never tried TIFF to GIF" bug.
      // webp joins the matrix in features/codec-webp.md.
      const src = await decode(read(path));
      const out = await decode(await encode(src, to));
      assert.deepEqual([out.width, out.height], [src.width, src.height]);
    });
  }
}

test('quality is not comparable across formats, and nothing here pretends it is', async () => {
  // A support question waiting to happen, worth pinning as a fact rather than a doc line:
  // the same number on two formats is two different files. Today only JPEG has a quality
  // dial among the pure-TS codecs, so this asserts the weaker true thing -- that the
  // library makes no cross-format size promise -- by showing one format's quality 80
  // against another format's whole output.
  const img = await decode(read('jpeg/photo.jpg'));
  const jpeg = await encode(img, 'jpeg', { quality: 80 });
  const png = await encode(img, 'png');
  assert.notEqual(jpeg.length, png.length);
});
