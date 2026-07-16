// The preview-path benchmark. features/fast-decode.md: "Benchmark it, record it" and
// "Record the number; watch it."
//
//   npm run bench:preview
//
// Deliberately NOT a test. Timings on a laptop under load are not an assertion -- the
// fact that the reduced IDCT runs instead of the full one IS, and that is pinned with an
// instrumented counter in test/core/fast-decode-counter.test.ts. This measures whether the
// thing that is provably happening is actually worth having, which is a different question
// and one only a stopwatch can answer.
//
// The source is generated, not committed: a 12MP JPEG is several MB and this is the only
// thing that needs one.

import { createImage } from '../src/core/image.ts';
import { decode, encode } from '../src/core/dispatch.ts';
import { crop } from '../src/core/transform/crop.ts';
import { rotate } from '../src/core/transform/rotate.ts';

const WIDTH = 4000;
const HEIGHT = 3000;

/** The PRD's subject: a 12MP photo. */
function source() {
  const img = createImage(WIDTH, HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 4;
      img.data[at] = (x * 255) / WIDTH;
      img.data[at + 1] = (y * 255) / HEIGHT;
      img.data[at + 2] = (Math.floor(x / 64) + Math.floor(y / 64)) % 2 === 0 ? 200 : 40;
      img.data[at + 3] = 255;
    }
  }
  return img;
}

async function time(label, fn) {
  await fn(); // warm: the first run pays for JIT and the cosine tables.
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const result = await fn();
    runs.push(performance.now() - started);
    if (i === 4) {
      runs.sort((a, b) => a - b);
      const median = runs[2];
      const size = result?.width === undefined ? '' : `  ${result.width}x${result.height}`;
      console.log(`  ${label.padEnd(26)} ${median.toFixed(0).padStart(4)}ms${size}`);
      return median;
    }
  }
}

console.log(`\ngenerating a ${WIDTH}x${HEIGHT} JPEG (12MP, the PRD's photo)...`);
const bytes = await encode(source(), 'jpeg', { quality: 85 });
console.log(`  ${(bytes.length / 1e6).toFixed(1)} MB\n`);

console.log('decode');
const full = await time('full resolution', () => decode(bytes));
const hinted = await time('hintMaxLongEdge: 1600', () => decode(bytes, { hintMaxLongEdge: 1600 }));
await time('hintMaxLongEdge: 400', () => decode(bytes, { hintMaxLongEdge: 400 }));

// The number that matters, from the spec's own two-pass design: on every interaction the
// plugin transforms the ALREADY-DECODED preview. No re-decode, and emphatically no encode.
const preview = await decode(bytes, { hintMaxLongEdge: 1600 });
const source16 = await decode(bytes);

console.log('\nper interaction (the frame budget)');
const frame = await time('crop + rotate 15 (preview)', async () =>
  rotate(crop(preview, { x: 100, y: 100, width: 800, height: 600 }), 15),
);
await time('crop + rotate 15 (full res)', async () =>
  rotate(crop(source16, { x: 400, y: 400, width: 3200, height: 2400 }), 15),
);

console.log(`\ndecode speedup at 1600: ${(full / hinted).toFixed(1)}x`);
console.log(`preview frame: ${frame.toFixed(0)}ms  (16ms = 60fps, 33ms = 30fps)`);
console.log(frame < 33 ? 'within a frame budget.\n' : 'OVER the frame budget.\n');
