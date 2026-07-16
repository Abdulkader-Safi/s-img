import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SImgError,
  CorruptImageError,
  InvalidOptionError,
  UnsupportedFormatError,
} from '../../src/core/errors.ts';

// features/errors.md. An Obsidian vault is a pile of files a human dragged in over
// five years: a .png that is a JPEG, a 40-byte truncated download, a HEIC. Each wants
// a different message in the UI and none should crash the editor. This taxonomy is the
// contract that lets the plugin write that switch statement.

test('every error is catchable as SImgError', () => {
  // The plugin needs `catch (e) { if (e instanceof SImgError) ... }` to be exhaustive.
  const errors = [
    new CorruptImageError('truncated'),
    new InvalidOptionError('crop.width', -5, 'must be >= 1'),
    new UnsupportedFormatError(new Uint8Array([0x00, 0x01])),
  ];

  for (const e of errors) {
    assert.ok(e instanceof SImgError, `${e.constructor.name} must extend SImgError`);
    assert.ok(e instanceof Error, `${e.constructor.name} must extend Error`);
  }
});

test('code is machine-readable, message is not', () => {
  // The plugin must never string-match on .message. Every conditional it needs has to
  // be expressible on `code`.
  assert.equal(new CorruptImageError('x').code, 'CORRUPT_IMAGE');
  assert.equal(new InvalidOptionError('a', 1, 'x').code, 'INVALID_OPTION');
  assert.equal(new UnsupportedFormatError(new Uint8Array()).code, 'UNSUPPORTED_FORMAT');
});

test('errors carry a usable name for stack traces', () => {
  assert.equal(new CorruptImageError('x').name, 'CorruptImageError');
});

test('InvalidOptionError names the option and the value', () => {
  // "invalid crop" is useless. "crop.width -5" is actionable.
  const e = new InvalidOptionError('crop.width', -5, 'must be >= 1');

  assert.equal(e.option, 'crop.width');
  assert.equal(e.value, -5);
  assert.match(e.message, /crop\.width/);
  assert.match(e.message, /-5/);
  assert.match(e.message, /must be >= 1/);
});

test('InvalidOptionError renders an object value without throwing', () => {
  const e = new InvalidOptionError('crop', { x: 1 }, 'out of bounds');
  assert.match(e.message, /x/, 'the value should be rendered, not "[object Object]"');
});

test('UnsupportedFormatError hex-dumps the first 12 bytes', () => {
  // The magic bytes are what turns "something went wrong" into a fixable bug report.
  const heic = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0xff, 0xff,
  ]);
  const e = new UnsupportedFormatError(heic);

  assert.equal(e.detectedMagic, '00 00 00 18 66 74 79 70 68 65 69 63', 'first 12 bytes only');
  assert.match(e.message, /00 00 00 18/);
});

test('UnsupportedFormatError does not itself throw on a short input', () => {
  // features/errors.md: "Error during error." A 3-byte file must produce a real error,
  // not a RangeError from reading past the end of the buffer.
  assert.equal(new UnsupportedFormatError(new Uint8Array([0xde, 0xad, 0xbe])).detectedMagic, 'de ad be');
  assert.equal(new UnsupportedFormatError(new Uint8Array()).detectedMagic, '');
});

test('UnsupportedFormatError can explain a format it DID recognise', () => {
  // Two different failures share this code. "We have never heard of this format" is the
  // common one. The other is "this is plainly a JPEG, but a progressive one, which we
  // cannot decode yet" -- and there the default message would be a lie that sends someone
  // hunting a corruption bug that is not there.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const e = new UnsupportedFormatError(jpeg, 'Progressive JPEG is not supported yet.');

  assert.equal(e.code, 'UNSUPPORTED_FORMAT', 'still the same code: the taxonomy does not grow for this');
  assert.equal(e.message, 'Progressive JPEG is not supported yet.');
  assert.equal(e.detectedMagic, 'ff d8 ff e0 00 10', 'the magic is still attached for the bug report');
});

test('an empty input still explains itself', () => {
  const e = new UnsupportedFormatError(new Uint8Array());
  assert.ok(e.message.length > 0, 'a 0-byte file needs a message a human can act on');
});

test('a cause is never swallowed', () => {
  // Debugging a codec failure with the underlying error thrown away is misery.
  const cause = new RangeError('offset is out of bounds');
  const e = new CorruptImageError('inflate failed', { cause });

  assert.equal(e.cause, cause);
});
