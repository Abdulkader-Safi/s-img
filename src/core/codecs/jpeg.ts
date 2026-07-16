/**
 * JPEG codec, baseline DCT. See features/codec-jpeg.md.
 *
 * The biggest, gnarliest codec in the set, and the one that matters most: a vault is
 * mostly photos and photos are mostly JPEG.
 *
 * Progressive (SOF2) is NOT supported yet and throws a clear, specific error. That is a
 * real gap -- a large share of web-sourced JPEGs are progressive -- and it closes before
 * the plugin swap in milestone 7. It is deliberately not blocking the rest of the
 * pipeline from existing.
 */

import { CorruptImageError, ImageTooLargeError, InvalidOptionError, UnsupportedFormatError } from '../errors.ts';
import { createImage, DEFAULT_MAX_PIXELS, type RawImage, type RGBA } from '../image.ts';
import { forwardDct, inverseDct } from './jpeg-dct.ts';
import {
  AC_CHROMA,
  AC_LUMA,
  DC_CHROMA,
  DC_LUMA,
  QUANT_CHROMA,
  QUANT_LUMA,
  ZIGZAG,
  scaleQuantTable,
  type HuffmanSpec,
} from './jpeg-tables.ts';

/** Markers we act on. Everything else is skipped by its length field. */
const Marker = {
  SOF0: 0xc0, // baseline
  SOF1: 0xc1, // extended sequential: same entropy coding, decodes identically
  SOF2: 0xc2, // progressive
  SOF9: 0xc9, // arithmetic-coded sequential
  SOF10: 0xca, // arithmetic-coded progressive
  DHT: 0xc4,
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  DQT: 0xdb,
  DRI: 0xdd,
  APP0: 0xe0,
  APP1: 0xe1,
  COM: 0xfe,
} as const;

export interface JpegEncodeOptions {
  /** 1-100. Default 82. */
  quality?: number;
  /** JPEG has no alpha, so transparency is composited onto this. Default white. */
  background?: RGBA;
}

/**
 * The default quality. High enough that nobody complains about artifacts, low enough to
 * be meaningfully smaller than 95, and roughly where the rest of the ecosystem sits.
 */
const DEFAULT_QUALITY = 82;

// --- public --------------------------------------------------------------------------

/** Read dimensions from the frame header without decoding the scan. */
export function probeJpeg(bytes: Uint8Array): { width: number; height: number } {
  const frame = readFrame(bytes, true);
  return { width: frame.width, height: frame.height };
}

/**
 * Decode a baseline JPEG to RGBA.
 *
 * @throws {UnsupportedFormatError} for progressive or arithmetic-coded files
 * @throws {CorruptImageError} for a malformed or truncated file
 */
export function decodeJpeg(bytes: Uint8Array): RawImage {
  const frame = readFrame(bytes, false);
  const { width, height, components } = frame;

  for (const c of components) upsample(c, frame);

  const image = createImage(width, height);
  if (components.length === 1) {
    greyToRgba(components[0]!.pixels!, image);
  } else if (components.length === 3) {
    ycbcrToRgba(components, image);
  } else {
    // 4 components: CMYK or YCCK, from print workflows, and usually Adobe-inverted.
    // Converted naively and without colour management, per the spec -- a wrong-ish colour
    // beats refusing to open the file.
    cmykToRgba(components, frame.adobeTransform, image);
  }

  return image;
}

/**
 * Encode to a baseline JPEG: 4:2:0, standard Annex K Huffman tables, a bare JFIF APP0 and
 * nothing else. No EXIF, no thumbnail, no ICC.
 *
 * @throws {InvalidOptionError} if quality is not an integer in 1-100
 */
export function encodeJpeg(image: RawImage, options: JpegEncodeOptions = {}): Uint8Array {
  const { quality = DEFAULT_QUALITY, background = [255, 255, 255, 255] } = options;

  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new InvalidOptionError('jpeg.quality', quality, 'must be an integer from 1 to 100');
  }

  const luma = scaleQuantTable(QUANT_LUMA, quality);
  const chroma = scaleQuantTable(QUANT_CHROMA, quality);

  return writeJpeg(image, luma, chroma, background);
}

/**
 * Read the EXIF orientation tag (1-8), or 1 if there is none.
 *
 * READS it only. Applying an orientation needs rotate and flip, and a codec that imports
 * a transform is a dependency running the wrong way round -- features/decode.md does the
 * applying, at the layer that already knows about both.
 */
export function readExifOrientation(bytes: Uint8Array): number {
  const app1 = findExif(bytes);
  return app1 === undefined ? 1 : (readOrientationTag(bytes, app1) ?? 1);
}

// --- markers -------------------------------------------------------------------------

interface Component {
  id: number;
  /** Horizontal and vertical sampling factors. */
  h: number;
  v: number;
  /** Quantisation table index. */
  tq: number;
  /** DC predictor, reset at every restart interval. */
  pred: number;
  dcTable: number;
  acTable: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Padded out to whole MCUs, which is what the scan actually writes. */
  blocksPerLineForMcu: number;
  blocksPerColumnForMcu: number;
  coefficients: Int16Array;
  /** Filled by the IDCT, at the component's own (possibly subsampled) resolution. */
  samples?: Uint8ClampedArray;
  sampleStride: number;
  /** Filled by the upsampler, at full image resolution. */
  pixels?: Uint8ClampedArray;
}

interface Frame {
  width: number;
  height: number;
  progressive: boolean;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
  /** From an Adobe APP14 marker: 0 = CMYK/RGB, 1 = YCbCr, 2 = YCCK. */
  adobeTransform: number;
}

/**
 * Walk the marker segments. With `headerOnly`, stop at the frame header and never touch
 * the scan -- so a caller sizing a preview does not need a decoder that can read it, and
 * probe works on progressive files that decode does not.
 */
function readFrame(bytes: Uint8Array, headerOnly: boolean): Frame {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== Marker.SOI) {
    throw new CorruptImageError('Not a JPEG: missing the SOI marker.');
  }

  const quant: (Uint16Array | undefined)[] = [];
  const dcTables: (HuffmanTable | undefined)[] = [];
  const acTables: (HuffmanTable | undefined)[] = [];
  let frame: Frame | undefined;
  let restartInterval = 0;
  let adobeTransform = -1;
  /** Which components a scan has actually covered, so a file missing one is caught. */
  const scanned = new Set<number>();

  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) {
      throw new CorruptImageError(`Expected a JPEG marker at byte ${at}.`);
    }
    // Fill bytes: a marker may be padded with any number of 0xff.
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];

    if (marker === undefined) throw new CorruptImageError('JPEG ended mid-marker.');
    if (marker === Marker.EOI) break;
    if (marker === Marker.SOI) continue;

    const length = readU16(bytes, at);
    const body = at + 2;
    const end = at + length;
    if (length < 2 || end > bytes.length) {
      throw new CorruptImageError(`JPEG segment at byte ${at} runs past the end of the file.`);
    }

    switch (marker) {
      case Marker.SOF9:
      case Marker.SOF10:
        // Vanishingly rare, patent-shadowed history, nobody produces them. A clear error
        // is fine forever; this one is not a gap to close.
        throw new UnsupportedFormatError(bytes, 'Arithmetic-coded JPEG is not supported.');

      case Marker.SOF0:
      case Marker.SOF1:
      case Marker.SOF2:
        frame = readSof(bytes, body, end, marker === Marker.SOF2, adobeTransform);
        if (headerOnly) return frame;
        if (frame.progressive) {
          throw new UnsupportedFormatError(
            bytes,
            'Progressive JPEG is not supported yet; only baseline JPEG can be decoded.',
          );
        }
        break;

      case Marker.DQT:
        readDqt(bytes, body, end, quant);
        break;

      case Marker.DHT:
        readDht(bytes, body, end, dcTables, acTables);
        break;

      case Marker.DRI:
        restartInterval = readU16(bytes, body);
        break;

      case Marker.APP0 + 14: // APP14
        // "Adobe" then a version, flags, and the colour transform in the last byte.
        if (length >= 13 && String.fromCharCode(...bytes.subarray(body, body + 5)) === 'Adobe') {
          adobeTransform = bytes[body + 9]!;
          if (frame !== undefined) frame.adobeTransform = adobeTransform;
        }
        break;

      case Marker.SOS: {
        if (frame === undefined) throw new CorruptImageError('JPEG has a scan before its frame header.');
        // NOT a return. Baseline is USUALLY one interleaved scan covering every component,
        // but it is legal (and cjpeg -scans will produce it) to send each component in its
        // own scan. Stopping at the first one decodes the luma and leaves both chroma
        // planes at zero -- a green image. Keep walking until EOI.
        at = readScan(bytes, body, end, frame, dcTables, acTables, restartInterval, scanned);
        continue;
      }

      default:
        break; // APPn, COM, and anything else: skipped by the length field.
    }

    at = end;
  }

  if (frame === undefined) throw new CorruptImageError('JPEG has no frame header.');
  if (scanned.size === 0) throw new CorruptImageError('JPEG has no scan data.');

  for (const c of frame.components) {
    if (!scanned.has(c.id)) {
      throw new CorruptImageError(`JPEG never sends a scan for component ${c.id}.`);
    }
    const q = quant[c.tq];
    if (q === undefined) {
      throw new CorruptImageError(`JPEG component ${c.id} names a missing quantisation table.`);
    }
    transform(c, q);
  }

  return frame;
}

/** SOF: dimensions, components, sampling factors. */
function readSof(
  bytes: Uint8Array,
  body: number,
  end: number,
  progressive: boolean,
  adobeTransform: number,
): Frame {
  if (body + 6 > end) throw new CorruptImageError('JPEG frame header is truncated.');

  const precision = bytes[body]!;
  if (precision !== 8) {
    throw new UnsupportedFormatError(bytes, `${precision}-bit JPEG is not supported; only 8-bit is.`);
  }

  const height = readU16(bytes, body + 1);
  const width = readU16(bytes, body + 3);
  const count = bytes[body + 5]!;

  if (width < 1 || height < 1) {
    throw new CorruptImageError(`JPEG declares an invalid size: ${width}x${height}.`);
  }
  // Before allocation, not after: two bytes of header can ask for 65535x65535, which is
  // 17 GB of RGBA from a file that fits in a tweet.
  if (width * height > DEFAULT_MAX_PIXELS) {
    throw new ImageTooLargeError(width, height, DEFAULT_MAX_PIXELS);
  }
  if (count < 1 || body + 6 + count * 3 > end) {
    throw new CorruptImageError('JPEG frame header component list is truncated.');
  }
  if (count !== 1 && count !== 3 && count !== 4) {
    throw new UnsupportedFormatError(bytes, `A ${count}-component JPEG is not supported.`);
  }

  const components: Component[] = [];
  let maxH = 1;
  let maxV = 1;

  for (let i = 0; i < count; i++) {
    const o = body + 6 + i * 3;
    const h = bytes[o + 1]! >> 4;
    const v = bytes[o + 1]! & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      throw new CorruptImageError(`JPEG component ${i} has invalid sampling factors ${h}x${v}.`);
    }
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    components.push({
      id: bytes[o]!,
      h,
      v,
      tq: bytes[o + 2]!,
      pred: 0,
      dcTable: 0,
      acTable: 0,
      blocksPerLine: 0,
      blocksPerColumn: 0,
      blocksPerLineForMcu: 0,
      blocksPerColumnForMcu: 0,
      coefficients: new Int16Array(0),
      sampleStride: 0,
    });
  }

  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));

  for (const c of components) {
    c.blocksPerLine = Math.ceil((Math.ceil(width / 8) * c.h) / maxH);
    c.blocksPerColumn = Math.ceil((Math.ceil(height / 8) * c.v) / maxV);
    c.blocksPerLineForMcu = mcusPerLine * c.h;
    c.blocksPerColumnForMcu = mcusPerColumn * c.v;
    c.coefficients = new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64);
  }

  return { width, height, progressive, maxH, maxV, mcusPerLine, mcusPerColumn, components, adobeTransform };
}

/** DQT: one or more quantisation tables, in zig-zag order. */
function readDqt(bytes: Uint8Array, body: number, end: number, quant: (Uint16Array | undefined)[]): void {
  let at = body;
  while (at < end) {
    const spec = bytes[at++]!;
    const id = spec & 15;
    const wide = spec >> 4; // 0 = 8-bit values, 1 = 16-bit
    const table = new Uint16Array(64);

    for (let i = 0; i < 64; i++) {
      if (at >= end) throw new CorruptImageError('JPEG quantisation table is truncated.');
      // Stored zig-zag, used in natural order.
      table[ZIGZAG[i]!] = wide ? readU16(bytes, (at += 2) - 2) : bytes[at++]!;
    }
    quant[id] = table;
  }
}

/** DHT: one or more Huffman tables. */
function readDht(
  bytes: Uint8Array,
  body: number,
  end: number,
  dcTables: (HuffmanTable | undefined)[],
  acTables: (HuffmanTable | undefined)[],
): void {
  let at = body;
  while (at < end) {
    const spec = bytes[at++]!;
    const id = spec & 15;
    const isAc = (spec >> 4) === 1;

    if (at + 16 > end) throw new CorruptImageError('JPEG Huffman table is truncated.');
    const counts = bytes.subarray(at, at + 16);
    at += 16;

    let total = 0;
    for (const n of counts) total += n;
    if (at + total > end) throw new CorruptImageError('JPEG Huffman table value list is truncated.');

    const table = buildHuffman({ counts, values: bytes.subarray(at, at + total) });
    at += total;

    if (isAc) acTables[id] = table;
    else dcTables[id] = table;
  }
}

// --- Huffman -------------------------------------------------------------------------

/**
 * A canonical Huffman table in the form the bit-sequential decoder wants: per code length,
 * the largest code of that length and the offset into `values`. Figure F.15 of T.81.
 */
interface HuffmanTable {
  /** maxcode[l] is the largest length-l code, or -1 if there are none. */
  maxcode: Int32Array;
  /** valoffset[l] + code indexes straight into values. */
  valoffset: Int32Array;
  values: Uint8Array;
}

function buildHuffman(spec: HuffmanSpec): HuffmanTable {
  const maxcode = new Int32Array(18).fill(-1);
  const valoffset = new Int32Array(18);

  // Figure C.2: canonical codes, assigned shortest-first in value order.
  let code = 0;
  let p = 0;
  for (let l = 1; l <= 16; l++) {
    const n = spec.counts[l - 1]!;
    if (n > 0) {
      valoffset[l] = p - code;
      p += n;
      code += n;
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  // A sentinel so the decode loop always terminates: no code is longer than 16 bits, and
  // reaching here at all means the bitstream is not valid for this table.
  maxcode[17] = 0xfffff;

  return { maxcode, valoffset, values: spec.values };
}

/**
 * The entropy-coded bit reader: byte-stuffed, restart-aware.
 *
 * Inside a scan, a literal 0xff byte is written as `FF 00`, because a bare 0xff starts a
 * marker. Miss the unstuffing and the bitstream desynchronises on the first bright pixel.
 */
class BitReader {
  private buf = 0;
  private count = 0;
  /** Set once a marker is met, so the caller can tell "scan ended" from "file ended". */
  markerHit = false;
  at: number;
  private readonly bytes: Uint8Array;

  // Spelled out rather than declared as constructor parameter properties: those emit real
  // assignments, so they are not type syntax, and Node's type stripping refuses them.
  constructor(bytes: Uint8Array, at: number) {
    this.bytes = bytes;
    this.at = at;
  }

  readBit(): number {
    if (this.count === 0) {
      if (this.at >= this.bytes.length) {
        throw new CorruptImageError('JPEG scan data ended mid-symbol: the file is truncated.');
      }
      let byte = this.bytes[this.at++]!;

      if (byte === 0xff) {
        const next = this.bytes[this.at];
        if (next === 0x00) {
          this.at++; // stuffed: a literal 0xff
        } else if (next !== undefined && next >= 0xd0 && next <= 0xd7) {
          // A restart marker where a bit was expected means the entropy data is shorter
          // than the MCU count claims.
          throw new CorruptImageError('JPEG hit a restart marker mid-symbol.');
        } else {
          // Any other marker ends the scan. Real encoders pad the last byte, so a decoder
          // that treats this as data reads a few bits of the EOI marker as coefficients.
          this.markerHit = true;
          this.at--;
          byte = 0;
        }
      }

      this.buf = byte;
      this.count = 8;
    }

    this.count--;
    return (this.buf >> this.count) & 1;
  }

  /** Read `n` bits as an unsigned integer, most significant first. */
  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }

  /**
   * Read `n` bits and sign-extend, per T.81's EXTEND. JPEG stores a magnitude category
   * and the raw bits; the top half of the range is positive and the bottom half is a
   * negative offset from it.
   */
  receiveAndExtend(n: number): number {
    if (n === 0) return 0;
    const v = this.receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(table: HuffmanTable): number {
    let code = this.readBit();
    let l = 1;
    while (code > table.maxcode[l]!) {
      code = (code << 1) | this.readBit();
      if (++l > 16) throw new CorruptImageError('JPEG Huffman code is longer than 16 bits.');
    }
    const v = table.values[code + table.valoffset[l]!];
    if (v === undefined) throw new CorruptImageError('JPEG Huffman code is not in the table.');
    return v;
  }

  /**
   * Consume a restart marker: drop the partial byte, then step over the RSTn.
   *
   * Restart intervals exist so a decoder can resynchronise, so the marker is byte-aligned
   * and any bits left over from the last symbol are padding.
   */
  restart(): void {
    this.count = 0;
    this.markerHit = false;

    const next = this.bytes[this.at + 1];
    if (this.bytes[this.at] !== 0xff || next === undefined || next < 0xd0 || next > 0xd7) {
      throw new CorruptImageError('JPEG is missing an expected restart marker.');
    }
    this.at += 2;
  }
}

// --- scan ----------------------------------------------------------------------------

/**
 * Decode one entropy-coded scan into its components' coefficients, and return the byte
 * offset just past it. The inverse transform waits until every scan is in.
 */
function readScan(
  bytes: Uint8Array,
  body: number,
  end: number,
  frame: Frame,
  dcTables: (HuffmanTable | undefined)[],
  acTables: (HuffmanTable | undefined)[],
  restartInterval: number,
  scanned: Set<number>,
): number {
  const count = bytes[body]!;
  if (body + 1 + count * 2 + 3 > end) throw new CorruptImageError('JPEG scan header is truncated.');

  const scan: Component[] = [];
  for (let i = 0; i < count; i++) {
    const id = bytes[body + 1 + i * 2]!;
    const c = frame.components.find((x) => x.id === id);
    if (c === undefined) throw new CorruptImageError(`JPEG scan names component ${id}, which the frame lacks.`);

    const tables = bytes[body + 2 + i * 2]!;
    c.dcTable = tables >> 4;
    c.acTable = tables & 15;
    c.pred = 0;
    scan.push(c);
    scanned.add(id);
  }

  const reader = new BitReader(bytes, end);

  // A scan with one component is NON-interleaved: it walks that component's own blocks
  // directly, with no MCU grouping. With several it walks MCUs, each holding h*v blocks
  // per component. Treating the two the same shears every subsampled multi-scan file.
  if (scan.length === 1) {
    const c = scan[0]!;
    decodeBlocks(reader, c, dcTables, acTables, c.blocksPerLine, c.blocksPerColumn, restartInterval, (i) => {
      const row = Math.floor(i / c.blocksPerLine);
      const col = i % c.blocksPerLine;
      return (row * c.blocksPerLineForMcu + col) * 64;
    });
  } else {
    decodeMcus(reader, scan, frame, dcTables, acTables, restartInterval);
  }

  return reader.at;
}

/** Walk a non-interleaved scan: this component's blocks, in raster order. */
function decodeBlocks(
  reader: BitReader,
  c: Component,
  dcTables: (HuffmanTable | undefined)[],
  acTables: (HuffmanTable | undefined)[],
  perLine: number,
  perColumn: number,
  restartInterval: number,
  offsetOf: (i: number) => number,
): void {
  const total = perLine * perColumn;
  const interval = restartInterval || total;

  for (let i = 0; i < total; i++) {
    if (i > 0 && i % interval === 0) restart(reader, [c]);
    decodeBlock(reader, c, dcTables, acTables, offsetOf(i));
  }
}

/** Walk an interleaved scan: MCU by MCU, each component contributing h*v blocks. */
function decodeMcus(
  reader: BitReader,
  scan: Component[],
  frame: Frame,
  dcTables: (HuffmanTable | undefined)[],
  acTables: (HuffmanTable | undefined)[],
  restartInterval: number,
): void {
  const total = frame.mcusPerLine * frame.mcusPerColumn;
  const interval = restartInterval || total;

  for (let mcu = 0; mcu < total; mcu++) {
    if (mcu > 0 && mcu % interval === 0) restart(reader, scan);

    const mcuRow = Math.floor(mcu / frame.mcusPerLine);
    const mcuCol = mcu % frame.mcusPerLine;

    for (const c of scan) {
      for (let v = 0; v < c.v; v++) {
        for (let h = 0; h < c.h; h++) {
          const row = mcuRow * c.v + v;
          const col = mcuCol * c.h + h;
          decodeBlock(reader, c, dcTables, acTables, (row * c.blocksPerLineForMcu + col) * 64);
        }
      }
    }
  }
}

/**
 * Cross a restart interval boundary: step over the marker and reset the DC predictors.
 *
 * Resetting the predictors is the half that is easy to forget. They are differential, so
 * carrying one across the boundary makes every block after it wrong by a constant -- and
 * the whole point of a restart interval is that each one decodes independently.
 */
function restart(reader: BitReader, scan: Component[]): void {
  reader.restart();
  for (const c of scan) c.pred = 0;
}

/** One 8x8 block: a differential DC coefficient, then run-length coded AC coefficients. */
function decodeBlock(
  reader: BitReader,
  c: Component,
  dcTables: (HuffmanTable | undefined)[],
  acTables: (HuffmanTable | undefined)[],
  offset: number,
): void {
  const dc = dcTables[c.dcTable];
  const ac = acTables[c.acTable];
  if (dc === undefined || ac === undefined) {
    throw new CorruptImageError(`JPEG component ${c.id} names a Huffman table the file never defined.`);
  }

  // DC is coded as a difference from the previous block's DC in the same component.
  c.pred += reader.receiveAndExtend(reader.decode(dc));
  c.coefficients[offset] = c.pred;

  let k = 1;
  while (k < 64) {
    const rs = reader.decode(ac);
    const size = rs & 15;
    const run = rs >> 4;

    if (size === 0) {
      if (run !== 15) break; // EOB: every remaining coefficient is zero
      k += 16; // ZRL: a run of exactly sixteen zeros
      continue;
    }

    k += run;
    if (k > 63) throw new CorruptImageError('JPEG coefficient run overflows its block.');
    c.coefficients[offset + ZIGZAG[k]!] = reader.receiveAndExtend(size);
    k++;
  }
}

/** Dequantise and inverse-transform every block of a component into a sample plane. */
function transform(c: Component, quant: Uint16Array): void {
  const stride = c.blocksPerLineForMcu * 8;
  const samples = new Uint8ClampedArray(stride * c.blocksPerColumnForMcu * 8);

  for (let row = 0; row < c.blocksPerColumnForMcu; row++) {
    for (let col = 0; col < c.blocksPerLineForMcu; col++) {
      inverseDct(
        c.coefficients,
        (row * c.blocksPerLineForMcu + col) * 64,
        quant,
        samples,
        row * 8 * stride + col * 8,
        stride,
      );
    }
  }

  c.samples = samples;
  c.sampleStride = stride;
}

// --- upsampling ----------------------------------------------------------------------

/**
 * Bring a component up to full image resolution.
 *
 * The chroma planes of a 4:2:0 file are half resolution in both axes, and this is where
 * they are stretched back. NOT nearest-neighbour: the triangle filter below is what
 * libjpeg calls "fancy upsampling" and has on by default, so it is both what colour edges
 * need (nearest makes them visibly chunky) and what makes our output match libjpeg's.
 */
function upsample(c: Component, frame: Frame): void {
  const { width, height, maxH, maxV } = frame;
  const inWidth = Math.ceil((width * c.h) / maxH);
  const inHeight = Math.ceil((height * c.v) / maxV);
  const src = c.samples!;
  const stride = c.sampleStride;

  if (c.h === maxH && c.v === maxV) {
    // Already full resolution: crop the MCU padding away and nothing else.
    const out = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      out.set(src.subarray(y * stride, y * stride + width), y * width);
    }
    c.pixels = out;
    return;
  }

  const hScale = maxH / c.h;
  const vScale = maxV / c.v;

  if (hScale === 2 && vScale === 1) {
    c.pixels = crop(fancyH2(src, stride, inWidth, inHeight), inWidth * 2, width, height);
    return;
  }
  if (hScale === 2 && vScale === 2) {
    c.pixels = crop(fancyH2V2(src, stride, inWidth, inHeight), inWidth * 2, width, height);
    return;
  }

  // An exotic sampling factor (4x1, 3x2 and the like). Legal, essentially never produced,
  // and replicating samples is correct if blocky. Not worth a bespoke filter each.
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(inHeight - 1, Math.floor((y * c.v) / maxV));
    for (let x = 0; x < width; x++) {
      out[y * width + x] = src[sy * stride + Math.min(inWidth - 1, Math.floor((x * c.h) / maxH))]!;
    }
  }
  c.pixels = out;
}

/** Take the top-left width x height of a plane, dropping the MCU padding. */
function crop(src: Uint8ClampedArray, stride: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) out.set(src.subarray(y * stride, y * stride + width), y * width);
  return out;
}

/**
 * Double the width with libjpeg's triangle filter: each output sample is 3/4 of its
 * nearest input and 1/4 of the next one over, with the two edge columns replicated.
 */
function fancyH2(src: Uint8ClampedArray, stride: number, width: number, height: number): Uint8ClampedArray {
  const outStride = width * 2;
  const out = new Uint8ClampedArray(outStride * height);

  for (let y = 0; y < height; y++) {
    const i = y * stride;
    const o = y * outStride;

    if (width === 1) {
      // Nothing to interpolate against.
      out[o] = out[o + 1] = src[i]!;
      continue;
    }

    // First column: no left neighbour, so the first output sample is a straight copy.
    out[o] = src[i]!;
    out[o + 1] = (src[i]! * 3 + src[i + 1]! + 2) >> 2;

    for (let x = 1; x < width - 1; x++) {
      const v = src[i + x]! * 3;
      out[o + x * 2] = (v + src[i + x - 1]! + 1) >> 2;
      out[o + x * 2 + 1] = (v + src[i + x + 1]! + 2) >> 2;
    }

    // Last column: mirror of the first.
    const last = width - 1;
    out[o + last * 2] = (src[i + last]! * 3 + src[i + last - 1]! + 1) >> 2;
    out[o + last * 2 + 1] = src[i + last]!;
  }

  return out;
}

/**
 * Double both axes with the triangle filter, in ONE fused pass. The 4:2:0 case, which is
 * the overwhelmingly common one.
 *
 * Fused deliberately, not composed out of a vertical pass and then a horizontal one. That
 * composition is the same filter mathematically, but it rounds to 8 bits TWICE, and the
 * error compounds: it left ~15% of channels off by one against libjpeg while 4:2:2 and
 * 4:4:4 were bit-exact. Doing both axes before the single divide by 16 makes 4:2:0 exact
 * too. The intermediate `colsum` is the vertical half (3:1) left un-rounded.
 */
function fancyH2V2(src: Uint8ClampedArray, stride: number, width: number, height: number): Uint8ClampedArray {
  const outStride = width * 2;
  const out = new Uint8ClampedArray(outStride * height * 2);

  for (let y = 0; y < height; y++) {
    // Each input row produces two output rows: the upper leans on the row above, the
    // lower on the row below. Clamped at the edges, so they lean on themselves and stay.
    for (let half = 0; half < 2; half++) {
      const near = y * stride;
      const far = (half === 0 ? Math.max(0, y - 1) : Math.min(height - 1, y + 1)) * stride;
      const o = (y * 2 + half) * outStride;

      const colsum = (x: number): number => src[near + x]! * 3 + src[far + x]!;

      if (width === 1) {
        out[o] = out[o + 1] = (colsum(0) * 4 + 8) >> 4;
        continue;
      }

      let last = 0;
      let cur = colsum(0);
      let next = colsum(1);

      // First column: no left neighbour, so the left output sample is all `cur`.
      out[o] = (cur * 4 + 8) >> 4;
      out[o + 1] = (cur * 3 + next + 7) >> 4;
      last = cur;
      cur = next;

      for (let x = 1; x < width - 1; x++) {
        next = colsum(x + 1);
        out[o + x * 2] = (cur * 3 + last + 8) >> 4;
        out[o + x * 2 + 1] = (cur * 3 + next + 7) >> 4;
        last = cur;
        cur = next;
      }

      // Last column: mirror of the first.
      const end = width - 1;
      out[o + end * 2] = (cur * 3 + last + 8) >> 4;
      out[o + end * 2 + 1] = (cur * 4 + 7) >> 4;
    }
  }

  return out;
}

// --- colour --------------------------------------------------------------------------

/**
 * libjpeg's YCbCr -> RGB tables, at 16-bit fixed point.
 *
 *   R = Y                + 1.40200 * (Cr - 128)
 *   G = Y - 0.34414 * (Cb - 128) - 0.71414 * (Cr - 128)
 *   B = Y + 1.77200 * (Cb - 128)
 *
 * Precomputed per possible channel value, which is both what libjpeg does (so the
 * rounding matches) and a great deal faster than three multiplies per pixel.
 */
const SCALEBITS = 16;
const ONE_HALF = 1 << (SCALEBITS - 1);
const fix = (x: number): number => Math.round(x * (1 << SCALEBITS));

const CR_R = new Int32Array(256);
const CB_B = new Int32Array(256);
const CR_G = new Int32Array(256);
const CB_G = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const x = i - 128;
  CR_R[i] = (fix(1.402) * x + ONE_HALF) >> SCALEBITS;
  CB_B[i] = (fix(1.772) * x + ONE_HALF) >> SCALEBITS;
  CR_G[i] = -fix(0.71414) * x;
  CB_G[i] = -fix(0.34414) * x + ONE_HALF;
}

function ycbcrToRgba(components: Component[], image: RawImage): void {
  const y = components[0]!.pixels!;
  const cb = components[1]!.pixels!;
  const cr = components[2]!.pixels!;
  const { data } = image;

  for (let i = 0, o = 0; i < y.length; i++, o += 4) {
    const luma = y[i]!;
    const b = cb[i]!;
    const r = cr[i]!;

    data[o] = luma + CR_R[r]!;
    data[o + 1] = luma + ((CB_G[b]! + CR_G[r]!) >> SCALEBITS);
    data[o + 2] = luma + CB_B[b]!;
    data[o + 3] = 255;
  }
}

function greyToRgba(y: Uint8ClampedArray, image: RawImage): void {
  const { data } = image;
  for (let i = 0, o = 0; i < y.length; i++, o += 4) {
    data[o] = data[o + 1] = data[o + 2] = y[i]!;
    data[o + 3] = 255;
  }
}

/**
 * CMYK and YCCK, from print workflows. Converted naively and without colour management,
 * which is documented and deliberate: an approximate colour beats refusing the file.
 */
function cmykToRgba(components: Component[], adobeTransform: number, image: RawImage): void {
  const [c0, c1, c2, c3] = [
    components[0]!.pixels!,
    components[1]!.pixels!,
    components[2]!.pixels!,
    components[3]!.pixels!,
  ];
  const { data } = image;

  for (let i = 0, o = 0; i < c0.length; i++, o += 4) {
    let c: number;
    let m: number;
    let ye: number;

    if (adobeTransform === 2) {
      // YCCK: the first three channels are YCbCr and convert as usual.
      const luma = c0[i]!;
      const cb = c1[i]!;
      const cr = c2[i]!;
      c = luma + CR_R[cr]!;
      m = luma + ((CB_G[cb]! + CR_G[cr]!) >> SCALEBITS);
      ye = luma + CB_B[cb]!;
    } else {
      c = c0[i]!;
      m = c1[i]!;
      ye = c2[i]!;
    }

    // Adobe writes CMYK inverted. Every 4-component JPEG in the wild is Adobe's.
    const k = c3[i]!;
    data[o] = (c * k) / 255;
    data[o + 1] = (m * k) / 255;
    data[o + 2] = (ye * k) / 255;
    data[o + 3] = 255;
  }
}

// --- EXIF ----------------------------------------------------------------------------

/** Find the APP1 payload that starts with "Exif\0\0", and return the TIFF header offset. */
function findExif(bytes: Uint8Array): number | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== Marker.SOI) return undefined;

  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker === Marker.SOS || marker === Marker.EOI) return undefined;

    const length = readU16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return undefined;

    if (marker === Marker.APP1 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === 'Exif\0\0') {
      return at + 10;
    }
    at += 2 + length;
  }
  return undefined;
}

/**
 * Read tag 0x0112 out of IFD0. Returns undefined for anything malformed rather than
 * throwing: a broken metadata block is not worth failing a decode over, because the
 * pixels are fine.
 */
function readOrientationTag(bytes: Uint8Array, tiff: number): number | undefined {
  if (tiff + 8 > bytes.length) return undefined;

  // "II" is little-endian, "MM" big-endian. Both are real: iPhones write big-endian, and
  // assuming little reads the entry count as 256 and finds nothing.
  const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!le && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(tiff + 2, le) !== 42) return undefined; // the TIFF magic number

  const ifd = tiff + view.getUint32(tiff + 4, le);
  if (ifd + 2 > bytes.length) return undefined;

  const count = view.getUint16(ifd, le);
  if (ifd + 2 + count * 12 > bytes.length) return undefined;

  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry, le) !== 0x0112) continue;

    // A SHORT value lives inline in the entry's value field, not at an offset.
    const value = view.getUint16(entry + 8, le);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

// --- encode --------------------------------------------------------------------------

/** A canonical Huffman table as the encoder wants it: code and length, indexed by value. */
interface HuffmanEncoder {
  codes: Int32Array;
  lengths: Uint8Array;
}

function buildEncoder(spec: HuffmanSpec): HuffmanEncoder {
  const codes = new Int32Array(256);
  const lengths = new Uint8Array(256);

  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < spec.counts[l - 1]!; i++) {
      const v = spec.values[k++]!;
      codes[v] = code++;
      lengths[v] = l;
    }
    code <<= 1;
  }
  return { codes, lengths };
}

const ENC_DC_LUMA = buildEncoder(DC_LUMA);
const ENC_AC_LUMA = buildEncoder(AC_LUMA);
const ENC_DC_CHROMA = buildEncoder(DC_CHROMA);
const ENC_AC_CHROMA = buildEncoder(AC_CHROMA);

/** A growable output buffer with a bit-level writer that re-stuffs 0xff. */
class BitWriter {
  private bytes = new Uint8Array(65536);
  private len = 0;
  private buf = 0;
  private count = 0;

  byte(v: number): void {
    if (this.len === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.len++] = v;
  }

  u16(v: number): void {
    this.byte((v >> 8) & 0xff);
    this.byte(v & 0xff);
  }

  write(v: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.buf = (this.buf << 1) | ((v >> i) & 1);
      if (++this.count === 8) {
        this.byte(this.buf & 0xff);
        // The mirror of the decoder's unstuffing: a literal 0xff inside entropy data must
        // be followed by 0x00, or every decoder reads it as a marker.
        if ((this.buf & 0xff) === 0xff) this.byte(0x00);
        this.buf = 0;
        this.count = 0;
      }
    }
  }

  /** Pad the final partial byte with ones, as T.81 requires. */
  flush(): void {
    while (this.count > 0) this.write(1, 1);
  }

  take(): Uint8Array {
    return this.bytes.slice(0, this.len);
  }
}

function writeJpeg(image: RawImage, luma: Uint16Array, chroma: Uint16Array, background: RGBA): Uint8Array {
  const { width, height } = image;
  const w = new BitWriter();

  w.u16(0xffd8); // SOI

  // A bare JFIF APP0 and nothing else: no EXIF, no thumbnail, no ICC. That makes
  // features/strip-metadata.md free on the write side, as long as this never grows.
  w.u16(0xffe0);
  w.u16(16);
  for (const ch of 'JFIF') w.byte(ch.charCodeAt(0));
  w.byte(0);
  w.u16(0x0102); // version 1.2
  w.byte(0); // density units: none
  w.u16(1); // x density
  w.u16(1); // y density
  w.byte(0); // no thumbnail
  w.byte(0);

  writeDqt(w, luma, chroma);
  writeSof(w, width, height);
  writeDht(w);
  writeSos(w, image, luma, chroma, background);

  w.u16(0xffd9); // EOI
  return w.take();
}

function writeDqt(w: BitWriter, luma: Uint16Array, chroma: Uint16Array): void {
  w.u16(0xffdb);
  w.u16(2 + 2 * 65);
  for (const [id, table] of [
    [0, luma],
    [1, chroma],
  ] as const) {
    w.byte(id); // 8-bit precision, table id
    // Written zig-zag, held in natural order.
    for (let i = 0; i < 64; i++) w.byte(table[ZIGZAG[i]!]!);
  }
}

function writeSof(w: BitWriter, width: number, height: number): void {
  w.u16(0xffc0); // SOF0: baseline
  w.u16(8 + 3 * 3);
  w.byte(8); // 8-bit samples
  w.u16(height);
  w.u16(width);
  w.byte(3); // components

  w.byte(1); // Y
  w.byte(0x22); // 2x2 sampling: 4:2:0
  w.byte(0); // quant table 0
  w.byte(2); // Cb
  w.byte(0x11);
  w.byte(1);
  w.byte(3); // Cr
  w.byte(0x11);
  w.byte(1);
}

function writeDht(w: BitWriter): void {
  const specs: readonly (readonly [number, HuffmanSpec])[] = [
    [0x00, DC_LUMA],
    [0x10, AC_LUMA],
    [0x01, DC_CHROMA],
    [0x11, AC_CHROMA],
  ];

  let length = 2;
  for (const [, s] of specs) length += 1 + 16 + s.values.length;

  w.u16(0xffc4);
  w.u16(length);
  for (const [id, s] of specs) {
    w.byte(id);
    for (const n of s.counts) w.byte(n);
    for (const v of s.values) w.byte(v);
  }
}

/** Colour-convert, subsample, transform and entropy-code the image into one scan. */
function writeSos(w: BitWriter, image: RawImage, luma: Uint16Array, chroma: Uint16Array, background: RGBA): void {
  const { width, height } = image;

  w.u16(0xffda);
  w.u16(6 + 2 * 3);
  w.byte(3);
  w.byte(1); // Y
  w.byte(0x00); // DC table 0, AC table 0
  w.byte(2); // Cb
  w.byte(0x11);
  w.byte(3); // Cr
  w.byte(0x11);
  w.byte(0); // spectral selection start
  w.byte(63); // ... end
  w.byte(0); // successive approximation

  // The MCU grid, padded out to whole 16x16 blocks. The padding is generated by clamping
  // reads to the edge rather than by filling: a black or transparent margin bleeds back
  // into the real pixels through the DCT and shows as a dark fringe at the edges.
  const mcusPerLine = Math.ceil(width / 16);
  const mcusPerColumn = Math.ceil(height / 16);

  const { y: yPlane, cb, cr } = toYCbCr(image, background);

  const block = new Int16Array(64);
  const pred = [0, 0, 0];

  for (let my = 0; my < mcusPerColumn; my++) {
    for (let mx = 0; mx < mcusPerLine; mx++) {
      // Four luma blocks at full resolution...
      for (let b = 0; b < 4; b++) {
        gather(block, yPlane, width, height, mx * 16 + (b & 1) * 8, my * 16 + (b >> 1) * 8, 1);
        forwardDct(block, luma);
        pred[0] = writeBlock(w, block, pred[0]!, ENC_DC_LUMA, ENC_AC_LUMA);
      }
      // ...and one of each chroma at half, which is what 4:2:0 means.
      gatherChroma(block, cb, width, height, mx * 8, my * 8);
      forwardDct(block, chroma);
      pred[1] = writeBlock(w, block, pred[1]!, ENC_DC_CHROMA, ENC_AC_CHROMA);

      gatherChroma(block, cr, width, height, mx * 8, my * 8);
      forwardDct(block, chroma);
      pred[2] = writeBlock(w, block, pred[2]!, ENC_DC_CHROMA, ENC_AC_CHROMA);
    }
  }

  w.flush();
}

interface Planes {
  y: Uint8ClampedArray;
  cb: Uint8ClampedArray;
  cr: Uint8ClampedArray;
}

/**
 * RGBA -> YCbCr planes, compositing alpha onto the background on the way.
 *
 * JPEG has no alpha, so transparency has to be composited rather than dropped: dropping
 * it paints every transparent pixel black.
 */
function toYCbCr(image: RawImage, background: RGBA): Planes {
  const { width, height, data } = image;
  const n = width * height;

  const y = new Uint8ClampedArray(n);
  const cb = new Uint8ClampedArray(n);
  const cr = new Uint8ClampedArray(n);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3]! / 255;
    const r = data[o]! * a + background[0] * (1 - a);
    const g = data[o + 1]! * a + background[1] * (1 - a);
    const b = data[o + 2]! * a + background[2] * (1 - a);

    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  return { y, cb, cr };
}

/**
 * Pull an 8x8 block out of a plane, level-shifted by -128, clamping reads at the image
 * edge so a partial MCU repeats its last real pixel instead of inventing one.
 */
function gather(
  block: Int16Array,
  plane: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  step: number,
): void {
  for (let y = 0; y < 8; y++) {
    const sy = Math.min(height - 1, y0 + y * step);
    for (let x = 0; x < 8; x++) {
      const sx = Math.min(width - 1, x0 + x * step);
      block[y * 8 + x] = plane[sy * width + sx]! - 128;
    }
  }
}

/** The same, but box-averaging each 2x2 to halve the resolution: the 4:2:0 downsample. */
function gatherChroma(
  block: Int16Array,
  plane: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
): void {
  for (let y = 0; y < 8; y++) {
    const sy0 = Math.min(height - 1, (y0 + y) * 2);
    const sy1 = Math.min(height - 1, sy0 + 1);
    for (let x = 0; x < 8; x++) {
      const sx0 = Math.min(width - 1, (x0 + x) * 2);
      const sx1 = Math.min(width - 1, sx0 + 1);

      const sum =
        plane[sy0 * width + sx0]! + plane[sy0 * width + sx1]! + plane[sy1 * width + sx0]! + plane[sy1 * width + sx1]!;
      block[y * 8 + x] = ((sum + 2) >> 2) - 128;
    }
  }
}

/** Entropy-code one quantised block. Returns the new DC predictor. */
function writeBlock(w: BitWriter, block: Int16Array, pred: number, dc: HuffmanEncoder, ac: HuffmanEncoder): number {
  const diff = block[0]! - pred;
  writeCoefficient(w, diff, dc, 0);

  let runOfZeros = 0;
  for (let k = 1; k < 64; k++) {
    const v = block[ZIGZAG[k]!]!;
    if (v === 0) {
      runOfZeros++;
      continue;
    }
    // A run longer than 15 needs explicit ZRL codes: the run length is only 4 bits.
    while (runOfZeros > 15) {
      w.write(ac.codes[0xf0]!, ac.lengths[0xf0]!);
      runOfZeros -= 16;
    }
    writeCoefficient(w, v, ac, runOfZeros);
    runOfZeros = 0;
  }

  // A trailing run of zeros is an EOB rather than that many explicit codes: this is where
  // most of JPEG's compression actually comes from.
  if (runOfZeros > 0) w.write(ac.codes[0]!, ac.lengths[0]!);

  return block[0]!;
}

/** Write a coefficient as its (run, magnitude-category) symbol plus the raw bits. */
function writeCoefficient(w: BitWriter, value: number, table: HuffmanEncoder, run: number): void {
  const size = magnitude(value);
  const symbol = (run << 4) | size;

  const length = table.lengths[symbol];
  if (length === undefined || length === 0) {
    throw new CorruptImageError(`No Huffman code for symbol ${symbol}: the coefficient is out of range.`);
  }
  w.write(table.codes[symbol]!, length);

  if (size > 0) {
    // Negative values are stored as the one's complement of the magnitude, which is the
    // exact inverse of the decoder's EXTEND.
    w.write(value < 0 ? value + (1 << size) - 1 : value, size);
  }
}

/** How many bits the magnitude needs: T.81's category, and 0 for a zero value. */
function magnitude(value: number): number {
  const v = Math.abs(value);
  let bits = 0;
  for (let x = v; x > 0; x >>= 1) bits++;
  return bits;
}

function readU16(bytes: Uint8Array, at: number): number {
  const hi = bytes[at];
  const lo = bytes[at + 1];
  if (hi === undefined || lo === undefined) throw new CorruptImageError('JPEG ended mid-field.');
  return (hi << 8) | lo;
}
