// Splice a minimal APP1/EXIF block carrying only an Orientation tag into a JPEG.
//
// Hand-built deliberately. ImageMagick's `-orient` writes NOTHING when the source has no
// EXIF profile -- it tracks the value as an internal property and drops it on write, so
// `magick in.png -orient RightTop out.jpg` produces a file with no tag at all and no
// warning. exiftool would do it, but it is not a dependency worth taking for one tag.
//
// The fixture is still validated by an independent reader rather than trusted: generate.sh
// asserts ImageMagick reads back the tag this writes, and then uses ImageMagick's OWN
// -auto-orient to produce the expected pixels. So our EXIF reader is never checked against
// our EXIF writer.
//
// Usage: node splice.mjs <src.jpg> <out.jpg> <orientation 1-8> [MM]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out, value, endian] = process.argv;
const le = endian !== 'MM';

// "Exif\0\0" (6) + TIFF header (8) + entry count (2) + one 12-byte entry + the 4-byte
// next-IFD offset = 32. The first attempt allocated 26 and silently truncated the entry's
// value field; ImageMagick then read no tag at all, which is what caught it.
const app1 = new Uint8Array(32);
const view = new DataView(app1.buffer);
app1.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"

// The TIFF header starts at 6, and every offset stored below is relative to THERE, not to
// the start of the segment. That +6 is the most common way to write a broken EXIF.
view.setUint16(6, le ? 0x4949 : 0x4d4d, le); // byte order: "II" or "MM"
view.setUint16(8, 42, le); // the TIFF magic
view.setUint32(10, 8, le); // IFD0 sits 8 bytes into the TIFF block, i.e. immediately

view.setUint16(14, 1, le); // one entry
view.setUint16(16, 0x0112, le); // tag: Orientation
view.setUint16(18, 3, le); // type: SHORT
view.setUint32(20, 1, le); // count: 1
view.setUint16(24, Number(value), le); // the value, inline: a SHORT fits the 4-byte field
// 26-27: the unused rest of the value field. 28-31: next-IFD offset, 0 = no IFD1.

const marker = new Uint8Array(4 + app1.length);
marker.set([0xff, 0xe1, ((app1.length + 2) >> 8) & 0xff, (app1.length + 2) & 0xff]);
marker.set(app1, 4);

// After SOI, before everything else.
const jpeg = readFileSync(src);
writeFileSync(out, Buffer.concat([jpeg.subarray(0, 2), marker, jpeg.subarray(2)]));
