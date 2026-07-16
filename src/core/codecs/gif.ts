/**
 * GIF codec, static frames only. See features/codec-gif.md.
 *
 * The interesting part of GIF is not the container, it is that GIF is a 256-colour format.
 * Encoding to it from an RGBA buffer means quantisation, and quantisation is a real
 * algorithm with real quality consequences. That is where the work is; the rest is a
 * header and an LZW dialect.
 *
 * Animated GIFs decode frame 0 and ignore the rest, deliberately. An animated GIF in a
 * vault is usually a meme, and showing the first frame beats refusing the file. Full
 * animation needs the whole frame-disposal state machine, which is a feature, not a tweak.
 */

import { CorruptImageError, ImageTooLargeError, InvalidOptionError } from '../errors.ts';
import { createImage, DEFAULT_MAX_PIXELS, type RawImage } from '../image.ts';

/** Block introducers. */
const IMAGE_DESCRIPTOR = 0x2c;
const EXTENSION = 0x21;
const TRAILER = 0x3b;
const GRAPHIC_CONTROL = 0xf9;

export interface GifEncodeOptions {
  /**
   * Palette size, 2-256. Default 256.
   *
   * Not `quality`: quality is a lossy-format dial, and GIF's loss is quantisation, which
   * is a different thing with a different name. See features/type-safety.md.
   */
  colors?: number;
  /**
   * Floyd-Steinberg error diffusion. Default true.
   *
   * Off matters for line art and screenshots, where dithering adds noise to what was
   * already flat, perfectly representable colour, and *increases* the file size.
   */
  dither?: boolean;
}

/** Read the logical screen size without decoding the frame. */
export function probeGif(bytes: Uint8Array): { width: number; height: number } {
  const screen = readScreen(bytes);
  return { width: screen.width, height: screen.height };
}

/**
 * Decode the first frame of a GIF to RGBA, composited onto the logical screen.
 *
 * @throws {CorruptImageError} for a malformed or truncated file
 */
export function decodeGif(bytes: Uint8Array): RawImage {
  const screen = readScreen(bytes);
  const image = createImage(screen.width, screen.height);

  let at = screen.dataStart;
  let transparentIndex = -1;

  while (at < bytes.length) {
    const block = bytes[at];

    if (block === TRAILER || block === undefined) break;

    if (block === EXTENSION) {
      // The graphic control extension carries the transparent index (which we need) and
      // the frame delay (which we do not). It applies to the NEXT image descriptor, so it
      // has to be read before we hit one.
      if (bytes[at + 1] === GRAPHIC_CONTROL && (bytes[at + 3]! & 1) !== 0) {
        transparentIndex = bytes[at + 6]!;
      }
      at = skipBlocks(bytes, at + 2);
      continue;
    }

    if (block === IMAGE_DESCRIPTOR) {
      readFrame(bytes, at, screen, transparentIndex, image);
      // Frame 0 and no further. Everything after is another frame we do not composite.
      return image;
    }

    throw new CorruptImageError(`Unknown GIF block 0x${block.toString(16)} at byte ${at}.`);
  }

  throw new CorruptImageError('GIF contains no image data.');
}

/**
 * Encode to a GIF: quantise, optionally dither, LZW-compress, wrap in a container.
 *
 * @throws {InvalidOptionError} if `colors` is not an integer in 2-256
 */
export function encodeGif(image: RawImage, options: GifEncodeOptions = {}): Uint8Array {
  const { colors = 256, dither = true } = options;

  if (!Number.isInteger(colors) || colors < 2 || colors > 256) {
    throw new InvalidOptionError('gif.colors', colors, 'must be an integer from 2 to 256');
  }

  // GIF alpha is one bit, so transparency costs a whole palette entry. Decide up front:
  // it changes how many colours the quantiser has left to work with.
  const transparent = hasTransparency(image);
  const budget = transparent ? colors - 1 : colors;

  const { palette, indices } = quantise(image, Math.max(1, budget), dither, transparent);

  // The index of the transparent entry, not its byte offset: `palette` holds RGB triples,
  // so its length is three times the entry count.
  const entries = palette.length / 3;
  return writeGif(image, palette, indices, transparent ? entries - 1 : -1);
}

// --- header --------------------------------------------------------------------------

interface Screen {
  width: number;
  height: number;
  /** The global colour table as RGB triples, or undefined if the file has none. */
  globalTable?: Uint8Array;
  dataStart: number;
}

function readScreen(bytes: Uint8Array): Screen {
  if (bytes.length < 13) {
    throw new CorruptImageError('Not a GIF: too short to hold a header.');
  }

  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  // Both are real and the difference is two bytes: 87a predates transparency and the
  // extension blocks, but the parts we read are identical.
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new CorruptImageError(`Not a GIF: signature is "${signature}", not GIF87a or GIF89a.`);
  }

  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  if (width < 1 || height < 1) {
    throw new CorruptImageError(`GIF declares an invalid logical screen: ${width}x${height}.`);
  }
  if (width * height > DEFAULT_MAX_PIXELS) {
    throw new ImageTooLargeError(width, height, DEFAULT_MAX_PIXELS);
  }

  const flags = bytes[10]!;
  let at = 13;
  let globalTable: Uint8Array | undefined;

  if ((flags & 0x80) !== 0) {
    // The size field is a power of two: 0 means 2 entries, 7 means 256.
    const size = (2 << (flags & 7)) * 3;
    if (at + size > bytes.length) throw new CorruptImageError('GIF global colour table is truncated.');
    globalTable = bytes.subarray(at, at + size);
    at += size;
  }

  return globalTable === undefined ? { width, height, dataStart: at } : { width, height, globalTable, dataStart: at };
}

/** Step over a chain of length-prefixed sub-blocks, returning the offset past the terminator. */
function skipBlocks(bytes: Uint8Array, at: number): number {
  while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
  if (at >= bytes.length) throw new CorruptImageError('GIF sub-block chain runs past the end of the file.');
  return at + 1;
}

// --- decode --------------------------------------------------------------------------

/** Read one image descriptor and paint its frame onto the logical screen. */
function readFrame(bytes: Uint8Array, at: number, screen: Screen, transparentIndex: number, image: RawImage): void {
  if (at + 10 > bytes.length) throw new CorruptImageError('GIF image descriptor is truncated.');

  const x = bytes[at + 1]! | (bytes[at + 2]! << 8);
  const y = bytes[at + 3]! | (bytes[at + 4]! << 8);
  const width = bytes[at + 5]! | (bytes[at + 6]! << 8);
  const height = bytes[at + 7]! | (bytes[at + 8]! << 8);
  const flags = bytes[at + 9]!;
  const interlaced = (flags & 0x40) !== 0;

  let cursor = at + 10;
  let table = screen.globalTable;

  // A local table overrides the global one for this frame. Legal, and the mechanism behind
  // pseudo-truecolour GIFs that stack many frames with many palettes.
  if ((flags & 0x80) !== 0) {
    const size = (2 << (flags & 7)) * 3;
    if (cursor + size > bytes.length) throw new CorruptImageError('GIF local colour table is truncated.');
    table = bytes.subarray(cursor, cursor + size);
    cursor += size;
  }

  if (table === undefined || table.length === 0) {
    throw new CorruptImageError('GIF frame has no colour table, global or local: its indices mean nothing.');
  }
  if (width < 1 || height < 1) {
    throw new CorruptImageError(`GIF frame has an invalid size: ${width}x${height}.`);
  }

  const indices = decompress(bytes, cursor, width * height);
  const entries = table.length / 3;

  for (let row = 0; row < height; row++) {
    // Interlaced rows arrive in four passes, not in order. Read them sequentially and the
    // image comes out as horizontal bands.
    const dstY = y + (interlaced ? interlacedRow(row, height) : row);
    if (dstY >= image.height) continue;

    for (let col = 0; col < width; col++) {
      const dstX = x + col;
      if (dstX >= image.width) continue;

      const index = indices[row * width + col]!;
      const to = (dstY * image.width + dstX) * 4;

      if (index === transparentIndex) continue; // leave the screen's transparent default
      if (index >= entries) {
        throw new CorruptImageError(`GIF pixel index ${index} is past the end of a ${entries}-colour table.`);
      }

      image.data[to] = table[index * 3]!;
      image.data[to + 1] = table[index * 3 + 1]!;
      image.data[to + 2] = table[index * 3 + 2]!;
      image.data[to + 3] = 255;
    }
  }
}

/**
 * Map a sequential row number to its real row, for an interlaced frame.
 *
 * Four passes: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1.
 */
function interlacedRow(row: number, height: number): number {
  const p1 = Math.ceil(height / 8);
  const p2 = Math.ceil((height - 4) / 8);
  const p3 = Math.ceil((height - 2) / 4);

  if (row < p1) return row * 8;
  if (row < p1 + p2) return (row - p1) * 8 + 4;
  if (row < p1 + p2 + p3) return (row - p1 - p2) * 4 + 2;
  return (row - p1 - p2 - p3) * 2 + 1;
}

/**
 * GIF's LZW dialect.
 *
 * Its own thing, and each detail below is a way to make a file that opens in one viewer
 * and not another: variable code width starting at minCodeSize + 1, explicit clear and end
 * codes, a table capped at 4096 that stops growing (rather than resetting itself) when
 * full, and the stream chopped into sub-blocks of at most 255 bytes.
 */
function decompress(bytes: Uint8Array, at: number, expected: number): Uint8Array {
  const minCodeSize = bytes[at];
  if (minCodeSize === undefined || minCodeSize < 2 || minCodeSize > 11) {
    throw new CorruptImageError(`GIF has an invalid LZW minimum code size: ${minCodeSize}.`);
  }
  at++;

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  // The dictionary. Entries 0..clearCode-1 are the literal colour indices; everything past
  // endCode is built as we go, as (prefix, suffix) pairs.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);

  const out = new Uint8Array(expected);
  let written = 0;

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let previous = -1;

  // The bit reader, threaded through the sub-block chain. Codes straddle both byte AND
  // sub-block boundaries, so this cannot be done a block at a time.
  let blockEnd = at + 1 + (bytes[at] ?? 0);
  let cursor = at + 1;
  let buffer = 0;
  let bits = 0;

  const stack = new Uint8Array(4096);

  for (;;) {
    while (bits < codeSize) {
      if (cursor >= blockEnd) {
        // Next sub-block. A zero length is the terminator.
        const size = bytes[blockEnd];
        if (size === undefined) throw new CorruptImageError('GIF LZW data ended mid-code.');
        if (size === 0) {
          if (written !== expected) {
            throw new CorruptImageError(`GIF frame decoded ${written} of ${expected} pixels: the data is truncated.`);
          }
          return out;
        }
        cursor = blockEnd + 1;
        blockEnd = cursor + size;
        if (blockEnd > bytes.length) throw new CorruptImageError('GIF LZW sub-block runs past the end of the file.');
      }
      buffer |= bytes[cursor++]! << bits;
      bits += 8;
    }

    const code = buffer & ((1 << codeSize) - 1);
    buffer >>= codeSize;
    bits -= codeSize;

    if (code === endCode) break;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      next = endCode + 1;
      previous = -1;
      continue;
    }

    let current = code;
    let depth = 0;

    if (code > next || (code === next && previous === -1)) {
      throw new CorruptImageError(`GIF LZW code ${code} is not in the dictionary yet.`);
    }

    // The self-referential case: a code that means "the previous string plus its own first
    // byte", emitted before the decoder has built it. Legal and common, and forgetting it
    // corrupts any run of a repeated pattern.
    if (code === next) {
      if (previous < 0) throw new CorruptImageError('GIF LZW stream opens with a deferred code.');
      stack[depth++] = first[previous]!;
      current = previous;
    }

    while (current >= clearCode) {
      stack[depth++] = suffix[current]!;
      current = prefix[current]!;
      if (depth >= stack.length) throw new CorruptImageError('GIF LZW dictionary has a cycle.');
    }
    stack[depth++] = current;

    if (written + depth > expected) {
      throw new CorruptImageError('GIF frame decodes to more pixels than its dimensions allow.');
    }
    // The stack unwound the string backwards, so it goes out in reverse.
    for (let i = depth - 1; i >= 0; i--) out[written++] = stack[i]!;

    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = current;
      first[next] = first[previous] !== undefined && previous >= clearCode ? first[previous]! : previous;
      next++;

      // Grow the code width as the dictionary fills, but stop at 4096: past that an
      // encoder is expected to send a clear code, and widening further reads nonsense.
      if ((next & (next - 1)) === 0 && next < 4096 && codeSize < 12) codeSize++;
    }

    previous = code;
    first[code] = first[code] !== undefined && code >= clearCode ? first[code]! : code < clearCode ? code : first[code]!;
  }

  if (written !== expected) {
    throw new CorruptImageError(`GIF frame decoded ${written} of ${expected} pixels: the data is truncated.`);
  }
  return out;
}

// --- quantisation --------------------------------------------------------------------

function hasTransparency(image: RawImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i]! < 128) return true;
  }
  return false;
}

interface Quantised {
  /** RGB triples, one per palette entry. */
  palette: Uint8Array;
  indices: Uint8Array;
}

/**
 * Median cut, then map every pixel to its nearest palette entry.
 *
 * Median cut over octree or NeuQuant because it is the smallest thing that produces a
 * result nobody complains about, and GIF is not a format this plugin's audience optimises
 * hard. NeuQuant is the upgrade path if a real complaint ever arrives.
 */
function quantise(image: RawImage, budget: number, dither: boolean, transparent: boolean): Quantised {
  const colors = collect(image);
  const exact = colors.length <= budget;

  // No shortcut for the exact case: median cut keeps splitting until no box holds two
  // colours, so a palette that already fits comes back out of it verbatim anyway. The
  // guarantee is real and tested ("an image that already fits in 256 colours round-trips
  // exactly") -- it just does not need its own branch to be true.
  const table = medianCut(colors, budget);

  const palette = new Uint8Array((table.length + (transparent ? 1 : 0)) * 3);
  for (let i = 0; i < table.length; i++) palette.set(table[i]!, i * 3);
  // The transparent entry goes last, so its index is stable and every real colour keeps
  // the index the quantiser gave it. Its RGB is never shown.
  if (transparent) palette.set([0, 0, 0], table.length * 3);

  // Skipping the diffuser when the palette is exact is a saving, not a correctness fix:
  // every colour has a perfect match, so the error at each pixel is zero and diffusing it
  // produces bit-identical output either way. It just avoids allocating a float buffer
  // three times the image and walking it for nothing.
  const indices = dither && !exact ? mapDithered(image, table, transparent) : mapNearest(image, table, transparent);

  return { palette, indices };
}

interface ColorCount {
  rgb: [number, number, number];
  count: number;
}

/** Every distinct opaque colour in the image, with how often it appears. */
function collect(image: RawImage): ColorCount[] {
  const counts = new Map<number, number>();

  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3]! < 128) continue; // will become the transparent index
    const key = (image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out: ColorCount[] = [];
  for (const [key, count] of counts) {
    out.push({ rgb: [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff], count });
  }
  // A fully transparent image has no opaque colour at all, and a zero-entry palette is not
  // a legal GIF. One black entry nobody will ever see.
  if (out.length === 0) out.push({ rgb: [0, 0, 0], count: 1 });
  return out;
}

/**
 * Recursively split the colour cube along its longest axis at the median, until there are
 * `budget` boxes, then average each box.
 *
 * Weighted by pixel count, not by distinct colour: a box holding one pixel of a rare colour
 * and one holding half the image should not be treated as equally worth splitting.
 */
function medianCut(colors: ColorCount[], budget: number): [number, number, number][] {
  let boxes: ColorCount[][] = [colors];

  while (boxes.length < budget) {
    // Split the box with the longest axis. Picking by colour count instead is a defensible
    // variant of the same algorithm rather than a mistake -- measured, the two land within
    // 3% of each other on a photo -- so the tests bound the resulting error rather than
    // pinning this particular choice.
    let target = -1;
    let longest = 0;

    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.length < 2) continue;
      const [, range] = widestAxis(boxes[i]!);
      if (range > longest) {
        longest = range;
        target = i;
      }
    }

    if (target < 0) break; // every box holds a single colour: nothing left to split

    const box = boxes[target]!;
    const [axis] = widestAxis(box);
    box.sort((a, b) => a.rgb[axis]! - b.rgb[axis]!);

    // The median by PIXEL COUNT, not by index: half the pixels each side, so a box is cut
    // where the image's weight actually is.
    const total = box.reduce((sum, c) => sum + c.count, 0);
    let running = 0;
    let split = 0;
    for (let i = 0; i < box.length - 1; i++) {
      running += box[i]!.count;
      split = i + 1;
      if (running * 2 >= total) break;
    }

    boxes = [...boxes.slice(0, target), box.slice(0, split), box.slice(split), ...boxes.slice(target + 1)];
  }

  return boxes.map(average);
}

/** The axis with the widest spread, and that spread. */
function widestAxis(box: ColorCount[]): [0 | 1 | 2, number] {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];

  for (const c of box) {
    for (let a = 0; a < 3; a++) {
      if (c.rgb[a]! < min[a]!) min[a] = c.rgb[a]!;
      if (c.rgb[a]! > max[a]!) max[a] = c.rgb[a]!;
    }
  }

  const spread: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = spread[0] >= spread[1] && spread[0] >= spread[2] ? 0 : spread[1] >= spread[2] ? 1 : 2;
  return [axis, spread[axis]];
}

/** The pixel-count-weighted mean colour of a box. */
function average(box: ColorCount[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (const c of box) {
    r += c.rgb[0] * c.count;
    g += c.rgb[1] * c.count;
    b += c.rgb[2] * c.count;
    n += c.count;
  }

  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Squared distance in RGB. Squared because only the ordering matters, and sqrt is not free. */
function distance(r: number, g: number, b: number, to: [number, number, number]): number {
  const dr = r - to[0];
  const dg = g - to[1];
  const db = b - to[2];
  return dr * dr + dg * dg + db * db;
}

function nearest(r: number, g: number, b: number, table: [number, number, number][]): number {
  let best = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < table.length; i++) {
    const d = distance(r, g, b, table[i]!);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

function mapNearest(image: RawImage, table: [number, number, number][], transparent: boolean): Uint8Array {
  const out = new Uint8Array(image.width * image.height);

  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    out[p] =
      transparent && image.data[i + 3]! < 128
        ? table.length
        : nearest(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, table);
  }
  return out;
}

/**
 * Floyd-Steinberg error diffusion.
 *
 * Without it, a photo quantised to 256 colours bands visibly on any gradient, and skies are
 * the giveaway. Each pixel's quantisation error is pushed onto its not-yet-visited
 * neighbours in the classic 7/3/5/1 proportions, so the error averages out across a region
 * instead of accumulating into a flat plateau.
 */
function mapDithered(image: RawImage, table: [number, number, number][], transparent: boolean): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);

  // Float, and a copy: the diffused error has to accumulate at better than 8-bit precision
  // and must not be clamped, or the whole mechanism rounds itself away.
  const work = new Float32Array(width * height * 3);
  for (let i = 0, w = 0; i < data.length; i += 4, w += 3) {
    work[w] = data[i]!;
    work[w + 1] = data[i + 1]!;
    work[w + 2] = data[i + 2]!;
  }

  const spread = (x: number, y: number, factor: number, er: number, eg: number, eb: number): void => {
    if (x < 0 || x >= width || y >= height) return;
    const w = (y * width + x) * 3;
    work[w] = work[w]! + er * factor;
    work[w + 1] = work[w + 1]! + eg * factor;
    work[w + 2] = work[w + 2]! + eb * factor;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;

      if (transparent && data[p * 4 + 3]! < 128) {
        out[p] = table.length;
        continue;
      }

      const w = p * 3;
      // Clamp only for the palette lookup: the stored error stays unclamped.
      const r = clamp(work[w]!);
      const g = clamp(work[w + 1]!);
      const b = clamp(work[w + 2]!);

      const index = nearest(r, g, b, table);
      out[p] = index;

      const chosen = table[index]!;
      const er = r - chosen[0];
      const eg = g - chosen[1];
      const eb = b - chosen[2];

      spread(x + 1, y, 7 / 16, er, eg, eb);
      spread(x - 1, y + 1, 3 / 16, er, eg, eb);
      spread(x, y + 1, 5 / 16, er, eg, eb);
      spread(x + 1, y + 1, 1 / 16, er, eg, eb);
    }
  }

  return out;
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// --- encode --------------------------------------------------------------------------

/** A growable byte sink. */
class Writer {
  private bytes = new Uint8Array(4096);
  private len = 0;

  byte(v: number): void {
    if (this.len === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.len++] = v;
  }

  u16(v: number): void {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }

  bytesOf(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.byte(values[i]!);
  }

  take(): Uint8Array {
    return this.bytes.slice(0, this.len);
  }
}

function writeGif(image: RawImage, palette: Uint8Array, indices: Uint8Array, transparentIndex: number): Uint8Array {
  const w = new Writer();
  const entries = palette.length / 3;

  // The table size field is a power of two, and its minimum is 2 entries: there is no way
  // to say "one colour". A single-colour image writes a padded table.
  let bits = 1;
  while (1 << bits < entries) bits++;
  const padded = 1 << bits;

  w.bytesOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a

  w.u16(image.width);
  w.u16(image.height);
  w.byte(0x80 | ((bits - 1) << 4) | (bits - 1)); // global table, colour resolution, size
  w.byte(0); // background index
  w.byte(0); // pixel aspect ratio: none

  w.bytesOf(palette);
  for (let i = entries; i < padded; i++) w.bytesOf([0, 0, 0]); // pad to the power of two

  // Only iff the image has transparency: the extension exists solely to name the
  // transparent index, and writing one anyway wastes bytes and a palette entry.
  if (transparentIndex >= 0) {
    w.bytesOf([EXTENSION, GRAPHIC_CONTROL, 4, 0x01, 0, 0, transparentIndex, 0]);
  }

  w.byte(IMAGE_DESCRIPTOR);
  w.u16(0); // frame x
  w.u16(0); // frame y
  w.u16(image.width);
  w.u16(image.height);
  w.byte(0); // no local table, not interlaced

  compress(w, indices, Math.max(2, bits));

  w.byte(TRAILER);
  return w.take();
}

/**
 * GIF's LZW, the write side. Mirrors `decompress` exactly, including the details that
 * decide whether a file opens everywhere or only in the viewer you tested.
 */
function compress(w: Writer, indices: Uint8Array, minCodeSize: number): void {
  w.byte(minCodeSize);

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;

  // (prefix << 8) | suffix -> code. A map rather than a trie: 4096 entries at most, and the
  // dictionary is rebuilt often enough that the allocation never matters.
  let dictionary = new Map<number, number>();

  // The sub-block chain: at most 255 data bytes each, length-prefixed. The length is ONE
  // byte, so a longer run is unrepresentable and the stream desynchronises.
  let block: number[] = [];
  let buffer = 0;
  let bits = 0;

  const flushBlock = (): void => {
    if (block.length === 0) return;
    w.byte(block.length);
    w.bytesOf(block);
    block = [];
  };

  const emit = (code: number): void => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block.push(buffer & 0xff);
      buffer >>= 8;
      bits -= 8;
      if (block.length === 255) flushBlock();
    }
  };

  emit(clearCode);

  let current = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (current << 8) | k;
    const found = dictionary.get(key);

    if (found !== undefined) {
      current = found;
      continue;
    }

    emit(current);

    if (next < 4096) {
      dictionary.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      // The dictionary is full. Send a clear code and start over, rather than keep coding
      // against a table the decoder has stopped growing.
      emit(clearCode);
      dictionary = new Map();
      codeSize = minCodeSize + 1;
      next = endCode + 1;
    }

    current = k;
  }

  emit(current);
  emit(endCode);

  // The final partial byte still has to go out.
  if (bits > 0) {
    block.push(buffer & 0xff);
    if (block.length === 255) flushBlock();
  }
  flushBlock();

  w.byte(0); // sub-block terminator
}
