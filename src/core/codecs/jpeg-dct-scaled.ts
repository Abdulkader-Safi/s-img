/**
 * Reduced inverse DCTs: produce an N x N block from the top-left N x N coefficients.
 * See features/fast-decode.md.
 *
 * This is the whole preview feature. A 12MP photo is 187,500 blocks; decoding it fully to
 * show a 1600px preview inverse-transforms every one of them and then throws 84% of the
 * result away. Taking only the low-frequency corner of each block and transforming THAT
 * gives the same picture at 1/2, 1/4 or 1/8 scale, and the transform gets cheaper rather
 * than more expensive -- which is why JPEG is the format this feature is really about.
 *
 * SEPARABLE, not the textbook double sum. The naive form is O(N^4) per block: for N=4 that
 * is 256 multiplies against roughly 176 for the fast 8x8 path this is supposed to beat, so
 * the "optimisation" would be slower than the thing it replaces. Rows then columns is
 * O(N^3): 128 for N=4, 16 for N=2. Worth stating because it is the trap -- a reduced IDCT
 * that is slower than the full one looks like it works and defeats the entire point.
 *
 * Not bit-exact with libjpeg's jidctred, and not trying to be. features/fast-decode.md is
 * explicit that the decode hint is best-effort and this is a preview; the full-resolution
 * save path is the one that must match libjpeg, and it still does.
 */

/** The scale factors JPEG's DCT can give for free: an N x N block out of an 8 x 8 one. */
export type BlockSize = 1 | 2 | 4 | 8;

/**
 * cos((2x + 1) * u * PI / 2N) for an N-point transform, as [x * n + u].
 *
 * Precomputed once. Float64 arithmetic on a fixed table is deterministic across engines --
 * IEEE 754 pins +, * and the table itself -- so Node and Bun agree, which is the property
 * the integer IDCT was chosen for in the full-resolution path.
 */
const TABLES = new Map<number, Float64Array>();

function cosines(n: number): Float64Array {
  let table = TABLES.get(n);
  if (table === undefined) {
    table = new Float64Array(n * n);
    for (let x = 0; x < n; x++) {
      for (let u = 0; u < n; u++) {
        table[x * n + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
      }
    }
    TABLES.set(n, table);
  }
  return table;
}

/** Scratch, reused across blocks: this runs per block and per component. */
const ws = new Float64Array(64);

/**
 * Dequantise the top-left `n` x `n` coefficients and inverse-transform them into an n x n
 * block of samples, level-shifted by 128 and clamped by the output array's own type.
 *
 * `n` must be 1, 2 or 4. The full-size case is jpeg-dct.ts's integer transform, which is
 * bit-exact with libjpeg and is what the save path uses.
 */
export function inverseDctScaled(
  coef: Int16Array,
  coefOffset: number,
  quant: Uint16Array,
  out: Uint8ClampedArray,
  outOffset: number,
  outStride: number,
  n: 1 | 2 | 4,
): void {
  // 1/8 scale: the DC coefficient IS the block's mean, times 8. No transform at all, which
  // is the cheapest a JPEG can possibly be decoded and is exactly what a thumbnail wants.
  if (n === 1) {
    out[outOffset] = Math.round((coef[coefOffset]! * quant[0]!) / 8) + 128;
    return;
  }

  const cos = cosines(n);

  // Pass 1: rows. Transform each of the n rows of coefficients into n partial sums.
  //
  // The 1/4 normalisation of the standard IDCT is applied once, here, and does NOT vary
  // with n: the DC-only case has to come out at F00/8 whatever the scale, because that is
  // the block's mean and downsampling cannot change a mean. Getting this wrong shows up as
  // a preview that is uniformly too dark or too bright, which is easy to miss next to a
  // thumbnail and obvious next to the full-resolution version.
  for (let v = 0; v < n; v++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let u = 0; u < n; u++) {
        const value = coef[coefOffset + v * 8 + u]! * quant[v * 8 + u]!;
        if (value !== 0) sum += (u === 0 ? Math.SQRT1_2 : 1) * value * cos[x * n + u]!;
      }
      ws[v * n + x] = sum;
    }
  }

  // Pass 2: columns.
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let sum = 0;
      for (let v = 0; v < n; v++) {
        const value = ws[v * n + x]!;
        if (value !== 0) sum += (v === 0 ? Math.SQRT1_2 : 1) * value * cos[y * n + v]!;
      }
      out[outOffset + y * outStride + x] = Math.round(sum / 4) + 128;
    }
  }
}

/**
 * The largest block size whose output still fits under `hint` on the long edge.
 *
 * Always at or under, never over: a caller asking for 1600 gets 1000 from a 4000px source
 * (1/4), not 2000 (1/2), because 2000 would be more pixels than they said they wanted. They
 * then read the REAL dimensions off the result, which is the only safe way to do it --
 * assuming the scale is `hint / longEdge` is the coordinate bug features/fast-decode.md
 * warns about, and it is off by 1.6x in exactly this case.
 */
export function blockSizeFor(width: number, height: number, hint: number): BlockSize {
  const longest = Math.max(width, height);

  // DESCENDING. The first draft went up from 1 and returned the first that fit, which is
  // the smallest -- so a 4000px source hinted at 1600 decoded at 500px instead of 1000,
  // throwing away half the resolution the caller asked for. The doc comment above said
  // "largest" the whole time. Only the benchmark caught it, because the output was a
  // perfectly good image of the wrong size.
  for (const n of [8, 4, 2, 1] as const) {
    if (Math.ceil((longest * n) / 8) <= hint) return n;
  }

  // Smaller than 1/8 of the image: DCT scaling cannot get there, so take the smallest it
  // can and let the caller's resize do the rest. Falling through to 8 here -- which the
  // first draft also did -- means a hint of 200 on a 12MP photo decodes at FULL RESOLUTION,
  // which is the exact opposite of what was asked for and is worse than not having the
  // feature at all.
  return 1;
}
