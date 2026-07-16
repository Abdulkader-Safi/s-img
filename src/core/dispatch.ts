/**
 * decode() and encode(): the boundary between "a file" and "pixels".
 * See features/decode.md and features/encode.md.
 *
 * Two views of one dispatch table. Everything format-specific lives in a codec; what
 * lives here is the part no codec can own -- the format sniff, the size guard, and the
 * EXIF orientation, which needs a codec's reader and a transform's writer and so belongs
 * to neither.
 *
 * By the time a RawImage leaves decode(), the source format does not exist. That is what
 * makes format conversion fall out for free rather than being a feature.
 */

import { decodeBmp, encodeBmp, probeBmp, type BmpEncodeOptions } from './codecs/bmp.ts';
import { decodeGif, encodeGif, probeGif, type GifEncodeOptions } from './codecs/gif.ts';
import { decodeJpeg, encodeJpeg, probeJpeg, readExifOrientation, type JpegEncodeOptions } from './codecs/jpeg.ts';
import { decodePng, encodePng, probePng } from './codecs/png.ts';
import { decodeTiff, encodeTiff, probeTiff, type TiffEncodeOptions } from './codecs/tiff.ts';
import { decodeWebp, encodeWebp, preloadWebp, probeWebp, type WebpEncodeOptions } from './codecs/webp.ts';
import { ImageTooLargeError, InvalidOptionError, SImgError, UnsupportedFormatError } from './errors.ts';
import { sniff, type Format } from './formats.ts';
import { assertValidImage, DEFAULT_MAX_PIXELS, type RawImage } from './image.ts';
import { flip } from './transform/flip.ts';
import { maxLongEdge as capLongEdge } from './transform/resize.ts';
import { rotate90 } from './transform/rotate90.ts';

export interface DecodeOptions {
  /**
   * Decode small, for a preview. The long edge lands at or under this.
   *
   * A HINT, not the pipeline's `.maxLongEdge()`, and the different name is deliberate.
   * This is a performance request -- "I do not need more than this many pixels" -- and
   * what each codec can do about it varies enormously: JPEG scales during the inverse DCT
   * and gets genuinely faster, while PNG has to inflate the whole thing first and only
   * saves on what comes after. `.maxLongEdge()` on the pipeline is an output GUARANTEE and
   * is exact.
   *
   * A caller who confuses the two gets a preview of the wrong size or an output that is not
   * capped, so they do not share a name. A name that lies costs more than a longer name.
   */
  hintMaxLongEdge?: number;
  /** Skip the format sniff and force a codec. Escape hatch, rarely correct. */
  format?: Format;
  /** Refuse to allocate a canvas larger than this many pixels. */
  maxPixels?: number;
}

/**
 * Format-conditional, so `quality` exists only where it means something.
 *
 * Named FormatOptions rather than EncodeOptions because it is what BOTH doors take --
 * `encode(img, 'jpeg', ...)` and `.toFormat('jpeg', ...)` -- and a type with two names is
 * a type a reader has to check twice. features/encode.md called it EncodeOptions and three
 * other specs called it this; the majority and the better name agree, and nothing had
 * shipped yet, so it is this.
 *
 * The `Record<string, never>` on png is what makes the error land: an object literal with
 * `quality` has an excess property against a type that permits none, and TypeScript's
 * excess-property check fires on the literal. `{}` would accept anything object-shaped.
 */
export type FormatOptions<F extends Format> = F extends 'jpeg'
  ? JpegEncodeOptions
  : F extends 'gif'
    ? GifEncodeOptions
    : F extends 'bmp'
      ? BmpEncodeOptions
      : F extends 'tiff'
        ? TiffEncodeOptions
        : F extends 'webp'
          ? WebpEncodeOptions
          : Record<string, never>;

interface Codec {
  /**
   * Header only, and SYNCHRONOUS even for WebP. That is not an accident: the size guard
   * has to reject a hostile file before any bytes reach a WASM heap that grows in pages
   * and fails ungracefully, so probe cannot be allowed to need the module it protects.
   */
  probe(bytes: Uint8Array): { width: number; height: number };
  /**
   * Async only for WebP, whose codec arrives via dynamic import. The rest return directly.
   *
   * `hint` is the preview size, and a codec is free to ignore it entirely -- only JPEG can
   * act on it cheaply (features/fast-decode.md). decode() caps whatever comes back, so a
   * codec that ignores it is correct, just not fast.
   */
  decode(bytes: Uint8Array, hint?: number): RawImage | Promise<RawImage>;
  encode(image: RawImage, opts: never): Uint8Array | Promise<Uint8Array>;
  /**
   * Every option this format understands. The types above already say this, and say it
   * better -- but types do not survive JSON.parse, and the batch pipeline is explicitly
   * serialisable (features/batch-pipeline.md), so `{format: 'png', quality: 80}` can
   * arrive from a settings file having never seen the compiler.
   *
   * Belt and braces. This is the one that fires in production.
   */
  options: readonly string[];
}

/**
 * The dispatch table. Every entry but webp is pure TypeScript and always loaded; webp's
 * WASM is behind a dynamic import inside its own module, so naming it here costs nothing
 * until someone actually touches a WebP.
 */
const CODECS: Partial<Record<Format, Codec>> = {
  // No options at all, which is the point: `quality` on a lossless format is a lie the
  // compiler catches and this catches again. A silently-ignored option is worse than an
  // error, because the user sees a slider move and the file not change.
  png: { probe: probePng, decode: decodePng, encode: encodePng, options: [] },
  jpeg: {
    // The only codec that can act on the hint, and the format the plugin sees most.
    probe: probeJpeg,
    decode: (bytes, hint) => decodeJpeg(bytes, hint === undefined ? {} : { hintMaxLongEdge: hint }),
    encode: encodeJpeg,
    options: ['quality', 'background'],
  },
  gif: { probe: probeGif, decode: decodeGif, encode: encodeGif, options: ['colors', 'dither'] },
  bmp: { probe: probeBmp, decode: decodeBmp, encode: encodeBmp, options: ['background'] },
  tiff: { probe: probeTiff, decode: decodeTiff, encode: encodeTiff, options: ['compression'] },
  // No `background`: WebP has real alpha, so there is nothing to composite onto.
  webp: { probe: probeWebp, decode: decodeWebp, encode: encodeWebp, options: ['quality', 'lossless'] },
};

/**
 * Warm a lazily-loaded codec so the first image open is not a visible stall.
 *
 * Only webp has anything to load; the rest resolve immediately rather than throwing, so a
 * plugin can preload its whole preset list without knowing which formats are WASM-backed.
 */
export async function preload(format: Format): Promise<void> {
  if (format === 'webp') await preloadWebp();
}

/**
 * Read an image's real dimensions without decoding it.
 *
 * Already existed internally for the size guard; exported because it removes a whole class
 * of coordinate bug for nothing. The preview path needs the SOURCE size to scale a crop
 * rectangle drawn in preview coordinates, and the only alternatives are decoding the image
 * twice or assuming a scale factor -- and assuming is how you get a crop that is off by
 * 1.6x, because JPEG's DCT scaling only does powers of two.
 *
 * Microseconds: it parses a header and allocates no pixel buffer.
 *
 * @throws {UnsupportedFormatError} nothing matched, or the format has no codec
 * @throws {CorruptImageError} the header matched and did not parse
 */
export function probe(bytes: Uint8Array): { width: number; height: number } {
  const format = sniff(bytes);
  const codec = format === undefined ? undefined : CODECS[format];
  if (codec === undefined) throw new UnsupportedFormatError(bytes);
  return codec.probe(bytes);
}

/**
 * Bytes in, RGBA out. Sniffs the format, guards the size, dispatches to a codec.
 *
 * Async because WebP's codec arrives via dynamic import (features/api-surface.md, Q3):
 * async everywhere beats a sync/async split that leaks the WebP special case into every
 * call site.
 *
 * @throws {UnsupportedFormatError} nothing matched, or the format has no codec
 * @throws {SImgError} FORMAT_MISMATCH if `opts.format` contradicts the header
 * @throws {ImageTooLargeError} the declared dimensions exceed `maxPixels`
 * @throws {CorruptImageError} the header matched and the rest did not parse
 */
export async function decode(bytes: Uint8Array, opts: DecodeOptions = {}): Promise<RawImage> {
  const detected = sniff(bytes);

  // Neither one silently wins. A caller forcing a codec against the header is doing
  // something exotic enough to deserve an explicit error before we act on a guess.
  if (opts.format !== undefined && opts.format !== detected) {
    throw new SImgError(
      'FORMAT_MISMATCH',
      `Asked to decode as ${opts.format}, but the header says ${detected ?? 'nothing we recognise'}.`,
    );
  }

  const format = opts.format ?? detected;
  const codec = format === undefined ? undefined : CODECS[format];
  if (codec === undefined) throw new UnsupportedFormatError(bytes);

  // The trust boundary. Read the declared size, compare, throw BEFORE allocating: a
  // 30-byte BMP header can claim 60000x60000, and a decoder that allocates first and
  // validates second is a one-line denial of service against anyone who opens an
  // attachment folder. Measured on the DECLARED size, never on the result -- a guard
  // applied after maxLongEdge shrank the image would let the hostile header through.
  const { width, height } = codec.probe(bytes);
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (width * height > maxPixels) throw new ImageTooLargeError(width, height, maxPixels);

  const image = await codec.decode(bytes, opts.hintMaxLongEdge);
  // The seam assertValidImage was written for. No codec here can currently fail it --
  // each validates its own header, and a 0-width BMP throws CORRUPT_IMAGE long before
  // this line -- so it is deliberately an unreachable assertion today. It stays because
  // the next codec through this seam is WebP: a WASM module whose output buffer we do
  // not control and cannot fix. Cheap insurance at the one place that can see the lie.
  assertValidImage(image);

  // Orientation first: it is what the image IS, and the cap applies to the edge the user
  // will actually see. A 24x16 tagged "rotate 90" displays as 16x24, whose long edge is
  // the 24 -- cap before rotating and the wrong axis gets capped.
  //
  // The 'jpeg' guard is for cost and clarity, not behaviour: readExifOrientation parses
  // JPEG APP1 markers, so on any other container it reports 1 and this would be a no-op
  // anyway (pinned by a test). Note TIFF carries its own Orientation tag -- same number,
  // 274, but in its IFD rather than an APP1 -- which this does NOT cover. See
  // features/index.md.
  const oriented = format === 'jpeg' ? applyOrientation(image, readExifOrientation(bytes)) : image;

  // Cap whatever the codec produced. For JPEG this is usually a no-op -- the DCT already
  // landed under the hint -- and for everything else it is the fallback: decode fully,
  // resize, and let the full-resolution buffer go. The caller still gets a small image and
  // still saves on every downstream transform, which is where most of the cost is anyway.
  // The decode itself is not faster, and the docs say so rather than implying a uniform win.
  //
  // It also makes the contract simple: never over the hint, for any format. JPEG's
  // power-of-two granularity means "at or under", never over -- a 4000px source hinted at
  // 1600 comes back at 1000, because 2000 would be more than was asked for.
  return opts.hintMaxLongEdge === undefined ? oriented : capLongEdge(oriented, opts.hintMaxLongEdge);
}

/**
 * RawImage in, bytes out. The mirror of decode().
 *
 * Writes no EXIF, no GPS, no ICC, always. There is nothing to preserve: decode already
 * dropped the metadata and baked the orientation into the pixels. Carrying the tag
 * forward would double-rotate. See features/strip-metadata.md.
 *
 * @throws {UnsupportedFormatError} the format has no encoder
 * @throws {SImgError} ENCODE_FAILED, with the original error as `cause`
 */
export async function encode<F extends Format>(
  image: RawImage,
  format: F,
  opts?: FormatOptions<F>,
): Promise<Uint8Array> {
  const codec = CODECS[format];
  if (codec === undefined) {
    throw new UnsupportedFormatError(new Uint8Array(0), `Cannot encode to ${format}: no encoder for that format.`);
  }

  // Reject an option this format does not have, rather than ignoring it. `quality` on a
  // PNG is the case that matters: the plugin disables its quality slider on lossless
  // formats, and the library and the UI must not disagree about what is possible.
  for (const key of Object.keys(opts ?? {})) {
    if (!codec.options.includes(key)) {
      throw new InvalidOptionError(
        `encode.${key}`,
        (opts as Record<string, unknown>)[key],
        codec.options.length === 0
          ? `${format} takes no options`
          : `${format} takes only ${codec.options.join(', ')}`,
      );
    }
  }

  // Checked rather than trusted, because the encoders do not fail on a malformed image:
  // encodePng handed a 2-byte buffer for a 4x4 reads past the end, gets undefined, and
  // writes a perfectly valid 72-byte PNG of garbage. Silent nonsense is worse than a
  // throw, and by the time anyone notices, the file is saved.
  try {
    assertValidImage(image);
  } catch (cause) {
    throw new SImgError('ENCODE_FAILED', `Cannot encode to ${format}: ${message(cause)}`, { cause });
  }

  try {
    return await codec.encode(image, (opts ?? {}) as never);
  } catch (cause) {
    // Never let a raw RangeError from a typed-array write escape the boundary. An
    // SImgError from the codec is already the contract -- an out-of-range quality is an
    // InvalidOptionError and says so better than ENCODE_FAILED would.
    if (cause instanceof SImgError) throw cause;
    throw new SImgError('ENCODE_FAILED', `Encoding to ${format} failed: ${message(cause)}`, { cause });
  }
}

/**
 * Apply an EXIF orientation (1-8) to the pixels.
 *
 * This is the reason decode is a layer rather than a re-export of the codecs: an iPhone
 * stores a landscape JPEG with a tag saying "rotate 90". Ignore it and every phone photo
 * comes out sideways and the user's crop coordinates mean nothing. The codec only READS
 * the tag -- a codec that imports a transform is a dependency running the wrong way
 * round -- so the applying happens here, where both are already in scope.
 *
 * An out-of-range value is left alone rather than thrown at. Real files carry 0 and 9,
 * and neither is a reason to refuse a photo the user can see fine in Preview.
 */
function applyOrientation(image: RawImage, orientation: number): RawImage {
  // The transform each value asks a viewer to apply to the STORED pixels. Mirroring runs
  // first where both are present, which is what makes 5 a transpose rather than a
  // transverse -- swap the order and 5 and 7 quietly trade places.
  switch (orientation) {
    case 2:
      return flip(image, { horizontal: true });
    case 3:
      return rotate90(image, 180);
    case 4:
      return flip(image, { vertical: true });
    case 5:
      return rotate90(flip(image, { horizontal: true }), 270);
    case 6:
      return rotate90(image, 90);
    case 7:
      return rotate90(flip(image, { horizontal: true }), 90);
    case 8:
      return rotate90(image, 270);
    default:
      return image;
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
