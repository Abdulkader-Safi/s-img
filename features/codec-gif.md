# GIF codec

**Milestone 4. Depends on: [decode.md](decode.md), [encode.md](encode.md).**

## What it is

Read and write GIF, **static frames only**. Prior art: omggif (decode), gifenc (encode).

The interesting part of GIF is not the container, it is that GIF is a 256-colour format.
Encoding to GIF from an RGBA buffer means quantisation, and quantisation is a real
algorithm with real quality consequences. That is where the work is.

## Decode

1. Header: `GIF87a` or `GIF89a`.
2. Logical screen descriptor: dimensions, global colour table flag and size, background
   index. **Size guard** here.
3. Global colour table, if present.
4. Blocks until the trailer: image descriptors (`0x2C`), extensions (`0x21`), trailer
   (`0x3B`). Graphic control extensions carry the transparent colour index and the frame
   delay; the transparency one we need, the delay we do not.
5. First image descriptor: frame position, size, local colour table flag, interlace flag.
6. LZW-decompress the frame's index stream, map indices through the colour table to RGBA,
   apply the transparent index as alpha 0.

**Animated GIFs:** decode frame 0, ignore the rest, do not throw. An animated GIF in a
vault is usually a meme, and "decode the first frame" is a far better outcome than an error.
Document the loss. Animated GIF support is a stretch goal in the PRD, not v1, and it would
need the whole frame-disposal state machine (`disposalMethod` 0–3, per-frame offsets,
compositing onto the previous canvas), which is a feature, not a tweak.

**Interlaced GIF:** rows come in 4 passes. Handle it; it is 10 lines and it exists in old
files.

## Encode

The pipeline:

1. **Quantise** RGBA down to ≤256 colours.
2. **Dither** (optional, see below).
3. **LZW-compress** the index stream.
4. Write header, logical screen descriptor, global colour table, one image descriptor,
   the compressed data, trailer. Plus a graphic control extension iff the image has
   transparency.

### Quantisation, the real decision

Options, worst to best:

- **Uniform / web-safe palette.** Fixed 6×6×6 cube. Terrible on photos, banding
  everywhere. Free.
- **Median cut.** The classic. Recursively split the colour cube along its longest axis at
  the median until you have 256 boxes, average each box. Well-understood, maybe 60 lines,
  good results.
- **Octree.** Similar quality, streaming, a bit more code.
- **NeuQuant.** A neural net from 1994, what gifsicle and friends use, best quality,
  meaningfully slower and much more code.

**Median cut.** It is the smallest thing that produces a result nobody complains about, and
GIF is not a format anyone in this plugin's audience is optimising hard. Note NeuQuant as
the upgrade path if a real complaint arrives.

### Dithering

Without dithering, a photo quantised to 256 colours has visible banding on any gradient —
skies are the giveaway. Floyd-Steinberg error diffusion fixes it for about 30 lines and one
extra buffer.

Ship **Floyd-Steinberg on by default with an option to disable**. Disable matters for line
art and screenshots, where dithering adds noise to what would otherwise be flat, perfectly
representable colour regions and *increases* the file size.

### Transparency

GIF alpha is one bit: an index in the palette is either the transparent one or it is not.
So the encoder thresholds: alpha < 128 → transparent index, else opaque, snapped to the
nearest palette colour. Semi-transparent pixels cannot survive. Document it — a rotated PNG
with a soft anti-aliased edge converted to GIF will get a hard jagged edge, and that is
inherent to the format, not a bug in this code.

Reserving a palette entry for transparency costs one of the 256.

### LZW

GIF's LZW is its own dialect: variable code width starting at `minCodeSize + 1`, explicit
clear and end codes, a 4095-entry table that must be reset when it fills, and the whole
stream chopped into sub-blocks of ≤255 bytes. Each of those details is a way to produce a
file that opens in one viewer and not another. Follow gifenc's structure.

No quality option (`quality` is a lossy-format thing and GIF's loss is quantisation, not a
dial). `.toFormat('gif', { quality })` is a compile error. Dithering and palette size are
GIF-specific options ([type-safety.md](type-safety.md) covers how those are typed).

## Use cases

- Reading a GIF from a vault and converting it to PNG or WebP. Probably the dominant use.
- Small line-art or screenshot output where 256 colours is genuinely enough and the file
  is tiny.
- Honestly: WebP beats GIF at everything except universal compatibility. GIF is here for
  completeness and read-side compatibility.

## Edge cases

- **Images with ≤256 colours already.** Median cut should return the exact palette and the
  round-trip should be lossless. Worth asserting: it is the test that proves the quantiser
  is not mangling colours it did not need to touch.
- **Frame smaller than the logical screen.** The image descriptor has its own x/y/w/h.
  Composite onto the logical screen at the offset, or crop to the frame. Use the *logical
  screen* size as the image size and place the frame in it — that is what the file means.
- **No global colour table, only local.** Legal. Use the local one.
- **An empty / 0-colour palette.** Corrupt. Throw.
- **Interlaced.** 4-pass row order. Fixture it.
- **A GIF over 256 colours across multiple local palettes** (a real trick for
  pseudo-truecolour GIFs): we decode frame 0 only, so we see one palette. Fine, documented.

## Acceptance

- Decodes 87a and 89a fixtures, interlaced and not, with and without transparency.
- An animated GIF decodes frame 0 with no error.
- Encode → decode of an image with ≤256 unique colours is byte-exact (the "do not mangle
  what fits" test).
- A photo quantised with dithering shows no banding on a gradient; with dithering off, it
  does. Both assertions, so the option provably does something.
- Output opens correctly in a browser and in Preview. Manual, once, but do it — LZW
  sub-block bugs pass unit tests and fail real viewers.
- Semi-transparent input produces hard-edged one-bit transparency, documented, not an error.
