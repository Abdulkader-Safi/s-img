/**
 * Rotation by any angle. See features/rotate.md.
 *
 * Right angles dispatch to the exact path (features/rotate-90.md) and none of this
 * applies. Everything here is the remainder: real geometry, real resampling, a canvas
 * that has to grow, and a fill for the corners that had no source.
 */

import { ImageTooLargeError, InvalidOptionError } from '../errors.ts';
import { createImage, type RawImage, type RGBA } from '../image.ts';
import { rotate90 } from './rotate90.ts';
import { hasAlpha, premultiply, sampleAt, type MutableRGBA, type Resampling } from './resample.ts';

/**
 * 512 MB of RGBA. Deliberately NOT the 20000 x 20000 that decode.md originally stated:
 * that is 400M pixels / 1.49 GB, which permits exactly the allocations the cap exists to
 * stop. Two places in the spec proved it:
 *
 *   - raw-image.md calls 20000x20000 (1.6 GB) "past what a V8 typed array will
 *     comfortably hold" -- so the cap allowed an image the spec itself calls unusable.
 *   - rotate.md requires a 20000x1 rotated 45 degrees to throw. Its box is 14143x14143 =
 *     200M pixels = 0.75 GB, which is UNDER 400M, so it would not have.
 *
 * 134M pixels clears any realistic photo (a 100MP scan is 400 MB) while catching both.
 * Callers who genuinely want more pass `maxPixels`.
 */
const DEFAULT_MAX_PIXELS = 128 * 1024 * 1024;

export interface RotateOptions {
  /** Default 'bilinear'. */
  resampling?: Resampling;
  /**
   * Fill for the new corners. Default is transparent, and the encoder composites onto
   * the pipeline's `background` when the target format has no alpha -- one rule,
   * decided where the format is actually known. Set this to fill *now*, even on an
   * alpha-capable format.
   */
  background?: RGBA;
  /** Refuse to allocate a canvas larger than this. Default 134M pixels (512 MB). */
  maxPixels?: number;
}

/**
 * Rotate by `angle` degrees, clockwise. The canvas grows to the rotated bounding box,
 * so no corner is lost.
 *
 * @throws {InvalidOptionError} if the angle is not finite
 * @throws {ImageTooLargeError} if the *computed* canvas exceeds the pixel cap
 */
export function rotate(image: RawImage, angle: number, options: RotateOptions = {}): RawImage {
  if (!Number.isFinite(angle)) {
    throw new InvalidOptionError('rotate.angle', angle, 'must be a finite number of degrees');
  }

  const { resampling = 'bilinear', background, maxPixels = DEFAULT_MAX_PIXELS } = options;

  // Right angles are exact: a pure index permutation, no resampling, no growth. The
  // dispatch is what makes rotate(90).rotate(-90) return the original bytes.
  const turn = ((angle % 360) + 360) % 360;
  if (turn % 90 === 0) return rotate90(image, angle);

  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  // The axis-aligned bounding box of the rotated rectangle. Ceil, never floor: floor
  // shaves a sliver off a real corner, which is the exact loss the growth prevents.
  const width = Math.ceil(Math.abs(image.width * cos) + Math.abs(image.height * sin));
  const height = Math.ceil(Math.abs(image.width * sin) + Math.abs(image.height * cos));

  // Legal input plus legal angle can still ask for 800 MB: a 20000x1 at 45 degrees has a
  // ~14000x14000 box. The cap has to cover the computed size, not just decode's input.
  if (width * height > maxPixels) {
    throw new ImageTooLargeError(width, height, maxPixels);
  }

  const out = createImage(width, height, background);

  const srcCx = image.width / 2;
  const srcCy = image.height / 2;
  const dstCx = width / 2;
  const dstCy = height / 2;

  // Bilinear is the default and the only kernel on the preview path, so it gets a
  // specialised loop. The generic sampler is correct but general: a call per pixel,
  // weigh() with branches per tap, and an alpha divide per tap. Measured on a 1600px
  // preview rotate: 126ms generic vs the budget's 33ms. Full-res 12MP was 835ms against
  // the 260ms ImageMagick baseline this project has to beat -- i.e. the honest version
  // was three times slower than the thing being replaced.
  //
  // Premultiplying the source ONCE (rather than four divides per pixel) and inlining the
  // four-tap lerp is where the time comes back: 261ms and 41ms after. Lanczos stays on
  // the generic path -- it is a final-output option and never runs per frame.
  if (resampling === 'bilinear') {
    return rotateBilinear(image, out, { cos, sin, srcCx, srcCy, dstCx, dstCy, background });
  }
  if (resampling === 'nearest') {
    // Also specialised, because without it "nearest" measured SLOWER than bilinear
    // (75ms vs 40ms on a 1600px preview): it was paying the generic sampler's call and
    // weight machinery to do a rounded array read. The fast kernel being the slowest is
    // a bug of its own.
    return rotateNearest(image, out, { cos, sin, srcCx, srcCy, dstCx, dstCy, background });
  }

  // One tuple for the whole loop. A per-pixel {r,g,b,a} would be a hundred million
  // short-lived objects on a large photo, and the GC would eat the frame budget.
  const pixel: MutableRGBA = [0, 0, 0, 0];

  // Iterate the DESTINATION and inverse-rotate to find the source. Never the reverse:
  // forward mapping (source -> destination) leaves holes, because rotation is not a
  // bijection on a discrete grid -- some destination pixels get written twice and others
  // never at all, and the result is pinholed. This is not a preference, it is the
  // difference between working and not.
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - dstCy;

    // The mapping is affine, so the per-column step is constant: compute the row's
    // starting source coordinate once and increment, rather than two multiplies per
    // pixel. This is the hot loop of the slowest operation in the library.
    let sx = (0.5 - dstCx) * cos + dy * sin + srcCx;
    let sy = -(0.5 - dstCx) * sin + dy * cos + srcCy;

    for (let x = 0; x < width; x++, sx += cos, sy -= sin) {
      // Outside the source is genuinely empty: leave whatever the fill put there,
      // rather than smearing an edge pixel outward.
      //
      // A fast path, not a correctness check -- sampleAt already returns transparent out
      // of range, and deleting this fails no test. It stays because the corners are
      // roughly a third of a 45-degree canvas, and this skips the sampler entirely for
      // every one of them.
      if (sx < -0.5 || sy < -0.5 || sx > image.width - 0.5 || sy > image.height - 0.5) continue;

      sampleAt(image, sx - 0.5, sy - 0.5, resampling, pixel);

      // A sample that resolved to nothing leaves the fill in place, so a background
      // colour survives at the very edge instead of being punched transparent.
      if (pixel[3] === 0 && background !== undefined) continue;

      out.data.set(pixel, (y * width + x) * 4);
    }
  }

  return out;
}

interface Geometry {
  cos: number;
  sin: number;
  srcCx: number;
  srcCy: number;
  dstCx: number;
  dstCy: number;
  background: RGBA | undefined;
}

/**
 * The bilinear rotate, specialised. Same maths as the generic path, none of the
 * generality: no per-pixel call, no weight function, and the alpha divide hoisted out of
 * the inner loop into a single premultiply pass.
 *
 * Correctness is not traded for this: it is checked against the same tests as the
 * generic path, including the sub-pixel centring and the coloured-transparency halo.
 */
function rotateBilinear(image: RawImage, out: RawImage, geo: Geometry): RawImage {
  const { cos, sin, srcCx, srcCy, dstCx, dstCy, background } = geo;
  const { width, height } = out;
  const sw = image.width;
  const sh = image.height;

  // Premultiply once. Averaging non-premultiplied RGBA drags a transparent pixel's
  // colour into its opaque neighbour: the halo around every rotated edge.
  const alpha = hasAlpha(image);
  const src = (alpha ? premultiply(image) : image).data;

  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - dstCy;
    let sx = (0.5 - dstCx) * cos + dy * sin + srcCx - 0.5;
    let sy = -(0.5 - dstCx) * sin + dy * cos + srcCy - 0.5;

    for (let x = 0; x < width; x++, sx += cos, sy -= sin) {
      if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      // Clamp the four taps to the edge. We are at most half a pixel outside here (the
      // check above saw to that), so this is the standard edge behaviour, not a smear.
      const xa = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0;
      const xb = x0 + 1 < 0 ? 0 : x0 + 1 >= sw ? sw - 1 : x0 + 1;
      const ya = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0;
      const yb = y0 + 1 < 0 ? 0 : y0 + 1 >= sh ? sh - 1 : y0 + 1;

      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;

      // Bilinear as products of the two axis weights: no weight function, no branches.
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const a = src[i00 + 3]! * w00 + src[i10 + 3]! * w10 + src[i01 + 3]! * w01 + src[i11 + 3]! * w11;
      if (a === 0 && background !== undefined) continue;

      const at = (y * width + x) * 4;
      if (a === 0) {
        // Fully transparent: nothing to un-premultiply, and the fill already holds.
        continue;
      }

      // Un-premultiply straight back out, so the buffer stays non-premultiplied RGBA.
      const unmul = alpha ? 255 / a : 1;
      out.data[at] = (src[i00]! * w00 + src[i10]! * w10 + src[i01]! * w01 + src[i11]! * w11) * unmul;
      out.data[at + 1] =
        (src[i00 + 1]! * w00 + src[i10 + 1]! * w10 + src[i01 + 1]! * w01 + src[i11 + 1]! * w11) * unmul;
      out.data[at + 2] =
        (src[i00 + 2]! * w00 + src[i10 + 2]! * w10 + src[i01 + 2]! * w01 + src[i11 + 2]! * w11) * unmul;
      out.data[at + 3] = a;
    }
  }

  return out;
}

/**
 * The nearest-neighbour rotate: round the source coordinate, copy the pixel. No
 * arithmetic on channel values at all, and so no premultiply either -- nothing is being
 * averaged, so nothing can bleed.
 */
function rotateNearest(image: RawImage, out: RawImage, geo: Geometry): RawImage {
  const { cos, sin, srcCx, srcCy, dstCx, dstCy } = geo;
  const { width, height } = out;
  const src = image.data;
  const sw = image.width;
  const sh = image.height;

  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - dstCy;
    let sx = (0.5 - dstCx) * cos + dy * sin + srcCx - 0.5;
    let sy = -(0.5 - dstCx) * sin + dy * cos + srcCy - 0.5;

    for (let x = 0; x < width; x++, sx += cos, sy -= sin) {
      const px = Math.round(sx);
      const py = Math.round(sy);
      if (px < 0 || py < 0 || px >= sw || py >= sh) continue;

      const from = (py * sw + px) * 4;
      const to = (y * width + x) * 4;
      out.data[to] = src[from]!;
      out.data[to + 1] = src[from + 1]!;
      out.data[to + 2] = src[from + 2]!;
      out.data[to + 3] = src[from + 3]!;
    }
  }

  return out;
}
