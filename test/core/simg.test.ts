import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SImg } from '../../src/core/simg.ts';
import { decode, encode } from '../../src/core/dispatch.ts';
import { createImage } from '../../src/core/image.ts';
import { SImgError } from '../../src/core/errors.ts';
import { applySpec, type PipelineSpec } from '../../src/core/pipeline.ts';
import { crop } from '../../src/core/transform/crop.ts';
import { flip } from '../../src/core/transform/flip.ts';
import { resize } from '../../src/core/transform/resize.ts';
import { rotate } from '../../src/core/transform/rotate.ts';

// features/api-surface.md, features/pipeline-order.md, features/batch-pipeline.md.
//
// One implementation, so one test file: the chain and the Pipeline are a spec builder and
// an executor, and the tests that matter are about the spec, the order, and the two shapes
// not drifting apart.

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const read = (path: string) => new Uint8Array(readFileSync(`${FIXTURES}${path}`));
const photo = () => read('jpeg/photo.jpg'); // 40x28

async function rejects(fn: () => Promise<unknown>, code: string): Promise<SImgError> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SImgError, `expected an SImgError, got ${String(err)}`);
  assert.equal(err.code, code);
  return err;
}

// --- the PRD's example ---------------------------------------------------------------

test("the PRD's example compiles and runs, verbatim", async () => {
  // features/api-surface.md's acceptance criterion, with SImg and safi-image substituted for
  // the PRD's placeholders. If this stops compiling, the headline API changed.
  const inputBuffer = read('png/rgba8.png'); // 16x16, so the crop below has to be smaller
  const out = await SImg.fromBuffer(inputBuffer)
    .crop({ x: 1, y: 1, width: 12, height: 10 })
    .rotate(15)
    .flip({ horizontal: true })
    .resize({ width: 8, upscale: false })
    .stripMetadata()
    .toFormat('webp', { quality: 80 })
    .toBuffer();

  const img = await decode(out);
  assert.equal(img.width, 8);
});

// --- laziness ------------------------------------------------------------------------

test('no method on the chain does any work until toBuffer is awaited', async () => {
  // Nothing decodes, nothing allocates, nothing throws a codec error. The chain records
  // intent. Built on bytes that are not an image at all, and it still costs nothing.
  const chain = SImg.fromBuffer(new Uint8Array([1, 2, 3])).crop({ x: 0, y: 0, width: 4, height: 4 }).rotate(15);
  assert.ok(chain instanceof Object, 'building the chain on garbage bytes threw');

  // ...and the failure lands on toBuffer, where the work is.
  await rejects(() => chain.toBuffer(), 'UNSUPPORTED_FORMAT');
});

test('a chain can be built and never executed, and nothing happens', () => {
  SImg.fromBuffer(photo()).crop({ x: 0, y: 0, width: 10, height: 10 }).resize({ width: 5 }).toFormat('png');
  assert.ok(true, 'no decode, no allocation, no error');
});

test('option mistakes throw synchronously, at the call site', async () => {
  // The distinction features/api-surface.md draws: a caller mistake is visible where it is
  // made, an ENVIRONMENT failure can only be found by trying. So crop validates eagerly...
  assert.throws(() => SImg.fromBuffer(photo()).crop({ x: 0, y: 0, width: -5, height: 10 }), {
    name: 'InvalidOptionError',
  });
  assert.throws(() => SImg.fromBuffer(photo()).rotate(Number.NaN), { name: 'InvalidOptionError' });
});

// --- the canonical order: the whole feature -------------------------------------------

test('rotate-then-crop and crop-then-rotate produce byte-identical output', async () => {
  // features/pipeline-order.md calls this "the whole feature in one test".
  const rect = { x: 4, y: 3, width: 20, height: 14 };
  const a = await SImg.fromBuffer(photo()).rotate(15).crop(rect).toFormat('png').toBuffer();
  const b = await SImg.fromBuffer(photo()).crop(rect).rotate(15).toFormat('png').toBuffer();
  assert.deepEqual(a, b);
});

test('every permutation of the five stages produces identical output', async () => {
  // 120 orderings. The definitive proof, and it is a loop.
  //
  // The operations do not commute -- crop then resize is a different region from resize
  // then crop, rotate then flip is a different image from flip then rotate for any non-180
  // angle -- so if call order leaked into the result at all, this fails loudly.
  type Step = (c: ReturnType<typeof SImg.fromBuffer>) => unknown;
  const STEPS: readonly (readonly [name: string, apply: Step])[] = [
    ['crop', (c) => c.crop({ x: 4, y: 3, width: 20, height: 14 })],
    ['rotate', (c) => c.rotate(15)],
    ['flip', (c) => c.flip({ horizontal: true })],
    ['resize', (c) => c.resize({ width: 12 })],
    ['format', (c) => c.toFormat('png')],
  ];

  const permutations = <T,>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

  const orderings = permutations(STEPS);
  assert.equal(orderings.length, 120, 'the permutation generator is wrong');

  const expected = await SImg.fromBuffer(photo())
    .crop({ x: 4, y: 3, width: 20, height: 14 })
    .rotate(15)
    .flip({ horizontal: true })
    .resize({ width: 12 })
    .toFormat('png')
    .toBuffer();

  for (const ordering of orderings) {
    const chain = SImg.fromBuffer(photo());
    for (const [, apply] of ordering) apply(chain);
    assert.deepEqual(await chain.toBuffer(), expected, `order: ${ordering.map(([n]) => n).join(' -> ')}`);
  }
});

test('the executor applies crop, rotate, flip, resize, in that order', async () => {
  // The permutation test above CANNOT catch a wrong order, which is worth stating plainly
  // because it looks like it should. It compares a chain against a chain, both running
  // through the same executor, so it proves call order does not leak into the result --
  // and is completely blind to whether the executor's own order is the documented one.
  // Reorder the stages in applySpec and all 120 orderings still agree with each other.
  //
  // Mutation testing proved it: "skip flip entirely" and "skip rotate when resize is also
  // set" both survived the 120 orderings. So this pins the order against the transforms
  // composed by hand, which is the only thing that can.
  const img = await decode(photo());
  const spec: PipelineSpec = {
    crop: { x: 4, y: 3, width: 20, height: 14 },
    rotate: { angle: 15 },
    flip: { horizontal: true },
    resize: { width: 12 },
  };

  const expected = resize(flip(rotate(crop(img, spec.crop!), 15), { horizontal: true }), { width: 12 });
  const actual = applySpec(img, spec);

  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
  assert.deepEqual(actual.data, expected.data);
});

test('a stage the spec omits is skipped, not applied as an identity', async () => {
  // An absent field is a skipped stage. On a spec that only sets `format`, the pixel data
  // is never touched at all -- which is the batch case, where most files just get
  // re-encoded, and where a stray identity copy would be a full-image allocation per file.
  const img = await decode(photo());
  const out = applySpec(img, { format: { format: 'png' } });
  assert.equal(out, img, 'a format-only spec copied the pixel buffer');
});

// --- last call wins ------------------------------------------------------------------

test('calling a method twice replaces the earlier call', async () => {
  // Not "apply both in sequence". The user dragging a slider generates a hundred calls and
  // means the last one.
  const img = await decode(await SImg.fromBuffer(photo()).resize({ width: 8 }).resize({ width: 20 }).toFormat('png').toBuffer());
  assert.equal(img.width, 20);
});

test('resize and maxLongEdge share a slot, and the last of either wins', async () => {
  // They are the same stage. 40x28 photo: maxLongEdge(20) caps the 40.
  const capped = await decode(await SImg.fromBuffer(photo()).resize({ width: 8 }).maxLongEdge(20).toFormat('png').toBuffer());
  assert.deepEqual([capped.width, capped.height], [20, 14], 'maxLongEdge should have won');

  const resized = await decode(await SImg.fromBuffer(photo()).maxLongEdge(20).resize({ width: 8 }).toFormat('png').toBuffer());
  assert.equal(resized.width, 8, 'resize should have won');
});

test('the last toFormat wins', async () => {
  const out = await SImg.fromBuffer(photo()).toFormat('gif').toFormat('png').toBuffer();
  assert.deepEqual([...out.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('format options reach the encoder', async () => {
  // The pipeline must not swallow them: same image, two qualities, and the low one has to
  // be meaningfully smaller or nothing is getting through.
  const low = await SImg.fromBuffer(photo()).toFormat('jpeg', { quality: 20 }).toBuffer();
  const high = await SImg.fromBuffer(photo()).toFormat('jpeg', { quality: 95 }).toBuffer();
  assert.ok(low.length < high.length * 0.6, `q20 ${low.length} vs q95 ${high.length}`);
});

test('the last crop wins, rather than cropping the crop', async () => {
  const img = await decode(
    await SImg.fromBuffer(photo())
      .crop({ x: 0, y: 0, width: 30, height: 20 })
      .crop({ x: 0, y: 0, width: 10, height: 8 })
      .toFormat('png')
      .toBuffer(),
  );
  assert.deepEqual([img.width, img.height], [10, 8]);
});

// --- defaults ------------------------------------------------------------------------

test('no toFormat means the output keeps the source format', async () => {
  // Re-encoding a JPEG as a PNG because the caller forgot to say would turn a 200 KB photo
  // into 4 MB. Checked for every format, since the source is read from the bytes.
  const CASES = [
    ['png/rgba8.png', [0x89, 0x50, 0x4e, 0x47]],
    ['jpeg/s420.jpg', [0xff, 0xd8, 0xff]],
    ['gif/basic.gif', [0x47, 0x49, 0x46, 0x38]],
    ['bmp/rgb24.bmp', [0x42, 0x4d]],
    ['webp/lossless.webp', [0x52, 0x49, 0x46, 0x46]],
  ] as const;

  for (const [path, magic] of CASES) {
    const out = await SImg.fromBuffer(read(path)).toBuffer();
    assert.deepEqual([...out.subarray(0, magic.length)], [...magic], path);
  }
});

test('an empty chain decodes and re-encodes, which is legal and not a no-op', async () => {
  // Worth a doc note rather than an error: a JPEG loses a little on the way through.
  const out = await SImg.fromBuffer(photo()).toBuffer();
  assert.deepEqual([...out.subarray(0, 3)], [0xff, 0xd8, 0xff], 'still a JPEG');
  assert.notDeepEqual(out, photo(), 'a re-encode is not a byte copy');
});

test('toBuffer twice runs twice and returns the same bytes', async () => {
  const chain = SImg.fromBuffer(photo()).resize({ width: 10 }).toFormat('png');
  assert.deepEqual(await chain.toBuffer(), await chain.toBuffer());
});

test('background fills the corners a rotation creates', async () => {
  // Onto PNG, which HAS alpha, so nothing is composited on encode: if the corner is red
  // here, it is red because rotate filled it. Testing this against a JPEG cannot tell the
  // two apart -- a transparent corner composited onto the same red is also red, and the
  // mutant that stops passing background to rotate survives.
  const out = await SImg.fromBuffer(photo()).rotate(45).background([255, 0, 0, 255]).toFormat('png').toBuffer();
  const img = await decode(out);
  assert.deepEqual([...img.data.subarray(0, 4)], [255, 0, 0, 255], 'the rotation corner');
});

test('background is what transparency composites onto for a format with no alpha', async () => {
  // The same option, the other half of its job. No rotate here, so the transparency comes
  // from the source and only the encoder can deal with it.
  const transparent = createImage(4, 4); // createImage zeroes: fully transparent
  const png = await encode(transparent, 'png');

  const onto = await SImg.fromBuffer(png).background([255, 0, 0, 255]).toFormat('jpeg').toBuffer();
  const img = await decode(onto);
  assert.ok(img.data[0]! > 200 && img.data[1]! < 60, `composited onto rgb(${img.data[0]}, ${img.data[1]}, ${img.data[2]})`);

  // ...and white when nothing is set, which is the documented default.
  const bare = await decode(await SImg.fromBuffer(png).toFormat('jpeg').toBuffer());
  assert.deepEqual([...bare.data.subarray(0, 4)], [255, 255, 255, 255]);
});

test('one background covers rotation fill and compositing at once', async () => {
  // The reason it is one option: a user should not learn two rules for the same idea.
  const out = await SImg.fromBuffer(photo()).rotate(45).background([0, 0, 255, 255]).toFormat('jpeg').toBuffer();
  const img = await decode(out);
  assert.ok(img.data[2]! > 200 && img.data[0]! < 60, `corner was rgb(${img.data[0]}, ${img.data[1]}, ${img.data[2]})`);
});

// --- the Pipeline ---------------------------------------------------------------------

test('one pipeline runs over many different inputs', async () => {
  // The save-all case. Mixed input formats, no toFormat, so each file keeps its own -- the
  // correct and possibly surprising behaviour for a batch.
  const p = SImg.pipeline().maxLongEdge(12).stripMetadata();
  const inputs = ['png/rgba8.png', 'jpeg/s420.jpg', 'gif/basic.gif', 'bmp/rgb24.bmp', 'tiff/rgb-none.tif'];

  for (const path of inputs) {
    const img = await decode(await p.run(read(path)));
    assert.ok(Math.max(img.width, img.height) <= 12, path);
  }
});

test('a pipeline is stateless, so two runs share nothing', async () => {
  const p = SImg.pipeline().resize({ width: 10 }).toFormat('png');
  const [a, b] = await Promise.all([p.run(photo()), p.run(photo())]);
  assert.deepEqual(a, b);
});

test('a corrupt file throws only for that file, and the loop continues', async () => {
  // One file in thirty is corrupt. The library throws from that run(); whether the batch
  // aborts is the plugin's decision, because the plugin is the thing with a progress bar.
  const p = SImg.pipeline().toFormat('png');
  const files = [photo(), new Uint8Array([1, 2, 3]), photo()];
  const results: string[] = [];

  for (const bytes of files) {
    try {
      await p.run(bytes);
      results.push('ok');
    } catch (e) {
      results.push((e as SImgError).code);
    }
  }
  assert.deepEqual(results, ['ok', 'UNSUPPORTED_FORMAT', 'ok']);
});

// --- serialisation ---------------------------------------------------------------------

test('a spec round-trips through JSON with no loss', async () => {
  // The real requirement: the plugin's presets live in its settings file and have to
  // survive a reload.
  const p = SImg.pipeline().maxLongEdge(1600).stripMetadata().toFormat('webp', { quality: 80 });
  const spec = p.toJSON();

  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec, 'the spec is not plain data');
  assert.deepEqual(spec, {
    version: 1,
    resize: { maxLongEdge: 1600 },
    stripMetadata: true,
    format: { format: 'webp', options: { quality: 80 } },
  });
});

test('a restored pipeline produces byte-identical output to the original', async () => {
  const p = SImg.pipeline().crop({ x: 2, y: 2, width: 20, height: 14 }).rotate(15).toFormat('png');
  const restored = SImg.pipeline(JSON.parse(JSON.stringify(p.toJSON())) as PipelineSpec);
  assert.deepEqual(await restored.run(photo()), await p.run(photo()));
});

test('toJSON returns a copy, so a caller cannot mutate the pipeline it came from', async () => {
  const p = SImg.pipeline().resize({ width: 10 });
  const spec = p.toJSON();
  spec.resize = { width: 999 };
  assert.deepEqual(p.toJSON().resize, { width: 10 });
});

test('a background tuple survives the round trip as an array', async () => {
  const p = SImg.pipeline().background([1, 2, 3, 4]);
  const restored = SImg.pipeline(JSON.parse(JSON.stringify(p.toJSON())) as PipelineSpec);
  assert.deepEqual(restored.toJSON().background, [1, 2, 3, 4]);
});

// --- the spec is a trust boundary -----------------------------------------------------

test('a corrupt spec throws INVALID_OPTION naming the field', () => {
  // A settings file may be from an older plugin, hand-edited, or corrupt. Types are not
  // validation: they do not survive JSON.parse.
  const CASES: readonly (readonly [spec: unknown, field: RegExp])[] = [
    [{ crop: { x: 0, y: 0, width: 'lots' } }, /pipeline\.crop\.width/],
    [{ crop: { x: 0, y: 0 } }, /pipeline\.crop\.width/],
    [{ rotate: { angle: 'sideways' } }, /pipeline\.rotate\.angle/],
    [{ format: { format: 'heic' } }, /pipeline\.format\.format/],
    [{ format: { format: 42 } }, /pipeline\.format\.format/],
    [{ stripMetadata: 'yes' }, /pipeline\.stripMetadata/],
    [{ background: [1, 2, 3] }, /pipeline\.background/],
    [{ background: 'red' }, /pipeline\.background/],
    [{ sharpen: true }, /pipeline\.sharpen/],
    ['not an object', /pipeline/],
    [null, /pipeline/],
    [[], /pipeline/],
  ];

  for (const [spec, field] of CASES) {
    assert.throws(() => SImg.pipeline(spec as PipelineSpec), { name: 'InvalidOptionError', message: field }, JSON.stringify(spec));
  }
});

test('an unknown version throws rather than being best-effort parsed', () => {
  assert.throws(() => SImg.pipeline({ version: 2 } as unknown as PipelineSpec), {
    name: 'InvalidOptionError',
    message: /pipeline\.version/,
  });
});

test('a valid spec from JSON is accepted', () => {
  const fromSettings = JSON.parse('{"version":1,"resize":{"maxLongEdge":800},"format":{"format":"webp"}}') as PipelineSpec;
  assert.ok(SImg.pipeline(fromSettings));
});

// --- the two shapes must not drift ----------------------------------------------------

test('the chain and the Pipeline produce byte-identical output', async () => {
  // They share the executor, so this is really a regression test against them growing
  // apart. If it ever fails, one of them has its own copy of the order.
  const rect = { x: 2, y: 2, width: 20, height: 14 };

  const chained = await SImg.fromBuffer(photo())
    .crop(rect)
    .rotate(15)
    .flip({ vertical: true })
    .maxLongEdge(16)
    .toFormat('png')
    .toBuffer();

  const piped = await SImg.pipeline()
    .crop(rect)
    .rotate(15)
    .flip({ vertical: true })
    .maxLongEdge(16)
    .toFormat('png')
    .run(photo());

  assert.deepEqual(chained, piped);
});

test('the chain and a hand-written spec produce byte-identical output', async () => {
  const spec: PipelineSpec = {
    version: 1,
    crop: { x: 2, y: 2, width: 20, height: 14 },
    rotate: { angle: 15 },
    format: { format: 'png' },
  };
  const fromSpec = await SImg.pipeline(spec).run(photo());
  const fromChain = await SImg.fromBuffer(photo()).crop(spec.crop!).rotate(15).toFormat('png').toBuffer();
  assert.deepEqual(fromSpec, fromChain);
});
