import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// scripts/guards.mjs enforces features/file-io.md's core boundary. It is regex-based,
// and its dangerous failure mode is passing silently -- which it did on the first
// attempt, because stripping string literals deleted the import specifiers it was
// hunting for. A guard nobody has watched fail is a comment.

const run = promisify(execFile);
const PROBE_DIR = new URL('../src/core/', import.meta.url).pathname;
const PROBE = `${PROBE_DIR}__probe.ts`;
const DIST_DIR = new URL('../dist/', import.meta.url).pathname;
const DIST_PROBE = `${DIST_DIR}__probe.js`;

/** Exit code of the guard script: 0 clean, 1 violations found. */
async function guardExitCode(): Promise<number> {
  try {
    await run('node', ['scripts/guards.mjs'], { cwd: new URL('..', import.meta.url).pathname });
    return 0;
  } catch (e) {
    return (e as { code: number }).code;
  }
}

async function probe(source: string): Promise<number> {
  await mkdir(PROBE_DIR, { recursive: true });
  await writeFile(PROBE, source);
  return guardExitCode();
}

afterEach(async () => {
  await rm(PROBE, { force: true });
});

test('rejects a node: import in core', async () => {
  const code = await probe("import { readFile } from 'node:fs/promises';\nexport const x = readFile;\n");
  assert.equal(code, 1, 'fs in src/core/ must fail the guard');
});

test('rejects Buffer in core', async () => {
  const code = await probe('export const x = Buffer.from([1]);\n');
  assert.equal(code, 1, 'Buffer in src/core/ must fail the guard');
});

test('rejects node:zlib outside codecs/png.ts', async () => {
  const code = await probe("import { deflateSync } from 'node:zlib';\nexport const x = deflateSync;\n");
  assert.equal(code, 1, 'zlib is only allowed in the one file that earns it');
});

test('rejects a bare throw', async () => {
  // features/errors.md: the public API only ever throws an SImgError, so
  // `catch (e) { e instanceof SImgError }` is exhaustive for the plugin.
  const code = await probe("export function f() {\n  throw new Error('nope');\n}\n");
  assert.equal(code, 1, 'throw new Error( must fail the guard');
});

test('rejects a .ts specifier in emitted JS', async () => {
  // Source imports carry `.ts` and tsc rewrites them to `.js` on emit
  // (rewriteRelativeImportExtensions). If that flag is ever dropped, dist/ ships
  // specifiers pointing at files that aren't in the package and every consumer
  // crashes on import -- while the suite stays green, because tests run from src.
  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(DIST_PROBE, "export { x } from './core/thing.ts';\n");
  const code = await guardExitCode();
  await rm(DIST_PROBE, { force: true });

  assert.equal(code, 1, 'a .ts specifier in dist/*.js must fail the guard');
});

test('allows banned words in prose', async () => {
  // The guard must read code, not comments -- or every error message mentioning
  // Buffer would fail the build.
  const code = await probe('// Buffer and process and __dirname, all in a comment.\nexport const x = 1;\n');
  assert.equal(code, 0, 'banned identifiers in comments must not fail the guard');
});
