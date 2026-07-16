import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// features/bundle-size.md. "A budget nobody enforces is a wish" -- and a check nobody has
// watched fail is the same thing wearing a CI badge.
//
// The spec names the exact regression worth catching: "The import() must survive bundling
// as a real dynamic import; if esbuild inlines it (which it will, given the wrong config),
// the core silently gains 300 KB and the budget check catches it. That is a good test of
// the check." So this plants it and watches the check catch it.
//
// It earned its place immediately. The first version of the check looked for the WASM in
// index.js, planting the regression did NOT fail it, and the reason is worth knowing: with
// splitting on, esbuild hoists a statically-imported module into a shared CHUNK rather than
// inlining it into the entry. index.js stayed 23 KB and pristine while eagerly depending on
// a 190 KB chunk next to it. The check now measures the entry's whole eager closure.
//
// EVERYTHING HAPPENS IN A COPY OF THE TREE. The first version of this file planted the
// import into the real src/core/codecs/webp.ts and restored it in afterEach, which is fine
// alone and wrong in a suite: node:test runs test FILES in parallel, so for a few hundred
// milliseconds the WebP tests in other processes were importing a deliberately broken
// module. Two of them failed, and they were right to. A test that edits shared source is a
// test that fails its neighbours.

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;

let dir: string;

before(async () => {
  // src/ and the one script, plus node_modules symlinked rather than installed: size.mjs
  // needs esbuild and nothing else, and it resolves entryPoints relative to cwd.
  dir = await mkdtemp(join(tmpdir(), 's-img-size-'));
  await cp(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  await cp(join(ROOT, 'scripts', 'size.mjs'), join(dir, 'size.mjs'));
  await symlink(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Exit code of the size script against the copied tree: 0 within budget and split. */
async function sizeExitCode(): Promise<{ code: number; output: string }> {
  try {
    const { stdout } = await run('node', ['size.mjs'], { cwd: dir });
    return { code: 0, output: stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, output: err.stdout + err.stderr };
  }
}

test('the core is within budget and the WASM is split out', async () => {
  const { code, output } = await sizeExitCode();
  assert.equal(code, 0, `the size check is failing on a clean tree:\n${output}`);
  assert.match(output, /min\+gzip/);
  assert.match(output, /WebP only, split out/, 'the WASM chunk vanished, so the split is not being verified');
});

test('a static WebP import fails the check, rather than quietly costing 190 KB', async () => {
  // The regression the spec predicts. One static import of the WASM module is all it takes,
  // and the whole premise of the project -- a small artifact Obsidian Sync can carry -- is
  // gone without a single test going red anywhere else.
  const webp = join(dir, 'src/core/codecs/webp.ts');
  const original = await readFile(webp, 'utf8');
  await writeFile(webp, `import { WASM_BASE64 as PLANTED } from './webp-wasm-dec.ts';\nglobalThis.__planted = PLANTED;\n${original}`);

  const { code, output } = await sizeExitCode();
  await writeFile(webp, original);

  assert.equal(code, 1, 'a statically-imported WASM passed the size check');
  assert.match(output, /EAGERLY|over budget/, `it failed, but not for the reason it should have:\n${output}`);
});

test('the WASM assertion is not vacuous: it fails if there is no WASM to find', async () => {
  // The self-check. "The WASM is not in the core" is trivially true of a build where the
  // WASM does not exist at all -- so the check would pass, forever, on a tree where the
  // generated modules were never built. Prove it notices.
  // BOTH of them: blanking only the decoder leaves the encoder's WASM in a chunk, which
  // satisfies "the WASM exists somewhere" and passes. Which is correct behaviour, and is
  // why the first draft of this test failed -- it was asserting the check is vacuous when
  // the check was, in fact, still finding a real WASM.
  const wasms = ['webp-wasm-dec.ts', 'webp-wasm-enc.ts'].map((name) => join(dir, 'src/core/codecs', name));
  const originals = await Promise.all(wasms.map((path) => readFile(path, 'utf8')));
  for (const path of wasms) await writeFile(path, `export const WASM_BASE64: string = '';\nexport const WASM_BYTES = 0;\n`);

  const { code, output } = await sizeExitCode();
  await Promise.all(wasms.map((path, i) => writeFile(path, originals[i]!)));

  assert.equal(code, 1, 'the check passed on a tree with no WASM in it, so it proves nothing');
  assert.match(output, /not in ANY chunk/);
});
