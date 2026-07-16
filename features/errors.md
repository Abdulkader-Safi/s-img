# Typed errors

**Milestone 1. Depends on: nothing.**

## What it is

Every failure the library can produce is a named class with a machine-readable `code`, so
the plugin's UI can react to "this file is not an image" differently from "this file is a
WebP and the WASM module failed to load". A bare `throw new Error('bad input')` is never
acceptable in this codebase.

## The shape

```typescript
class SImgError extends Error {
  readonly code: SImgErrorCode;
}

type SImgErrorCode =
  | 'UNSUPPORTED_FORMAT'    // magic bytes matched nothing we can read
  | 'CORRUPT_IMAGE'         // magic bytes matched, the rest did not parse
  | 'FORMAT_MISMATCH'       // header says PNG, extension said JPEG, we trust the header
  | 'INVALID_OPTION'        // crop outside bounds, resize to 0, angle out of range
  | 'IMAGE_TOO_LARGE'       // declared dimensions exceed the decode cap
  | 'CODEC_LOAD_FAILED'     // the WebP WASM module could not be loaded
  | 'ENCODE_FAILED';        // the encoder itself blew up
```

Subclasses carry the context that makes the message actionable, because a UI that says
"invalid crop" is useless and one that says "crop x=900 w=400 exceeds image width 1200" is
not:

```typescript
class UnsupportedFormatError extends SImgError {
  readonly code = 'UNSUPPORTED_FORMAT';
  readonly detectedMagic: string;   // first 12 bytes as hex, for the bug report
}

class InvalidOptionError extends SImgError {
  readonly code = 'INVALID_OPTION';
  readonly option: string;          // 'crop.width'
  readonly value: unknown;
}

class CodecLoadError extends SImgError {
  readonly code = 'CODEC_LOAD_FAILED';
  readonly format: Format;
  readonly cause?: unknown;         // the original dynamic-import rejection
}
```

## Why it matters here specifically

An Obsidian vault is a pile of files a human dragged in over five years. The plugin will
be handed a `.png` that is actually a JPEG, a `.jpg` that is a 40-byte truncated download,
a HEIC from an iPhone, and a `.webp` on a machine where the WASM load is blocked. Each of
those wants a different message in the UI, and none of them should crash the editor. The
error taxonomy is the contract that lets the plugin write that switch statement.

## Rules

- **Throw at the earliest honest point.** Magic-byte validation happens before the decoder
  allocates anything ([decode.md](decode.md)). Option validation happens when the option is
  set on the builder, not when the pipeline runs, so `.crop({ width: -5 })` throws on that
  line and the stack trace points at the caller's mistake.
- **Never swallow a cause.** `CodecLoadError` keeps the original rejection in `cause`.
  Debugging a WASM load failure with the underlying error thrown away is misery.
- **Messages are for humans, `code` is for machines.** The plugin should never string-match
  on `.message`. Every conditional the plugin needs must be expressible on `code` plus the
  subclass fields; if it is not, the taxonomy is missing an entry.
- **The public API only ever throws `SImgError`.** Anything escaping from a codec's guts
  gets caught at the boundary and wrapped. A caller should be able to write
  `catch (e) { if (e instanceof SImgError) ... }` and have that be exhaustive.

## Use cases

- Plugin opens a folder of images, one is corrupt: catch `CORRUPT_IMAGE`, skip that file,
  show which one failed, keep going with the other eleven.
- User drags in a HEIC: `UNSUPPORTED_FORMAT` with `detectedMagic` showing the `ftypheic`
  box, so the plugin can say "HEIC is not supported" rather than "something went wrong".
  See [heic-decision.md](heic-decision.md).
- Batch save-all: one file in the batch throws, the batch reports per-file results rather
  than aborting the other twenty. See [batch-pipeline.md](batch-pipeline.md).

## Edge cases

- **`instanceof` across bundle boundaries.** If the plugin ever ends up with two copies of
  the library bundled, `instanceof` breaks. The `code` field is the reliable check and the
  docs should say so. Not worth a Symbol.hasInstance hack in v1.
- **Error during error.** `detectedMagic` reads the first 12 bytes; on a 3-byte input that
  read must not itself throw. Hex-dump whatever is there.

## Acceptance

- Every `throw` in the codebase throws an `SImgError` subclass. Enforced by an ESLint
  `no-throw-literal` plus a grep in CI for `throw new Error(`.
- A truncated PNG produces `CORRUPT_IMAGE`, not a `RangeError` from a typed array read.
- A text file renamed to `.png` produces `UNSUPPORTED_FORMAT` with the magic bytes attached.
