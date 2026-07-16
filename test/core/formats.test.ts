import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sniff, FORMATS, type Format } from '../../src/core/formats.ts';

// features/decode.md, "Format sniffing". The extension is a lie, the header is the
// truth. A vault holds a .png that is really a JPEG and a .jpg that is a 40-byte
// truncated download, so nothing downstream may trust a filename.

/** Build a header from magic bytes, padded to a realistic length. */
function header(...bytes: number[]): Uint8Array {
  const buf = new Uint8Array(32);
  buf.set(bytes);
  return buf;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const BMP = [0x42, 0x4d];
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a];

/** RIFF....WEBP: the size field at 4..8 is arbitrary and must not be matched on. */
function webp(size = [0x24, 0x00, 0x00, 0x00]): Uint8Array {
  return header(0x52, 0x49, 0x46, 0x46, ...size, 0x57, 0x45, 0x42, 0x50);
}

test('identifies every supported format', () => {
  assert.equal(sniff(header(...PNG)), 'png');
  assert.equal(sniff(header(...JPEG)), 'jpeg');
  assert.equal(sniff(header(...GIF87)), 'gif');
  assert.equal(sniff(header(...GIF89)), 'gif');
  assert.equal(sniff(header(...BMP)), 'bmp');
  assert.equal(sniff(header(...TIFF_LE)), 'tiff');
  assert.equal(sniff(header(...TIFF_BE)), 'tiff');
  assert.equal(sniff(webp()), 'webp');
});

test('every format in FORMATS is reachable by the sniffer', () => {
  // If a format is added to the union without a signature, decode can never dispatch
  // to it. This catches that at the seam.
  const reachable: Format[] = ['png', 'jpeg', 'gif', 'bmp', 'tiff', 'webp'];
  assert.deepEqual([...FORMATS].sort(), [...reachable].sort());
});

test('TIFF is matched in both byte orders', () => {
  // Big-endian TIFF is real (older Mac and print workflows) and is exactly what a
  // hardcoded little-endian reader mangles silently.
  assert.equal(sniff(header(...TIFF_BE)), 'tiff');
});

test('WebP ignores the RIFF size field', () => {
  // Bytes 4..8 are the file length. Matching on them would fail on every real file.
  assert.equal(sniff(webp([0xff, 0xff, 0xff, 0xff])), 'webp');
  assert.equal(sniff(webp([0x00, 0x00, 0x00, 0x00])), 'webp');
});

test('a RIFF container that is not WebP is not WebP', () => {
  // RIFF also carries WAV and AVI. Matching "RIFF" alone would claim them.
  const wav = header(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
  assert.equal(sniff(wav), undefined);
});

test('returns undefined for what we cannot read', () => {
  const text = new TextEncoder().encode('# Just a markdown note, renamed to .png\n');
  assert.equal(sniff(text), undefined);
});

test('does not throw on inputs too short to hold a signature', () => {
  // A 40-byte truncated download, or a 0-byte file a bad sync produced. Reading past
  // the end here would crash the editor on a file the user can see in Finder.
  assert.equal(sniff(new Uint8Array()), undefined);
  assert.equal(sniff(new Uint8Array([0x89])), undefined);
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e])), undefined, 'a partial PNG signature');
  assert.equal(sniff(new Uint8Array([0xff, 0xd8])), undefined, 'a partial JPEG signature');
  assert.equal(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46])), undefined, 'RIFF with no type');
});

test('a truncated JPEG signature is not a JPEG', () => {
  // FF D8 alone is not enough: the third byte must be FF too.
  assert.equal(sniff(header(0xff, 0xd8, 0x00)), undefined);
});

test('HEIC is not claimed as a supported format', () => {
  // features/heic-decision.md: HEIC is dropped. It must sniff as unreadable rather
  // than be mistaken for something we can decode. Naming it in the error message is
  // feat/decode's job, where the error is actually built.
  const heic = header(
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
  );
  assert.equal(sniff(heic), undefined);
});

test('sniffing reads only the header, whatever the file size', () => {
  // decode calls this before allocating anything. It must not walk 48 MB.
  const big = new Uint8Array(8 * 1024 * 1024);
  big.set(PNG);
  assert.equal(sniff(big), 'png');
});
