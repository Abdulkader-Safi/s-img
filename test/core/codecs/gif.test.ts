import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodeGif, encodeGif, probeGif } from '../../../src/core/codecs/gif.ts';
import { CorruptImageError, ImageTooLargeError, InvalidOptionError } from '../../../src/core/errors.ts';
import { createImage, type RawImage } from '../../../src/core/image.ts';

// features/codec-gif.md. The interesting part of GIF is not the container, it is that GIF
// is a 256-colour format: encoding to it means quantisation, and quantisation is a real
// algorithm with real quality consequences. That is where the work is.
//
// Decode, by contrast, is exact -- indices map through a palette, there is no tolerance to
// argue about -- so these compare byte for byte.

const DIR = new URL('../../fixtures/gif/', import.meta.url).pathname;

const gif = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}${name}.gif`));
const rgba = (name: string): Uint8Array => new Uint8Array(readFileSync(`${DIR}${name}.rgba`));

/** Every fixture, its logical screen size, and the trap it exists to catch. */
const CASES: readonly (readonly [name: string, width: number, height: number, why: string])[] = [
  ['basic', 32, 32, '89a, global colour table, no transparency'],
  ['gif87a', 16, 16, 'the older 87a header'],
  ['transparent', 16, 16, 'a transparent palette index'],
  ['interlaced', 32, 32, 'rows stored in 4 passes'],
  ['flat', 8, 8, 'a tiny palette'],
  ['animated', 16, 16, 'frame 0 of an animation'],
  // offset-frame is deliberately absent: ImageMagick is not our reference for it. See the
  // logical-screen test below.
];

for (const [name, width, height, why] of CASES) {
  test(`decodes ${name} exactly as ImageMagick does (${why})`, () => {
    const img = decodeGif(gif(name));

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
    assert.deepEqual(probeGif(gif(name)), { width, height }, name);
  }
});

test('an interlaced GIF is not shredded into bands', () => {
  // Interlaced rows arrive in 4 passes (every 8th from 0, every 8th from 4, every 4th from
  // 2, every 2nd from 1). Reading them in file order puts row 8 where row 1 belongs, and
  // the image comes out as horizontal bands. The byte-exact check above catches it, but
  // this names the failure -- and proves the fixture really is interlaced, by checking the
  // flag rather than trusting the filename.
  const bytes = gif('interlaced');
  const descriptor = firstImageDescriptor(bytes);
  assert.ok((bytes[descriptor + 9]! & 0x40) !== 0, 'the fixture is not actually interlaced');

  assert.deepEqual(Array.from(decodeGif(bytes).data), Array.from(rgba('interlaced')));
});

/** Offset of the first image descriptor, stepping over the colour table and any extensions. */
function firstImageDescriptor(bytes: Uint8Array): number {
  const flags = bytes[10]!;
  let at = 13 + ((flags & 0x80) !== 0 ? (2 << (flags & 7)) * 3 : 0);

  while (at < bytes.length && bytes[at] === 0x21) {
    at += 2;
    while (bytes[at] !== 0 && at < bytes.length) at += bytes[at]! + 1;
    at++;
  }
  assert.equal(bytes[at], 0x2c, 'expected an image descriptor');
  return at;
}

test('the logical screen is the image size, and the area outside the frame is transparent', () => {
  // A frame can be smaller than the logical screen and sit at an offset, and this is the
  // one place ImageMagick is NOT our reference, so the expectations are spelled out here
  // rather than diffed against a .rgba.
  //
  // Two questions. The size: the file declares a 20x20 logical screen, so handing back the
  // 8x8 frame would lose where the image actually sits. And what fills the rest: the
  // GIF89a spec says the background colour index, and ImageMagick duly paints it red --
  // but browsers ignore that field and render transparent.
  //
  // We follow the browser, because the plugin renders in Obsidian, which is Chromium. If a
  // user sees a transparent surround and we decode red, editing changes what they saw.
  // Verified rather than assumed: Chromium decodes this exact fixture to 20x20 with
  // rgba(0,0,0,0) outside the frame and red inside, which is what this asserts.
  const img = decodeGif(gif('offset-frame'));

  assert.equal(img.width, 20);
  assert.equal(img.height, 20);

  // The frame is a solid red 8x8 at (6,5). Everything else had no pixel and stays clear.
  const at = (x: number, y: number): number[] => Array.from(img.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4));

  assert.deepEqual(at(6, 5), [255, 0, 0, 255], 'top-left of the frame');
  assert.deepEqual(at(13, 12), [255, 0, 0, 255], 'bottom-right of the frame');
  assert.equal(at(5, 5)[3], 0, 'just left of the frame');
  assert.equal(at(14, 12)[3], 0, 'just right of the frame');
  assert.equal(at(0, 0)[3], 0, 'the corner of the screen');
});

test('an animated GIF decodes frame 0 without erroring', () => {
  // An animated GIF in a vault is usually a meme, and "decode the first frame" is a far
  // better outcome than an error. The loss is documented, not thrown.
  const img = decodeGif(gif('animated'));

  assert.equal(img.width, 16);
  assert.equal(img.height, 16);
  // Frame 0 of red/lime/blue is red.
  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [255, 0, 0, 255]);
});

test('a transparent index decodes to alpha 0, and only there', () => {
  const img = decodeGif(gif('transparent'));

  let clear = 0;
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] === 0) clear++;
    else if (img.data[i] === 255) opaque++;
    else assert.fail(`GIF alpha is one bit: found ${img.data[i]}`);
  }

  assert.ok(clear > 0, 'the fixture has a transparent region');
  assert.ok(opaque > 0, 'the fixture has an opaque region');
});

// --- validation ---------------------------------------------------------------------

test('rejects a file that is not a GIF', () => {
  const png = new Uint8Array(200);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => decodeGif(png), CorruptImageError);
});

test('rejects an empty file', () => {
  assert.throws(() => decodeGif(new Uint8Array()), CorruptImageError);
});

test('rejects a file whose only fault is the signature', () => {
  const bad = gif('basic').slice();
  bad[3] = 0x39; // "GIF9" -- neither 87a nor 89a

  assert.throws(
    () => decodeGif(bad),
    (e: unknown) => e instanceof CorruptImageError && /GIF8|signature/i.test(e.message),
  );
});

test('rejects a truncated file', () => {
  const full = gif('basic');
  assert.throws(() => decodeGif(full.subarray(0, full.length - 30)), CorruptImageError);
});

test('rejects a GIF with no image data at all', () => {
  // Header and screen descriptor, then straight to the trailer. Legal to parse, but there
  // is no image, and returning a blank canvas would silently invent one.
  const bytes = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x3b,
  ]);
  assert.throws(() => decodeGif(bytes), CorruptImageError);
});

test('rejects a frame that names a colour table the file never sends', () => {
  // No global table, no local table: every index is meaningless, and a blank canvas would
  // silently invent an image. Built by MOVING the table out rather than just clearing the
  // flag -- clearing it alone leaves 192 bytes of palette where the block chain expects a
  // block, so the parser trips over that first and this check never runs.
  assert.throws(() => decodeGif(withColourTable(gif('basic'), 'none')), CorruptImageError);
});

test('a frame with a local colour table decodes the same as with a global one', () => {
  // A local table overrides the global one, and it is the mechanism behind
  // pseudo-truecolour GIFs. ImageMagick will not emit one for frame 0 at any coaxing, so
  // this moves `basic`'s global table into a local one: the same bytes, in the other slot.
  // The pixels must be identical, which makes the reference the plain fixture itself.
  const moved = withColourTable(gif('basic'), 'local');
  assert.deepEqual(Array.from(decodeGif(moved).data), Array.from(rgba('basic')));
});

test('a local colour table wins over the global one', () => {
  // Same as above, but with the GLOBAL table left in place and scribbled on. If the local
  // table is being ignored in favour of the global one, every colour comes out wrong --
  // and simply moving the table cannot show that, because both tables are the same bytes.
  const both = withColourTable(gif('basic'), 'both');
  assert.deepEqual(Array.from(decodeGif(both).data), Array.from(rgba('basic')));
});

/**
 * Rewrite `basic.gif` so its colour table lives somewhere else.
 *
 * - `local`: moved to the image descriptor, no global table.
 * - `both`: local table added, and the global table left behind filled with garbage, so
 *   reading the wrong one is loud.
 * - `none`: removed entirely, leaving a structurally valid file with no palette at all.
 */
function withColourTable(bytes: Uint8Array, where: 'local' | 'both' | 'none'): Uint8Array {
  const flags = bytes[10]!;
  assert.ok((flags & 0x80) !== 0, 'the source fixture must have a global colour table');

  const entries = 2 << (flags & 7);
  const table = bytes.slice(13, 13 + entries * 3);
  const descriptor = firstImageDescriptor(bytes);
  assert.equal(bytes[descriptor + 9]! & 0x80, 0, 'the source fixture must not already have a local table');

  const head = bytes.slice(0, 13 + (where === 'both' ? entries * 3 : 0));
  if (where === 'none') head[10] = flags & 0x7f;
  if (where === 'local') head[10] = flags & 0x7f;
  if (where === 'both') head.fill(0x2a, 13, 13 + entries * 3); // garbage the global table

  // Everything from the image descriptor to the trailer, with the local flag set.
  const rest = bytes.slice(descriptor);
  if (where !== 'none') rest[9] = rest[9]! | 0x80 | (flags & 7);

  const out = new Uint8Array(head.length + 10 + (where === 'none' ? 0 : table.length) + (rest.length - 10));
  out.set(head);
  out.set(rest.subarray(0, 10), head.length);
  if (where === 'none') {
    out.set(rest.subarray(10), head.length + 10);
  } else {
    out.set(table, head.length + 10);
    out.set(rest.subarray(10), head.length + 10 + table.length);
  }
  return out;
}

test('refuses a logical screen larger than the pixel cap', () => {
  // Four bytes of header can declare 65535x65535: 4.3 billion pixels, 17 GB of RGBA, from
  // a file that fits in a tweet. The guard has to fire off the HEADER, before allocation.
  const bad = gif('basic').slice();
  bad[6] = 0xff;
  bad[7] = 0xff;
  bad[8] = 0xff;
  bad[9] = 0xff;

  assert.throws(() => decodeGif(bad), ImageTooLargeError);
});

test('rejects a frame whose LZW data ends early but tidily', () => {
  // The nastier truncation. Lopping bytes off the end removes the terminator too, so the
  // reader runs off the buffer and throws for that reason -- the "decoded fewer pixels
  // than the frame declares" check never runs. This one keeps the chain well-formed and
  // just stops early, which is what a half-written file looks like.
  const bytes = gif('basic');
  const descriptor = firstImageDescriptor(bytes);
  const dataStart = descriptor + 10 + 1; // no local table, then the min code size

  // Keep the first sub-block, then terminate and close the file properly.
  const first = bytes[dataStart]!;
  const out = new Uint8Array(dataStart + 1 + first + 2);
  out.set(bytes.subarray(0, dataStart + 1 + first));
  out[dataStart + 1 + first] = 0x00; // sub-block terminator
  out[dataStart + 2 + first] = 0x3b; // trailer

  assert.throws(
    () => decodeGif(out),
    (e: unknown) => e instanceof CorruptImageError && /truncated|pixels/i.test(e.message),
  );
});

// --- encode -------------------------------------------------------------------------

/** Distinct colours in an image, as packed RGBA integers. */
function palette(img: RawImage): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < img.data.length; i += 4) {
    seen.add((img.data[i]! << 24) | (img.data[i + 1]! << 16) | (img.data[i + 2]! << 8) | img.data[i + 3]!);
  }
  return seen;
}

test('an image that already fits in 256 colours round-trips exactly', () => {
  // THE test that the quantiser does not mangle colours it never needed to touch. If the
  // palette fits, the output must be the input, byte for byte -- no dithering noise, no
  // nearest-colour drift, nothing.
  const src = createImage(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      // 256 distinct colours, exactly filling the palette.
      src.data.set([x * 16, y * 16, (x + y) * 8, 255], (y * 16 + x) * 4);
    }
  }
  assert.equal(palette(src).size, 256, 'the fixture must actually use all 256');

  const round = decodeGif(encodeGif(src));
  assert.deepEqual(Array.from(round.data), Array.from(src.data));
});

test('a handful of colours round-trips exactly, dithering or not', () => {
  for (const dither of [true, false]) {
    const src = decodeGif(gif('flat'));
    const round = decodeGif(encodeGif(src, { dither }));
    assert.deepEqual(Array.from(round.data), Array.from(src.data), `dither: ${dither}`);
  }
});

test('encode round-trips every decodable fixture within reach', () => {
  for (const [name] of CASES) {
    const src = decodeGif(gif(name));
    const round = decodeGif(encodeGif(src));

    assert.equal(round.width, src.width, name);
    assert.equal(round.height, src.height, name);
    // Each fixture is already <= 256 colours, so this is lossless.
    assert.deepEqual(Array.from(round.data), Array.from(src.data), name);
  }
});

test('a photo is quantised to at most 256 colours', () => {
  const src = photo(64, 64);
  assert.ok(palette(src).size > 256, 'the source must exceed the palette, or this proves nothing');

  const round = decodeGif(encodeGif(src));
  assert.ok(palette(round).size <= 256, `quantised to ${palette(round).size} colours`);
});

test('median cut splits along the axis that actually varies', () => {
  // The colour cube is split along its LONGEST axis. Get that wrong -- split whichever box
  // holds the most colours, or always split on red -- and a palette gets spent on an axis
  // carrying no information while the one that does collapses.
  //
  // Here red and green are constant and only blue moves, across 256 levels. A quantiser
  // that picks the right axis returns 4 distinct blues. One that always reaches for red
  // finds nothing to split and returns a single flat colour.
  const src = createImage(256, 1);
  for (let x = 0; x < 256; x++) src.data.set([128, 128, x, 255], x * 4);

  const round = decodeGif(encodeGif(src, { colors: 4, dither: false }));
  const blues = new Set<number>();
  for (let i = 0; i < round.data.length; i += 4) {
    assert.equal(round.data[i], 128, 'red does not vary and must not move');
    assert.equal(round.data[i + 1], 128, 'green does not vary and must not move');
    blues.add(round.data[i + 2]!);
  }

  assert.equal(blues.size, 4, `expected the palette spent on blue, got ${blues.size} distinct blues`);
});

test('median cut weights a box by how many pixels it holds, not how many colours', () => {
  // A box's colour is the mean of what is IN it, and the mean has to be weighted by pixel
  // count. Otherwise one stray pixel of a rare colour pulls a box as hard as fifty pixels
  // of a common one, and a large flat region drifts off to a colour that was never in it.
  //
  // Built so a box ends up holding near-black (50 pixels) and a lone light grey (1 pixel).
  // Weighted, that box averages to ~5 and the blacks stay black. Unweighted it averages to
  // ~125 and half the image turns mid-grey.
  const src = createImage(101, 1);
  for (let x = 0; x < 50; x++) src.data.set([0, 0, 0, 255], x * 4);
  src.data.set([250, 250, 250, 255], 50 * 4);
  for (let x = 51; x < 101; x++) src.data.set([255, 255, 255, 255], x * 4);

  const round = decodeGif(encodeGif(src, { colors: 2, dither: false }));

  assert.ok(round.data[0]! < 40, `the black half drifted to ${round.data[0]}: the average is not pixel-weighted`);
});

test('the palette size is configurable', () => {
  const src = photo(64, 64);
  const round = decodeGif(encodeGif(src, { colors: 16 }));

  assert.ok(palette(round).size <= 16, `asked for 16, got ${palette(round).size}`);
});

test('rejects a palette size outside 2 to 256', () => {
  const src = createImage(8, 8);
  for (const colors of [0, 1, 257, -4, Number.NaN, 12.5]) {
    assert.throws(() => encodeGif(src, { colors }), InvalidOptionError, `colors: ${colors}`);
  }
});

test('dithering trades per-pixel accuracy for a correct local average', () => {
  // What dithering actually DOES, stated as the two halves of one trade. A smooth ramp
  // cannot survive an 8-colour palette: undithered it collapses into flat plateaus, each a
  // solid block of the wrong colour. Error diffusion scatters the difference across
  // neighbours so any small REGION averages back to the right value, at the cost of every
  // individual pixel sitting further off than before.
  //
  // Measured on this ramp: the 8x8 window average is out by 8.0 undithered and 1.1
  // dithered, while per-pixel error moves the other way, 8.0 to 10.0. Both directions are
  // asserted, so the option provably does something and cannot be quietly turned into a
  // no-op either way.
  //
  // The first version measured the longest run of identical pixels, which barely moved (9
  // to 8) and nearly got the dithering written off as broken. A ramp gives the diffuser
  // only a few units of error to push around, so it flips a pixel or two per band rather
  // than shattering it. Run length was measuring the wrong thing.
  const src = ramp();
  const off = decodeGif(encodeGif(src, { colors: 8, dither: false }));
  const on = decodeGif(encodeGif(src, { colors: 8, dither: true }));

  assert.ok(
    windowError(src, on) < windowError(src, off) / 4,
    `dithering must fix the local average: ${windowError(src, on).toFixed(2)} against ${windowError(src, off).toFixed(2)}`,
  );
  assert.ok(
    pixelError(src, on) > pixelError(src, off),
    'dithering costs per-pixel accuracy; if it did not, it is not diffusing anything',
  );
});

test('dithering is on by default', () => {
  assert.deepEqual(
    Array.from(decodeGif(encodeGif(ramp(), { colors: 8 })).data),
    Array.from(decodeGif(encodeGif(ramp(), { colors: 8, dither: true })).data),
  );
});

/** A smooth full-range greyscale ramp: the thing a coarse palette cannot represent. */
function ramp(): RawImage {
  const img = createImage(128, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 128; x++) {
      const v = Math.round((x * 255) / 127);
      img.data.set([v, v, v, 255], (y * 128 + x) * 4);
    }
  }
  return img;
}

/** How far an 8x8 window's average strays from the original's: a direct measure of banding. */
function windowError(a: RawImage, b: RawImage): number {
  let total = 0;
  let windows = 0;

  for (let y = 0; y + 8 <= a.height; y += 8) {
    for (let x = 0; x + 8 <= a.width; x += 8) {
      let sa = 0;
      let sb = 0;
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const k = ((y + j) * a.width + x + i) * 4;
          sa += a.data[k]!;
          sb += b.data[k]!;
        }
      }
      total += Math.abs(sa - sb) / 64;
      windows++;
    }
  }
  return total / windows;
}

/** Mean per-pixel error. Dithering makes this WORSE, on purpose. */
function pixelError(a: RawImage, b: RawImage): number {
  let total = 0;
  for (let i = 0; i < a.data.length; i += 4) total += Math.abs(a.data[i]! - b.data[i]!);
  return total / (a.data.length / 4);
}

test('encode thresholds alpha to one bit', () => {
  // GIF alpha is one bit: an index is the transparent one or it is not. Semi-transparent
  // pixels CANNOT survive, so a soft anti-aliased edge becomes a hard jagged one. That is
  // inherent to the format, not a bug here, and it is documented rather than thrown.
  const src = createImage(4, 1);
  src.data.set([255, 0, 0, 0], 0); // fully clear
  src.data.set([255, 0, 0, 100], 4); // under the threshold
  src.data.set([255, 0, 0, 200], 8); // over it
  src.data.set([255, 0, 0, 255], 12); // fully opaque

  const round = decodeGif(encodeGif(src));

  assert.equal(round.data[3], 0, 'alpha 0 stays clear');
  assert.equal(round.data[7], 0, 'alpha 100 rounds to clear');
  assert.equal(round.data[11], 255, 'alpha 200 rounds to opaque');
  assert.equal(round.data[15], 255, 'alpha 255 stays opaque');
});

test('an image with no transparency writes no graphic control extension', () => {
  // The extension exists solely to name the transparent index. Writing one anyway wastes
  // 8 bytes and reserves a palette entry that could have held a real colour.
  const bytes = encodeGif(createImage(8, 8, [10, 20, 30, 255]));
  assert.ok(!hasExtension(bytes, 0xf9), 'an opaque image needs no graphic control extension');
});

test('an image with transparency writes one', () => {
  const src = createImage(8, 8, [10, 20, 30, 255]);
  src.data.set([0, 0, 0, 0], 0);
  assert.ok(hasExtension(encodeGif(src), 0xf9), 'a transparent image needs a graphic control extension');
});

function hasExtension(bytes: Uint8Array, label: number): boolean {
  const flags = bytes[10]!;
  let at = 13 + ((flags & 0x80) !== 0 ? (2 << (flags & 7)) * 3 : 0);

  while (at < bytes.length && bytes[at] === 0x21) {
    if (bytes[at + 1] === label) return true;
    at += 2;
    while (bytes[at] !== 0 && at < bytes.length) at += bytes[at]! + 1;
    at++;
  }
  return false;
}

test('encode writes a well-formed container', () => {
  const bytes = encodeGif(createImage(8, 8, [1, 2, 3, 255]));

  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  assert.equal(bytes[6]! | (bytes[7]! << 8), 8, 'logical screen width');
  assert.equal(bytes[8]! | (bytes[9]! << 8), 8, 'logical screen height');
  assert.equal(bytes[bytes.length - 1], 0x3b, 'trailer');
});

test('every LZW sub-block is 255 bytes or fewer', () => {
  // The sub-block length is ONE byte, so a longer run is unrepresentable and the stream
  // desynchronises. A big noisy image is what makes the blocks run long enough to matter,
  // and our own decoder would happily read whatever we wrote -- this checks the container
  // against the spec rather than against ourselves.
  const bytes = encodeGif(photo(128, 128));

  const flags = bytes[10]!;
  let at = 13 + ((flags & 0x80) !== 0 ? (2 << (flags & 7)) * 3 : 0);
  while (bytes[at] === 0x21) {
    at += 2;
    while (bytes[at] !== 0) at += bytes[at]! + 1;
    at++;
  }

  assert.equal(bytes[at], 0x2c, 'image descriptor');
  at += 10;
  const lflags = bytes[at - 1]!;
  if ((lflags & 0x80) !== 0) at += (2 << (lflags & 7)) * 3;
  at++; // minimum code size

  let blocks = 0;
  while (bytes[at] !== 0) {
    const size = bytes[at]!;
    assert.ok(size <= 255, `sub-block of ${size} bytes`);
    at += size + 1;
    blocks++;
  }
  assert.ok(blocks > 1, `expected the data to span several sub-blocks, got ${blocks}`);
});

test('every small size round-trips, whatever the bitstream lands on', () => {
  // LZW codes are 2 to 12 bits wide, so where the stream ends relative to a byte boundary
  // depends on the exact pixel count. A handful of fixed-size fixtures all happen to land
  // tidily: dropping the final partial byte entirely broke only 9 of these 120 sizes and
  // NONE of the fixtures. A sweep is the cheapest way to cover the alignments.
  for (let width = 1; width <= 40; width++) {
    for (let height = 1; height <= 3; height++) {
      const src = createImage(width, height);
      for (let i = 0; i < src.data.length; i += 4) {
        src.data.set([(i * 7) % 256, (i * 13) % 251, (i * 29) % 241, 255], i);
      }

      const round = decodeGif(encodeGif(src));
      assert.equal(round.width, width, `${width}x${height}`);
      assert.equal(round.height, height, `${width}x${height}`);
      assert.deepEqual(Array.from(round.data), Array.from(src.data), `${width}x${height}`);
    }
  }
});

test('the LZW dictionary is reset when it fills', () => {
  // The dictionary caps at 4096 entries. When it fills, the encoder sends a clear code and
  // starts fresh; letting it freeze instead is also legal GIF ("deferred clear") and our
  // own decoder reads both, so nothing else here can tell the difference. File size can.
  //
  // Measured on a 200x200 gradient: 22 KB resetting, 50 KB frozen -- a 2.2x collapse,
  // because a stale dictionary keeps coding at 12 bits for matches it no longer finds.
  // (Freezing does win on pure noise, by about 10%. Noise is not what anyone stores.)
  const src = createImage(200, 200);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) src.data.set([(x * 255) / 200, (y * 255) / 200, 128, 255], (y * 200 + x) * 4);
  }

  const size = encodeGif(src).length;
  assert.ok(size < 30_000, `${size} bytes for a 200x200 gradient: the dictionary is not being reset`);
});

test('quantising a photo to 16 colours stays within a sane error', () => {
  // A bound on the OUTCOME, not on the strategy. Median cut has several defensible variants
  // -- split the box with the longest axis, or the one holding the most colours -- and
  // measured they land within 3% of each other (26.5 against 25.6 mean error here), so
  // pinning our particular choice would be pinning a coin flip. What is worth guarding is
  // that the quantiser does not fall off a cliff: a broken one is not 3% worse, it is
  // several times worse.
  const src = createImage(64, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      src.data.set([(x * 3 + y * 5) % 256, (x * 7 + y * 2) % 256, (x * x + y * y) % 256, 255], (y * 64 + x) * 4);
    }
  }

  const round = decodeGif(encodeGif(src, { colors: 16, dither: false }));

  let total = 0;
  for (let i = 0; i < src.data.length; i++) {
    if (i % 4 !== 3) total += Math.abs(round.data[i]! - src.data[i]!);
  }
  const error = total / (src.data.length * 0.75);

  assert.ok(error < 40, `mean per-channel error ${error.toFixed(1)} at 16 colours: the quantiser is broken`);
});

test('a 1x1 round-trips', () => {
  const src = createImage(1, 1, [200, 100, 50, 255]);
  const round = decodeGif(encodeGif(src));

  assert.equal(round.width, 1);
  assert.equal(round.height, 1);
  assert.deepEqual(Array.from(round.data), [200, 100, 50, 255]);
});

test('a single-colour image round-trips, despite needing a 2-entry palette', () => {
  // GIF's minimum colour table is 2 entries: the size field is a power of two and 0 means
  // 2. An image with one colour still has to write a padded table.
  const round = decodeGif(encodeGif(createImage(8, 8, [7, 8, 9, 255])));
  for (let i = 0; i < round.data.length; i += 4) {
    assert.deepEqual(Array.from(round.data.subarray(i, i + 4)), [7, 8, 9, 255]);
  }
});

/** A deterministic, colour-rich test image with far more than 256 distinct colours. */
function photo(width: number, height: number): RawImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      img.data.set(
        [
          (x * 3 + y * 5) % 256,
          (x * 7 + y * 2) % 256,
          (x * x + y * y) % 256,
          255,
        ],
        (y * width + x) * 4,
      );
    }
  }
  return img;
}
