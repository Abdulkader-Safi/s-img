/**
 * The library's format vocabulary, and the sniffer that identifies one from bytes.
 * See features/decode.md, "Format sniffing".
 *
 * The extension is a lie. The header is the truth. An Obsidian vault holds a `.png`
 * that is really a JPEG and a `.jpg` that is a 40-byte truncated download, so nothing
 * downstream trusts a filename.
 */

/**
 * Every format we can read or write.
 *
 * PNG, JPEG, GIF, BMP and TIFF are pure TypeScript and always loaded. WebP is a
 * lazily-loaded WASM module (features/codec-webp.md), which is why
 * `supportedFormats()` is a function rather than this constant.
 */
export const FORMATS = ['png', 'jpeg', 'gif', 'bmp', 'tiff', 'webp'] as const;

export type Format = (typeof FORMATS)[number];

/** A run of bytes that must appear at a fixed offset. */
interface Fragment {
  readonly offset: number;
  readonly bytes: readonly number[];
}

/** A format's signature: every fragment must match. Most formats need only one. */
interface Signature {
  readonly format: Format;
  readonly fragments: readonly Fragment[];
}

/**
 * Ordered strongest-signature-first, so a long match is tested before a short one.
 *
 * These are a *first pass* only: they pick a codec, and the codec's own header parse
 * is the real validation. That split is what lets decode tell "we recognised this and
 * it was broken" (CORRUPT_IMAGE) from "we have no idea what this is"
 * (UNSUPPORTED_FORMAT). BMP's two bytes especially will false-positive on plenty of
 * non-images; the DIB header check is what catches those.
 */
const SIGNATURES: readonly Signature[] = [
  { format: 'png', fragments: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  {
    // RIFF....WEBP. Bytes 4-8 are the file length, so the signature has to skip them:
    // this is the reason a signature is a list of fragments rather than one run. RIFF
    // alone is also WAV and AVI, so matching only the container would swallow both.
    format: 'webp',
    fragments: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
  { format: 'gif', fragments: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }] }, // covers 87a and 89a
  { format: 'tiff', fragments: [{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }] }, // II*. little-endian
  { format: 'tiff', fragments: [{ offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }] }, // MM.* big-endian
  { format: 'jpeg', fragments: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { format: 'bmp', fragments: [{ offset: 0, bytes: [0x42, 0x4d] }] }, // BM. Weak: two bytes.
];

/**
 * Identify a format from its magic bytes, or `undefined` if we cannot read it.
 *
 * Reads only the header, never the pixel data, so it is safe to call on an 8 MB
 * buffer before deciding whether to allocate anything.
 *
 * `undefined` covers both "unknown" and "known but dropped": a HEIC returns
 * `undefined` here, and naming it in the error is feat/decode's job, where the error
 * is built. See features/heic-decision.md.
 */
export function sniff(bytes: Uint8Array): Format | undefined {
  return SIGNATURES.find((signature) =>
    signature.fragments.every((fragment) => matches(bytes, fragment)),
  )?.format;
}

/** True if every byte of the fragment is present at its offset. Short input is a miss. */
function matches(bytes: Uint8Array, { offset, bytes: expected }: Fragment): boolean {
  // Belt and braces: an out-of-range read returns undefined, which fails the compare
  // below anyway. Kept because "a truncated file is not a match" is a real contract,
  // and it should be visible here rather than emerge from a subtlety of the language.
  if (bytes.length < offset + expected.length) return false;

  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}
