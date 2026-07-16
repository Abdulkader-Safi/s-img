/**
 * Mirror an image. See features/flip.md.
 *
 * Exact, no resampling, dimensions unchanged. Both axes at once is a 180 rotation --
 * a mathematical fact rather than a special case, and a free cross-check against
 * rotate90.
 */

import { createImage, type RawImage } from '../image.ts';

export interface FlipOptions {
  /**
   * Mirror left-to-right. Named for the direction of motion, not the axis of
   * reflection (which is vertical). This is the one place every image library confuses
   * everyone; the name matches the plugin's existing UI label. Do not be clever.
   */
  horizontal?: boolean;
  /** Mirror top-to-bottom. */
  vertical?: boolean;
}

/**
 * Mirror on either or both axes. Neither is a no-op, not an error: the plugin passes
 * both false when the user has toggled nothing.
 */
export function flip(image: RawImage, { horizontal = false, vertical = false }: FlipOptions): RawImage {
  const { width, height, data } = image;
  if (!horizontal && !vertical) return { width, height, data: data.slice() };

  const out = createImage(width, height);
  const rowBytes = width * 4;

  for (let y = 0; y < height; y++) {
    const srcRow = (vertical ? height - 1 - y : y) * rowBytes;

    if (!horizontal) {
      // Whole-row memcpy: cheap and cache-friendly.
      out.data.set(data.subarray(srcRow, srcRow + rowBytes), y * rowBytes);
      continue;
    }

    // Reverse pixel order within the row. Both axes are handled in this one pass
    // rather than two, which halves the memory traffic.
    for (let x = 0; x < width; x++) {
      const from = srcRow + (width - 1 - x) * 4;
      out.data.set(data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }

  return out;
}
