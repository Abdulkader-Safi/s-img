import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodePng, encodePng, probePng } from '../../../src/core/codecs/png.ts';

/**
 * Decode PNGs produced by ImageMagick (libpng) and compare against the pixels libpng
 * itself decoded from them.
 *
 * png.test.ts builds its fixtures with our own helpers, which share our decoder's
 * assumptions -- so a symmetric bug passes both sides. That is not theoretical:
 * mutation testing showed that breaking the Paeth tie-break (`pb <= pc` to `pb < pc`)
 * failed ZERO of those tests, because hand-built fixtures never produced a pb == pc
 * tie. These fixtures are photo-like noise, which does.
 *
 * ImageMagick is not a test dependency. The .png and .rgba files are committed; see
 * test/fixtures/png/generate.sh to regenerate.
 */

const DIR = new URL('../../fixtures/png/', import.meta.url).pathname;

function load(name: string): { png: Uint8Array; expected: Uint8Array } {
  return {
    png: new Uint8Array(readFileSync(`${DIR}${name}.png`)),
    expected: new Uint8Array(readFileSync(`${DIR}${name}.rgba`)),
  };
}

/** Every fixture, and what makes it worth having. */
const CASES: readonly (readonly [name: string, why: string])[] = [
  ['paeth-photo', 'noise, so libpng reaches for Paeth and hits the pb == pc tie'],
  ['flat', 'one colour: the trivially-compressible path'],
  ['rgba8', 'truecolour + alpha, including partial transparency'],
  ['gray8', 'colour type 0, expanded to RGBA'],
  ['gray1', '1-bit, on a width whose rows do not end on a byte boundary'],
  ['gray16', '16-bit, truncated to 8'],
  ['palette', 'colour type 3 via PLTE'],
  ['palette-trns', 'palette plus per-entry alpha from tRNS'],
  ['interlaced', 'Adam7: seven passes, each with its own stride'],
  ['odd-17x13', 'dimensions nobody fixtures until something breaks'],
];

for (const [name, why] of CASES) {
  test(`decodes ${name} exactly as libpng does (${why})`, () => {
    const { png, expected } = load(name);
    const img = decodePng(png);

    assert.equal(img.data.length, expected.length, 'pixel buffer size');

    // Report the first disagreement rather than dumping thousands of bytes.
    for (let i = 0; i < expected.length; i++) {
      if (img.data[i] !== expected[i]) {
        const pixel = Math.floor(i / 4);
        assert.fail(
          `${name}: byte ${i} (pixel ${pixel % img.width},${Math.floor(pixel / img.width)}, ` +
            `channel ${'rgba'[i % 4]}) is ${img.data[i]}, libpng says ${expected[i]}`,
        );
      }
    }
  });
}

test('probe agrees with the decoded size on every fixture', () => {
  for (const [name] of CASES) {
    const { png } = load(name);
    const img = decodePng(png);
    assert.deepEqual(probePng(png), { width: img.width, height: img.height }, name);
  }
});

test('re-encoding a libpng image preserves every pixel', () => {
  // The full loop: their bytes in, our bytes out, our bytes back in. PNG is lossless,
  // so anything but an exact match is a bug in one of the two halves.
  for (const [name] of CASES) {
    const { png, expected } = load(name);
    const round = decodePng(encodePng(decodePng(png)));

    assert.deepEqual(Array.from(round.data), Array.from(expected), `${name} did not survive`);
  }
});
