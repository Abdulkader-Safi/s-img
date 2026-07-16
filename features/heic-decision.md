# HEIC / HEIF: open question Q1

**Blocker. Needs your call before milestone 5 is planned.**

## The question

The plugin's open-format list includes HEIC. iPhone photos are HEIC by default, so they land
in vaults constantly. Do we support reading them?

## Why it is not just "add another codec"

HEIC is HEVC (H.265) intra-frame coding wrapped in an ISOBMFF container. It is the same
complexity class as AVIF, which was already dropped for exactly this reason. There is no
pure JS HEVC decoder and there will not be one.

So it is WASM or nothing, and the WASM is not WebP-sized:

| Module | Size | Notes |
|---|---|---|
| libwebp (jSquash) | ~200–400 KB | already accepted |
| libheif + libde265 | **~1–2 MB** | 3–5× the entire rest of the library |

That is the whole problem. The project exists to replace a 7 MB ImageMagick bundle because
Obsidian Sync chokes on it. Shipping 2 MB to read iPhone photos spends a big chunk of the
win on one format. Still 3.5× better than ImageMagick, but the headline goes from "10x
smaller" to "3x smaller", and that is the number that justified the whole rewrite.

Licensing is worth a look too: HEVC is patent-encumbered in a way WebP is not. libheif is
LGPL and libde265 is GPL/commercial-dual. For an open-source Obsidian plugin that is
probably navigable, but it is a real question and not one to discover in month three.

## Options

### A. Drop it, like AVIF

`UNSUPPORTED_FORMAT` with a clear message: "HEIC is not supported. Convert to JPEG first."

- **For:** keeps the bundle honest. Zero complexity. Consistent with the AVIF call. macOS
  users can convert in Preview in two clicks, and iOS can be set to "Most Compatible" so it
  shoots JPEG in the first place.
- **Against:** iPhone photos are *the* common case for a phone-to-vault workflow. Users will
  hit this and it will read as a missing feature, not a considered tradeoff.

### B. Second lazy module, opt-in

Same lazy-load pattern as WebP, but the plugin decides whether to bundle it at all.

- **For:** users who need it get it; users who do not never download it. The lazy machinery
  already exists for WebP, so the marginal code is small.
- **Against:** "the plugin decides whether to bundle it" is the hard part. If it is a
  dependency of `safi-image`, npm installs it for everyone and the plugin's bundler has to be
  told to exclude it. If it is a separate optional package (`safi-image-heic`) with a
  registration hook, that is a plugin architecture — real design work, and a second package
  to publish and version.
- **Also against:** the plugin bundles what it bundles. Obsidian users do not choose modules
  at install time. So "opt-in" really means "you, Safi, decide once when you build the
  plugin", which collapses B into A-or-always-2MB unless the plugin downloads the WASM at
  runtime on first HEIC — which means network access from an Obsidian plugin, which is its
  own can of worms (offline vaults, corporate proxies, users who would rather not).

### C. Read-only, and only if it is cheap

Decode HEIC, never encode it. Nobody needs to *write* HEIC — every use case is "get this
iPhone photo into a sensible format". Halves the surface but not the size; libde265's
decoder is most of the megabytes.

## Recommendation

**Option A for v1: drop it, with a specific, helpful error.**

The reasoning:

- The bundle budget is the entire reason this project exists. Spending 2 MB, 13× the pure JS
  core, on one input format contradicts the premise.
- The workaround is genuinely easy and one-time: iOS Settings → Camera → Formats → Most
  Compatible. A user who hits this once fixes it forever at the source.
- Option B's "opt-in" does not really exist in the Obsidian distribution model without
  runtime downloads, which is a worse feature than the problem it solves.
- Dropping it now does not close the door. The lazy-load machinery from
  [codec-webp.md](codec-webp.md) and the `unavailable` reporting in
  [supported-formats.md](supported-formats.md) mean adding HEIC later is a new module and
  a registration, not a refactor. If the bug reports pile up, that is data, and it is cheap
  to act on then.

The error message earns its keep. `UNSUPPORTED_FORMAT` with `detectedMagic` showing the
`ftypheic`/`ftypmif1` box, and text that says HEIC specifically plus how to fix it at the
source. A user who gets "HEIC is not supported — set iOS Camera → Formats → Most Compatible,
or convert in Preview" is helped. One who gets "unsupported format" files an issue.

## What tips it to B

- More than a handful of real users asking.
- Evidence that phone-to-vault is a dominant workflow rather than a plausible one.
- Someone shipping a libheif build meaningfully under 1 MB.

## Your call

- [ ] **A.** Drop it. Clear error naming HEIC and the fix. *(recommended)*
- [ ] **B.** Second lazy module. Needs a decision on how the plugin opts out of the 2 MB.
- [ ] **C.** Read-only. Same size problem, smaller surface.

Until this is ticked, HEIC bytes hit the `UNSUPPORTED_FORMAT` path in
[decode.md](decode.md) by default, which is option A by inaction. That is a fine place to
sit — but the error message is worth writing properly either way, so do that regardless of
what you pick.
