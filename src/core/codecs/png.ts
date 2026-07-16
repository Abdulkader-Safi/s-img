/**
 * PNG codec. See features/codec-png.md.
 *
 * The easiest format in pure JS, because the hard part (DEFLATE) is node:zlib, which
 * exists on Node and Bun. This is the file that owns the one allowed `node:` import in
 * the core: everything else under src/core/ is host-free, and a browser build would
 * swap this module's zlib calls for CompressionStream. See features/file-io.md.
 *
 * Built first because it gives the whole pipeline a lossless round-trip to test
 * against, so every other feature is verified without a JPEG's lossy noise in the way.
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib';

import { CorruptImageError } from '../errors.ts';
import { createImage, type RawImage } from '../image.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ColourType = {
  Greyscale: 0,
  Truecolour: 2,
  Palette: 3,
  GreyscaleAlpha: 4,
  TruecolourAlpha: 6,
} as const;

/** Channels stored per pixel, before expansion to RGBA. */
const CHANNELS: Record<number, number> = {
  [ColourType.Greyscale]: 1,
  [ColourType.Truecolour]: 3,
  [ColourType.Palette]: 1,
  [ColourType.GreyscaleAlpha]: 2,
  [ColourType.TruecolourAlpha]: 4,
};

/** Bit depths the spec allows per colour type. A mismatch is a corrupt header. */
const LEGAL_DEPTHS: Record<number, readonly number[]> = {
  [ColourType.Greyscale]: [1, 2, 4, 8, 16],
  [ColourType.Truecolour]: [8, 16],
  [ColourType.Palette]: [1, 2, 4, 8],
  [ColourType.GreyscaleAlpha]: [8, 16],
  [ColourType.TruecolourAlpha]: [8, 16],
};

/** Adam7: seven passes, each with its own origin and stride. */
const ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
] as const;

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

/**
 * Read dimensions from IHDR without touching the pixel data.
 *
 * decode.md's size guard runs off this: read the header, multiply, compare against the
 * cap, and refuse *before* allocating. A decoder that allocates first and validates
 * second is a one-line denial of service against anyone who opens an attachment folder.
 */
export function probePng(bytes: Uint8Array): { width: number; height: number } {
  const { width, height } = readHeader(bytes);
  return { width, height };
}

/** Decode a PNG to RGBA. */
export function decodePng(bytes: Uint8Array): RawImage {
  const header = readHeader(bytes);
  const { palette, alpha, data } = readChunks(bytes, header);

  const inflated = inflate(data);
  const raw = header.interlace === 1 ? deinterlace(inflated, header) : unfilterPass(inflated, header, header.width, header.height);

  return toRgba(raw, header, palette, alpha);
}

/**
 * Encode RGBA to PNG. Deliberately one flavour: 8-bit RGBA, colour type 6,
 * non-interlaced, one IDAT, Paeth-filtered, deflate level 9.
 *
 * Not written: palette output (a quantiser, for a case GIF or WebP serves better),
 * 16-bit, APNG, or any ancillary chunk. features/strip-metadata.md is satisfied here
 * by construction -- there is no code path that can emit EXIF.
 */
export function encodePng(image: RawImage): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;

  // Paeth on every row, rather than the libpng heuristic that tries all five and picks
  // the cheapest. Paeth is near-optimal on photos for one line instead of five, and PNG
  // is not the format anyone reaches for when they care about bytes -- that is what the
  // JPEG and WebP paths are for. Revisit if a real file measurably disappoints.
  const scanlines = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    scanlines[at] = 4; // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? data[y * stride + i - 4]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y > 0 ? data[(y - 1) * stride + i - 4]! : 0;
      scanlines[at + 1 + i] = (data[y * stride + i]! - paeth(a, b, c)) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = ColourType.TruecolourAlpha;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const compressed: Uint8Array = deflateSync(scanlines, { level: 9 });

  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ]);
}

// --- header ------------------------------------------------------------------------

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < 8 + 25) {
    throw new CorruptImageError('Not a PNG: too short to hold a signature and IHDR.');
  }
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new CorruptImageError('Not a PNG: bad signature.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readType(bytes, 12) !== 'IHDR') {
    throw new CorruptImageError('Not a PNG: the first chunk is not IHDR.');
  }
  verifyCrc(bytes, 8, view.getUint32(8));

  const header: Header = {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24]!,
    colourType: bytes[25]!,
    interlace: bytes[28]!,
  };

  if (header.width < 1 || header.height < 1) {
    throw new CorruptImageError(`PNG has an invalid size: ${header.width}x${header.height}.`);
  }
  const legal = LEGAL_DEPTHS[header.colourType];
  if (legal === undefined) {
    throw new CorruptImageError(`PNG colour type ${header.colourType} is not defined.`);
  }
  if (!legal.includes(header.bitDepth)) {
    throw new CorruptImageError(
      `PNG bit depth ${header.bitDepth} is not allowed for colour type ${header.colourType}.`,
    );
  }
  if (header.interlace !== 0 && header.interlace !== 1) {
    throw new CorruptImageError(`PNG interlace method ${header.interlace} is not defined.`);
  }

  return header;
}

// --- chunks ------------------------------------------------------------------------

interface Chunks {
  palette?: Uint8Array;
  alpha?: Uint8Array;
  data: Uint8Array[];
}

function readChunks(bytes: Uint8Array, header: Header): Chunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunks = { data: [] };
  let at = 8;

  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = readType(bytes, at + 4);
    const end = at + 12 + length;
    if (end > bytes.length) throw new CorruptImageError(`PNG chunk ${type} runs past the end.`);

    verifyCrc(bytes, at, length);

    const data = bytes.subarray(at + 8, at + 8 + length);
    switch (type) {
      case 'PLTE':
        out.palette = data;
        break;
      case 'tRNS':
        out.alpha = data;
        break;
      case 'IDAT':
        out.data.push(data);
        break;
      case 'IEND':
        // Anything after IEND is junk (appended thumbnails, a bad exporter). Ignore it.
        return finishChunks(out, header);
      default:
        break; // ancillary: gAMA, pHYs, tEXt, iCCP... all metadata, all dropped
    }
    at = end;
  }

  return finishChunks(out, header);
}

function finishChunks(chunks: Chunks, header: Header): Chunks {
  if (chunks.data.length === 0) throw new CorruptImageError('PNG has no IDAT chunk.');
  if (header.colourType === ColourType.Palette && chunks.palette === undefined) {
    throw new CorruptImageError('PNG is palette-based but has no PLTE chunk.');
  }
  return chunks;
}

function readType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/**
 * Verify a chunk's CRC. A cheap check, and the difference between "this file is
 * corrupt" and silently editing garbage. `crc32` is node:zlib's, so there is no
 * hand-rolled table to get wrong.
 */
function verifyCrc(bytes: Uint8Array, at: number, length: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expected = view.getUint32(at + 8 + length);
  const actual = crc32(bytes.subarray(at + 4, at + 8 + length));

  if (actual !== expected) {
    const type = readType(bytes, at + 4);
    throw new CorruptImageError(
      `PNG chunk ${type} failed its checksum: the file is damaged.`,
    );
  }
}

function inflate(parts: Uint8Array[]): Uint8Array {
  try {
    // The DEFLATE stream spans the IDAT chunks, so they must be joined before
    // inflating. Inflating each chunk separately fails on every real multi-IDAT file.
    return inflateSync(concat(parts));
  } catch (cause) {
    throw new CorruptImageError('PNG pixel data could not be decompressed.', { cause });
  }
}

// --- filtering ---------------------------------------------------------------------

/**
 * Undo the per-scanline filters for one pass, returning raw bytes.
 *
 * This is the one genuinely fiddly loop in PNG decoding: per byte, with a data
 * dependency on the previous pixel and the previous row, which is also why it is the
 * place to be careful about performance.
 */
function unfilterPass(
  inflated: Uint8Array,
  header: Header,
  width: number,
  height: number,
): Uint8Array {
  if (width === 0 || height === 0) return new Uint8Array();

  const channels = CHANNELS[header.colourType]!;
  const bitsPerPixel = channels * header.bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  // Filters work on whole bytes; for sub-byte depths the "pixel" step is 1 byte.
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

  if (inflated.length < height * (stride + 1)) {
    throw new CorruptImageError(
      `PNG pixel data is short: expected ${height * (stride + 1)} bytes, got ${inflated.length}.`,
    );
  }

  const out = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;

    for (let i = 0; i < stride; i++) {
      const x = inflated[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = y > 0 ? out[up + i]! : 0;
      const c = i >= bpp && y > 0 ? out[up + i - bpp]! : 0;

      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new CorruptImageError(`PNG scanline ${y} has unknown filter type ${filter}.`);
      }
      out[dst + i] = value & 0xff;
    }
  }

  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// --- interlace ---------------------------------------------------------------------

/**
 * Rebuild a full raster from Adam7's seven passes.
 *
 * Each pass is its own sub-image with its own width, height and filter state, so they
 * are unfiltered independently and then scattered back into place.
 */
function deinterlace(inflated: Uint8Array, header: Header): Uint8Array {
  const channels = CHANNELS[header.colourType]!;
  const bitsPerPixel = channels * header.bitDepth;
  const stride = Math.ceil((header.width * bitsPerPixel) / 8);
  const out = new Uint8Array(header.height * stride);
  let at = 0;

  for (const { xStart, yStart, xStep, yStep } of ADAM7) {
    const passWidth = Math.ceil((header.width - xStart) / xStep);
    const passHeight = Math.ceil((header.height - yStart) / yStep);
    if (passWidth <= 0 || passHeight <= 0) continue;

    const passStride = Math.ceil((passWidth * bitsPerPixel) / 8);
    const consumed = passHeight * (passStride + 1);
    const raw = unfilterPass(inflated.subarray(at, at + consumed), header, passWidth, passHeight);
    at += consumed;

    for (let y = 0; y < passHeight; y++) {
      for (let x = 0; x < passWidth; x++) {
        copyPixel(raw, y * passStride, x, out, (yStart + y * yStep) * stride, xStart + x * xStep, header.bitDepth, channels);
      }
    }
  }

  return out;
}

/** Move one pixel between rasters, at whatever bit depth. */
function copyPixel(
  src: Uint8Array,
  srcRow: number,
  srcX: number,
  dst: Uint8Array,
  dstRow: number,
  dstX: number,
  bitDepth: number,
  channels: number,
): void {
  if (bitDepth >= 8) {
    const size = (bitDepth / 8) * channels;
    dst.set(src.subarray(srcRow + srcX * size, srcRow + srcX * size + size), dstRow + dstX * size);
    return;
  }

  // Sub-byte: one channel by definition (greyscale or palette), so move the bits.
  const value = readBits(src, srcRow, srcX, bitDepth);
  const shift = 8 - bitDepth - ((dstX * bitDepth) % 8);
  const at = dstRow + Math.floor((dstX * bitDepth) / 8);
  dst[at] = (dst[at]! & ~(((1 << bitDepth) - 1) << shift)) | (value << shift);
}

/** Read one sub-byte sample. MSB first, which is PNG's order. */
function readBits(bytes: Uint8Array, row: number, x: number, bitDepth: number): number {
  const bit = x * bitDepth;
  const byte = bytes[row + (bit >> 3)]!;
  const shift = 8 - bitDepth - (bit & 7);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

// --- expansion to RGBA -------------------------------------------------------------

/**
 * Expand whatever the file stored into RGBA, the one layout everything downstream
 * speaks (features/raw-image.md).
 *
 * Yes, this means a 1-bit fax image explodes 32x. Correct and simple beats clever.
 */
function toRgba(
  raw: Uint8Array,
  header: Header,
  palette: Uint8Array | undefined,
  alpha: Uint8Array | undefined,
): RawImage {
  const { width, height, bitDepth, colourType } = header;
  const image = createImage(width, height);
  const channels = CHANNELS[colourType]!;
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  // 16-bit truncates to 8: a documented, deliberate loss (features/raw-image.md).
  const step = bitDepth === 16 ? 2 : 1;
  /** Scale a sub-byte sample so its full range maps onto 0-255: 2-bit 0..3 -> 0,85,170,255. */
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  for (let y = 0; y < height; y++) {
    const row = y * stride;

    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;

      if (bitDepth < 8) {
        // Only greyscale and palette reach here: one channel, sub-byte.
        const value = readBits(raw, row, x, bitDepth);
        if (colourType === ColourType.Palette) {
          writePalette(image.data, out, value, palette!, alpha);
        } else {
          const grey = Math.round(value * scale);
          image.data.set([grey, grey, grey, 255], out);
        }
        continue;
      }

      const at = row + x * channels * step;
      switch (colourType) {
        case ColourType.Greyscale: {
          const grey = raw[at]!;
          image.data.set([grey, grey, grey, 255], out);
          break;
        }
        case ColourType.GreyscaleAlpha: {
          const grey = raw[at]!;
          image.data.set([grey, grey, grey, raw[at + step]!], out);
          break;
        }
        case ColourType.Truecolour:
          image.data.set([raw[at]!, raw[at + step]!, raw[at + 2 * step]!, 255], out);
          break;
        case ColourType.TruecolourAlpha:
          image.data.set(
            [raw[at]!, raw[at + step]!, raw[at + 2 * step]!, raw[at + 3 * step]!],
            out,
          );
          break;
        case ColourType.Palette:
          writePalette(image.data, out, raw[at]!, palette!, alpha);
          break;
        default:
          throw new CorruptImageError(`PNG colour type ${colourType} is not supported.`);
      }
    }
  }

  return image;
}

function writePalette(
  data: Uint8ClampedArray,
  out: number,
  index: number,
  palette: Uint8Array,
  alpha: Uint8Array | undefined,
): void {
  const at = index * 3;
  if (at + 2 >= palette.length + 1) {
    throw new CorruptImageError(
      `PNG palette index ${index} is past the end of a ${palette.length / 3}-entry palette.`,
    );
  }
  // tRNS may be shorter than PLTE; entries beyond it are fully opaque.
  data.set([palette[at]!, palette[at + 1]!, palette[at + 2]!, alpha?.[index] ?? 255], out);
}

// --- bytes -------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
