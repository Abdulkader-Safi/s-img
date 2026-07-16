/**
 * supportedFormats(): ask the library what it can actually do, right now, in this process.
 * See features/supported-formats.md.
 *
 * Mirrors the plugin's existing `Magick.supportedFormats` call, so the Format panel builds
 * its list from the library's real state rather than a hardcoded array that drifts.
 */

import { isWebpLoaded, webpFailure } from './codecs/webp.ts';
import { FORMATS, type Format } from './formats.ts';

export interface FormatSupport {
  /** Formats that can be decoded, in a stable, documented order. */
  read: Format[];
  /**
   * Formats that can be encoded.
   *
   * A separate array from `read` even though they are identical today, because one day
   * they will not be: HEIC is the plausible case, where decoding is one problem and
   * encoding is a much worse one nobody wants. Collapsing to a single list now would mean
   * a breaking change then.
   */
  write: Format[];
  /** Formats needing a lazy module that has not loaded yet. Safe to ignore entirely. */
  pending: Format[];
  /** Formats whose module load was attempted and failed, and why. */
  unavailable: { format: Format; reason: string }[];
}

/**
 * What this install can do.
 *
 * A function rather than a constant because of WebP: whether it works depends on whether a
 * WASM module loaded, which depends on whether anything touched a WebP, whether
 * `preload('webp')` ran, and whether that load *failed*. A hardcoded array would be wrong
 * in exactly the case the plugin most needs -- WASM blocked, WebP unavailable, and the UI
 * offering it anyway, which is a user picking WebP and getting an error on 30 files.
 *
 * Optimistic by design: WebP is listed until we KNOW it is broken. The honest alternative
 * -- report only what is loaded right now -- is a deadlock made of semantics: the plugin
 * builds its dropdown at startup, sees no WebP, never offers it, so nothing ever triggers
 * the lazy load.
 *
 * Never triggers a load itself, and never awaits one, so a UI can call it freely.
 */
export function supportedFormats(): FormatSupport {
  const failure = webpFailure();

  // Fresh arrays every call: a caller sorting the dropdown in place must not rewrite what
  // the next caller sees.
  const usable = FORMATS.filter((format) => !(format === 'webp' && failure !== undefined));

  return {
    read: [...usable],
    write: [...usable],
    // Pending means nothing has TRIED to load it yet. A load that failed has tried, so it
    // is unavailable rather than pending -- reporting it as both would leave a UI showing
    // "WebP (loading...)" forever.
    pending: isWebpLoaded() ? [] : ['webp'],
    unavailable: failure === undefined ? [] : [{ format: 'webp', reason: failure }],
  };
}
