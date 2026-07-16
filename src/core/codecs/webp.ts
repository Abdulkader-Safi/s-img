/**
 * WebP: libwebp compiled to WASM, loaded on first use.
 * See features/codec-webp.md.
 *
 * The only non-pure-TypeScript codec here, and the PRD concedes it: WebP's lossy mode is
 * VP8 intra-frame coding -- a video codec's intra path -- and writing that in TypeScript
 * is a multi-month project that would end up slower and buggier than the WASM.
 *
 * Two things in this file are ours rather than libwebp's, and both are deliberate:
 *
 *   probeWebp parses the header in pure TypeScript, so the size guard in decode() can
 *   reject a hostile file BEFORE any bytes reach a WASM heap that grows in pages and
 *   fails ungracefully.
 *
 *   The WASM arrives as base64 from a generated module rather than as a .wasm file
 *   fetched at runtime. jSquash's loader cannot find its own binary under Node or inside
 *   an esbuild bundle, and an Obsidian plugin is an esbuild bundle. The full measurement
 *   is in scripts/gen-wasm.mjs.
 */

import { CorruptImageError, InvalidOptionError, SImgError } from '../errors.ts';
import { createImage, type RawImage } from '../image.ts';

export interface WebpEncodeOptions {
  /** 1-100. Default 80. WebP's scale is not JPEG's; the same number means something else. */
  quality?: number;
  /** Lossless mode. Passing this AND an explicit quality throws rather than ignoring one. */
  lossless?: boolean;
}

/**
 * Default quality. Not JPEG's 82: the scales are unrelated, and 80 is roughly where WebP
 * sits for visually-lossless-ish photos. features/format-quality.md.
 */
const DEFAULT_QUALITY = 80;

// --- the header, in pure TypeScript --------------------------------------------------

/**
 * Read the dimensions without decoding, and without the WASM.
 *
 * WebP is three formats wearing one extension and they store the size in three different
 * places. A probe that handles only VP8 works on most files and reads garbage from the
 * rest, which is worse than failing.
 *
 * @throws {CorruptImageError} if the container or the frame header does not parse
 */
export function probeWebp(bytes: Uint8Array): { width: number; height: number } {
  // RIFF....WEBP + a 4-byte chunk tag + a 4-byte chunk size = 20 before any payload.
  if (bytes.length < 20) throw new CorruptImageError(`WebP header is truncated: ${bytes.length} bytes.`);
  if (fourcc(bytes, 0) !== 'RIFF') throw new CorruptImageError('Not a RIFF container.');
  // RIFF alone is also WAV and AVI. probe must not assume the sniffer ran.
  if (fourcc(bytes, 8) !== 'WEBP') throw new CorruptImageError(`RIFF container is not a WebP: ${fourcc(bytes, 8)}.`);

  const chunk = fourcc(bytes, 12);
  const at = 20; // the first chunk's payload

  if (chunk === 'VP8 ') return readVp8(bytes, at);
  if (chunk === 'VP8L') return readVp8l(bytes, at);
  if (chunk === 'VP8X') return readVp8x(bytes, at);
  throw new CorruptImageError(`Unknown WebP chunk: "${chunk}".`);
}

/** Simple lossy. Dimensions are 14 bits each, after a 3-byte tag and a 3-byte start code. */
function readVp8(bytes: Uint8Array, at: number): { width: number; height: number } {
  if (bytes.length < at + 10) throw new CorruptImageError('WebP VP8 frame header is truncated.');
  // Without this check a corrupt file yields two arbitrary bytes as a dimension, and the
  // size guard is then handed a number that means nothing.
  if (bytes[at + 3] !== 0x9d || bytes[at + 4] !== 0x01 || bytes[at + 5] !== 0x2a) {
    throw new CorruptImageError('WebP VP8 keyframe start code is missing.');
  }
  // The top 2 bits of each are a scaling hint, not part of the dimension.
  const width = (bytes[at + 6]! | (bytes[at + 7]! << 8)) & 0x3fff;
  const height = (bytes[at + 8]! | (bytes[at + 9]! << 8)) & 0x3fff;
  return { width, height };
}

/** Simple lossless. 14 bits each, bit-packed into a 32-bit LE word after a 0x2f signature. */
function readVp8l(bytes: Uint8Array, at: number): { width: number; height: number } {
  if (bytes.length < at + 5) throw new CorruptImageError('WebP VP8L header is truncated.');
  if (bytes[at] !== 0x2f) throw new CorruptImageError('WebP VP8L signature is missing.');

  const bits = (bytes[at + 1]! | (bytes[at + 2]! << 8) | (bytes[at + 3]! << 16) | (bytes[at + 4]! << 24)) >>> 0;
  // Stored minus one, so a 1x1 is a zero here. Reading 0 as "absent" breaks the smallest
  // legal image.
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** Extended: alpha, animation, metadata. A 24-bit canvas size, also stored minus one. */
function readVp8x(bytes: Uint8Array, at: number): { width: number; height: number } {
  if (bytes.length < at + 10) throw new CorruptImageError('WebP VP8X header is truncated.');
  const u24 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
  return { width: u24(at + 4) + 1, height: u24(at + 7) + 1 };
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

// --- the WASM ------------------------------------------------------------------------

/**
 * Memoised, so a batch of 30 WebP files triggers exactly one load rather than 30. The
 * promise is cached, not the result: two concurrent first-touches must await the same
 * load rather than start a second one.
 *
 * Once loaded, stays loaded for the process lifetime. No unloading, no eviction. YAGNI:
 * the plugin runs in a long-lived Electron process and 300 KB of WASM is not the memory
 * problem there.
 */
let decoder: Promise<WebpDecoder> | undefined;
let encoder: Promise<WebpEncoder> | undefined;

interface WebpDecoder {
  decode(bytes: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } | null;
}
interface WebpEncoder {
  encode(data: Uint8ClampedArray, width: number, height: number, options: Record<string, number>): ArrayBuffer | null;
}

/** base64 to bytes, using the one decoder every target runtime already has. */
function fromBase64(b64: string): Uint8Array {
  // atob is a web standard and is global in Node 16+, Bun, Electron and browsers. Buffer
  // would be simpler and is banned in core for exactly the reason this file exists.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The shim features/codec-webp.md predicted would be needed, and the exact reason it is.
 *
 * The Emscripten glue picks its wasm path with:
 *
 *   if (Module["locateFile"]) { wasmBinaryFile = locateFile("webp_enc.wasm") }
 *   else { wasmBinaryFile = new URL("webp_enc.wasm", import.meta.url).href }
 *
 * esbuild rewrites `import.meta` to `{}` when it emits CJS -- and an Obsidian plugin is
 * CJS -- so `import.meta.url` is undefined and that `new URL` throws "Invalid URL" before
 * a single byte is decoded. Supplying locateFile takes the FIRST branch, so the line that
 * breaks is never reached.
 *
 * What it returns does not matter: getBinary checks `file == wasmBinaryFile && wasmBinary`
 * and hands back our bytes either way. It exists to steer the branch, not to find a file.
 */
const MODULE_OPTIONS = {
  noInitialRun: true,
  locateFile: (path: string) => path,
};

async function loadDecoder(): Promise<WebpDecoder> {
  decoder ??= (async () => {
    try {
      const [{ default: factory }, { WASM_BASE64 }] = await Promise.all([
        import('@jsquash/webp/codec/dec/webp_dec.js'),
        import('./webp-wasm-dec.ts'),
      ]);
      return (await factory({ ...MODULE_OPTIONS, wasmBinary: fromBase64(WASM_BASE64) })) as WebpDecoder;
    } catch (cause) {
      decoder = undefined; // a failed load must not poison every later attempt
      throw new SImgError('CODEC_LOAD_FAILED', `The WebP decoder could not be loaded: ${message(cause)}`, { cause });
    }
  })();
  return decoder;
}

async function loadEncoder(): Promise<WebpEncoder> {
  encoder ??= (async () => {
    try {
      const [{ default: factory }, { WASM_BASE64 }] = await Promise.all([
        import('@jsquash/webp/codec/enc/webp_enc_simd.js'),
        import('./webp-wasm-enc.ts'),
      ]);
      return (await factory({ ...MODULE_OPTIONS, wasmBinary: fromBase64(WASM_BASE64) })) as WebpEncoder;
    } catch (cause) {
      encoder = undefined;
      throw new SImgError('CODEC_LOAD_FAILED', `The WebP encoder could not be loaded: ${message(cause)}`, { cause });
    }
  })();
  return encoder;
}

/** Warm the modules so the first image open is not a visible stall. features/api-surface.md. */
export async function preloadWebp(): Promise<void> {
  await Promise.all([loadDecoder(), loadEncoder()]);
}

/** True once the module is in memory. Used by supportedFormats() and by the tests. */
export function isWebpLoaded(): boolean {
  return decoder !== undefined || encoder !== undefined;
}

// --- decode and encode ---------------------------------------------------------------

/**
 * Decode a WebP to RGBA. Alpha is native here: nothing is composited.
 *
 * @throws {CorruptImageError} if libwebp will not read it
 * @throws {SImgError} CODEC_LOAD_FAILED if the WASM will not load
 */
export async function decodeWebp(bytes: Uint8Array): Promise<RawImage> {
  const { width, height } = probeWebp(bytes); // fails fast, and before the WASM sees anything
  const module = await loadDecoder();

  let result: { width: number; height: number; data: Uint8ClampedArray } | null;
  try {
    result = module.decode(bytes);
  } catch (cause) {
    // libwebp inside emscripten aborts rather than throwing anything we would recognise.
    throw new CorruptImageError(`The WebP decoder failed: ${message(cause)}`, { cause });
  }
  if (result === null) throw new CorruptImageError('The WebP decoder rejected this file.');

  const image = createImage(result.width, result.height);
  image.data.set(result.data);
  // The header and the payload disagreeing means one of them is lying, and the size guard
  // upstream trusted the header. Unreachable with a real libwebp, which is the point: it
  // is the assertion that our hand-written probe and libwebp's reader have not drifted
  // apart, and the day it fires is the day the size guard was protecting nothing.
  if (result.width !== width || result.height !== height) {
    throw new CorruptImageError(
      `WebP header says ${width}x${height} but the decoder produced ${result.width}x${result.height}.`,
    );
  }
  return image;
}

/**
 * Encode RGBA to WebP. Alpha is preserved, no compositing and no `background` option.
 *
 * @throws {InvalidOptionError} quality out of range, or lossless with an explicit quality
 * @throws {SImgError} CODEC_LOAD_FAILED if the WASM will not load
 */
export async function encodeWebp(image: RawImage, options: WebpEncodeOptions = {}): Promise<Uint8Array> {
  const { quality, lossless = false } = options;

  // An option that silently does nothing under another option is a lie the caller cannot
  // see. If it is worth throwing over, it is worth being explicit about.
  if (lossless && quality !== undefined) {
    throw new InvalidOptionError('encode.quality', quality, 'is ignored when lossless is true; pass one or the other');
  }
  if (quality !== undefined && (!Number.isFinite(quality) || quality < 1 || quality > 100)) {
    throw new InvalidOptionError('encode.quality', quality, 'must be between 1 and 100');
  }

  const [module, { defaultOptions }] = await Promise.all([loadEncoder(), import('@jsquash/webp/meta.js')]);

  let result: ArrayBuffer | null;
  try {
    // Every field of libwebp's WebPConfig, then our two on top. The struct has to be
    // COMPLETE: emscripten's embind reads each field by name and a missing one is not
    // "use the default", it is `Missing field: "image_hint"` thrown from inside the WASM.
    // Taken from jSquash's meta.js rather than hand-copied, so a libwebp version bump that
    // adds a field does not silently become our bug.
    //
    // Everything we deliberately do not expose lives in there: method, alphaQuality, sns,
    // filter, near-lossless. Dozens of knobs, each one a support question, for a plugin
    // whose UI has one slider.
    result = module.encode(image.data, image.width, image.height, {
      ...defaultOptions,
      quality: quality ?? DEFAULT_QUALITY,
      lossless: lossless ? 1 : 0,
    });
  } catch (cause) {
    throw new SImgError('ENCODE_FAILED', `The WebP encoder failed: ${message(cause)}`, { cause });
  }
  if (result === null) throw new SImgError('ENCODE_FAILED', 'The WebP encoder returned nothing.');

  return new Uint8Array(result);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
