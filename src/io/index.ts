/**
 * The filesystem boundary. The ONLY place `fs` lives.
 * See features/file-io.md.
 *
 * The rule the whole layout exists to enforce: no `fs` anywhere in the pixel code. Not
 * because of Bun/Node portability -- `node:fs` works on both -- but because code that
 * cannot touch the filesystem cannot develop a filesystem-shaped bug, cannot need a mock in
 * a test, and cannot surprise anyone. A browser build swaps this module and nothing else,
 * which is only true if the line exists from day one; bolting it on later means chasing an
 * fs import out of a JPEG decoder.
 *
 * The strongest reason is the plainest: the plugin does not want it anyway. Obsidian reads
 * through the vault API (`vault.readBinary`), not `fs`. A library that reaches for `fs` is
 * useless to its actual consumer, which is why `fromBuffer` is the primary entry and this
 * module is a convenience for everyone else.
 *
 * `scripts/guards.mjs` enforces the line mechanically, and has a test that watches it fail.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { SImg, type SImgChain } from '../core/simg.ts';

/**
 * Start a chain from a file.
 *
 * A missing file throws Node's own ENOENT, unwrapped. This is the one place the "the public
 * API only ever throws SImgError" rule bends, and it bends on purpose: a missing file is not
 * an image error, and Node's message is better than anything we would write over the top of
 * it. This module is a convenience shim, not the library.
 */
export async function fromFile(path: string): Promise<SImgChain> {
  return SImg.fromBuffer(await readFile(path));
}

/**
 * Write encoded bytes to a file.
 *
 * Takes a Uint8Array and hands it straight to writeFile, which accepts one. No conversion
 * anywhere: a core that returned Buffer would drag node:buffer into the pixel code and
 * break the browser story for a convenience nobody asked for. A Node caller who wants
 * Buffer methods can `Buffer.from(result)` with zero copy.
 */
export async function toFile(bytes: Uint8Array, path: string): Promise<void> {
  await writeFile(path, bytes);
}
