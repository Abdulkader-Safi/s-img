/**
 * Typed errors. See features/errors.md.
 *
 * An Obsidian vault is a pile of files a human dragged in over five years: a `.png`
 * that is really a JPEG, a 40-byte truncated download, a HEIC from an iPhone. Each
 * wants a different message in the UI and none should crash the editor.
 *
 * Two rules hold this together:
 *   - `code` is for machines, `message` is for humans. The plugin must never
 *     string-match on a message. Every conditional it needs is expressible on `code`
 *     plus the subclass fields; if it is not, this taxonomy is missing an entry.
 *   - The public API only ever throws an `SImgError`. Anything escaping a codec's guts
 *     gets caught at the boundary and wrapped, so `catch (e) { e instanceof SImgError }`
 *     is exhaustive.
 */

/**
 * The full taxonomy. This union is the contract, and it is complete even where the
 * matching class has not been written yet: each class lands on the branch that gives it
 * a caller (CODEC_LOAD_FAILED with feat/codec-webp, which is also when the `Format` type
 * it carries will exist). A class with no caller is a class with no test.
 */
export type SImgErrorCode =
  | 'UNSUPPORTED_FORMAT' // magic bytes matched nothing we can read
  | 'CORRUPT_IMAGE' // magic bytes matched, the rest did not parse
  | 'FORMAT_MISMATCH' // header says PNG, the caller said JPEG; we trust the header
  | 'INVALID_OPTION' // crop outside bounds, resize to 0, angle out of range
  | 'IMAGE_TOO_LARGE' // declared dimensions exceed the decode cap
  | 'CODEC_LOAD_FAILED' // a lazily-loaded codec module could not be loaded
  | 'ENCODE_FAILED'; // the encoder itself blew up

export class SImgError extends Error {
  readonly code: SImgErrorCode;

  constructor(code: SImgErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    // Subclass name, for free, in stack traces. Cosmetic only: `code` is the contract,
    // which is what keeps this honest under a minifier that mangles class names.
    this.name = new.target.name;
  }
}

/** Magic bytes matched, the rest did not parse. A truncated or damaged file. */
export class CorruptImageError extends SImgError {
  constructor(message: string, options?: ErrorOptions) {
    super('CORRUPT_IMAGE', message, options);
  }
}

/** A caller mistake: a crop outside the image, a resize to zero, an angle out of range. */
export class InvalidOptionError extends SImgError {
  readonly option: string;
  readonly value: unknown;

  /**
   * @param option dotted path of the offending field, e.g. `crop.width`
   * @param value what was actually passed
   * @param reason what was expected, e.g. `must be >= 1`
   */
  constructor(option: string, value: unknown, reason: string) {
    // "invalid crop" is useless to a UI. "crop.width must be >= 1, got -5" is actionable.
    super('INVALID_OPTION', `${option} ${reason}, got ${render(value)}`);
    this.option = option;
    this.value = value;
  }
}

/** Nothing we can read. Carries the magic bytes, which is what makes a bug report fixable. */
export class UnsupportedFormatError extends SImgError {
  /** The first 12 bytes as space-separated hex, or `''` for an empty input. */
  readonly detectedMagic: string;

  constructor(bytes: Uint8Array) {
    const magic = hexDump(bytes, MAGIC_BYTES);
    super(
      'UNSUPPORTED_FORMAT',
      magic === ''
        ? 'Not an image: the file is empty.'
        : `Not a supported image format. First bytes: ${magic}`,
    );
    this.detectedMagic = magic;
  }
}

/** Enough bytes to identify any format we support, and to recognise one we do not. */
const MAGIC_BYTES = 12;

/**
 * Space-separated hex of up to `limit` bytes. `subarray` clamps, so a 3-byte file
 * dumps 3 bytes rather than reading past the end: an error constructor that throws
 * while reporting an error is the worst possible failure.
 */
function hexDump(bytes: Uint8Array, limit: number): string {
  return Array.from(bytes.subarray(0, limit), (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Render a value for a message. Must never throw: it runs inside an error constructor. */
function render(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular, BigInt, a throwing toJSON. Something is better than nothing.
    return String(value);
  }
}
