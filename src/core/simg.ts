/**
 * The public API: the chained builder and the reusable pipeline.
 * See features/api-surface.md and features/batch-pipeline.md.
 *
 * Both are sugar over one spec and one executor (features/pipeline-order.md), which is the
 * point rather than an implementation detail:
 *
 *   SImg.fromBuffer(b).crop(r).toBuffer()   and   SImg.pipeline({ crop: r }).run(b)
 *
 * are literally the same code path with the same spec. The chain is a spec builder with an
 * input attached. Two APIs, one implementation, and the batch case is not bolted on.
 *
 * ASYNC EVERYWHERE, signed off against features/api-surface.md's Q3. WebP's dynamic import
 * is inherently async, and a sync/async split would leak that implementation detail into
 * every call site -- the plugin would need `if (format === 'webp') await ... else ...`,
 * which is the library's problem wearing the caller's clothes. A `toBufferSync()` that
 * throws on WebP is a footgun that fires on exactly the format this project most wants
 * people to use. The cost is a Promise wrapper on work that could be synchronous:
 * microseconds against a 260ms rotate, and nobody will ever measure it.
 */

import { type FormatOptions } from './dispatch.ts';
import { type Format } from './formats.ts';
import { type RGBA } from './image.ts';
import { runPipeline, validateSpec, type PipelineSpec } from './pipeline.ts';
import { assertCropOptions, type CropOptions } from './transform/crop.ts';
import { type FlipOptions } from './transform/flip.ts';
import { assertResizeOptions, type ResizeOptions } from './transform/resize.ts';
import { type Resampling } from './transform/resample.ts';
import { assertRotateAngle, type RotateOptions } from './transform/rotate.ts';

/**
 * The stage-recording half of both public shapes.
 *
 * NO METHOD HERE DOES ANY WORK. They record intent and return `this`. Nothing decodes,
 * nothing allocates a pixel buffer, nothing throws a codec error, until the result is
 * asked for. Two consequences worth stating:
 *
 *   - Call order does not matter, because nothing runs in call order. That is what makes
 *     the canonical order possible rather than a lie.
 *   - The chain can be built once and executed never. Cheap.
 *
 * Calling a method twice replaces the earlier call rather than applying both: the spec has
 * one slot per operation, so a second call overwrites the slot. That falls straight out of
 * the data structure, and it is what a UI wants -- a user dragging the resize slider
 * generates a hundred calls and means the last one.
 */
abstract class Stages<T> {
  protected readonly spec: PipelineSpec;

  protected constructor(spec: PipelineSpec) {
    this.spec = spec;
  }

  /**
   * Crop to a rectangle inside the source image. Runs FIRST, whenever it is called.
   *
   * Validated here, eagerly, even though nothing runs until toBuffer(): a negative width
   * is a caller mistake and should surface on the line that made it. Only the numbers the
   * caller supplied are checked -- whether the rectangle FITS needs the image, so that
   * check stays in crop() where the image exists.
   */
  crop(rect: CropOptions): T {
    assertCropOptions(rect);
    this.spec.crop = rect;
    return this as unknown as T;
  }

  /** Rotate clockwise by any angle. Runs after crop, on the cropped frame. */
  rotate(angle: number, options: RotateOptions = {}): T {
    assertRotateAngle(angle);
    this.spec.rotate = { angle, ...options };
    return this as unknown as T;
  }

  /** Mirror on either or both axes. */
  flip(options: FlipOptions): T {
    this.spec.flip = options;
    return this as unknown as T;
  }

  /** Resize. Shares a slot with maxLongEdge: last of either wins. */
  resize(options: ResizeOptions): T {
    assertResizeOptions(options);
    this.spec.resize = options;
    return this as unknown as T;
  }

  /** Cap the long edge, whichever it is. Shares a slot with resize. */
  maxLongEdge(size: number, resampling?: Resampling): T {
    this.spec.resize = resampling === undefined ? { maxLongEdge: size } : { maxLongEdge: size, resampling };
    return this as unknown as T;
  }

  /**
   * Drop EXIF, GPS and colour profiles.
   *
   * Already the default and effectively a no-op: decode throws away everything that is not
   * pixels, so no encoder has anything to write. It exists because the plugin has this
   * toggle and the library should accept the call, because a documented method with tests
   * behind it is a stronger promise than "our decoder happens to drop it", and because the
   * day someone adds metadata preservation, this is what turns it off.
   */
  stripMetadata(): T {
    this.spec.stripMetadata = true;
    return this as unknown as T;
  }

  /**
   * The output format. Omit it and the output keeps the SOURCE format -- re-encoding a
   * JPEG as a PNG because the caller forgot to say would turn a 200 KB photo into 4 MB.
   */
  toFormat<F extends Format>(format: F, options?: FormatOptions<F>): T {
    this.spec.format = options === undefined ? { format } : { format, options: options as FormatOptions<Format> };
    return this as unknown as T;
  }

  /**
   * Fill colour: rotation's new corners, contain-padding, and the compositing an
   * alpha-less format does. One option and one default (white) for all three, so a user
   * does not learn two rules for the same idea.
   */
  background(colour: RGBA): T {
    this.spec.background = colour;
    return this as unknown as T;
  }

  /**
   * The spec as a plain object. No functions, no class instances, no buffers, so
   * `JSON.parse(JSON.stringify(spec))` round-trips exactly.
   *
   * A copy, so a caller holding it cannot mutate the pipeline it came from.
   */
  toJSON(): PipelineSpec {
    return { ...this.spec };
  }
}

/** A pipeline with an input attached. Built by `SImg.fromBuffer`. */
export class SImgChain extends Stages<SImgChain> {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    super({ version: 1 });
    this.#bytes = bytes;
  }

  /**
   * Run it. This is where every error that is not an option mistake surfaces: the decode,
   * the codec load, the encode.
   *
   * Not cached. Calling it twice runs it twice and produces the same bytes, because the
   * whole thing is deterministic -- just paid for twice. Caching would need a spec-dirty
   * check and nobody is calling it twice.
   */
  async toBuffer(): Promise<Uint8Array> {
    return runPipeline(this.spec, this.#bytes);
  }
}

/**
 * A pipeline with no input: the same config, N images.
 *
 * The plugin's save-all is what motivates this, but the real reason it is a value rather
 * than "call the chain N times" is that a preset has to live in a settings file. A chain
 * built by code is a function, and a function does not go in JSON.
 */
export class Pipeline extends Stages<Pipeline> {
  constructor(spec: PipelineSpec = {}) {
    // Validated on the way in, always: a spec from a settings file has never met the
    // compiler and may be from an older version, hand-edited, or corrupt.
    super({ version: 1, ...validateSpec(spec) });
  }

  /**
   * Run one image through it.
   *
   * Stateless: two run() calls share nothing but the spec, so a Pipeline is safe to hold
   * for the process lifetime and safe to use concurrently.
   *
   * A corrupt file throws from ITS run() and no other. Whether a batch aborts is a product
   * decision and belongs where the UI is -- which is what features/errors.md's `code` is
   * for: the plugin's catch block needs to tell "this file is corrupt, skip it" from "WebP
   * will not load, abort, because the other 29 will fail identically".
   *
   * On concurrency, for whoever writes that loop: these are CPU-bound synchronous
   * operations wearing async clothes. `Promise.all` over 30 files parallelises nothing and
   * holds 30 decoded images in memory at once, which is how you run out of it. A
   * sequential loop is genuinely faster and uses a thirtieth of the peak memory.
   */
  async run(bytes: Uint8Array): Promise<Uint8Array> {
    return runPipeline(this.spec, bytes);
  }
}

/**
 * The library's front door.
 *
 * `decode` and `encode` stay exported alongside it: the chain is sugar, and a caller who
 * wants to do something we did not think of should not have to fight the builder.
 */
export const SImg = {
  /** Start a chain from encoded bytes. */
  fromBuffer(bytes: Uint8Array): SImgChain {
    return new SImgChain(bytes);
  },

  /** Build a reusable pipeline, optionally from a stored spec. */
  pipeline(spec?: PipelineSpec): Pipeline {
    return new Pipeline(spec);
  },
} as const;
