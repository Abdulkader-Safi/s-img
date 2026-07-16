/**
 * Cut a rectangle out. See features/crop.md.
 *
 * The cheapest operation in the library: no filtering, no interpolation, one row-wise
 * copy of a sub-rectangle.
 */

import { InvalidOptionError } from '../errors.ts';
import { createImage, type RawImage } from '../image.ts';

export interface CropOptions {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crop to `rect`, which must lie entirely inside the image.
 *
 * Out of bounds throws rather than clamping to the intersection: a crop that silently
 * shrinks returns an image of a different size than the caller asked for, and every
 * downstream calculation is then quietly wrong. A rectangle outside the image means the
 * caller's coordinate space is out of sync with the image's, and that should surface at
 * the call site with the numbers attached.
 *
 * The coordinate origin resets: the returned image's (0,0) IS the rectangle's top-left,
 * so a later rotate spins around the cropped frame rather than the original padded one.
 * That is free here because a RawImage has no offset field to go stale -- which is
 * exactly why a future "optimisation" into a lazy view-with-offset must not happen.
 *
 * @throws {InvalidOptionError} if the rectangle is fractional, empty, or out of bounds
 */
/**
 * The half of crop's validation that does not need an image.
 *
 * Split out so the chain can validate eagerly, at the call site, before any decode
 * (features/api-surface.md): `.crop({ width: -5 })` is a caller mistake and should surface
 * on the line that made it, not two awaits later. The bounds checks below genuinely need
 * the image and stay in crop().
 *
 * @throws {InvalidOptionError} if the rectangle is fractional or empty
 */
export function assertCropOptions(rect: CropOptions): void {
  assertInteger(rect.x, 'crop.x', 0);
  assertInteger(rect.y, 'crop.y', 0);
  assertInteger(rect.width, 'crop.width', 1);
  assertInteger(rect.height, 'crop.height', 1);
}

export function crop(image: RawImage, rect: CropOptions): RawImage {
  assertCropOptions(rect);

  if (rect.x + rect.width > image.width) {
    throw new InvalidOptionError(
      'crop.width',
      rect.width,
      `must fit inside the image: x=${rect.x} + width=${rect.width} exceeds width ${image.width}`,
    );
  }
  if (rect.y + rect.height > image.height) {
    throw new InvalidOptionError(
      'crop.height',
      rect.height,
      `must fit inside the image: y=${rect.y} + height=${rect.height} exceeds height ${image.height}`,
    );
  }

  const out = createImage(rect.width, rect.height);
  const rowBytes = rect.width * 4;

  // One .set() per row: a memcpy under the hood. A per-pixel loop with per-channel
  // indexing is several times slower for zero benefit.
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * image.width + rect.x) * 4;
    out.data.set(image.data.subarray(from, from + rowBytes), y * rowBytes);
  }

  return out;
}

function assertInteger(value: number, name: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new InvalidOptionError(name, value, `must be an integer >= ${min}`);
  }
}
