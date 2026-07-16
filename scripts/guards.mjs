// The two mechanical checks the specs actually assert. See features/file-io.md
// and features/type-safety.md.
//
//   1. No filesystem (or other host) access under src/core/. node:zlib in
//      codecs/png.ts is the ONE allowed exception -- it's what a browser build
//      would swap for CompressionStream.
//   2. No `any` in the emitted .d.ts.
//
// ponytail: greps, not eslint. Two rules don't need a plugin ecosystem.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
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

// Guard 2: no `any` in the public types. Only meaningful once dist/ exists.
for (const file of (await walk(DIST)).filter((f) => f.endsWith('.d.ts'))) {
  const code = await readFile(file, 'utf8');
  // `any` as a type position, not as part of a word like "anywhere" or "Company".
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

console.log('guards: core is host-free, public types carry no `any`');
