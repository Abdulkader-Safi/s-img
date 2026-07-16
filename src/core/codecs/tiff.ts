/**
 * TIFF codec, common cases only. See features/codec-tiff.md.
 *
 * TIFF is not a format, it is a container spec with a tag system, and "a TIFF" can be
 * almost anything. The scope discipline matters more than the code: uncompressed, LZW and
 * PackBits; strips not tiles; first page only; 1/4/8/16 bits per sample. Everything else
 * throws with its own name attached.
 */

import { CorruptImageError, ImageTooLargeError, InvalidOptionError, UnsupportedFormatError } from '../errors.ts';
import { createImage, DEFAULT_MAX_PIXELS, type RawImage } from '../image.ts';

/** The tags we act on. Everything else in the IFD is skipped. */
const Tag = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  ColorMap: 320,
  TileWidth: 322,
  Predictor: 317,
  ExtraSamples: 338,
  SampleFormat: 339,
} as const;

const Compression = {
  None: 1,
  CcittRle: 2,
  CcittG3: 3,
  CcittG4: 4,
  Lzw: 5,
  OldJpeg: 6,
  Jpeg: 7,
  Deflate: 8,
  PackBits: 32773,
} as const;

const Photometric = {
  WhiteIsZero: 0,
  BlackIsZero: 1,
  Rgb: 2,
  Palette: 3,
} as const;

/** Byte width of each IFD field type, indexed by the type code. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

export interface TiffEncodeOptions {
  /** Default 'lzw'. TIFF is lossless either way; this only trades size for speed. */
  compression?: 'none' | 'lzw';
}

/** Read the size from IFD0 without decoding the strips. */
export function probeTiff(bytes: Uint8Array): { width: number; height: number } {
  const { reader, ifd } = openTiff(bytes);
  const dir = readIfd(reader, ifd);
  const { width, height } = readSize(reader, dir);
  return { width, height };
}

/**
 * Decode the first page of a TIFF to RGBA.
 *
 * @throws {UnsupportedFormatError} for tiled, BigTIFF, JPEG-in-TIFF or CCITT files
 * @throws {CorruptImageError} for a malformed or truncated file
 */
export function decodeTiff(bytes: Uint8Array): RawImage {
  const { reader, ifd } = openTiff(bytes);
  // First IFD only. A multi-page TIFF decodes page 0 with no error, same reasoning as an
  // animated GIF: page 0 beats refusing the file.
  const dir = readIfd(reader, ifd);

  if (dir.has(Tag.TileWidth)) {
    throw new UnsupportedFormatError(bytes, 'Tiled TIFF is not supported; only strip-based TIFF is.');
  }

  const { width, height } = readSize(reader, dir);
  const compression = value(reader, dir, Tag.Compression) ?? Compression.None;
  checkCompression(bytes, compression);

  const samplesPerPixel = value(reader, dir, Tag.SamplesPerPixel) ?? 1;
  const bits = values(reader, dir, Tag.BitsPerSample);
  const bitsPerSample = bits.length > 0 ? bits[0]! : 1;
  const photometric = value(reader, dir, Tag.Photometric) ?? Photometric.BlackIsZero;

  for (const b of bits) {
    if (b !== bitsPerSample) {
      throw new UnsupportedFormatError(bytes, `TIFF with mixed sample depths (${bits.join(', ')}) is not supported.`);
    }
  }
  if (![1, 4, 8, 16].includes(bitsPerSample)) {
    throw new UnsupportedFormatError(bytes, `TIFF with ${bitsPerSample} bits per sample is not supported.`);
  }

  const samples = readStrips(reader, dir, bytes, width, height, samplesPerPixel, bitsPerSample, compression);

  return toRgba(reader, dir, samples, width, height, samplesPerPixel, bitsPerSample, photometric, bytes);
}

/**
 * Encode to a TIFF: little-endian, single strip, single IFD, predictor 1, 8 bits per
 * sample, RGB or RGBA.
 *
 * The tag set is the minimum viable one and nothing else. No EXIF IFD, no ICC, no software
 * tag -- which is what makes features/strip-metadata.md satisfied by construction here, as
 * long as this never grows.
 */
export function encodeTiff(image: RawImage, options: TiffEncodeOptions = {}): Uint8Array {
  const { compression = 'lzw' } = options;

  if (compression !== 'none' && compression !== 'lzw') {
    throw new InvalidOptionError('tiff.compression', compression, "must be 'none' or 'lzw'");
  }

  return writeTiff(image, compression);
}

// --- reading -------------------------------------------------------------------------

/**
 * A cursor over the file that knows its byte order.
 *
 * Every read goes through here, deliberately. A reader that hardcodes little-endian works
 * on most files and produces garbage on the rest, and per the spec that is the single most
 * likely TIFF bug -- so there is no way to read an integer here without saying so.
 */
interface Reader {
  bytes: Uint8Array;
  view: DataView;
  le: boolean;
}

function openTiff(bytes: Uint8Array): { reader: Reader; ifd: number } {
  if (bytes.length < 8) {
    throw new CorruptImageError('Not a TIFF: too short to hold a header.');
  }

  const le = bytes[0] === 0x49 && bytes[1] === 0x49; // "II"
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d; // "MM"
  if (!le && !be) {
    throw new CorruptImageError('Not a TIFF: the byte order mark is neither II nor MM.');
  }

  const reader: Reader = { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), le };
  const magic = reader.view.getUint16(2, le);

  if (magic === 43) {
    // Magic 43 means 64-bit offsets throughout: a different format wearing the same
    // signature, not a variation on this one.
    throw new UnsupportedFormatError(bytes, 'BigTIFF is not supported; only classic TIFF is.');
  }
  if (magic !== 42) {
    throw new CorruptImageError(`Not a TIFF: magic number is ${magic}, not 42.`);
  }

  const ifd = reader.view.getUint32(4, le);
  if (ifd + 2 > bytes.length) {
    throw new CorruptImageError('TIFF IFD offset points past the end of the file.');
  }
  return { reader, ifd };
}

interface Entry {
  type: number;
  count: number;
  /** Byte offset of the value: the entry itself when it fits inline, else where it points. */
  at: number;
}

/**
 * Read one IFD into a tag -> entry map.
 *
 * The value-vs-offset rule is TIFF's other classic bug: if `count * typeSize` fits in four
 * bytes the value sits IN the entry, otherwise those four bytes are an offset to it. A
 * single-strip file stores its StripOffsets inline for exactly this reason.
 */
function readIfd(reader: Reader, at: number): Map<number, Entry> {
  const count = reader.view.getUint16(at, reader.le);
  if (at + 2 + count * 12 + 4 > reader.bytes.length) {
    throw new CorruptImageError('TIFF IFD runs past the end of the file.');
  }

  const dir = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    const tag = reader.view.getUint16(entry, reader.le);
    const type = reader.view.getUint16(entry + 2, reader.le);
    const n = reader.view.getUint32(entry + 4, reader.le);

    const size = TYPE_SIZE[type] ?? 0;
    if (size === 0) continue; // an unknown field type: skip it rather than guess

    const inline = n * size <= 4;
    const valueAt = inline ? entry + 8 : reader.view.getUint32(entry + 8, reader.le);
    if (!inline && valueAt + n * size > reader.bytes.length) {
      throw new CorruptImageError(`TIFF tag ${tag} points past the end of the file.`);
    }

    dir.set(tag, { type, count: n, at: valueAt });
  }
  return dir;
}

/** One numeric field value at `index`, whatever its integer type. */
function field(reader: Reader, entry: Entry, index: number): number {
  const at = entry.at + index * (TYPE_SIZE[entry.type] ?? 1);

  switch (entry.type) {
    case 1: // BYTE
    case 7: // UNDEFINED
      return reader.bytes[at]!;
    case 2: // ASCII
      return reader.bytes[at]!;
    case 3: // SHORT
      return reader.view.getUint16(at, reader.le);
    case 4: // LONG
      return reader.view.getUint32(at, reader.le);
    case 6: // SBYTE
      return reader.view.getInt8(at);
    case 8: // SSHORT
      return reader.view.getInt16(at, reader.le);
    case 9: // SLONG
      return reader.view.getInt32(at, reader.le);
    default:
      throw new CorruptImageError(`TIFF field type ${entry.type} is not a supported integer type.`);
  }
}

function value(reader: Reader, dir: Map<number, Entry>, tag: number): number | undefined {
  const entry = dir.get(tag);
  return entry === undefined || entry.count === 0 ? undefined : field(reader, entry, 0);
}

function values(reader: Reader, dir: Map<number, Entry>, tag: number): number[] {
  const entry = dir.get(tag);
  if (entry === undefined) return [];
  return Array.from({ length: entry.count }, (_, i) => field(reader, entry, i));
}

function readSize(reader: Reader, dir: Map<number, Entry>): { width: number; height: number } {
  const width = value(reader, dir, Tag.ImageWidth);
  const height = value(reader, dir, Tag.ImageLength);

  if (width === undefined || height === undefined) {
    throw new CorruptImageError('TIFF is missing ImageWidth or ImageLength.');
  }
  if (width < 1 || height < 1) {
    throw new CorruptImageError(`TIFF declares an invalid size: ${width}x${height}.`);
  }
  // Before allocation: the tags are four bytes each and can ask for anything.
  if (width * height > DEFAULT_MAX_PIXELS) {
    throw new ImageTooLargeError(width, height, DEFAULT_MAX_PIXELS);
  }
  return { width, height };
}

/** Everything we cannot read, each saying what it actually is. */
function checkCompression(bytes: Uint8Array, compression: number): void {
  switch (compression) {
    case Compression.None:
    case Compression.Lzw:
    case Compression.PackBits:
      return;

    case Compression.Jpeg:
    case Compression.OldJpeg:
      // Technically a small job now that the JPEG codec exists -- hand the strip over --
      // but it is out of scope per the PRD and noted as a cheap later win.
      throw new UnsupportedFormatError(bytes, 'JPEG-compressed TIFF is not supported.');

    case Compression.CcittRle:
    case Compression.CcittG3:
    case Compression.CcittG4:
      // A whole codec for a narrow case.
      throw new UnsupportedFormatError(bytes, 'CCITT fax-compressed TIFF is not supported.');

    case Compression.Deflate:
      throw new UnsupportedFormatError(bytes, 'Deflate-compressed TIFF is not supported.');

    default:
      throw new UnsupportedFormatError(bytes, `TIFF compression method ${compression} is not supported.`);
  }
}

/**
 * Decompress every strip and concatenate.
 *
 * Multiple strips are the NORMAL case, not the exception: RowsPerStrip is often 8 or 16, so
 * a 3000px-tall image has hundreds. A decoder that assumes one strip works on its own
 * fixtures and fails on everything real.
 */
function readStrips(
  reader: Reader,
  dir: Map<number, Entry>,
  bytes: Uint8Array,
  width: number,
  height: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  compression: number,
): Uint8Array {
  const offsets = values(reader, dir, Tag.StripOffsets);
  const counts = values(reader, dir, Tag.StripByteCounts);
  const rowsPerStrip = value(reader, dir, Tag.RowsPerStrip) ?? height;

  if (offsets.length === 0) throw new CorruptImageError('TIFF has no StripOffsets.');
  if (counts.length !== offsets.length) {
    throw new CorruptImageError('TIFF StripOffsets and StripByteCounts disagree on the strip count.');
  }
  if (rowsPerStrip < 1) throw new CorruptImageError('TIFF RowsPerStrip is zero.');

  // Rows are padded to a whole byte, which only shows on sub-byte depths.
  const bytesPerRow = Math.ceil((width * samplesPerPixel * bitsPerSample) / 8);
  const predictor = value(reader, dir, Tag.Predictor) ?? 1;

  if (predictor !== 1 && predictor !== 2) {
    throw new UnsupportedFormatError(bytes, `TIFF predictor ${predictor} is not supported.`);
  }

  const out = new Uint8Array(bytesPerRow * height);
  let written = 0;

  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i]!;
    const count = counts[i]!;
    if (offset + count > bytes.length) {
      throw new CorruptImageError(`TIFF strip ${i} runs past the end of the file.`);
    }

    const rows = Math.min(rowsPerStrip, height - i * rowsPerStrip);
    if (rows <= 0) break;
    const expected = bytesPerRow * rows;
    const raw = bytes.subarray(offset, offset + count);

    const strip =
      compression === Compression.Lzw
        ? decompressLzw(raw, expected)
        : compression === Compression.PackBits
          ? decompressPackBits(raw, expected)
          : raw.subarray(0, expected);

    if (strip.length < expected) {
      throw new CorruptImageError(`TIFF strip ${i} decoded ${strip.length} of ${expected} bytes.`);
    }

    // Horizontal differencing is per strip and per row, so it has to be undone here rather
    // than over the assembled buffer.
    if (predictor === 2) unpredict(strip, width, rows, samplesPerPixel, bitsPerSample, bytesPerRow);

    out.set(strip.subarray(0, Math.min(expected, out.length - written)), written);
    written += expected;
  }

  if (written < out.length) {
    throw new CorruptImageError(`TIFF strips cover ${written} of ${out.length} bytes.`);
  }
  return out;
}

/**
 * Undo predictor 2: each sample was stored as its difference from the one to its left.
 *
 * Easy to forget, because a predictor-1 file decodes perfectly without this and looks fine.
 * Leave it applied and the image is a horizontal smear.
 */
function unpredict(
  strip: Uint8Array,
  width: number,
  rows: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  bytesPerRow: number,
): void {
  if (bitsPerSample !== 8) {
    // Differencing is only defined for whole samples; at other depths libtiff does not
    // emit it, and guessing here would corrupt rather than help.
    throw new CorruptImageError(`TIFF predictor 2 with ${bitsPerSample} bits per sample is not supported.`);
  }

  for (let row = 0; row < rows; row++) {
    const start = row * bytesPerRow;
    for (let i = samplesPerPixel; i < width * samplesPerPixel; i++) {
      strip[start + i] = (strip[start + i]! + strip[start + i - samplesPerPixel]!) & 0xff;
    }
  }
}

/**
 * TIFF's LZW. Emphatically NOT GIF's LZW.
 *
 * The differences are exactly the ones that produce subtly corrupt output rather than an
 * obvious failure, which is why the spec says not to share an implementation with the GIF
 * codec however similar they look:
 *
 *   - MSB-first bit packing, where GIF is LSB-first.
 *   - The code width grows ONE code EARLY (at 511, 1023, 2047 rather than 512, 1024,
 *     2048). The famous off-by-one that everyone hits.
 *   - No sub-blocks: one flat stream.
 *   - Clear is 256 and end-of-information is 257, fixed, rather than derived from a
 *     minimum code size.
 */
function decompressLzw(input: Uint8Array, expected: number): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;

  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);

  const out = new Uint8Array(expected);
  let written = 0;

  let codeSize = 9;
  let next = EOI + 1;
  let previous = -1;

  let at = 0;
  let buffer = 0;
  let bits = 0;

  for (;;) {
    while (bits < codeSize) {
      if (at >= input.length) {
        if (written === expected) return out;
        throw new CorruptImageError('TIFF LZW data ended mid-code.');
      }
      // MSB-first: new bytes go in at the BOTTOM and the code comes off the top.
      buffer = (buffer << 8) | input[at++]!;
      bits += 8;
    }

    const code = (buffer >> (bits - codeSize)) & ((1 << codeSize) - 1);
    bits -= codeSize;

    if (code === EOI) break;

    if (code === CLEAR) {
      codeSize = 9;
      next = EOI + 1;
      previous = -1;
      continue;
    }

    let depth = 0;
    let current = code;

    if (code > next) {
      throw new CorruptImageError(`TIFF LZW code ${code} is not in the dictionary yet.`);
    }
    // The self-referential case: a code meaning "the previous string plus its own first
    // byte", emitted before the decoder has built it.
    if (code === next) {
      if (previous < 0) throw new CorruptImageError('TIFF LZW stream opens with a deferred code.');
      stack[depth++] = firstByte(prefix, previous);
      current = previous;
    }

    while (current >= CLEAR) {
      stack[depth++] = suffix[current]!;
      current = prefix[current]!;
      if (depth >= stack.length) throw new CorruptImageError('TIFF LZW dictionary has a cycle.');
    }
    stack[depth++] = current;

    if (written + depth > expected) {
      throw new CorruptImageError('TIFF LZW decodes to more bytes than the strip declares.');
    }
    for (let i = depth - 1; i >= 0; i--) out[written++] = stack[i]!;

    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = stack[depth - 1]!;
      next++;
    }
    previous = code;

    // ONE EARLY. This is the off-by-one: at 511 codes the next one needs 10 bits, because
    // the encoder switched before emitting it. Use 512 here (GIF's rule) and every file
    // decodes as noise past the first 200-odd codes.
    if (next + 1 >= 1 << codeSize && codeSize < 12) codeSize++;
  }

  if (written !== expected) {
    throw new CorruptImageError(`TIFF LZW decoded ${written} of ${expected} bytes: the strip is truncated.`);
  }
  return out;
}

/** The first byte of a dictionary entry's string, by walking its prefix chain. */
function firstByte(prefix: Int32Array, code: number): number {
  let current = code;
  let guard = 0;
  while (current >= 256) {
    current = prefix[current]!;
    if (++guard > 4096) throw new CorruptImageError('TIFF LZW dictionary has a cycle.');
  }
  return current;
}

/**
 * PackBits: byte-oriented RLE, and about twenty lines.
 *
 * A signed length byte: 0..127 means "the next n+1 bytes are literal", -1..-127 means "the
 * next byte, repeated 1-n times", -128 is a no-op.
 */
function decompressPackBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let written = 0;
  let at = 0;

  while (at < input.length && written < expected) {
    const length = (input[at++]! << 24) >> 24; // to signed

    if (length === -128) continue;

    if (length >= 0) {
      const n = Math.min(length + 1, expected - written);
      if (at + n > input.length) throw new CorruptImageError('TIFF PackBits literal run is truncated.');
      out.set(input.subarray(at, at + n), written);
      written += n;
      at += length + 1;
    } else {
      const byte = input[at++];
      if (byte === undefined) throw new CorruptImageError('TIFF PackBits repeat run is truncated.');
      const n = Math.min(1 - length, expected - written);
      out.fill(byte, written, written + n);
      written += n;
    }
  }
  return out.subarray(0, written);
}

// --- samples to RGBA -----------------------------------------------------------------

function toRgba(
  reader: Reader,
  dir: Map<number, Entry>,
  samples: Uint8Array,
  width: number,
  height: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  photometric: number,
  bytes: Uint8Array,
): RawImage {
  const image = createImage(width, height);
  const bytesPerRow = Math.ceil((width * samplesPerPixel * bitsPerSample) / 8);

  // ExtraSamples says whether sample 4 is alpha and whether it is premultiplied. 1 is
  // associated (premultiplied), 2 unassociated. Absent with 4 samples, assume unassociated.
  const extra = values(reader, dir, Tag.ExtraSamples);
  const premultiplied = extra[0] === 1;

  const palette = photometric === Photometric.Palette ? readColorMap(reader, dir, bitsPerSample, bytes) : undefined;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const read = (s: number): number =>
        sampleAt(samples, y * bytesPerRow, x * samplesPerPixel + s, bitsPerSample, reader.le);

      if (palette !== undefined) {
        // The RAW sample, not the scaled one: this is an INDEX into the colour map, and
        // stretching it to 0-255 the way an intensity is stretched turns index 10 of 16
        // into index 170 of 16.
        const index = rawSampleAt(samples, y * bytesPerRow, x * samplesPerPixel, bitsPerSample, reader.le);
        if (index * 3 + 2 >= palette.length) {
          throw new CorruptImageError(`TIFF palette index ${index} is past the end of the colour map.`);
        }
        image.data.set([palette[index * 3]!, palette[index * 3 + 1]!, palette[index * 3 + 2]!, 255], to);
        continue;
      }

      if (photometric === Photometric.Rgb) {
        const alpha = samplesPerPixel >= 4 ? read(3) : 255;
        let r = read(0);
        let g = read(1);
        let b = read(2);

        // Associated alpha is premultiplied; RawImage is not. Undo it at the boundary.
        if (samplesPerPixel >= 4 && premultiplied && alpha > 0) {
          r = Math.min(255, Math.round((r * 255) / alpha));
          g = Math.min(255, Math.round((g * 255) / alpha));
          b = Math.min(255, Math.round((b * 255) / alpha));
        }
        image.data.set([r, g, b, alpha], to);
        continue;
      }

      if (photometric === Photometric.WhiteIsZero || photometric === Photometric.BlackIsZero) {
        // WhiteIsZero inverts the ramp. Ignore it and you ship a negative.
        const v = photometric === Photometric.WhiteIsZero ? 255 - read(0) : read(0);
        const alpha = samplesPerPixel >= 2 ? read(1) : 255;
        image.data.set([v, v, v, alpha], to);
        continue;
      }

      throw new UnsupportedFormatError(bytes, `TIFF PhotometricInterpretation ${photometric} is not supported.`);
    }
  }

  return image;
}

/**
 * Read one sample at its stored width, WITHOUT scaling.
 *
 * Sub-byte samples are MSB-first within the byte whatever the file's byte order -- that
 * order governs multi-byte integers, not bit packing. Multi-byte ones do respect it.
 */
function rawSampleAt(samples: Uint8Array, rowStart: number, index: number, bitsPerSample: number, le: boolean): number {
  if (bitsPerSample === 8) return samples[rowStart + index]!;
  if (bitsPerSample === 16) {
    const at = rowStart + index * 2;
    return le ? samples[at]! | (samples[at + 1]! << 8) : (samples[at]! << 8) | samples[at + 1]!;
  }

  const bit = index * bitsPerSample;
  const byte = samples[rowStart + (bit >> 3)]!;
  return (byte >> (8 - bitsPerSample - (bit & 7))) & ((1 << bitsPerSample) - 1);
}

/**
 * Read one sample and scale it to 0-255: an intensity, not an index.
 *
 * The scaling is `round(v * 255 / max)`, and for 16-bit that is NOT the same as keeping the
 * high byte however much it looks like it. `v >> 8` is `floor(v / 256)` where the right
 * answer is `round(v / 257)`, and the two disagree by one at the top of every step -- which
 * is exactly the off-by-one that shows up against libtiff.
 */
function sampleAt(samples: Uint8Array, rowStart: number, index: number, bitsPerSample: number, le: boolean): number {
  const raw = rawSampleAt(samples, rowStart, index, bitsPerSample, le);
  if (bitsPerSample === 8) return raw;

  // A 1-bit sample becomes 0 or 255, a 4-bit one steps by 17, a 16-bit one divides by 257.
  return Math.round((raw / ((1 << bitsPerSample) - 1)) * 255);
}

function readColorMap(
  reader: Reader,
  dir: Map<number, Entry>,
  bitsPerSample: number,
  bytes: Uint8Array,
): Uint8Array {
  const entry = dir.get(Tag.ColorMap);
  if (entry === undefined) {
    throw new UnsupportedFormatError(bytes, 'TIFF is palette-coloured but has no ColorMap.');
  }

  // The map is stored as three consecutive runs (all reds, then all greens, then all
  // blues), NOT interleaved, and the values are 16-bit.
  const entries = 1 << bitsPerSample;
  if (entry.count < entries * 3) {
    throw new CorruptImageError(`TIFF ColorMap has ${entry.count} values, expected ${entries * 3}.`);
  }

  // Scaled, not >> 8. Same trap as the samples: the high byte is floor(v / 256) where the
  // right answer is round(v / 257), and they disagree by one at the top of every step.
  const scale = (v: number): number => Math.round((v / 65535) * 255);

  const out = new Uint8Array(entries * 3);
  for (let i = 0; i < entries; i++) {
    out[i * 3] = scale(field(reader, entry, i));
    out[i * 3 + 1] = scale(field(reader, entry, entries + i));
    out[i * 3 + 2] = scale(field(reader, entry, entries * 2 + i));
  }
  return out;
}

// --- writing -------------------------------------------------------------------------

function hasAlpha(image: RawImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) return true;
  }
  return false;
}

function writeTiff(image: RawImage, compression: 'none' | 'lzw'): Uint8Array {
  const { width, height } = image;
  const alpha = hasAlpha(image);
  const samplesPerPixel = alpha ? 4 : 3;

  // A wholly opaque alpha channel is a quarter of the file carrying no information.
  const pixels = new Uint8Array(width * height * samplesPerPixel);
  for (let p = 0, o = 0; p < width * height; p++, o += samplesPerPixel) {
    pixels[o] = image.data[p * 4]!;
    pixels[o + 1] = image.data[p * 4 + 1]!;
    pixels[o + 2] = image.data[p * 4 + 2]!;
    if (alpha) pixels[o + 3] = image.data[p * 4 + 3]!;
  }

  const strip = compression === 'lzw' ? compressLzw(pixels) : pixels;

  // Tags must appear in ascending order, which the spec requires and some readers enforce.
  const tags: [number, number, number][] = [
    [Tag.ImageWidth, 3, width],
    [Tag.ImageLength, 3, height],
    [Tag.BitsPerSample, 3, 8], // count > 1: patched to an offset below
    [Tag.Compression, 3, compression === 'lzw' ? Compression.Lzw : Compression.None],
    [Tag.Photometric, 3, Photometric.Rgb],
    [Tag.StripOffsets, 4, 0], // patched once the layout is known
    [Tag.SamplesPerPixel, 3, samplesPerPixel],
    [Tag.RowsPerStrip, 3, height], // one strip
    [Tag.StripByteCounts, 4, strip.length],
  ];
  if (alpha) tags.push([Tag.ExtraSamples, 3, 2]); // unassociated: non-premultiplied

  // Layout: header, IFD, then the out-of-line values, then the strip.
  const ifdAt = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  const bitsAt = ifdAt + ifdSize;
  const bitsSize = samplesPerPixel * 2;
  const stripAt = bitsAt + bitsSize;

  const out = new Uint8Array(stripAt + strip.length);
  const view = new DataView(out.buffer);

  out[0] = 0x49; // II: little-endian
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdAt, true);

  view.setUint16(ifdAt, tags.length, true);
  for (let i = 0; i < tags.length; i++) {
    const [tag, type, v] = tags[i]!;
    const entry = ifdAt + 2 + i * 12;

    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);

    if (tag === Tag.BitsPerSample) {
      // One value per sample, so it only fits inline at 2 samples or fewer.
      view.setUint32(entry + 4, samplesPerPixel, true);
      view.setUint32(entry + 8, bitsAt, true);
      continue;
    }

    view.setUint32(entry + 4, 1, true);
    if (type === 3) view.setUint16(entry + 8, tag === Tag.StripOffsets ? stripAt : v, true);
    else view.setUint32(entry + 8, tag === Tag.StripOffsets ? stripAt : v, true);
  }
  // Zero: there is no second page, and a reader will go hunting for one otherwise. Written
  // explicitly even though the buffer is already zero-filled -- leaning on the allocator to
  // satisfy a format requirement is the kind of thing that survives until someone reuses a
  // buffer.
  view.setUint32(ifdAt + 2 + tags.length * 12, 0, true);

  for (let i = 0; i < samplesPerPixel; i++) view.setUint16(bitsAt + i * 2, 8, true);
  out.set(strip, stripAt);

  return out;
}

/**
 * TIFF's LZW, the write side. Mirrors `decompressLzw`, including the early width bump.
 *
 * The subtle half is keeping the code width in lockstep. The encoder adds a dictionary
 * entry immediately after emitting a code; the decoder cannot add one until it has read the
 * NEXT code, so its counter runs permanently one behind. Use the same bump condition on
 * both and they widen a code apart, the decoder reads a 9-bit code as 10 bits, and
 * everything after it is noise. Hence `next >= 1 << codeSize` here against `next + 1 >= ...`
 * there: the same moment, expressed from two different counters.
 */
function compressLzw(input: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  let codeSize = 9;

  const emit = (code: number): void => {
    // MSB-first: the code goes in at the top and whole bytes fall off it.
    buffer = (buffer << codeSize) | code;
    bits += codeSize;
    while (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  };

  // Keyed by (prefix code, next byte), which is what the decoder's dictionary means too.
  let dictionary = new Map<number, number>();
  let next = EOI + 1;

  emit(CLEAR);

  if (input.length === 0) {
    emit(EOI);
    if (bits > 0) out.push((buffer << (8 - bits)) & 0xff);
    return new Uint8Array(out);
  }

  let current = input[0]!;

  for (let i = 1; i < input.length; i++) {
    const k = input[i]!;
    const key = current * 256 + k;
    const found = dictionary.get(key);

    if (found !== undefined) {
      current = found;
      continue;
    }

    emit(current);

    if (next < 4094) {
      dictionary.set(key, next++);
      if (next >= 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      // The dictionary is full: start over, exactly as the decoder does on a clear code.
      emit(CLEAR);
      dictionary = new Map();
      next = EOI + 1;
      codeSize = 9;
    }

    current = k;
  }

  emit(current);
  emit(EOI);

  // The final partial byte still has to go out, left-aligned.
  //
  // Neither this nor the EOI above is observable: a strip carries its uncompressed byte
  // count, so every reader (ours and libtiff, both checked) stops the moment it has enough
  // bytes and never looks at the tail. Delete either one alone and everything still passes.
  // They stay because the format asks for them, and because they cover each other -- EOI's
  // 9-plus bits guarantee the last DATA code is fully flushed, and this line completes the
  // EOI. Drop both and the last code goes with them.
  //
  // Worth contrasting with the GIF encoder, where the identical omission broke 9 of 120
  // sizes outright: GIF sub-blocks carry no uncompressed length, so its decoder has to read
  // to the terminator and every trailing bit matters.
  if (bits > 0) out.push((buffer << (8 - bits)) & 0xff);

  return new Uint8Array(out);
}
