/**
 * Resize, and the shrink-only preset mode. See features/resize.md and
 * features/max-long-edge.md.
 */

import { InvalidOptionError } from '../errors.ts';
import { createImage, type RawImage, type RGBA } from '../image.ts';
import { crop } from './crop.ts';
import { resampleTo, type Resampling } from './resample.ts';

/** The plugin's existing limits. */
const MIN_SIZE = 1;
const MAX_SIZE = 20000;

/** Shared with rotate's fill and the encoder's alpha compositing. One rule to learn. */
const DEFAULT_BACKGROUND: RGBA = [255, 255, 255, 255];

export interface ResizeOptions {
  width?: number;
  height?: number;
  /** Default true: the plugin's percentage chips go to 200%. */
  upscale?: boolean;
  /** Only meaningful when both width and height are given. Default 'fill'. */
  fit?: 'fill' | 'contain' | 'cover';
  /** Default 'bilinear'. */
  resampling?: Resampling;
  /** Only used by fit: 'contain'. Default white. */
  background?: RGBA;
}

/**
 * General-purpose resize. Allows upscaling; `maxLongEdge` is the shrink-only operation.
 *
 * @throws {InvalidOptionError} if no target is given, or a target is out of range
 */
/** The half of resize's validation that does not need an image. See assertCropOptions. */
export function assertResizeOptions(options: ResizeOptions): void {
  if (options.width === undefined && options.height === undefined) {
    throw new InvalidOptionError('resize', options, 'needs a width or a height');
  }
  if (options.width !== undefined) assertSize(options.width, 'resize.width');
  if (options.height !== undefined) assertSize(options.height, 'resize.height');
}

export function resize(image: RawImage, options: ResizeOptions): RawImage {
  const { fit = 'fill', resampling = 'bilinear', upscale = true, background = DEFAULT_BACKGROUND } = options;

  assertResizeOptions(options);

  const { width, height } = resolve(image, options);

  // "Unchanged", not "scale to the largest allowed size": any partial-scaling reading
  // would surprise a caller who wanted "shrink if needed".
  if (!upscale && (width > image.width || height > image.height)) {
    return { width: image.width, height: image.height, data: image.data.slice() };
  }
  if (width === image.width && height === image.height) {
    return { width, height, data: image.data.slice() };
  }

  if (options.width !== undefined && options.height !== undefined) {
    if (fit === 'contain') return contain(image, width, height, resampling, background);
    if (fit === 'cover') return cover(image, width, height, resampling);
  }

  return resampleTo(image, width, height, resampling);
}

/**
 * Shrink so the longest edge is at most `size`. Never enlarges. Aspect ratio preserved.
 *
 * Separate from `resize` rather than a flag on it, because the caller should not have
 * to know which edge is longer: a vault mixes portrait and landscape, and a width-based
 * API would push that branch into the plugin. `upscale: false` is a *guard* on an
 * operation that normally enlarges; this is an operation that structurally cannot.
 * Same word, different contract.
 *
 * @throws {InvalidOptionError} if `size` is out of range
 */
export function maxLongEdge(image: RawImage, size: number, resampling: Resampling = 'bilinear'): RawImage {
  assertSize(size, 'maxLongEdge.size');

  const longest = Math.max(image.width, image.height);
  // Already under the cap: return the same buffer, so capping a folder where most files
  // are already small costs almost nothing.
  if (longest <= size) return image;

  const scale = size / longest;
  return resampleTo(image, floorAt1(image.width * scale), floorAt1(image.height * scale), resampling);
}

/** Work out the real target from whichever dimensions were given. */
function resolve(image: RawImage, { width, height }: ResizeOptions): { width: number; height: number } {
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) return { width, height: floorAt1((width / image.width) * image.height) };

  // Only reachable with at least one dimension set: resize() rejects neither.
  const only = height!;
  return { width: floorAt1((only / image.height) * image.width), height: only };
}

/** Scale to fit inside the box, pad the remainder. Output is exactly width x height. */
function contain(
  image: RawImage,
  width: number,
  height: number,
  resampling: Resampling,
  background: RGBA,
): RawImage {
  const scale = Math.min(width / image.width, height / image.height);
  const inner = resampleTo(image, floorAt1(image.width * scale), floorAt1(image.height * scale), resampling);

  const out = createImage(width, height, background);
  const left = Math.floor((width - inner.width) / 2);
  const top = Math.floor((height - inner.height) / 2);

  for (let y = 0; y < inner.height; y++) {
    const from = y * inner.width * 4;
    out.data.set(inner.data.subarray(from, from + inner.width * 4), ((top + y) * width + left) * 4);
  }

  return out;
}

/** Scale to fill the box, centre-crop the overflow. Output is exactly width x height. */
function cover(image: RawImage, width: number, height: number, resampling: Resampling): RawImage {
  const scale = Math.max(width / image.width, height / image.height);
  const scaled = resampleTo(image, floorAt1(image.width * scale), floorAt1(image.height * scale), resampling);

  // Reuses crop rather than duplicating the rectangle copy.
  return crop(scaled, {
    x: Math.floor((scaled.width - width) / 2),
    y: Math.floor((scaled.height - height) / 2),
    width: Math.min(width, scaled.width),
    height: Math.min(height, scaled.height),
  });
}

/** A derived dimension rounds, but never to zero: there is no 0-pixel image. */
function floorAt1(value: number): number {
  return Math.max(1, Math.round(value));
}

function assertSize(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new InvalidOptionError(name, value, 'must be an integer');
  }
  if (value < MIN_SIZE || value > MAX_SIZE) {
    // Throw rather than clamp: silently returning 20000 when the caller asked for 50000
    // means their aspect-ratio maths is wrong and nobody finds out until it looks
    // stretched.
    throw new InvalidOptionError(name, value, `must be between ${MIN_SIZE} and ${MAX_SIZE}`);
  }
}
