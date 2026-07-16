/**
 * The sampling kernels. See features/resampling.md.
 *
 * Written once, used by both resize and arbitrary-angle rotate: given a source image
 * and a fractional coordinate, what colour goes here. Same maths problem, same code.
 */

import { createImage, type RawImage } from '../image.ts';

export type Resampling = 'nearest' | 'bilinear' | 'lanczos3';

/**
 * A writable RGBA tuple. The public RGBA is readonly, but rotate samples millions of
 * pixels and must not allocate a tuple per pixel: a hundred million short-lived objects
 * would hand the frame budget to the GC (features/rotate.md).
 */
export type MutableRGBA = [r: number, g: number, b: number, a: number];

/** Lanczos lobes. 3 means a 6-tap footprint per axis. */
const LOBES = 3;

/**
 * Resize with a separable two-pass filter: horizontally into a temp, then vertically.
 *
 * Separable is not an optimisation detail, it is what makes Lanczos usable at all --
 * 36 taps per pixel become 6 + 6.
 */
export function resampleTo(
  src: RawImage,
  width: number,
  height: number,
  kernel: Resampling,
): RawImage {
  if (width === src.width && height === src.height) {
    return { width, height, data: src.data.slice() };
  }
  if (kernel === 'nearest') return resampleNearest(src, width, height);

  // Averaging non-premultiplied RGBA is wrong: a transparent pixel still carries an RGB
  // value (usually black), and averaging it in bleeds that into the neighbouring opaque
  // pixel -- a dark fringe around every soft edge. Most photos are fully opaque, so the
  // scan pays for itself by skipping both conversions on the common case.
  const alpha = hasAlpha(src);
  const source = alpha ? premultiply(src) : src;

  const horizontal = resample1D(source, width, src.height, kernel, true);
  const out = resample1D(horizontal, width, height, kernel, false);

  return alpha ? unpremultiply(out) : out;
}

/** Round and copy. No arithmetic on channel values at all. */
function resampleNearest(src: RawImage, width: number, height: number): RawImage {
  const out = createImage(width, height);
  const xRatio = src.width / width;
  const yRatio = src.height / height;

  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * yRatio));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * xRatio));
      const from = (sy * src.width + sx) * 4;
      out.data.set(src.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/** One weighted tap: which source sample, and how much of it. */
interface Tap {
  index: number;
  weight: number;
}

/**
 * Resample along one axis.
 *
 * Weights are precomputed per output column (or row) and reused down the whole image.
 * Computing sinc() per pixel instead of per column is the single biggest performance
 * mistake available here, and the easiest to make.
 */
function resample1D(
  src: RawImage,
  width: number,
  height: number,
  kernel: Resampling,
  horizontal: boolean,
): RawImage {
  const out = createImage(width, height);
  const outLength = horizontal ? width : height;
  const srcLength = horizontal ? src.width : src.height;
  const taps = planTaps(srcLength, outLength, kernel);

  const rows = horizontal ? height : width;
  for (let r = 0; r < rows; r++) {
    for (let o = 0; o < outLength; o++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (const { index, weight } of taps[o]!) {
        const at = horizontal ? (r * src.width + index) * 4 : (index * src.width + r) * 4;
        red += src.data[at]! * weight;
        green += src.data[at + 1]! * weight;
        blue += src.data[at + 2]! * weight;
        alpha += src.data[at + 3]! * weight;
      }

      // Uint8ClampedArray saturates on write, which is exactly why RawImage uses it:
      // a Lanczos kernel legitimately produces -3 and 280 and must not wrap.
      const to = horizontal ? (r * width + o) * 4 : (o * width + r) * 4;
      out.data[to] = red;
      out.data[to + 1] = green;
      out.data[to + 2] = blue;
      out.data[to + 3] = alpha;
    }
  }

  return out;
}

/**
 * Precompute the taps for every output position on one axis.
 *
 * The filter footprint widens when minifying (`scale < 1`), which is what stops
 * downscaling from aliasing. Plain bilinear reads its 4 nearest neighbours regardless,
 * so an 8x downscale never looks at 90% of the source: moire on fabric, jagged text,
 * sparkling detail. Widening the support to cover the whole source region being
 * averaged is the fix, and it is why this is not "just bilinear".
 */
function planTaps(srcLength: number, outLength: number, kernel: Resampling): Tap[][] {
  const scale = outLength / srcLength;
  const support = kernel === 'lanczos3' ? LOBES : 1;
  // Minifying: stretch the footprint so every source pixel in the region contributes.
  const filterScale = scale < 1 ? 1 / scale : 1;
  const radius = support * filterScale;

  const plan: Tap[][] = [];

  for (let o = 0; o < outLength; o++) {
    // Sample from pixel centres, so the mapping stays symmetric and does not drift.
    const centre = (o + 0.5) / scale - 0.5;
    const first = Math.max(0, Math.ceil(centre - radius));
    const last = Math.min(srcLength - 1, Math.floor(centre + radius));

    const taps: Tap[] = [];
    let total = 0;

    for (let i = first; i <= last; i++) {
      const weight = weigh((i - centre) / filterScale, kernel);
      if (weight === 0) continue;
      taps.push({ index: i, weight });
      total += weight;
    }

    // Normalise, so the taps always sum to 1 even where the footprint hangs off the
    // edge. Without this the border darkens (or lightens) visibly.
    if (total === 0) {
      plan.push([{ index: Math.min(srcLength - 1, Math.max(0, Math.round(centre))), weight: 1 }]);
    } else {
      plan.push(taps.map((t) => ({ index: t.index, weight: t.weight / total })));
    }
  }

  return plan;
}

function weigh(x: number, kernel: Resampling): number {
  const d = Math.abs(x);
  if (kernel === 'bilinear') return d < 1 ? 1 - d : 0;
  // lanczos3
  if (d === 0) return 1;
  if (d >= LOBES) return 0;
  return (LOBES * Math.sin(Math.PI * d) * Math.sin((Math.PI * d) / LOBES)) / (Math.PI * Math.PI * d * d);
}

/** Cheap scan: most photos are fully opaque and can skip premultiply entirely. */
function hasAlpha(img: RawImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) return true;
  }
  return false;
}

function premultiply(img: RawImage): RawImage {
  const out = createImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]! / 255;
    out.data[i] = img.data[i]! * a;
    out.data[i + 1] = img.data[i + 1]! * a;
    out.data[i + 2] = img.data[i + 2]! * a;
    out.data[i + 3] = img.data[i + 3]!;
  }
  return out;
}

function unpremultiply(img: RawImage): RawImage {
  const out = createImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]!;
    if (a === 0) {
      // Nothing to recover: the colour was multiplied to nothing. Leave it clear.
      continue;
    }
    const scale = 255 / a;
    out.data[i] = img.data[i]! * scale;
    out.data[i + 1] = img.data[i + 1]! * scale;
    out.data[i + 2] = img.data[i + 2]! * scale;
    out.data[i + 3] = a;
  }
  return out;
}

/**
 * Sample one fractional coordinate. Used by arbitrary-angle rotate, whose mapping is
 * not axis-aligned and so cannot use the separable path above.
 *
 * Outside the source is transparent, not a smeared edge pixel: rotate's new corners
 * genuinely have no source (features/rotate.md).
 */
export function sampleAt(
  src: RawImage,
  x: number,
  y: number,
  kernel: Resampling,
  out: MutableRGBA,
): MutableRGBA {
  if (kernel === 'nearest') {
    const sx = Math.round(x);
    const sy = Math.round(y);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) return clear(out);
    const at = (sy * src.width + sx) * 4;
    out[0] = src.data[at]!;
    out[1] = src.data[at + 1]!;
    out[2] = src.data[at + 2]!;
    out[3] = src.data[at + 3]!;
    return out;
  }

  const radius = kernel === 'lanczos3' ? LOBES : 1;
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  let total = 0;

  for (let sy = Math.ceil(y - radius); sy <= Math.floor(y + radius); sy++) {
    if (sy < 0 || sy >= src.height) continue;
    const wy = weigh(sy - y, kernel);
    if (wy === 0) continue;

    for (let sx = Math.ceil(x - radius); sx <= Math.floor(x + radius); sx++) {
      if (sx < 0 || sx >= src.width) continue;
      const weight = wy * weigh(sx - x, kernel);
      if (weight === 0) continue;

      const at = (sy * src.width + sx) * 4;
      // Premultiplied, so the transparent fill outside the image cannot bleed its RGB
      // into the edge. This is where rotate's halo comes from if you skip it.
      const a = src.data[at + 3]! / 255;
      red += src.data[at]! * a * weight;
      green += src.data[at + 1]! * a * weight;
      blue += src.data[at + 2]! * a * weight;
      alpha += src.data[at + 3]! * weight;
      total += weight;
    }
  }

  if (total === 0 || alpha === 0) return clear(out);

  const norm = 1 / total;
  const a = alpha * norm;
  const unmul = 255 / a;

  out[0] = clamp(red * norm * unmul);
  out[1] = clamp(green * norm * unmul);
  out[2] = clamp(blue * norm * unmul);
  out[3] = clamp(a);
  return out;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clear(out: MutableRGBA): MutableRGBA {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  return out;
}
