import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  // Everything features/type-safety.md says a caller must be able to name. Imported as
  // types, used as types below: if any of them stopped being exported, this file would not
  // compile, which is the assertion.
  type Format,
  type FormatOptions,
  type FormatSupport,
  type RawImage,
  type RGBA,
  type PipelineSpec,
  type CropOptions,
  type ResizeOptions,
  type RotateOptions,
  type FlipOptions,
  type Resampling,
  type DecodeOptions,
  type SImgErrorCode,
  SImgError,
  CorruptImageError,
  ImageTooLargeError,
  InvalidOptionError,
  UnsupportedFormatError,
  SImg,
  encode,
  createImage,
} from '../src/index.ts';

// features/type-safety.md.
//
// Most of this feature is a tsconfig and a type, and both are verified by `tsc -p
// tsconfig.test.json` during `npm run check` rather than at runtime. What is left worth
// testing is the surface: that a consumer can NAME everything, and that the places where
// the types cannot help are covered by the runtime.
//
// The compile-error mechanism itself is pinned in test/core/format-quality.test.ts, with
// ts-expect-error directives that fail the BUILD if the error stops happening. (Spelled
// without the @ on purpose: writing the directive's real name in a comment IS the
// directive, and tsc then reports it as unused. Found the hard way, one line up.)

// --- every public type is nameable ---------------------------------------------------

/**
 * NEVER CALLED. The assertion is that this file compiles.
 *
 * "A library that makes callers write `Parameters<typeof x>[0]` to name an argument type
 * has failed at its own API." So every one of these is declared the way a consumer would
 * declare it: as a plain annotation, no inference, no utility types.
 */
function _everyTypeIsNameable(): void {
  const format: Format = 'webp';
  const jpegOptions: FormatOptions<'jpeg'> = { quality: 80 };
  const webpOptions: FormatOptions<'webp'> = { lossless: true };
  const pngOptions: FormatOptions<'png'> = {};
  const support: FormatSupport = { read: [], write: [], pending: [], unavailable: [] };
  const image: RawImage = createImage(1, 1);
  const colour: RGBA = [255, 255, 255, 255];
  const spec: PipelineSpec = { version: 1 };
  const rect: CropOptions = { x: 0, y: 0, width: 1, height: 1 };
  const resizing: ResizeOptions = { width: 100, upscale: false, fit: 'contain' };
  const rotating: RotateOptions = { resampling: 'bilinear' };
  const flipping: FlipOptions = { horizontal: true };
  const resampling: Resampling = 'nearest';
  const decoding: DecodeOptions = { maxPixels: 100 };
  const code: SImgErrorCode = 'CORRUPT_IMAGE';

  void [format, jpegOptions, webpOptions, pngOptions, support, image, colour, spec, rect, resizing, rotating, flipping, resampling, decoding, code];
}

test('every public type is exported and nameable by a consumer', () => {
  assert.equal(typeof _everyTypeIsNameable, 'function', 'the assertion is that this file compiles');
});

test('every error class is exported, so a plugin can narrow on instanceof', () => {
  // The plugin's catch block is the reason these are classes and not just codes.
  for (const Ctor of [SImgError, CorruptImageError, ImageTooLargeError, InvalidOptionError, UnsupportedFormatError]) {
    assert.equal(typeof Ctor, 'function');
  }
  assert.ok(new CorruptImageError('x') instanceof SImgError, 'the subclasses narrow to the base');
});

// --- the places the types cannot help -------------------------------------------------

test('a Format-typed variable widens the check, and the runtime catches it', async () => {
  // A known, documented hole: the generic F is inferred from the LITERAL argument, so
  // toFormat('png', ...) narrows to the PNG branch. Pass a Format-typed variable and F
  // widens to the union, the option check softens, and nothing fails to compile.
  //
  // This is not fixable in the type system, and it is exactly why the runtime check is not
  // optional. Which is the whole "types are not validation" point, in one test.
  const format: Format = 'png';
  const err = await encode(createImage(2, 2), format, { quality: 80 } as unknown as FormatOptions<typeof format>).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof InvalidOptionError, 'the widened call was not caught at runtime either');
  assert.match(err.message, /png takes no options/);
});

test('excess property checking only fires on object literals, so the runtime backs it up', async () => {
  // `const o = { quality: 80 }; toFormat('png', o)` compiles. Known TypeScript behaviour,
  // not a bug, and not fixable -- the excess-property check is a literal-only rule.
  const options = { quality: 80 };
  await assert.rejects(() => encode(createImage(2, 2), 'png', options as unknown as FormatOptions<'png'>), {
    name: 'InvalidOptionError',
  });
});

test('a null from JSON.parse produces a message better than "expected number"', async () => {
  // exactOptionalPropertyTypes draws a real line between `{}` and `{ quality: undefined }`,
  // and a settings file happily produces `{"quality": null}`, which is neither. The type
  // rejects it; the runtime has to say something a human can act on.
  const config = JSON.parse('{"quality": null}') as { quality: number };
  const err = await encode(createImage(2, 2), 'jpeg', config).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof InvalidOptionError);
  assert.match(err.message, /quality/);
  assert.match(err.message, /from 1 to 100/, 'the message says what was wanted, not just what was wrong');
  assert.match(err.message, /null/, 'and what it got');
});

test('a spec from JSON with a wrong-typed field names the field', () => {
  // The other trust boundary. Same rule: the types are for the developer at 3pm, the
  // validation is for production at 3am.
  const fromSettings = JSON.parse('{"version":1,"crop":{"x":0,"y":0,"width":"all","height":10}}') as PipelineSpec;
  assert.throws(() => SImg.pipeline(fromSettings), { name: 'InvalidOptionError', message: /pipeline\.crop\.width/ });
});

// --- the emitted types ----------------------------------------------------------------

test('the no-any guard covers the emitted declarations', () => {
  // `any` in a .d.ts is how a strict library quietly stops being one, and it is only
  // visible in the BUILD output -- the source can be clean while an inferred return type
  // widens. scripts/guards.mjs greps dist/**/*.d.ts for it and test/guards.test.ts watches
  // that guard fail on a planted violation, so this is a pointer rather than a duplicate.
  assert.ok(true, 'enforced by scripts/guards.mjs, guard 4');
});
