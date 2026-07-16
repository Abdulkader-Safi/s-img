// The mechanical checks the specs assert. See features/file-io.md, features/errors.md
// and features/type-safety.md.
//
//   1. No filesystem (or other host) access under src/core/. node:zlib in
//      codecs/png.ts is the ONE allowed exception -- it's what a browser build
//      would swap for CompressionStream.
//   2. Every throw is a typed SImgError, so the plugin's instanceof check is exhaustive.
//   3. The emitted JS never imports a .ts path that won't exist in the package.
//   4. No `any` in the emitted .d.ts.
//
// Each one has a test in test/guards.test.ts that watches it fail on purpose. That is
// not ceremony: the first version of guard 1 passed silently on a real violation,
// because stripping string literals deleted the import specifiers it was hunting for.
//
// ponytail: greps, not eslint. Four rules don't need a plugin ecosystem.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const CORE = join(ROOT, 'src/core');
const DIST = join(ROOT, 'dist');

/** The only `node:` import allowed in the core, and the only file allowed to have it. */
const ZLIB_EXCEPTION = { file: 'codecs/png.ts', module: 'node:zlib' };

/** Banned imports. Checked against code with comments stripped but STRINGS INTACT --
 *  an import specifier is a string literal, so stripping strings would delete the
 *  very thing being looked for. */
const BANNED_IMPORTS = [
  { pattern: /from\s+['"]node:(?!zlib['"])[\w/]+['"]/g, what: 'a node: import' },
  { pattern: /from\s+['"](?:fs|path|os|crypto)(?:\/[\w/]+)?['"]/g, what: 'a bare node builtin import' },
  { pattern: /\bimport\s*\(\s*['"]node:(?!zlib['"])[\w/]+['"]/g, what: 'a dynamic node: import' },
];

/** Banned identifiers. Checked against code with comments AND strings stripped, so the
 *  word "Buffer" in an error message doesn't fail the build. Same mistake as fs, in
 *  different hats. */
const BANNED_IDENTS = [
  { pattern: /\brequire\s*\(/g, what: 'require()' },
  { pattern: /\bBuffer\b/g, what: 'Buffer' },
  { pattern: /\bprocess\s*\./g, what: 'process' },
  { pattern: /\b__dirname\b/g, what: '__dirname' },
];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out; // not built / not written yet
    throw e;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Strip comments only. Prose can't trip a check, import specifiers survive. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Strip strings too, for identifier checks. Run on already-comment-stripped code. */
function stripStrings(src) {
  return src
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const failures = [];
const coreFiles = (await walk(CORE)).filter((f) => f.endsWith('.ts'));

// Guard 1: core stays host-free.
for (const file of coreFiles) {
  const rel = relative(CORE, file);
  const code = stripComments(await readFile(file, 'utf8'));
  const ident = stripStrings(code);

  for (const { pattern, what } of BANNED_IMPORTS) {
    for (const m of code.matchAll(pattern)) {
      failures.push(`src/core/${rel}: ${what} -- ${m[0].trim()}`);
    }
  }
  for (const { pattern, what } of BANNED_IDENTS) {
    for (const m of ident.matchAll(pattern)) {
      failures.push(`src/core/${rel}: ${what}`);
    }
  }

  // zlib is allowed, but only in the one file that earns it.
  if (code.includes(ZLIB_EXCEPTION.module) && rel !== ZLIB_EXCEPTION.file) {
    failures.push(
      `src/core/${rel}: ${ZLIB_EXCEPTION.module} is only allowed in ${ZLIB_EXCEPTION.file}`,
    );
  }
}

// Guard 2: everything throws a typed error, so the plugin's `instanceof SImgError`
// is exhaustive. src/core/errors.ts is where the subclasses are defined, so it is
// the one file allowed to name the base Error.
for (const file of (await walk(SRC)).filter((f) => f.endsWith('.ts'))) {
  const rel = relative(SRC, file);
  if (rel === 'core/errors.ts') continue;

  const code = stripStrings(stripComments(await readFile(file, 'utf8')));
  for (const _ of code.matchAll(/\bthrow\s+new\s+(?:Error|TypeError|RangeError)\s*\(/g)) {
    failures.push(`src/${rel}: bare throw -- use an SImgError subclass (features/errors.md)`);
  }
  for (const _ of code.matchAll(/\bthrow\s+(?!new\b)['"`{[]/g)) {
    failures.push(`src/${rel}: thrown literal -- use an SImgError subclass`);
  }
}

// Guard 3: the emitted JS never points at a .ts file. Source uses `.ts` specifiers and
// tsc rewrites them on emit (rewriteRelativeImportExtensions in tsconfig.json). Drop
// that flag and dist/ ships imports of files that aren't in the package: every consumer
// crashes at import time, and the suite stays green because tests run from src.
// Declaration files legitimately keep `.ts` -- TS resolves those to the sibling .d.ts.
for (const file of (await walk(DIST)).filter((f) => f.endsWith('.js'))) {
  const code = stripComments(await readFile(file, 'utf8'));
  for (const m of code.matchAll(/(?:from|import\s*\()\s*['"](\.[^'"]*\.ts)['"]/g)) {
    failures.push(`${relative(ROOT, file)}: emitted a .ts specifier (${m[1]}) -- it won't exist in dist/`);
  }
}

// Guard 4: no `any` in the public types. Only meaningful once dist/ exists.
// Comments are stripped first: doc comments carry the word "any" in ordinary prose
// ("or any ancillary chunk"), and flagging those trains everyone to ignore the guard.
for (const file of (await walk(DIST)).filter((f) => f.endsWith('.d.ts'))) {
  const raw = await readFile(file, 'utf8');
  const code = stripComments(raw);
  // `any` as a type, not part of a word like "anywhere" or "Company".
  for (const m of code.matchAll(/(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/g)) {
    const line = code.slice(0, m.index).split('\n').length;
    failures.push(`${relative(ROOT, file)}:${line}: \`any\` in the public API surface`);
  }
}

if (failures.length > 0) {
  console.error('Guard failures:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\n${failures.length} failure(s). See features/file-io.md, features/type-safety.md.`);
  process.exit(1);
}

console.log(
  `guards: ${coreFiles.length} core file(s) host-free, all throws typed, ` +
    'no .ts specifiers emitted, no `any` in public types',
);
