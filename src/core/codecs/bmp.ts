/**
 * BMP codec. See features/codec-bmp.md.
 *
 * Trivial once the pixel pipeline exists: a header, then the pixels, no entropy coding.
 * Honestly, it is here because it is nearly free and because BMPs do turn up in vaults
 * from old Windows tooling and scanners. Nobody chooses BMP as an output format on
 * purpose: this is a read-side compatibility feature with the write side thrown in
 * because the encoder is 40 lines.
 */

import { CorruptImageError } from '../errors.ts';
import { createImage, type RawImage, type RGBA } from '../image.ts';

const FILE_HEADER = 14;
const INFO_HEADER = 40;

/** Compression methods we can read. */
const Compression = {
  Rgb: 0,
  Rle8: 1,
  Rle4: 2,
  Bitfields: 3,
  AlphaBitfields: 6,
} as const;

interface Header {
  width: number;
  height: number;
  /** True when the stored rows run top-down, which a NEGATIVE height signals. */
  topDown: boolean;
  bpp: number;
  compression: number;
  dataOffset: number;
  paletteOffset: number;
  paletteSize: number;
  masks?: Masks;
}

/**
 * BI_BITFIELDS channel masks: one bit-field per channel, in the pixel word.
 *
 * Just the masks, with no shift stored alongside. A field is scaled to 0-255 by dividing
 * by its own mask (see `scale`), which needs no shift at all -- shifting the field down
 * and dividing by the shifted maximum is the same arithmetic with two extra steps.
 */
interface Masks {
  red: number;
  green: number;
  blue: number;
  alpha?: number;
}

export interface BmpEncodeOptions {
  /** BMP has no alpha here, so transparency is composited onto this. Default white. */
  background?: RGBA;
}

/** Read dimensions without touching the pixel data. */
export function probeBmp(bytes: Uint8Array): { width: number; height: number } {
  const { width, height } = readHeader(bytes);
  return { width, height };
}

/** Decode a BMP to RGBA. */
export function decodeBmp(bytes: Uint8Array): RawImage {
  const header = readHeader(bytes);
  const image = createImage(header.width, header.height);

  const stride = Math.ceil((header.width * header.bpp) / 32) * 4;
  const needed = header.dataOffset + stride * header.height;
  if (bytes.length < needed) {
    throw new CorruptImageError(
      `BMP pixel data is short: expected ${needed} bytes, file is ${bytes.length}.`,
    );
  }

  const palette = header.bpp <= 8 ? readPalette(bytes, header) : undefined;

  // A 32-bit BMP whose alpha channel is entirely zero means "no alpha", not "fully
  // invisible". Trusting the zeros decodes a perfectly good file to nothing, which is a
  // real bug in real libraries. Detect it once and treat the image as opaque.
  const opaque = header.bpp === 32 && !hasRealAlpha(bytes, header, stride);

  for (let y = 0; y < header.height; y++) {
    // Rows run bottom-up unless the height was negative. Normalised here, because
    // RawImage has no orientation field, deliberately.
    const row = header.dataOffset + (header.topDown ? y : header.height - 1 - y) * stride;

    for (let x = 0; x < header.width; x++) {
      const out = (y * header.width + x) * 4;
      readPixel(bytes, row, x, header, palette, opaque, image.data, out);
    }
  }

  return image;
}

/**
 * Encode to 24-bit BI_RGB, BITMAPINFOHEADER, bottom-up, rows padded to 4 bytes: the
 * maximally-compatible flavour and nothing else.
 *
 * No alpha. 32-bit BMP with alpha exists, but support across viewers is a mess -- plenty
 * of software reads the channel as garbage or ignores it. Writing 24-bit means
 * compositing onto `background` here, which is the boring, correct choice.
 */
export function encodeBmp(image: RawImage, { background = [255, 255, 255, 255] }: BmpEncodeOptions = {}): Uint8Array {
  const { width, height, data } = image;
  const stride = Math.ceil((width * 3) / 4) * 4;
  const size = FILE_HEADER + INFO_HEADER + stride * height;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);

  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  view.setUint32(2, size, true);
  view.setUint32(10, FILE_HEADER + INFO_HEADER, true);

  view.setUint32(14, INFO_HEADER, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive: bottom-up, the compatible choice
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bpp
  view.setUint32(30, Compression.Rgb, true);
  view.setUint32(34, stride * height, true);
  view.setInt32(38, 2835, true); // ~72 DPI, in pixels per metre
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const row = FILE_HEADER + INFO_HEADER + (height - 1 - y) * stride;

    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const a = data[from + 3]! / 255;
      const at = row + x * 3;

      // Composite, not truncate: a transparent pixel still carries an RGB value, and
      // dropping the alpha would paint it black rather than the background.
      out[at] = data[from + 2]! * a + background[2] * (1 - a); // B
      out[at + 1] = data[from + 1]! * a + background[1] * (1 - a); // G
      out[at + 2] = data[from]! * a + background[0] * (1 - a); // R
    }
  }

  return out;
}

// --- header ------------------------------------------------------------------------

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < FILE_HEADER + INFO_HEADER) {
    throw new CorruptImageError('Not a BMP: too short to hold a header.');
  }
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new CorruptImageError('Not a BMP: missing the BM signature.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dibSize = view.getUint32(14, true);

  if (dibSize < INFO_HEADER) {
    // BITMAPCOREHEADER (12 bytes) is from 1990 and is not worth the code.
    throw new CorruptImageError(`BMP DIB header size ${dibSize} is not supported (need 40 or more).`);
  }

  const rawHeight = view.getInt32(22, true);
  const header: Header = {
    width: view.getInt32(18, true),
    // The sign IS the flag: negative height means the rows are stored top-down.
    height: Math.abs(rawHeight),
    topDown: rawHeight < 0,
    bpp: view.getUint16(28, true),
    compression: view.getUint32(30, true),
    // Authoritative, and it can sit past the header with a gap. Never assume the pixels
    // follow the DIB header.
    dataOffset: view.getUint32(10, true),
    paletteOffset: FILE_HEADER + dibSize,
    paletteSize: view.getUint32(46, true),
  };

  if (header.width < 1 || header.height < 1) {
    throw new CorruptImageError(`BMP has an invalid size: ${header.width}x${rawHeight}.`);
  }

  if (header.compression === Compression.Rle8 || header.compression === Compression.Rle4) {
    throw new CorruptImageError('BMP RLE compression is not supported.');
  }
  if (
    header.compression !== Compression.Rgb &&
    header.compression !== Compression.Bitfields &&
    header.compression !== Compression.AlphaBitfields
  ) {
    throw new CorruptImageError(`BMP compression method ${header.compression} is not supported.`);
  }

  if (![1, 4, 8, 16, 24, 32].includes(header.bpp)) {
    throw new CorruptImageError(`BMP bit depth ${header.bpp} is not supported.`);
  }

  // BI_BITFIELDS is NOT the exotic case codec-bmp.md assumed: it is what ImageMagick
  // writes for every 32-bit BMP, alongside a BITMAPV5HEADER.
  if (header.compression !== Compression.Rgb) {
    header.masks = readMasks(view, dibSize);
  }

  if (header.paletteSize === 0 && header.bpp <= 8) {
    header.paletteSize = 1 << header.bpp;
  }

  return header;
}

/**
 * Where the channel masks live depends on the header. A V4/V5 header carries them at a
 * fixed offset; a plain INFOHEADER puts them immediately after itself.
 */
function readMasks(view: DataView, dibSize: number): Masks {
  const at = dibSize >= 108 ? FILE_HEADER + 40 : FILE_HEADER + dibSize;

  const red = view.getUint32(at, true);
  const green = view.getUint32(at + 4, true);
  const blue = view.getUint32(at + 8, true);
  // The alpha mask only exists on V4/V5, or with BI_ALPHABITFIELDS.
  const alpha = dibSize >= 108 ? view.getUint32(at + 12, true) : 0;

  if (red === 0 && green === 0 && blue === 0) {
    throw new CorruptImageError('BMP declares BI_BITFIELDS but every channel mask is zero.');
  }

  return alpha === 0 ? { red, green, blue } : { red, green, blue, alpha };
}

// --- pixels ------------------------------------------------------------------------

function readPalette(bytes: Uint8Array, header: Header): Uint8Array {
  const end = header.paletteOffset + header.paletteSize * 4;
  if (end > bytes.length) {
    throw new CorruptImageError('BMP palette runs past the end of the file.');
  }
  return bytes.subarray(header.paletteOffset, end);
}

/** Does the alpha channel carry any information, or is it just zeros? */
function hasRealAlpha(bytes: Uint8Array, header: Header, stride: number): boolean {
  const alpha = header.masks?.alpha;
  for (let y = 0; y < header.height; y++) {
    const row = header.dataOffset + y * stride;
    for (let x = 0; x < header.width; x++) {
      const raw = readU32(bytes, row + x * 4);
      if ((alpha === undefined ? raw & 0xff000000 : raw & alpha) !== 0) return true;
    }
  }
  return false;
}

function readPixel(
  bytes: Uint8Array,
  row: number,
  x: number,
  header: Header,
  palette: Uint8Array | undefined,
  opaque: boolean,
  out: Uint8ClampedArray,
  at: number,
): void {
  const { bpp, masks } = header;

  if (bpp <= 8) {
    const index = readIndex(bytes, row, x, bpp);
    const p = index * 4;
    if (palette === undefined || p + 2 >= palette.length + 1) {
      throw new CorruptImageError(`BMP palette index ${index} is past the end of the palette.`);
    }
    // Palette entries are BGRA quads.
    out.set([palette[p + 2]!, palette[p + 1]!, palette[p]!, 255], at);
    return;
  }

  if (bpp === 24) {
    const from = row + x * 3;
    // Channel order is BGR, not RGB.
    out.set([bytes[from + 2]!, bytes[from + 1]!, bytes[from]!, 255], at);
    return;
  }

  if (bpp === 16 || bpp === 32) {
    const size = bpp / 8;
    const raw = size === 2 ? bytes[row + x * 2]! | (bytes[row + x * 2 + 1]! << 8) : readU32(bytes, row + x * 4);

    if (masks !== undefined) {
      const alpha = masks.alpha;
      out.set(
        [
          scale(raw, masks.red),
          scale(raw, masks.green),
          scale(raw, masks.blue),
          opaque || alpha === undefined ? 255 : scale(raw, alpha),
        ],
        at,
      );
      return;
    }

    // BI_RGB at 32bpp: BGRX, where X is alpha on newer writers and padding on older.
    const from = row + x * 4;
    out.set([bytes[from + 2]!, bytes[from + 1]!, bytes[from]!, opaque ? 255 : bytes[from + 3]!], at);
    return;
  }

  throw new CorruptImageError(`BMP bit depth ${bpp} is not supported.`);
}

/** Read a sub-byte or 8-bit palette index. Sub-byte fields are MSB-first. */
function readIndex(bytes: Uint8Array, row: number, x: number, bpp: number): number {
  if (bpp === 8) return bytes[row + x]!;
  const bit = x * bpp;
  const byte = bytes[row + (bit >> 3)]!;
  return (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
}

function readU32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

/**
 * Extract a masked field and stretch it to 0-255.
 *
 * Dividing by the mask itself does the shift for free: for a 5-bit red at 0xf800, a field
 * of 0x0800 over 0xf800 is 1/31, the same ratio as shifting down to 1 and dividing by 31.
 * The masks are contiguous in every BMP that exists, and the division does not care where
 * in the word the field sits.
 *
 * The `>>> 0` is load-bearing, not decoration: `&` yields a SIGNED 32-bit int, so an alpha
 * mask of 0xff000000 makes `raw & mask` negative, and the whole channel scales to a
 * negative and clamps to zero. Every 32-bit BMP decodes fully transparent without it.
 */
function scale(raw: number, mask: number): number {
  return mask === 0 ? 0 : Math.round((((raw & mask) >>> 0) / mask) * 255);
}
