/**
 * The pixel buffer. See features/raw-image.md.
 *
 * One flat, boring struct that every decoder produces, every transform consumes and
 * produces, and every encoder takes. It is the only currency in the library: if a
 * function needs to know anything about an image beyond these three fields, that
 * function is in the wrong layer.
 */

import { CorruptImageError, InvalidOptionError } from './errors.ts';

/**
 * RGBA, 8 bits per channel, row-major, top-left origin, no stride, non-premultiplied.
 *
 * Pixel `(x, y)` lives at `(y * width + x) * 4`.
 *
 * Every one of those is a decision, and each is argued in features/raw-image.md:
 *
 * - **RGBA always**, even for opaque images, so every transform is written once
 *   instead of once per pixel format. The 25% memory cost over RGB beats threading a
 *   `PixelFormat` enum through every function.
 * - **`Uint8ClampedArray`**, not `Buffer`. It works on Node, Bun and (later) the
 *   browser, and its clamping is exactly what resampling wants: a Lanczos kernel
 *   writing -3 or 280 saturates rather than wraps. That is the difference between a
 *   clean edge and black speckles in the highlights.
 * - **Non-premultiplied**, matching PNG, WebP and GIF. The resampler premultiplies
 *   internally where it matters and converts back.
 * - **No stride, one orientation.** BMP stores rows bottom-up and TIFF can too; that
 *   is the codec's problem to normalise at the boundary, not a flag every transform
 *   has to respect.
 */
export interface RawImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Non-premultiplied, 0-255 per channel. */
export type RGBA = readonly [r: number, g: number, b: number, a: number];

/** Bytes per pixel. RGBA, always. */
const CHANNELS = 4;

/**
 * Allocate a canvas, optionally flood-filled.
 *
 * Used by rotate's grown canvas (features/rotate.md) for the corners that had no
 * source, and by tests. Unfilled means transparent black.
 *
 * @throws {InvalidOptionError} if a dimension is not a positive integer
 */
export function createImage(width: number, height: number, fill?: RGBA): RawImage {
  assertDimension(width, 'width');
  assertDimension(height, 'height');

  const data = new Uint8ClampedArray(width * height * CHANNELS);

  // Fill the first pixel, then keep doubling the filled region. `copyWithin` is a
  // memmove and clamps to the buffer itself, so the last (partial) doubling needs no
  // special case.
  //
  // Worth the three lines over `for (i += 4) data.set(fill, i)`: rotate grows the
  // canvas to the rotated bounding box, and on the 1415x1415 a 45-degree rotate
  // produces, the per-pixel loop measured 29ms against this one's 0.95ms. 29ms is a
  // third of a frame on the preview path, for a buffer that is about to be
  // overwritten anyway. See features/rotate.md.
  //
  // A transparent-black fill is what the fresh buffer already holds, so skip it.
  if (fill !== undefined && fill.some((channel) => channel !== 0)) {
    data.set(fill, 0);
    for (let filled = CHANNELS; filled < data.length; filled *= 2) {
      data.copyWithin(filled, 0, filled);
    }
  }

  return { width, height, data };
}

/**
 * Check the invariant at a trust boundary: the decoder to pipeline seam.
 *
 * A codec that returns a buffer of the wrong length is a bug, and we want it caught
 * at the seam rather than three transforms later as a garbage image. It throws
 * `CorruptImageError` because that is how it reaches the user: their file went in and
 * something unusable came out. Whether the fault is the file's or ours, the plugin's
 * handling is the same.
 *
 * @throws {CorruptImageError} if the image is malformed
 */
export function assertValidImage(image: RawImage): asserts image is RawImage {
  const { width, height, data } = image;

  if (!Number.isInteger(width) || width < 1) {
    throw new CorruptImageError(`Decoded image has an invalid width: ${width}`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new CorruptImageError(`Decoded image has an invalid height: ${height}`);
  }

  const expected = width * height * CHANNELS;
  if (data.length !== expected) {
    throw new CorruptImageError(
      `Decoded image buffer is ${data.length} bytes, expected ${expected} ` +
        `for ${width}x${height} RGBA.`,
    );
  }
}

/**
 * Deep copy. A new object over a new buffer, sharing nothing with the source.
 *
 * Transforms allocate and return new images rather than mutating in place: an
 * allocation per stage, in exchange for freedom from an entire class of aliasing bug.
 */
export function copyImage(image: RawImage): RawImage {
  return {
    width: image.width,
    height: image.height,
    // Copies the bytes. `new Uint8ClampedArray(view)` would copy too, but slice() says
    // so plainly and can't be misread as wrapping the same ArrayBuffer.
    data: image.data.slice(),
  };
}

/** Dimensions are positive integers. A fractional pixel count is a caller bug. */
function assertDimension(value: number, name: 'width' | 'height'): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidOptionError(name, value, 'must be an integer >= 1');
  }
}
