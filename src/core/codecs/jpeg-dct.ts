/**
 * The 8x8 DCT, forward and inverse. See features/codec-jpeg.md.
 *
 * This is the hot loop of the whole library, so it is the "slow" integer transform from
 * libjpeg (jidctint.c / jfdctint.c), which despite the name is the Loeffler-Ligtenberg-
 * Moschytz algorithm the spec asks for: 11 multiplies per 1-D pass instead of the naive
 * O(n^4) double loop, which is roughly an order of magnitude slower for no benefit.
 *
 * Two reasons for THIS variant rather than the AAN float/fast one, which is nominally
 * quicker:
 *
 *   - It is exact integer arithmetic, so it is deterministic across engines and platforms.
 *     A float IDCT can disagree with itself between Node and Bun.
 *   - libjpeg's default is islow, so our output matches libjpeg's bit-for-bit. That turns
 *     "close to a reference decoder" from a judgement call into an equality check, and the
 *     fixtures compare within a delta of 2 rather than a hand-waved 8.
 */

/** Fixed-point precision of the constants. */
const CONST_BITS = 13;
/** Extra fractional bits kept between the two passes. */
const PASS1_BITS = 2;

// The rotator constants, as CONST_BITS fixed point: round(value * 2^13).
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

/** Round-and-shift: the fixed-point descale, with the rounding bias libjpeg uses. */
const descale = (x: number, n: number): number => (x + (1 << (n - 1))) >> n;

/** Scratch shared by both transforms. Reused because this runs per 8x8 block. */
const ws = new Int32Array(64);

/**
 * Dequantise and inverse-transform one block, writing 8x8 samples into `out`.
 *
 * `coef` holds 64 coefficients in natural order; `quant` the matching quantisation table.
 * Output samples are level-shifted back up by 128 and clamped to 0..255.
 */
export function inverseDct(
  coef: Int16Array,
  coefOffset: number,
  quant: Uint16Array,
  out: Uint8ClampedArray,
  outOffset: number,
  outStride: number,
): void {
  // Pass 1: columns. Results are left with PASS1_BITS of extra fraction.
  for (let c = 0; c < 8; c++) {
    const i = coefOffset + c;

    // The overwhelmingly common block: a DC term and nothing else. Most blocks in a real
    // photo are flat at this scale, so this shortcut is not a micro-optimisation, it is
    // most of the decode.
    if (
      coef[i + 8]! === 0 &&
      coef[i + 16]! === 0 &&
      coef[i + 24]! === 0 &&
      coef[i + 32]! === 0 &&
      coef[i + 40]! === 0 &&
      coef[i + 48]! === 0 &&
      coef[i + 56]! === 0
    ) {
      const dc = (coef[i]! * quant[c]!) << PASS1_BITS;
      for (let r = 0; r < 8; r++) ws[c + r * 8] = dc;
      continue;
    }

    // Even part.
    let z2 = coef[i + 16]! * quant[c + 16]!;
    let z3 = coef[i + 48]! * quant[c + 48]!;
    let z1 = (z2 + z3) * FIX_0_541196100;
    let tmp2 = z1 + z3 * -FIX_1_847759065;
    let tmp3 = z1 + z2 * FIX_0_765366865;

    z2 = coef[i]! * quant[c]!;
    z3 = coef[i + 32]! * quant[c + 32]!;
    let tmp0 = (z2 + z3) << CONST_BITS;
    let tmp1 = (z2 - z3) << CONST_BITS;

    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;

    // Odd part.
    tmp0 = coef[i + 56]! * quant[c + 56]!;
    tmp1 = coef[i + 40]! * quant[c + 40]!;
    tmp2 = coef[i + 24]! * quant[c + 24]!;
    tmp3 = coef[i + 8]! * quant[c + 8]!;

    z1 = tmp0 + tmp3;
    z2 = tmp1 + tmp2;
    z3 = tmp0 + tmp2;
    let z4 = tmp1 + tmp3;
    const z5 = (z3 + z4) * FIX_1_175875602;

    tmp0 = tmp0 * FIX_0_298631336;
    tmp1 = tmp1 * FIX_2_053119869;
    tmp2 = tmp2 * FIX_3_072711026;
    tmp3 = tmp3 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223;
    z2 = z2 * -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560 + z5;
    z4 = z4 * -FIX_0_390180644 + z5;

    tmp0 += z1 + z3;
    tmp1 += z2 + z4;
    tmp2 += z2 + z3;
    tmp3 += z1 + z4;

    const d = CONST_BITS - PASS1_BITS;
    ws[c] = descale(tmp10 + tmp3, d);
    ws[c + 56] = descale(tmp10 - tmp3, d);
    ws[c + 8] = descale(tmp11 + tmp2, d);
    ws[c + 48] = descale(tmp11 - tmp2, d);
    ws[c + 16] = descale(tmp12 + tmp1, d);
    ws[c + 40] = descale(tmp12 - tmp1, d);
    ws[c + 24] = descale(tmp13 + tmp0, d);
    ws[c + 32] = descale(tmp13 - tmp0, d);
  }

  // Pass 2: rows. No DC shortcut here -- pass 1 has already spread any DC term across
  // every row, so a row of a real block is almost never flat.
  for (let r = 0; r < 8; r++) {
    const i = r * 8;
    const o = outOffset + r * outStride;

    let z2 = ws[i + 2]!;
    let z3 = ws[i + 6]!;
    let z1 = (z2 + z3) * FIX_0_541196100;
    let tmp2 = z1 + z3 * -FIX_1_847759065;
    let tmp3 = z1 + z2 * FIX_0_765366865;

    let tmp0 = (ws[i]! + ws[i + 4]!) << CONST_BITS;
    let tmp1 = (ws[i]! - ws[i + 4]!) << CONST_BITS;

    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;

    tmp0 = ws[i + 7]!;
    tmp1 = ws[i + 5]!;
    tmp2 = ws[i + 3]!;
    tmp3 = ws[i + 1]!;

    z1 = tmp0 + tmp3;
    z2 = tmp1 + tmp2;
    z3 = tmp0 + tmp2;
    let z4 = tmp1 + tmp3;
    const z5 = (z3 + z4) * FIX_1_175875602;

    tmp0 = tmp0 * FIX_0_298631336;
    tmp1 = tmp1 * FIX_2_053119869;
    tmp2 = tmp2 * FIX_3_072711026;
    tmp3 = tmp3 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223;
    z2 = z2 * -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560 + z5;
    z4 = z4 * -FIX_0_390180644 + z5;

    tmp0 += z1 + z3;
    tmp1 += z2 + z4;
    tmp2 += z2 + z3;
    tmp3 += z1 + z4;

    // The +128 is the level shift: JPEG stores samples centred on zero. Uint8ClampedArray
    // does the clamping, which is exactly libjpeg's range_limit table in a type.
    const d = CONST_BITS + PASS1_BITS + 3;
    out[o] = descale(tmp10 + tmp3, d) + 128;
    out[o + 7] = descale(tmp10 - tmp3, d) + 128;
    out[o + 1] = descale(tmp11 + tmp2, d) + 128;
    out[o + 6] = descale(tmp11 - tmp2, d) + 128;
    out[o + 2] = descale(tmp12 + tmp1, d) + 128;
    out[o + 5] = descale(tmp12 - tmp1, d) + 128;
    out[o + 3] = descale(tmp13 + tmp0, d) + 128;
    out[o + 4] = descale(tmp13 - tmp0, d) + 128;
  }
}

/**
 * Forward-transform and quantise one block. `block` holds 64 samples in natural order,
 * already level-shifted to -128..127; the quantised coefficients are written back into it.
 *
 * jfdctint.c, and the exact mirror of the inverse above.
 */
export function forwardDct(block: Int16Array, quant: Uint16Array): void {
  // Pass 1: rows. Results are scaled up by 2^PASS1_BITS.
  for (let r = 0; r < 8; r++) {
    const i = r * 8;

    const tmp0 = block[i]! + block[i + 7]!;
    const tmp7 = block[i]! - block[i + 7]!;
    const tmp1 = block[i + 1]! + block[i + 6]!;
    const tmp6 = block[i + 1]! - block[i + 6]!;
    const tmp2 = block[i + 2]! + block[i + 5]!;
    const tmp5 = block[i + 2]! - block[i + 5]!;
    const tmp3 = block[i + 3]! + block[i + 4]!;
    const tmp4 = block[i + 3]! - block[i + 4]!;

    // Even part.
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;

    ws[i] = (tmp10 + tmp11) << PASS1_BITS;
    ws[i + 4] = (tmp10 - tmp11) << PASS1_BITS;

    let z1 = (tmp12 + tmp13) * FIX_0_541196100;
    ws[i + 2] = descale(z1 + tmp13 * FIX_0_765366865, CONST_BITS - PASS1_BITS);
    ws[i + 6] = descale(z1 + tmp12 * -FIX_1_847759065, CONST_BITS - PASS1_BITS);

    // Odd part.
    z1 = tmp4 + tmp7;
    let z2 = tmp5 + tmp6;
    let z3 = tmp4 + tmp6;
    let z4 = tmp5 + tmp7;
    const z5 = (z3 + z4) * FIX_1_175875602;

    const t4 = tmp4 * FIX_0_298631336;
    const t5 = tmp5 * FIX_2_053119869;
    const t6 = tmp6 * FIX_3_072711026;
    const t7 = tmp7 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223;
    z2 = z2 * -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560 + z5;
    z4 = z4 * -FIX_0_390180644 + z5;

    const d = CONST_BITS - PASS1_BITS;
    ws[i + 7] = descale(t4 + z1 + z3, d);
    ws[i + 5] = descale(t5 + z2 + z4, d);
    ws[i + 3] = descale(t6 + z2 + z3, d);
    ws[i + 1] = descale(t7 + z1 + z4, d);
  }

  // Pass 2: columns, and quantise on the way out.
  for (let c = 0; c < 8; c++) {
    const tmp0 = ws[c]! + ws[c + 56]!;
    const tmp7 = ws[c]! - ws[c + 56]!;
    const tmp1 = ws[c + 8]! + ws[c + 48]!;
    const tmp6 = ws[c + 8]! - ws[c + 48]!;
    const tmp2 = ws[c + 16]! + ws[c + 40]!;
    const tmp5 = ws[c + 16]! - ws[c + 40]!;
    const tmp3 = ws[c + 24]! + ws[c + 32]!;
    const tmp4 = ws[c + 24]! - ws[c + 32]!;

    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;

    quantise(block, c, descale(tmp10 + tmp11, PASS1_BITS), quant);
    quantise(block, c + 32, descale(tmp10 - tmp11, PASS1_BITS), quant);

    let z1 = (tmp12 + tmp13) * FIX_0_541196100;
    quantise(block, c + 16, descale(z1 + tmp13 * FIX_0_765366865, CONST_BITS + PASS1_BITS), quant);
    quantise(block, c + 48, descale(z1 + tmp12 * -FIX_1_847759065, CONST_BITS + PASS1_BITS), quant);

    z1 = tmp4 + tmp7;
    let z2 = tmp5 + tmp6;
    let z3 = tmp4 + tmp6;
    let z4 = tmp5 + tmp7;
    const z5 = (z3 + z4) * FIX_1_175875602;

    const t4 = tmp4 * FIX_0_298631336;
    const t5 = tmp5 * FIX_2_053119869;
    const t6 = tmp6 * FIX_3_072711026;
    const t7 = tmp7 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223;
    z2 = z2 * -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560 + z5;
    z4 = z4 * -FIX_0_390180644 + z5;

    const d = CONST_BITS + PASS1_BITS;
    quantise(block, c + 56, descale(t4 + z1 + z3, d), quant);
    quantise(block, c + 40, descale(t5 + z2 + z4, d), quant);
    quantise(block, c + 24, descale(t6 + z2 + z3, d), quant);
    quantise(block, c + 8, descale(t7 + z1 + z4, d), quant);
  }
}

/**
 * Divide a coefficient by its quantisation step, rounding to nearest.
 *
 * The /8 is the transform's own scale factor: the forward pass above leaves everything 8x
 * larger than the true DCT, which is exactly what the inverse expects to undo, so it is
 * folded in here rather than costing a separate pass.
 */
function quantise(block: Int16Array, at: number, value: number, quant: Uint16Array): void {
  const q = quant[at]! * 8;
  // Round half away from zero, symmetric about zero. Truncating instead biases every
  // coefficient toward zero and visibly flattens the image at low quality.
  block[at] = value < 0 ? -Math.round(-value / q) : Math.round(value / q);
}
