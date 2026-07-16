import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import exifr from 'exifr';

import { decode, encode } from '../../src/core/dispatch.ts';
import type { Format } from '../../src/core/formats.ts';

// features/strip-metadata.md.
//
// This file IS the feature. Stripping is not a code path here -- it is the consequence of
// RawImage having three fields, none of them metadata, so by the time any encoder runs
// there is no EXIF left to write. That makes the guarantee free and makes losing it
// silent, which is exactly why it needs a test suite pointed at it rather than a comment.
//
// Read back with exifr, a devDependency, rather than with our own code. An assertion that
// our reader cannot find what our writer did not write is worth nothing: the two would
// share a blind spot and agree. exifr parses EXIF, GPS, ICC and XMP out of JPEG, TIFF,
// PNG and WebP, which covers the whole per-format table in the spec with one outside
// opinion.
//
// The `stripMetadata()` method itself is a builder method and lands with
// features/api-surface.md. There is nothing for it to do but promise this.

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const read = (path: string) => new Uint8Array(readFileSync(`${FIXTURES}${path}`));

/** Everything exifr can find, or `undefined` when a file carries nothing at all. */
async function readMetadata(bytes: Uint8Array): Promise<Record<string, unknown> | undefined> {
  // Buffer, because exifr wants a Node buffer or an ArrayBuffer, not a Uint8Array view.
  return (await exifr.parse(Buffer.from(bytes), {
    tiff: true,
    exif: true,
    gps: true,
    icc: true,
    xmp: true,
    iptc: true,
    jfif: true,
  })) as Record<string, unknown> | undefined;
}

const FORMATS: readonly Format[] = ['png', 'jpeg', 'gif', 'bmp', 'tiff'];

/**
 * The formats exifr will look inside. It refuses GIF and BMP outright ("Unknown file
 * format"), which is not a gap in the tool: neither format has a metadata container for it
 * to parse. GIF has comment extensions and nothing else, BMP has no concept at all. They
 * are covered structurally below instead.
 */
const PARSEABLE: readonly Format[] = ['png', 'jpeg', 'tiff'];

/** Keys that describe the photo rather than being the photo. See the TIFF note below. */
const METADATA_KEY = /exif|gps|icc|xmp|iptc|profile|make|model|date|software|artist|copyright|lens|orientation/i;

// --- does the detector detect? ------------------------------------------------------

test('the leak detector finds metadata when it IS there', async () => {
  // Every assertion below is of the form "we found nothing", which is what a broken
  // detector also reports. So: point the exact same reader and the exact same filter at
  // the source file, and require it to light up. Without this, a typo in the regex or a
  // wrong argument to exifr would turn this whole suite green and meaningless.
  const found = await readMetadata(read('exif/gps.jpg'));
  const leaked = Object.keys(found ?? {}).filter((k) => METADATA_KEY.test(k));
  assert.ok(leaked.length > 0, 'the detector cannot see the metadata in the source file');
  assert.ok(
    leaked.some((k) => /gps/i.test(k)),
    `expected GPS keys among ${JSON.stringify(leaked)}`,
  );
});

// --- the guarantee ------------------------------------------------------------------

for (const format of PARSEABLE) {
  test(`${format} output carries no EXIF, GPS, ICC or XMP`, async () => {
    // The source is a real photo with a real EXIF block, so this cannot pass by encoding
    // something that never had metadata to begin with.
    const img = await decode(read('exif/gps.jpg'));
    const out = await encode(img, format);

    const found = await readMetadata(out);
    // TIFF is the interesting one: its pixels live in the same IFD structure EXIF uses, so
    // exifr always finds the image tags (ImageWidth and friends). Those are not metadata,
    // they are the file. What must not be there is anything ABOUT the photo.
    const leaked = Object.keys(found ?? {}).filter((k) => METADATA_KEY.test(k));
    assert.deepEqual(leaked, [], `${format} leaked: ${JSON.stringify(found)}`);
  });
}

test('GIF writes no comment extension, the only metadata it has', async () => {
  // 0x21 0xFE is a comment extension: the one place a GIF could carry anything about the
  // image. Structural rather than parsed, because exifr refuses GIFs entirely.
  const out = await encode(await decode(read('exif/gps.jpg')), 'gif');
  for (let i = 0; i + 1 < out.length; i++) {
    assert.ok(!(out[i] === 0x21 && out[i + 1] === 0xfe), `a comment extension at ${i}`);
  }
});

test('BMP has no metadata concept, and the header confirms it', async () => {
  // Nothing to strip and nowhere to put it. The nearest thing is a colour profile in a
  // V5 header, so the assertion is that we do not write one: bV5CSType stays 0 (LCS_
  // CALIBRATED_RGB) rather than naming an embedded profile.
  const img = await decode(read('exif/gps.jpg'));
  const out = await encode(img, 'bmp');
  const headerSize = new DataView(out.buffer, out.byteOffset).getUint32(14, true);
  assert.ok(headerSize <= 124, `DIB header is ${headerSize} bytes`);

  // Rows pad to a 4-byte boundary, so the pixel block is not simply width * height * 3.
  const stride = Math.ceil((img.width * 3) / 4) * 4;
  assert.equal(out.length, 14 + headerSize + stride * img.height, 'pixels and header only, no trailing block');
});

test('a JPEG with GPS in has no GPS out', async () => {
  // The privacy case, stated as bluntly as the spec states it. The fixture is Beirut,
  // 33.8938 N 35.5018 E, and generate.sh proves exifr can read it out of the SOURCE, so a
  // pass here is the encoder dropping it rather than the fixture never having it.
  const before = await exifr.gps(Buffer.from(read('exif/gps.jpg')));
  assert.equal(before?.latitude.toFixed(4), '33.8938', 'the fixture really is carrying a location');

  const out = await encode(await decode(read('exif/gps.jpg')), 'jpeg');
  assert.equal(await exifr.gps(Buffer.from(out)), undefined, 'the location survived the round trip');
});

test('stripping metadata cannot rotate the photo', async () => {
  // The single most important sentence in the spec, as a test. The classic failure of a
  // naive strip tool: an iPhone stores landscape pixels plus "rotate 90 CW", the tool drops
  // the tag without applying it, and every phone photo saves out sideways -- which then
  // gets blamed on the strip feature.
  //
  // We apply on decode and write no tag, so the pixels are physically upright and the tag
  // is not needed. That is what makes it safe to throw away.
  const img = await decode(read('exif/orient-6.jpg'));
  assert.deepEqual([img.width, img.height], [16, 24], 'decode applied the rotation');

  const out = await encode(img, 'jpeg');
  assert.equal((await readMetadata(out))?.Orientation, undefined, 'no tag written');

  // Upright in a viewer that ignores EXIF entirely, which is the whole point.
  const round = await decode(out);
  assert.deepEqual([round.width, round.height], [16, 24]);
});

test('no format inflates a small file with a metadata block', async () => {
  // 50-100 KB of EXIF plus thumbnail plus ICC is most of a small file. A 4x4 has nowhere
  // to hide one: any format whose output runs to kilobytes here is writing something it
  // should not.
  const img = await decode(read('exif/gps.jpg'), { maxLongEdge: 4 });
  for (const format of FORMATS) {
    const out = await encode(img, format);
    assert.ok(out.length < 1024, `${format} wrote ${out.length} bytes for a 4x4`);
  }
});

test('a JPEG carries the minimum legal marker set and nothing else', async () => {
  // Named per marker rather than left to exifr, because exifr reports what it can PARSE
  // and a segment it does not understand is a segment it does not mention. APP2 is ICC,
  // APP13 is a Photoshop thumbnail, COM is a comment: none of them would show up above.
  const out = await encode(await decode(read('exif/gps.jpg')), 'jpeg');
  const BANNED: readonly (readonly [marker: number, what: string])[] = [
    [0xe1, 'APP1: EXIF or XMP'],
    [0xe2, 'APP2: an ICC profile'],
    [0xed, 'APP13: a Photoshop thumbnail'],
    [0xfe, 'COM: a comment'],
  ];
  for (const [marker, what] of BANNED) {
    for (let i = 0; i + 1 < out.length; i++) {
      // Only meaningful in the header: past SOS these bytes are entropy-coded data and
      // will hit any pattern by chance.
      if (out[i] === 0xff && out[i + 1] === 0xda) break;
      assert.ok(!(out[i] === 0xff && out[i + 1] === marker), `${what} at ${i}`);
    }
  }
});

test('a PNG carries only IHDR, IDAT and IEND', async () => {
  // tEXt, iTXt, zTXt, eXIf and iCCP are all legal here and all absent by construction.
  const out = await encode(await decode(read('exif/gps.jpg')), 'png');
  const text = Buffer.from(out).toString('latin1');
  for (const chunk of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'tIME']) {
    assert.ok(!text.includes(chunk), `a ${chunk} chunk`);
  }
});

// --- the marker for when this stops being true --------------------------------------

test('decode drops metadata at the boundary, so no encoder can write it back', async () => {
  // The architectural claim the whole feature rests on, pinned directly: a RawImage has
  // three fields and none of them is metadata. When this assertion starts failing, someone
  // has added metadata preservation and features/strip-metadata.md needs rewriting -- and
  // stripMetadata() stops being a promise and becomes a code path.
  const img = await decode(read('exif/gps.jpg'));
  assert.deepEqual(Object.keys(img).sort(), ['data', 'height', 'width']);
});
