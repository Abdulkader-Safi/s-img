/**
 * Rotation by a right angle. See features/rotate-90.md.
 *
 * Exact and lossless: a pure index permutation, every output pixel is exactly one
 * input pixel moved. Separate from the arbitrary-angle path (features/rotate.md)
 * because the guarantees differ -- routing 90 degrees through a bilinear filter would
 * blur an image for no reason, and rotate(90).rotate(-90) must return the original
 * bytes.
 */

import { InvalidOptionError } from '../errors.ts';
import { createImage, type RawImage } from '../image.ts';

/** Positive is clockwise. Stated once, never wavered from. */
export function rotate90(image: RawImage, angle: number): RawImage {
  const turn = normalise(angle);
  if (!Number.isInteger(turn) || turn % 90 !== 0) {
    throw new InvalidOptionError('rotate.angle', angle, 'rotate90 only accepts multiples of 90');
  }

  const { width, height, data } = image;
  if (turn === 0) return { width, height, data: data.slice() };

  // 180 is a straight reverse of the pixel array: the cheapest case, and it needs none
  // of the transpose below. Both signs survive the fold, so both are named.
  if (turn === 180 || turn === -180) {
    const out = createImage(width, height);
    const pixels = width * height;
    for (let i = 0; i < pixels; i++) {
      const from = (pixels - 1 - i) * 4;
      out.data.set(data.subarray(from, from + 4), i * 4);
    }
    return out;
  }

  // After the fold, turn is one of 0, +-90, +-180, so this is the whole story. An
  // earlier version also tested `turn === -270`, which the fold makes unreachable --
  // and that dead branch masked the fold entirely: deleting the fold failed no test,
  // because the -270 case silently covered for it.
  const clockwise = turn === 90;
  const out = createImage(height, width);

  // The naive transpose: reads the source sequentially, writes the destination with a
  // stride, so it is a cache miss per pixel on a large image. A tiled version (32x32
  // blocks, keeping both regions resident) is several times faster on a 12MP photo.
  // Left naive until a benchmark says the plugin stutters -- this is four lines and
  // obviously correct, and it is the reference any tiled version gets tested against.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const toX = clockwise ? height - 1 - y : y;
      const toY = clockwise ? x : width - 1 - x;
      out.data.set(data.subarray(from, from + 4), (toY * height + toX) * 4);
    }
  }

  return out;
}

/** Fold any angle into (-360, 360), so 450 is 90 and -270 is 90. */
function normalise(angle: number): number {
  const turn = angle % 360;
  return turn > 180 ? turn - 360 : turn < -180 ? turn + 360 : turn;
}
