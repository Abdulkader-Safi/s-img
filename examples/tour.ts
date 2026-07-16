// A tour of safi-image, as a consumer would actually use it.
//
//   npm run example
//
// Not a test. Nothing here asserts; it does real work on a real photo and writes real files
// into examples/output/ for you to open and look at. features/index.md asks for "a real
// script under examples/ that exercises it end to end the way a consumer would... something
// you can actually run and watch work, separate from the test suite."
//
// Read it top to bottom: it is also the shortest honest documentation of the API.

import { mkdir, writeFile } from "node:fs/promises";

import {
  SImg,
  decode,
  encode,
  probe,
  supportedFormats,
  fromFile,
  toFile,
  createImage,
  SImgError,
  UnsupportedFormatError,
  type PipelineSpec,
} from "../src/index.ts";

const OUT = new URL("output/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const heading = (text: string): void => console.log(`\n\x1b[1m${text}\x1b[0m`);
const done = (file: string, note: string): void =>
  console.log(`  \x1b[32m✓\x1b[0m ${file.padEnd(28)} ${note}`);

// ---------------------------------------------------------------------------------------
heading("What can this build actually do?");

// Worth calling at startup rather than assuming: WebP arrives via a lazily-loaded WASM, so
// it can be genuinely unavailable in a way PNG never is.
const support = supportedFormats();
console.log(`  read:    ${support.read.join(", ")}`);
console.log(`  write:   ${support.write.join(", ")}`);
console.log(
  `  pending: ${support.pending.join(", ") || "(none)"}   — loads on first use`,
);

// ---------------------------------------------------------------------------------------
heading("Make a source image");

// Every other example needs a photo. Building one keeps this script self-contained.
const WIDTH = 1200;
const HEIGHT = 800;
const photo = createImage(WIDTH, HEIGHT);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const at = (y * WIDTH + x) * 4;
    const wave = Math.sin(x / 90) * Math.cos(y / 70);
    photo.data[at] = 40 + wave * 60 + (x / WIDTH) * 150;
    photo.data[at + 1] = 90 + (y / HEIGHT) * 120;
    photo.data[at + 2] = 150 - wave * 70;
    photo.data[at + 3] = 255;
  }
}
const source = await encode(photo, "jpeg", { quality: 90 });
await writeFile(`${OUT}source.jpg`, source);
done(
  "source.jpg",
  `${WIDTH}x${HEIGHT}, ${(source.length / 1024).toFixed(0)} KB`,
);

// ---------------------------------------------------------------------------------------
heading("Read the size without decoding");

// Microseconds, no pixel buffer. This is how you scale a crop rectangle from a preview back
// to source coordinates without decoding twice.
console.log(`  probe():  ${JSON.stringify(probe(source))}`);

// ---------------------------------------------------------------------------------------
heading("The chain");

// Order is canonical and does NOT depend on the order you call the methods:
// crop -> rotate -> flip -> resize -> format. Say what you want; the library sequences it.
const thumb = await SImg.fromBuffer(source)
  .crop({ x: 200, y: 100, width: 800, height: 600 })
  .rotate(8, { resampling: "lanczos3" })
  .maxLongEdge(400)
  .background([255, 255, 255, 255]) // the corners rotation exposes, and JPEG has no alpha
  .toFormat("jpeg", { quality: 80 })
  .toBuffer();

await writeFile(`${OUT}thumb.jpg`, thumb);
const t = await decode(thumb);
done(
  "thumb.jpg",
  `${t.width}x${t.height}, cropped + rotated 8° + capped at 400px`,
);

// ---------------------------------------------------------------------------------------
heading("Convert between formats");

for (const format of ["png", "webp", "gif", "bmp", "tiff"] as const) {
  const bytes = await SImg.fromBuffer(source)
    .maxLongEdge(200)
    .toFormat(format)
    .toBuffer();
  await writeFile(`${OUT}converted.${format}`, bytes);
  done(`converted.${format}`, `${(bytes.length / 1024).toFixed(1)} KB`);
}

// WebP twice, because the difference is the whole reason to choose it.
const lossy = await SImg.fromBuffer(source)
  .toFormat("webp", { quality: 60 })
  .toBuffer();
const lossless = await SImg.fromBuffer(source)
  .toFormat("webp", { lossless: true })
  .toBuffer();
console.log(`  webp q60:     ${(lossy.length / 1024).toFixed(1)} KB`);
console.log(
  `  webp lossless ${(lossless.length / 1024).toFixed(1)} KB  — ${(lossless.length / lossy.length).toFixed(1)}x bigger`,
);

// ---------------------------------------------------------------------------------------
heading("A pipeline you can store and replay");

// The point: a chain is one image, a pipeline is a RECIPE. It is plain JSON, so it survives
// a settings file, and the same object drives the preview and the full-resolution save.
const preset = SImg.pipeline()
  .maxLongEdge(600)
  .stripMetadata()
  .toFormat("jpeg", { quality: 75 });

const spec: PipelineSpec = preset.toJSON();
await writeFile(`${OUT}preset.json`, JSON.stringify(spec, null, 2));
done("preset.json", "JSON: store it in settings, ship it to another machine");

// Round-tripped through JSON, exactly as a settings file would, then applied to two images.
const restored = SImg.pipeline(
  JSON.parse(await readText(`${OUT}preset.json`)) as PipelineSpec,
);
for (const [i, bytes] of [source, lossless].entries()) {
  const out = await restored.run(bytes);
  await writeFile(`${OUT}batch-${i}.jpg`, out);
  const img = await decode(out);
  done(
    `batch-${i}.jpg`,
    `${img.width}x${img.height} from the same stored spec`,
  );
}

// ---------------------------------------------------------------------------------------
heading("Files, if you are on Node");

// The core never touches the filesystem -- that is what keeps it portable. fromFile/toFile
// are a ten-line shim, and the only part of the library that imports node:fs.
await toFile(
  await (
    await fromFile(`${OUT}source.jpg`)
  )
    .maxLongEdge(120)
    .toFormat("png")
    .toBuffer(),
  `${OUT}tiny.png`,
);
done("tiny.png", "fromFile -> chain -> toFile");

// ---------------------------------------------------------------------------------------
heading("When things go wrong");

// Every failure is an SImgError with a code you can switch on, never a raw TypeError from
// somewhere in a decoder. A plugin's catch block is the reason these are classes.
try {
  await decode(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
} catch (e) {
  const err = e as UnsupportedFormatError;
  console.log(`  ${err.name} [${err.code}]`);
  console.log(`  "${err.message}"`);
  console.log(`  instanceof SImgError: ${err instanceof SImgError}`);
}

// The messages are meant to be readable by whoever gets the bug report, not just by you.
try {
  await SImg.fromBuffer(source).toFormat("jpeg", { quality: 500 }).toBuffer();
} catch (e) {
  console.log(`  ${(e as SImgError).name}: "${(e as Error).message}"`);
}

console.log(
  `\n\x1b[1mDone.\x1b[0m Everything is in examples/output/ — go and look at it.\n`,
);

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
