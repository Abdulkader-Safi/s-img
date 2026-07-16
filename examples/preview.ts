// The two-pass preview design, which is the reason this library exists.
//
//   npm run example:preview
//
// The PRD measured a ~260ms full-resolution rotate causing visible stutter while dragging a
// slider. features/fast-decode.md's answer is not "make the rotate faster" -- it is to stop
// doing it at full resolution 60 times a second:
//
//   1. On open:            decode once, small. Hold it.
//   2. On every interaction: transform THAT. No re-decode. No encode.
//   3. On save:            decode at full resolution, apply the same spec, encode.
//
// Step 2 never encodes. A preview that re-encodes a JPEG every frame would be slower than
// the problem it is fixing.
//
// This script runs that loop and prints real timings. Not a test -- a demonstration you can
// watch, on a 12MP photo, on your own machine.

import { mkdir, writeFile } from "node:fs/promises";

import {
  SImg,
  createImage,
  decode,
  encode,
  probe,
  type PipelineSpec,
} from "../src/index.ts";
import { crop } from "../src/core/transform/crop.ts";
import { rotate } from "../src/core/transform/rotate.ts";

const OUT = new URL("output/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const ms = (n: number): string => `${n.toFixed(0).padStart(4)}ms`;
const heading = (text: string): void => console.log(`\n\x1b[1m${text}\x1b[0m`);

// --- a 12MP photo, the PRD's subject ----------------------------------------------------

heading("Setting up a 12MP photo");
const W = 4000;
const H = 3000;
const img = createImage(W, H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const at = (y * W + x) * 4;
    img.data[at] = 30 + (x / W) * 200;
    img.data[at + 1] =
      60 + Math.sin(x / 300) * Math.cos(y / 240) * 90 + (y / H) * 90;
    img.data[at + 2] = 170 - (y / H) * 120;
    img.data[at + 3] = 255;
  }
}
const source = await encode(img, "jpeg", { quality: 85 });
await writeFile(`${OUT}big.jpg`, source);
console.log(`  ${W}x${H}, ${(source.length / 1e6).toFixed(1)} MB on disk`);

// --- 1. on open -------------------------------------------------------------------------

heading("1. On open: decode a preview, once");

// probe() costs nothing and tells you the truth about the source. You need it to map a
// rectangle the user drew on the preview back onto the full-resolution image.
let started = performance.now();
const real = probe(source);
console.log(
  `  probe()                    ${ms(performance.now() - started)}  ${real.width}x${real.height}, no pixels decoded`,
);

started = performance.now();
const preview = await decode(source, { hintMaxLongEdge: 1600 });
const previewMs = performance.now() - started;
console.log(
  `  decode(hintMaxLongEdge)    ${ms(previewMs)}  ${preview.width}x${preview.height}`,
);

started = performance.now();
const full = await decode(source);
console.log(
  `  decode() full resolution   ${ms(performance.now() - started)}  ${full.width}x${full.height}`,
);

// 1000, not 1600. JPEG's DCT scales by powers of two, so 1/2 would be 2000 -- over the cap
// -- and 1/4 it is. THIS is why you never assume the scale is `hint / longEdge`: it would
// be 2.5 here, and the real answer is 4. Read the dimensions off the result, always.
const scale = real.width / preview.width;
console.log(
  `\n  the scale is ${scale} (${real.width} / ${preview.width}), NOT ${(real.width / 1600).toFixed(2)} (${real.width} / 1600)`,
);
console.log(
  `  assume the second and every crop is off by ${(scale / (real.width / 1600)).toFixed(1)}x. Read it off the result.`,
);

// --- 2. per interaction -----------------------------------------------------------------

heading("2. On every interaction: transform the preview");

// The user drags a rotate slider. Each frame: transform the already-decoded preview and
// push the pixels at a canvas. Nothing is decoded and nothing is encoded.
const drawn = { x: 120, y: 90, width: 700, height: 520 }; // in PREVIEW coordinates
const frames: number[] = [];
for (const angle of [2, 5, 8, 11, 14, 17, 20, 23]) {
  started = performance.now();
  rotate(crop(preview, drawn), angle, { resampling: "bilinear" });
  frames.push(performance.now() - started);
}
const slowest = Math.max(...frames);
const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
console.log(
  `  8 frames of crop + rotate: mean ${ms(mean)}, worst ${ms(slowest)}`,
);

// The same work at full resolution, which is what the PRD measured as a stutter.
started = performance.now();
rotate(
  crop(full, {
    x: drawn.x * scale,
    y: drawn.y * scale,
    width: drawn.width * scale,
    height: drawn.height * scale,
  }),
  20,
  { resampling: "bilinear" },
);
const fullMs = performance.now() - started;
console.log(`  the same frame, full res:  ${ms(fullMs)}`);
console.log(
  `\n  ${(fullMs / mean).toFixed(0)}x cheaper. ${slowest < 16 ? "Inside a 16ms frame: the slider is smooth." : slowest < 33 ? "Inside 33ms: 30fps." : "Over budget."}`,
);

// --- 3. on save -------------------------------------------------------------------------

heading("3. On save: the same spec, at full resolution");

// The spec is one JSON object. The preview used it; the save uses it. That is the whole
// trick -- there is no second code path to drift out of sync with the first.
const spec: PipelineSpec = SImg.pipeline()
  .crop({
    x: drawn.x * scale,
    y: drawn.y * scale,
    width: drawn.width * scale,
    height: drawn.height * scale,
  })
  .rotate(20)
  .background([255, 255, 255, 255])
  .toFormat("jpeg", { quality: 88 })
  .toJSON();

started = performance.now();
const saved = await SImg.pipeline(spec).run(source);
console.log(
  `  decode + transform + encode ${ms(performance.now() - started)}  — once, when the user hits save. Nobody notices.`,
);
await writeFile(`${OUT}saved.jpg`, saved);
const out = await decode(saved);
console.log(
  `  saved.jpg                   ${out.width}x${out.height}, ${(saved.length / 1024).toFixed(0)} KB`,
);

// And the proof the coordinates survived the round trip: the preview's own version of the
// same edit, from the same rectangle, scaled.
const previewOut = await SImg.pipeline({ ...spec, crop: drawn }).run(
  await encode(preview, "jpeg", { quality: 88 }),
);
await writeFile(`${OUT}saved-preview.jpg`, previewOut);
const pv = await decode(previewOut);
console.log(
  `  saved-preview.jpg           ${pv.width}x${pv.height}, the same edit at preview scale`,
);
console.log(
  `\n  ratio ${(out.width / pv.width).toFixed(2)} vs the scale ${scale} — the same region, ${scale}x bigger.`,
);
console.log("  Open both. They are the same picture.\n");
