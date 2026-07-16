// Splice an APP1/EXIF block carrying GPS coordinates into a JPEG.
//
// The privacy case strip-metadata.md is actually about: a photo shared out of a vault with
// the location still in it. Everything else metadata does is a size or hygiene concern;
// this one is a leak.
//
// Hand-built for the same reason as splice.mjs -- ImageMagick cannot write EXIF and
// exiftool is not a dependency. generate.sh makes exifr read the coordinates back before
// the fixture is trusted, so a broken block cannot masquerade as "no GPS found" in the
// very test that is supposed to prove we removed it. That failure mode is the whole risk
// here: a fixture with no GPS in it passes a "no GPS out" test perfectly.
//
// Usage: node splice-gps.mjs <src.jpg> <out.jpg>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out] = process.argv;

// Beirut, 33.8938 N 35.5018 E, as degrees/minutes/seconds rationals.
const LAT = [
  [33, 1],
  [53, 1],
  [3768, 100],
];
const LON = [
  [35, 1],
  [30, 1],
  [648, 100],
];

// One TIFF block. Every offset below is relative to the START of this block (byte 6 of the
// APP1 payload, right after "Exif\0\0"), never to the segment or the file.
//
//   0   TIFF header (8)
//   8   IFD0: count + one entry (GPSInfo) + next-IFD offset  = 2 + 12 + 4 = 18
//   26  GPS IFD: count + four entries + next-IFD offset      = 2 + 48 + 4 = 54
//   80  GPSLatitude rationals  (3 x 8)
//   104 GPSLongitude rationals (3 x 8)
const GPS_IFD = 26;
const LAT_AT = 80;
const LON_AT = 104;
const tiff = new Uint8Array(128);
const v = new DataView(tiff.buffer);

v.setUint16(0, 0x4949, true); // "II", little-endian
v.setUint16(2, 42, true);
v.setUint32(4, 8, true); // IFD0 starts at 8

v.setUint16(8, 1, true); // IFD0: one entry
v.setUint16(10, 0x8825, true); // GPSInfo: a pointer to another IFD, not a value
v.setUint16(12, 4, true); // type LONG
v.setUint32(14, 1, true); // count
v.setUint32(18, GPS_IFD, true); // ...the offset of the GPS IFD
v.setUint32(22, 0, true); // no IFD1

let at = GPS_IFD;
v.setUint16(at, 4, true); // GPS IFD: four entries
at += 2;

/** One 12-byte IFD entry. A RATIONAL never fits the 4-byte field, so it carries an offset. */
const entry = (tag, type, count, value) => {
  v.setUint16(at, tag, true);
  v.setUint16(at + 2, type, true);
  v.setUint32(at + 4, count, true);
  v.setUint32(at + 8, value, true);
  at += 12;
};

entry(0x0001, 2, 2, 0x004e); // GPSLatitudeRef: "N\0", ASCII fits inline
entry(0x0002, 5, 3, LAT_AT); // GPSLatitude: 3 RATIONALs, out of line
entry(0x0003, 2, 2, 0x0045); // GPSLongitudeRef: "E\0"
entry(0x0004, 5, 3, LON_AT); // GPSLongitude
v.setUint32(at, 0, true); // no next IFD

for (const [i, [num, den]] of [...LAT, ...LON].entries()) {
  const base = (i < 3 ? LAT_AT : LON_AT) + (i % 3) * 8;
  v.setUint32(base, num, true);
  v.setUint32(base + 4, den, true);
}

const app1 = new Uint8Array(6 + tiff.length);
app1.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
app1.set(tiff, 6);

const marker = new Uint8Array(4 + app1.length);
marker.set([0xff, 0xe1, ((app1.length + 2) >> 8) & 0xff, (app1.length + 2) & 0xff]);
marker.set(app1, 4);

const jpeg = readFileSync(src);
writeFileSync(out, Buffer.concat([jpeg.subarray(0, 2), marker, jpeg.subarray(2)]));
