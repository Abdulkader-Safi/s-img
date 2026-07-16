import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImage } from '../../../src/core/image.ts';
import { resize, maxLongEdge } from '../../../src/core/transform/resize.ts';
import { rotate } from '../../../src/core/transform/rotate.ts';
import { SImg } from '../../../src/core/simg.ts';
import { RESAMPLING, type Resampling } from '../../../src/core/transform/resample.ts';

// features/type-safety.md: "the types are for the developer at 3pm, the validation is for
// production at 3am." Every other option validates -- quality, angle, crop, dimensions --
// and `resampling` did not. It silently fell through to a default.
//
// Found by writing examples/tour.ts with `resampling: 'bicubic'`, which is not a kernel
// this library has. It ran. It produced a perfectly good image, resampled with something
// other than what was asked for, and nothing anywhere said a word. The example was not
// typechecked (examples/ was outside tsconfig, now fixed) -- but a plain JS caller or a
// settings file has no types either, which is the whole point of validating.
//
// The spec path is the one that matters: `{"resize":{"resampling":"bicubic"}}` out of a
// settings file is untrusted input, and "quietly ignore it" is the worst possible answer.

const img = (): ReturnType<typeof createImage> => {
  const out = createImage(20, 20);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 200;
    out.data[i + 3] = 255;
  }
  return out;
};

// Every way a bad value arrives: a typo, a plausible-but-absent kernel, wrong case, wrong
// type, and null (which is what JSON.parse produces and `undefined` never is).
const BAD = ['bicubic', 'nonsense', 'NEAREST', 'Lanczos3', 42, null, {}] as const;

test('resize rejects a resampling kernel it does not have', () => {
  for (const bad of BAD) {
    assert.throws(
      () => resize(img(), { width: 10, resampling: bad as unknown as Resampling }),
      { name: 'InvalidOptionError', message: /resize\.resampling/ },
      `resize accepted ${JSON.stringify(bad)}`,
    );
  }
});

test('rotate rejects a resampling kernel it does not have', () => {
  for (const bad of BAD) {
    assert.throws(
      () => rotate(img(), 10, { resampling: bad as unknown as Resampling }),
      { name: 'InvalidOptionError', message: /rotate\.resampling/ },
      `rotate accepted ${JSON.stringify(bad)}`,
    );
  }
});

test('maxLongEdge rejects one too, since it takes the kernel directly', () => {
  assert.throws(() => maxLongEdge(img(), 10, 'bicubic' as unknown as Resampling), { name: 'InvalidOptionError' });
});

test('a spec out of a settings file is checked before it can silently degrade', () => {
  // The trust boundary, and the reason this is a bug rather than a nicety. A stored spec
  // asking for lanczos3 with a typo would produce bilinear output forever, and the only
  // symptom is that the images are slightly softer than someone expected.
  const fromSettings = JSON.parse('{"version":1,"resize":{"maxLongEdge":100,"resampling":"bicubic"}}');
  assert.throws(() => SImg.pipeline(fromSettings), { name: 'InvalidOptionError', message: /resampling/ });
});

test('the message says what was wanted, not just that it was wrong', () => {
  // A caller who typed 'bicubic' needs to know the list, not that they are wrong.
  const err = (() => {
    try {
      resize(img(), { width: 10, resampling: 'bicubic' as unknown as Resampling });
      return undefined;
    } catch (e) {
      return e as Error;
    }
  })();
  assert.ok(err !== undefined);
  assert.match(err.message, /bicubic/, 'the message does not say what it got');
  for (const kernel of RESAMPLING) assert.match(err.message, new RegExp(kernel), `the message does not offer ${kernel}`);
});

test('every kernel the library claims to have actually works', () => {
  // The other half: a validator is also a place to accidentally reject something valid.
  // RESAMPLING is the single source of truth -- the type is derived from it -- so this
  // cannot drift out of sync with the union the way a hand-written list would.
  for (const kernel of RESAMPLING) {
    assert.equal(resize(img(), { width: 10, resampling: kernel }).width, 10, `resize rejected ${kernel}`);
    assert.ok(rotate(img(), 10, { resampling: kernel }).width > 0, `rotate rejected ${kernel}`);
  }
});

test('omitting it is still fine', () => {
  assert.equal(resize(img(), { width: 10 }).width, 10);
  assert.ok(rotate(img(), 10, {}).width > 0);
  assert.ok(rotate(img(), 10).width > 0);
});

// --- the wider hole ---------------------------------------------------------------------

test('the resize stage is validated at all, which it was not', () => {
  // Chasing the resampling bug turned up that validateSpec never looked at `resize`. Every
  // one of these reached applySpec and threw from inside a transform at RUN time -- or, for
  // `fit`, did not throw and just silently did the wrong thing.
  //
  // The README promises this exact behaviour: "it throws InvalidOptionError naming the
  // field rather than failing weirdly three steps later." It has to be true.
  const cases: [string, RegExp][] = [
    ['{"version":1,"resize":{"maxLongEdge":"banana"}}', /pipeline\.resize\.maxLongEdge/],
    ['{"version":1,"resize":{"width":"800"}}', /pipeline\.resize\.width/],
    ['{"version":1,"resize":{"height":null}}', /pipeline\.resize\.height/],
    ['{"version":1,"resize":{"width":100,"fit":"squish"}}', /pipeline\.resize\.fit/],
    ['{"version":1,"resize":{"width":100,"upscale":"yes"}}', /pipeline\.resize\.upscale/],
    ['{"version":1,"resize":{"width":100,"resampling":"bicubic"}}', /pipeline\.resize\.resampling/],
    ['{"version":1,"resize":null}', /pipeline\.resize/],
    ['{"version":1,"resize":[]}', /pipeline\.resize/],
    ['{"version":1,"resize":{}}', /maxLongEdge, a width, or a height/],
  ];
  for (const [json, message] of cases) {
    assert.throws(() => SImg.pipeline(JSON.parse(json)), { name: 'InvalidOptionError', message }, `accepted ${json}`);
  }
});

test('a valid resize stage still round-trips, in both of its shapes', () => {
  // The other half of a validator: not rejecting what is real. ResizeStage is a union --
  // a cap or a real resize -- and both have to survive JSON.
  for (const json of [
    '{"version":1,"resize":{"maxLongEdge":100}}',
    '{"version":1,"resize":{"maxLongEdge":100,"resampling":"lanczos3"}}',
    '{"version":1,"resize":{"width":100}}',
    '{"version":1,"resize":{"width":100,"height":80,"fit":"contain","upscale":false,"resampling":"nearest"}}',
  ]) {
    const spec = JSON.parse(json);
    assert.deepEqual(SImg.pipeline(spec).toJSON(), spec, `${json} did not survive`);
  }
});
