/**
 * The pipeline: a plain spec, and one function that reads it in a fixed order.
 * See features/pipeline-order.md and features/batch-pipeline.md.
 *
 * The canonical order -- crop, rotate, flip, resize, format -- is not a convenience. It is
 * a correctness feature, and it is the plugin's existing behaviour on purpose. The
 * operations genuinely do not commute:
 *
 *   crop then resize != resize then crop      (different regions)
 *   rotate then flip != flip then rotate      (for any non-180 angle)
 *   rotate then crop != crop then rotate      (rotate moves the coordinate space)
 *
 * Every one of those is a real, silent, wrong-output bug. The classic is resize-then-crop:
 * the user drags a crop box on a 1200px preview, the pipeline resizes to 600px first, and
 * the rectangle now cuts a region twice as large from the wrong part of the image. It does
 * not throw and it does not look broken -- it quietly crops the wrong thing, and nobody
 * notices until they look closely at a photo they saved last week.
 *
 * The order lives HERE, in the executor, and not in the spec. The spec is a record with one
 * slot per operation and no order information in it at all, so there is nowhere for a caller
 * to express an order and therefore no way for them to get it wrong.
 */

import { decode, encode, type FormatOptions } from './dispatch.ts';
import { InvalidOptionError } from './errors.ts';
import { FORMATS, sniff, type Format } from './formats.ts';
import { type RawImage, type RGBA } from './image.ts';
import { crop, type CropOptions } from './transform/crop.ts';
import { flip, type FlipOptions } from './transform/flip.ts';
import { maxLongEdge, resize, type ResizeOptions } from './transform/resize.ts';
import { type Resampling } from './transform/resample.ts';
import { rotate, type RotateOptions } from './transform/rotate.ts';

/** resize() and maxLongEdge() share a slot: they are the same stage. Last of either wins. */
export type ResizeStage = ResizeOptions | { maxLongEdge: number; resampling?: Resampling };

/**
 * Everything a pipeline can do, as a value.
 *
 * A plain object of plain values: no functions, no class instances, no buffers. That is the
 * real requirement, not a nicety -- the plugin's presets live in its settings JSON and have
 * to survive a reload, so `JSON.parse(JSON.stringify(spec))` must round-trip exactly.
 */
export interface PipelineSpec {
  /**
   * Costs one line today, and is the difference between a clean migration and a guessing
   * game when the shape changes. An unknown version is an error, not a best-effort parse.
   */
  version?: 1;
  crop?: CropOptions;
  rotate?: { angle: number } & RotateOptions;
  flip?: FlipOptions;
  resize?: ResizeStage;
  format?: { format: Format; options?: FormatOptions<Format> };
  /**
   * Effectively always true (features/strip-metadata.md): decode drops metadata at the
   * boundary, so there is never anything for an encoder to write. It is here so the
   * plugin's toggle has somewhere to go, and so the day someone adds metadata preservation
   * this is the flag that turns it back off.
   */
  stripMetadata?: boolean;
  /** Shared by rotate's fill and the alpha compositing on a format with no alpha. */
  background?: RGBA;
}

/** The only version this library speaks. */
const VERSION = 1;

/**
 * Apply the geometric stages, in the canonical order, and nothing else.
 *
 * Read top to bottom: the field order below IS the documented order, and keeping this to
 * one short function is what keeps that checkable by eye rather than by archaeology.
 *
 * An absent field is a SKIPPED stage, not an identity operation. No `crop` means no copy.
 * On a spec that only sets `format`, this returns the input untouched and the pixel data is
 * never copied at all -- which is the batch case, where most files just get re-encoded.
 */
export function applySpec(image: RawImage, spec: PipelineSpec): RawImage {
  let out = image;

  // 1. Crop first. The user drew the rectangle on the image as they see it, which is the
  //    source. Everything after it also works on less data, which is free performance on
  //    the expensive stages.
  if (spec.crop !== undefined) out = crop(out, spec.crop);

  // 2. Rotate second, on the cropped frame. Before resize, so the resize is the final
  //    quality pass on the rotated result rather than stacking two lots of blur.
  if (spec.rotate !== undefined) {
    const { angle, ...options } = spec.rotate;
    // The pipeline's background is the default; the stage's own wins if it set one. Built
    // conditionally rather than spread over an undefined, because exactOptionalPropertyTypes
    // draws a real distinction between "absent" and "present and undefined".
    out = rotate(out, angle, spec.background === undefined ? options : { background: spec.background, ...options });
  }

  // 3. Flip third. Cheap and exact, so its position barely matters for quality -- it
  //    matters for matching the plugin's existing rotate-then-flip semantics, because
  //    users who rotate and flip have a mental model and it is the plugin's.
  if (spec.flip !== undefined) out = flip(out, spec.flip);

  // 4. Resize last of the geometry, so the final resample decides the output's sharpness.
  if (spec.resize !== undefined) {
    const stage = spec.resize;
    out = isMaxLongEdge(stage)
      ? maxLongEdge(out, stage.maxLongEdge, stage.resampling)
      : resize(out, spec.background === undefined ? stage : { background: spec.background, ...stage });
  }

  return out;
}

/**
 * Decode, apply, encode. The whole library in one line, and the only path either the chain
 * or a Pipeline takes.
 *
 * No `format` means encode back to the SOURCE format. Re-encoding a JPEG as a PNG because
 * the caller forgot to say would turn a 200 KB photo into 4 MB, which is a nasty surprise
 * for a "just crop this and save it" edit. The source format is read from the bytes rather
 * than carried on the RawImage, which keeps features/raw-image.md clean.
 */
export async function runPipeline(spec: PipelineSpec, bytes: Uint8Array): Promise<Uint8Array> {
  const image = await decode(bytes);
  const out = applySpec(image, spec);

  // sniff() cannot be undefined here: decode already threw if it were.
  const format = spec.format?.format ?? sniff(bytes)!;
  const options = spec.format?.options ?? {};

  // `background` is the pipeline's, shared by rotate's fill and the compositing an
  // alpha-less format does -- one rule, so a user does not learn two. A format that takes
  // no background (png, gif, webp) must not be handed one, since encode rejects unknown
  // options by design.
  const takesBackground = format === 'jpeg' || format === 'bmp';
  const merged =
    spec.background !== undefined && takesBackground ? { background: spec.background, ...options } : options;

  return encode(image === out ? image : out, format, merged as FormatOptions<Format>);
}

/** Distinguishes the two shapes sharing the resize slot. */
function isMaxLongEdge(stage: ResizeStage): stage is { maxLongEdge: number; resampling?: Resampling } {
  return 'maxLongEdge' in stage;
}

/**
 * Check a spec that has never met the compiler.
 *
 * A trust boundary, and it gets the same treatment as decode's magic bytes: a spec from a
 * settings file may be from an older plugin, hand-edited, or corrupt. Types are not
 * validation -- they do not survive JSON.parse.
 *
 * Deliberately shallow. It checks the SHAPE and the fields a bad value would let through
 * silently; it does not re-implement each transform's own validation, because crop() and
 * rotate() already throw precise errors and duplicating them here is two places to be
 * wrong. What it must catch is a field that would otherwise be quietly ignored.
 *
 * @throws {InvalidOptionError} naming the offending field
 */
export function validateSpec(spec: unknown): PipelineSpec {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new InvalidOptionError('pipeline', spec, 'must be an object');
  }
  const s = spec as Record<string, unknown>;

  if (s['version'] !== undefined && s['version'] !== VERSION) {
    throw new InvalidOptionError('pipeline.version', s['version'], `is not a version this library understands (${VERSION})`);
  }

  const KNOWN = ['version', 'crop', 'rotate', 'flip', 'resize', 'format', 'stripMetadata', 'background'];
  for (const key of Object.keys(s)) {
    if (!KNOWN.includes(key)) {
      throw new InvalidOptionError(`pipeline.${key}`, s[key], `is not a pipeline stage (expected one of ${KNOWN.join(', ')})`);
    }
  }

  if (s['crop'] !== undefined) {
    for (const field of ['x', 'y', 'width', 'height']) {
      const value = (s['crop'] as Record<string, unknown> | null)?.[field];
      if (typeof value !== 'number') {
        throw new InvalidOptionError(`pipeline.crop.${field}`, value, 'must be a number');
      }
    }
  }

  if (s['rotate'] !== undefined) {
    const angle = (s['rotate'] as Record<string, unknown> | null)?.['angle'];
    if (typeof angle !== 'number') throw new InvalidOptionError('pipeline.rotate.angle', angle, 'must be a number');
  }

  if (s['format'] !== undefined) {
    const format = (s['format'] as Record<string, unknown> | null)?.['format'];
    if (typeof format !== 'string' || !FORMATS.includes(format as Format)) {
      throw new InvalidOptionError('pipeline.format.format', format, `must be one of ${FORMATS.join(', ')}`);
    }
  }

  if (s['stripMetadata'] !== undefined && typeof s['stripMetadata'] !== 'boolean') {
    throw new InvalidOptionError('pipeline.stripMetadata', s['stripMetadata'], 'must be a boolean');
  }

  // Serialises as an array and restores as an array, so the validator has to accept one
  // back. A 3-element tuple is the classic thing to hand-write into a settings file.
  if (s['background'] !== undefined) {
    const bg = s['background'];
    if (!Array.isArray(bg) || bg.length !== 4 || bg.some((v) => typeof v !== 'number')) {
      throw new InvalidOptionError('pipeline.background', bg, 'must be an [r, g, b, a] array of four numbers');
    }
  }

  return s as PipelineSpec;
}
