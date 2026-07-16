# Swap into the Obsidian plugin

**Milestone 7. Depends on: everything. This is the only milestone that proves the project
worked.**

## What it is

Replace ImageMagick with `s-img` in the plugin, and confirm Obsidian Sync works end to end.

Every other milestone is a means to this. A library that hits every budget and passes every
test and does not actually run inside the plugin has achieved nothing.

## The success criterion

**A user with Obsidian Sync enabled can install the plugin and it syncs.**

That is it. Not "the bundle is 140 KB", not "the tests pass". Those are proxies. The
deliverable is a plugin that Sync does not choke on, and it is not verified until a real
vault with Sync on has synced it to a second device.

## The work

1. **Delete the ImageMagick bundle and its loader.** The 7 MB WASM, the init code, the
   `Magick.read`/`Magick.write` calls, the format probing.
2. **Rewire the editor's apply path.** The plugin builds a chain or a `PipelineSpec` from
   its UI state and calls `toBuffer()`. The canonical order
   ([pipeline-order.md](pipeline-order.md)) matches what the plugin already does, so if the
   plugin currently sorts its own operations before calling ImageMagick, **that sort can be
   deleted.** Deleting it is part of the deliverable: two places enforcing the same order is
   two places to drift.
3. **Rewire the preview path.** `decode(bytes, {hintMaxLongEdge: 1600})` on open, transform
   per frame, canvas. `RawImage.data` goes straight into `ImageData` with no conversion
   ([raw-image.md](raw-image.md)) — verify that is actually true and not a wishful sentence
   in a spec.
4. **Rewire the Format panel** to `supportedFormats()` ([supported-formats.md](supported-formats.md)).
5. **Rewire save-all** to one `Pipeline` over N files ([batch-pipeline.md](batch-pipeline.md)),
   with the plugin owning the loop, the progress bar, and the per-file error policy.
6. **Presets** become `PipelineSpec` objects in the settings file. Existing presets need a
   migration — the old format is whatever the plugin stores today, and users have them.
   **Do not drop them silently.** This is a small job that will be discovered late if it is
   not written down now.
7. **Measure the real bundle** ([bundle-size.md](bundle-size.md)).
8. **Test Sync on a real vault, on two devices.**

## What will go wrong

Guessing in advance, because these are the ones worth a spike rather than a surprise:

- **The WebP dynamic import versus esbuild.** Obsidian plugins bundle to one file. A dynamic
  `import()` either becomes a real chunk (needs the `.wasm` and the chunk to be findable at
  runtime, from a plugin directory, with no server) or gets inlined (300 KB in the core,
  budget blown). This is flagged in [codec-webp.md](codec-webp.md) as the milestone-5 spike
  and it is the single most likely thing to derail milestone 7. **Do the spike in milestone
  5, not here.**
- **`node:zlib` in an Obsidian plugin.** Obsidian is Electron, so Node builtins are there —
  but the plugin runs in a renderer with `nodeIntegration` in a configuration that is
  Obsidian's business, not ours. If `zlib` is not reachable, PNG needs `CompressionStream`
  instead, which is a real fallback and a real chunk of work. **Verify this in milestone 1**,
  the day PNG encode first works. It is a five-minute check that de-risks the entire
  project, and finding out in milestone 7 would be brutal.
- **Progressive JPEG.** If it is still unimplemented ([codec-jpeg.md](codec-jpeg.md)), a
  real vault will find one within a day. Close it before this milestone.
- **Performance on a real 12MP photo** on a real laptop, not a benchmark on a dev machine.
- **A vault full of files we have never seen.** Weird TIFFs, CMYK JPEGs, animated GIFs,
  HEICs, a `.png` that is a JPEG, a 0-byte file someone's sync mangled. Every one is a
  documented edge case in some file here; the vault is where the documentation gets graded.

## The comparison to run

Before and after, same inputs, same settings:

| | ImageMagick | s-img |
|---|---|---|
| Bundle size | 7 MB | ? |
| Sync works | no | **must be yes** |
| Preview responsiveness | stutters | ? |
| Full-res rotate | ~260ms | ? |
| Output size at quality 80 | baseline | within ~10%? |
| Output visual quality | baseline | indistinguishable? |

**Output quality against ImageMagick is the acceptance test nobody thinks to run.** A pure
JS JPEG encoder that produces 30% larger files at the same quality number, or visibly
different colours, is a regression the user will feel even though every unit test passes.
Run a real photo through both at quality 80 and compare bytes and pixels. If the quant table
scaling is wrong ([codec-jpeg.md](codec-jpeg.md)), this is where it shows.

## Use cases

- The plugin ships and Sync users can finally use it. The point.
- The library gets its first real user and its first real bug reports.
- The README gets a real number for the size claim instead of a target.

## Edge cases

- **Users mid-upgrade** with old presets. Migration, see above.
- **A format ImageMagick read and we do not.** HEIC, mainly
  ([heic-decision.md](heic-decision.md)). Someone's workflow breaks. Whether that is
  acceptable is the Q1 decision, and this is where it gets tested against a real person.
- **A format ImageMagick wrote and we do not.** Check the plugin's current write list
  against ours before starting. If there is anything on it we dropped, that is a
  conversation, not a surprise.
- **Rollback.** If Sync still struggles for some unrelated reason, keep the ImageMagick
  branch alive until the new one is confirmed on two devices.

## Acceptance

- The plugin builds with no ImageMagick, and the 7 MB WASM is gone from the repo.
- Every editor control works: crop, rotate (both kinds), flip, resize, format, quality,
  strip metadata, presets, save-all.
- The plugin's own operation-ordering code is deleted, not left dead.
- Preview is responsive on a 12MP photo.
- Old presets migrate.
- Output at quality 80 is within ~10% of ImageMagick's size and visually indistinguishable.
- **A real vault with Sync enabled syncs the plugin to a second device.** Nothing else in
  this document counts until this line is ticked.
