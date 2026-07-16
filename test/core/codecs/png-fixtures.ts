/**
 * Builds PNG bytes by hand, from the spec, using node:zlib directly.
 *
 * Deliberately NOT built with our own encoder: decoding a fixture our encoder
 * produced only proves the two agree, so a symmetric bug (a wrong CRC, a flipped
 * filter, a byte order mistake) passes both sides and ships. These fixtures are
 * assembled from raw chunk bytes so the decoder is tested against the format rather
 * than against itself.
 *
 * crc32 comes from node:zlib, which is an independent implementation of the same
 * checksum the codec uses.
 */

import { crc32, deflateSync } from 'node:zlib';

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const ColourType = {
  Greyscale: 0,
  Truecolour: 2,
  Palette: 3,
  GreyscaleAlpha: 4,
  TruecolourAlpha: 6,
} as const;

export const Filter = {
  None: 0,
  Sub: 1,
  Up: 2,
  Average: 3,
  Paeth: 4,
} as const;

/** One PNG chunk: length, type, data, CRC over type+data. */
export function chunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);

  const forCrc = new Uint8Array(typeBytes.length + data.length);
  forCrc.set(typeBytes);
  forCrc.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(forCrc));

  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function ihdr(opts: {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace?: number;
}): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, opts.width);
  view.setUint32(4, opts.height);
  data[8] = opts.bitDepth;
  data[9] = opts.colourType;
  data[10] = 0; // compression: deflate, the only defined value
  data[11] = 0; // filter method: adaptive, the only defined value
  data[12] = opts.interlace ?? 0;
  return chunk('IHDR', data);
}

/**
 * Assemble a full PNG.
 *
 * @param scanlines already filter-prefixed rows, i.e. what goes into the zlib stream
 * @param extra chunks to insert between IHDR and IDAT (PLTE, tRNS, ...)
 * @param idatChunks split the deflate stream across this many IDAT chunks
 */
export function png(opts: {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  scanlines: Uint8Array;
  extra?: Uint8Array[];
  interlace?: number;
  idatChunks?: number;
}): Uint8Array {
  const compressed: Uint8Array = deflateSync(opts.scanlines);
  const pieces = splitIdat(compressed, opts.idatChunks ?? 1);

  return concat([
    new Uint8Array(PNG_SIGNATURE),
    ihdr(opts),
    ...(opts.extra ?? []),
    ...pieces.map((p) => chunk('IDAT', p)),
    chunk('IEND'),
  ]);
}

/** A DEFLATE stream may be split across any number of IDAT chunks. Real files do. */
function splitIdat(data: Uint8Array, count: number): Uint8Array[] {
  if (count <= 1) return [data];
  const size = Math.ceil(data.length / count);
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += size) {
    out.push(data.subarray(at, Math.min(at + size, data.length)));
  }
  return out;
}

/** Prefix each row with a filter-type byte. `rows` are raw, unfiltered bytes. */
export function unfilteredScanlines(rows: number[][], filter = Filter.None): Uint8Array {
  return concat(rows.map((row) => new Uint8Array([filter, ...row])));
}
