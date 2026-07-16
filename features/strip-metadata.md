# stripMetadata()

**Milestone 4. Depends on: every codec's encoder.**

## What it is

Drop EXIF, GPS and embedded colour profiles from the encoded output.

```typescript
stripMetadata(): this;
```

No options. It is on or it is not.

## The thing to understand about this feature

**In this library's architecture, stripping is already the default and this method is
almost a no-op.**

The reason is [decode.md](decode.md): decode throws away everything that is not pixels.
`RawImage` has three fields and none of them is metadata. So by the time any encoder runs,
there is no EXIF to write, no GPS, no ICC — they stopped existing at the decode boundary.
Every encoder in this library writes the minimum legal tag set and nothing more, and each
codec file says so explicitly.

That makes this feature mostly a *guarantee to keep true*, not a code path to build. The
tests are the deliverable: encode every format, parse the output with an independent EXIF
reader, assert nothing is there.

## Then why does the method exist

Three reasons, and they are enough:

1. **It is the plugin's existing UI control.** There is a "strip metadata" toggle. The
   library needs to accept the call, or the plugin has to explain why the toggle does
   nothing.
2. **It is a promise in the public API.** "Metadata is stripped" being a documented method
   with a test suite behind it is a stronger contract than "our decoder happens to drop it".
   The moment someone adds ICC preservation for colour management, this method's tests are
   what stop the strip path silently disappearing.
3. **It is where the orientation subtlety gets written down.** See below.

If we ever add metadata preservation (see "if this changes"), this method becomes the thing
that turns it off, and the API will not have to change to accommodate it. That is worth one
method today.

## EXIF orientation, the one that matters

An iPhone JPEG stores landscape pixels plus an orientation tag saying "rotate 90 CW". Two
possible behaviours:

- Ignore the tag on decode, drop it on encode → **every phone photo saves out sideways.**
  Catastrophic, and it would be blamed on the strip feature.
- Apply the tag on decode, then drop it → the pixels are physically upright and the tag is
  no longer needed. Correct.

We do the second. Decode applies orientation, encode writes no orientation tag, and the
result is an image that is upright in every viewer including the ones that ignore EXIF.
That means stripping metadata **cannot** rotate the user's photo, which is the classic
failure mode of naive strip tools. This is the single most important sentence in this file.

## Per format

- **JPEG:** EXIF lives in `APP1`, ICC in `APP2`, XMP in another `APP1`, comments in `COM`,
  and a Photoshop thumbnail in `APP13`. The encoder writes `APP0` (JFIF) and nothing else,
  so all of it is gone by construction.
- **TIFF:** EXIF is an IFD referenced by tag 34665, GPS by 34853, ICC by 34675. The encoder
  writes ~10 tags and none of those are on the list.
- **PNG:** `tEXt`, `iTXt`, `zTXt` for text; `eXIf` for EXIF; `iCCP` for the profile. The
  encoder writes `IHDR`, `IDAT`, `IEND`. Nothing else.
- **WebP:** `EXIF` and `ICCP` chunks in the RIFF container. The WASM encoder is configured
  to emit neither. **Verify this** — it is the one codec where we are not writing the bytes
  ourselves, so the guarantee is an assumption about libwebp's config until a test proves
  it. See [codec-webp.md](codec-webp.md).
- **GIF:** no EXIF concept. Comment extensions exist; we write none.
- **BMP:** no metadata concept at all.

## Use cases

- **Privacy.** GPS coordinates in a photo shared out of a vault is the real risk here. A
  screenshot of a note with an embedded location is a genuine leak.
- **Size.** An EXIF block plus a thumbnail plus an ICC profile can be 50–100 KB. On a small
  image that is most of the file.
- **Sync hygiene.** Smaller files, fewer bytes through Obsidian Sync, which is the whole
  point of this project.

## If this ever changes

Preserving metadata would mean `RawImage` grows a `metadata` field, or decode returns
`{ image, metadata }`, and every encoder learns to write it back. That is a real design
change, and this file is the marker for where the decision lives. Two things would force it:
colour-managed workflows needing ICC round-trips, or users complaining that their photo's
capture date vanished. Neither is a v1 concern, and the second is arguably a feature.

## Edge cases

- **A JPEG whose EXIF is corrupt.** We read only the orientation tag; if that read fails,
  assume orientation 1 and carry on. Never fail a decode over metadata we are about to
  throw away.
- **Orientation values 2, 4, 5, 7** are the mirrored ones (flip plus rotate). They are rare
  but they exist and they are the ones everybody gets wrong because they cannot be tested by
  looking at a photo of a landscape. Fixture all 8 values. There is a standard test-image
  set for exactly this; use it.
- **ICC-tagged wide-gamut photos** (Display P3 from a modern iPhone). Dropping the profile
  means the numbers get reinterpreted as sRGB and saturated colours shift visibly. This is a
  real, if niche, quality loss and it is inherent to not being colour-managed. Document it.

## Acceptance

- For every format: encode an image, parse the output with an independent EXIF/metadata
  library, assert zero tags.
- A JPEG with GPS in, no GPS out.
- All 8 EXIF orientation values decode to correctly-oriented pixels. The mirrored ones
  (2, 4, 5, 7) are the ones that catch the bug.
- Output file size for a small image is not inflated by any metadata block.
- Calling `stripMetadata()` and not calling it produce byte-identical output today. When
  that assertion starts failing, someone has added metadata preservation and this file needs
  rewriting.
