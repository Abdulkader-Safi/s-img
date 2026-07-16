# File I/O boundary

**Milestone 6. Depends on: [api-surface.md](api-surface.md).**

## What it is

The rule: **no `fs` anywhere in the pixel-processing code.** Only at the edge, only in one
module, and the core never imports it.

```
src/
  core/        <- decode, encode, transforms, codecs. Zero node: imports.
  io/          <- the only place fs lives.
  index.ts     <- exports both
```

## Why the PRD is right to insist

- **Bun and Node parity.** `node:fs` works on both, so this is not about portability
  today. It is about the core staying honest: code that cannot touch the filesystem cannot
  develop a filesystem-shaped bug, cannot need a mock in a test, and cannot surprise anyone.
- **The browser build later.** The PRD's stated non-goal says the core does not change,
  only the I/O layer. That is only true if the line exists from day one. Bolting it on
  afterwards means chasing an `fs` import out of a JPEG decoder, which is exactly the kind
  of retrofit that never quite finishes.
- **Testing.** Every transform test builds a `RawImage` in memory. No fixtures on disk, no
  temp directories, no cleanup, no flake. The codec tests do read fixture files — from the
  *test* code, not from library code.
- **The plugin does not want it anyway.** Obsidian plugins read through the vault API
  (`vault.readBinary`), not `fs`. A library that reaches for `fs` is useless to the actual
  consumer. This is the practical reason and it is the strongest one.

## What `io/` contains

Roughly nothing:

```typescript
async function fromFile(path: string): Promise<SImgChain> {
  return SImg.fromBuffer(await readFile(path));
}

async function toFile(bytes: Uint8Array, path: string): Promise<void> {
  await writeFile(path, bytes);
}
```

That is the whole module. Two functions, a `node:fs/promises` import, no logic.

Which raises the fair question: **why does it exist at all?** The caller could write those
two lines. The answer is that it is convenient for a CLI, a test script, or a Node consumer
who is not the plugin, and it costs ten lines. If it were more than that, it would be a
subpackage or nothing.

The plugin will not use it. It reads through Obsidian's vault API and calls `fromBuffer`.
That is the point of `fromBuffer` being the primary entry.

## Uint8Array, not Buffer

The core returns `Uint8Array` ([encode.md](encode.md)). `Buffer` is a `Uint8Array` subclass,
so a Node caller can `Buffer.from(result)` with zero copy if they need Buffer methods.
Going the other way — a core that returns `Buffer` — drags `node:buffer` into the core and
breaks the browser story for a convenience nobody asked for.

`io/toFile` takes a `Uint8Array` and hands it to `writeFile`, which accepts one. No
conversion anywhere.

## Enforcing it

A grep in CI: no `node:` import under `src/core/`. One line in a test, and it is the thing
that keeps this rule alive after the third contributor. A lint rule
(`no-restricted-imports` scoped to the core path) is nicer if it is free.

Worth checking the same way: `Buffer`, `process`, and `__dirname` should not appear in the
core either. They are all the same mistake wearing different hats.

The exception, and it is a real one: [codec-png.md](codec-png.md) imports `node:zlib`. That
is a `node:` import in the core, deliberately, because writing DEFLATE in TypeScript to
avoid it would be absurd. So the rule is "no `fs`", plus "zlib is the one allowed exception,
and it is the thing the browser build would have to swap for `CompressionStream`". Write
that in the lint rule's comment, not just here.

## Use cases

- A CLI or a script: `fromFile` / `toFile`.
- The plugin: neither. `fromBuffer`, always.
- Tests: in-memory everywhere except the codec fixture tests.
- A future browser build: swap `io/`, swap zlib for `CompressionStream`, done — if the line
  held.

## Edge cases

- **`fromFile` on a missing file.** Let `fs`'s `ENOENT` through. Do not wrap it in an
  `SImgError`; it is not an image error, and Node's error is better than anything we would
  write. This is the one place the "public API only throws `SImgError`" rule bends, and it
  bends because `io/` is a convenience shim, not the library.
- **Huge files.** `readFile` loads the whole thing. Streaming decode is not a thing here
  (every codec needs the whole buffer anyway). Fine.
- **Path traversal, permissions.** The caller's problem. We do not sanitise paths; a library
  that second-guesses the path its caller passed is worse than one that does not.

## Acceptance

- `grep -rE "from ['\"]node:(fs|path|os)" src/core/` returns nothing. In CI.
- The core imports exactly one `node:` module, `zlib`, in exactly one file.
- Every transform test runs with no filesystem access.
- `fromFile('x.png').crop(...).toBuffer()` works on Node and on Bun.
- `Buffer.from(result)` on the output is zero-copy (same underlying `ArrayBuffer`).
