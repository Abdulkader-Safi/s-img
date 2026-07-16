# supportedFormats()

**Milestone 5. Depends on: [codec-webp.md](codec-webp.md).**

## What it is

Ask the library what it can actually do, right now, in this process.

```typescript
function supportedFormats(): { read: Format[]; write: Format[] };
```

Mirrors the plugin's existing `Magick.supportedFormats` call, so the Format panel builds its
list from the library's real state instead of a hardcoded array that drifts.

## Why it is not a constant

Five of the six formats are always there — they are pure JS, statically imported, and if
they are missing the bundle is broken. WebP is the reason this is a function: it depends on
whether a WASM module has loaded, which depends on whether anything touched a WebP file, or
whether `preload('webp')` was called, or whether the load *failed*.

So the honest answer changes over the process lifetime, and a hardcoded array would be wrong
in exactly the case the plugin most needs to handle: WASM blocked, WebP unavailable, and the
UI offering it anyway. That is a user picking WebP, hitting save, and getting an error on
30 files.

## The tricky bit: what does it report before WebP loads?

Three possible semantics:

1. **"What is loaded right now."** WebP is absent until something loads it. Honest but
   useless: the plugin calls this at startup to build its Format dropdown, gets no WebP,
   and never offers it — so nothing ever triggers the lazy load. A deadlock made of
   semantics.
2. **"What could work if asked."** WebP is always listed unless a load has been attempted
   and failed. Useful, slightly optimistic.
3. **Report the state explicitly** and let the caller decide.

**Take option 2, with option 3's information available.** The plugin's real question is
"should I show this in the dropdown", and the answer is yes-unless-we-know-it-is-broken:

```typescript
interface FormatSupport {
  read: Format[];
  write: Format[];
  /** Formats that need a lazy module which has not loaded yet. */
  pending: Format[];
  /** Formats whose module load was attempted and failed, with why. */
  unavailable: { format: Format; reason: string }[];
}
```

WebP starts in `pending` **and** in `read`/`write`. If its load fails, it moves to
`unavailable` and drops out of `read`/`write`, and a plugin that re-reads this after an
error gets an accurate picture and can grey the option out. The plugin can ignore `pending`
entirely and still be correct; it is there for a UI that wants to show "WebP (loading…)".

This shape only becomes more useful if [heic-decision.md](heic-decision.md) lands as a
second optional module, which is an argument for building it now.

## Use cases

- The plugin's Format panel builds its dropdown at startup.
- After a `CODEC_LOAD_FAILED`, the plugin re-reads and greys out WebP with the reason in a
  tooltip.
- A batch job checks the target format is writable before starting 200 files rather than
  failing on file 1.
- Debug output in a bug report: "here is what your install can actually do."

## Edge cases

- **Read and write differ.** Not today (all six are both), but the type must allow it,
  because HEIC would plausibly be read-only (decoding HEIC is one problem, encoding it is
  a much worse one nobody wants). Do not collapse to a single array.
- **Called during a load.** WebP is in `pending` and in `read`/`write`. Fine.
- **Called after a failed load, then the load somehow succeeds later.** Does not happen —
  the memoised promise in [codec-webp.md](codec-webp.md) caches the rejection too, so a
  failure is permanent for the process. Which is the right call: retrying a failed WASM
  instantiation 30 times during a batch is worse than failing once.
- **Order.** Return in a stable, documented order so the plugin's dropdown does not shuffle
  between calls.

## Acceptance

- Returns all six in `read` and `write` on a fresh process, with `webp` also in `pending`.
- After a successful WebP load, `webp` leaves `pending` and stays in `read`/`write`.
- After a simulated failed load, `webp` is in `unavailable` with a readable reason and is
  gone from `read` and `write`.
- The five pure JS formats are never in `pending` and never in `unavailable`.
- The returned arrays are stable across calls and mutating them does not affect the library.
