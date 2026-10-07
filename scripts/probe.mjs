/*
 * Run one .mts file against the compiler, with TypeScript types and the
 * extension's own modules available.
 *
 *   node scripts/probe.mjs probe.mts
 *
 * The compiler ships no type definitions and is ESM without a package.json, so
 * a probe cannot just import it. This bundles the probe (esbuild resolves both
 * of those problems) into out/probe.mjs and runs it.
 *
 * The compiler bundle is rebuilt first. `src/compiler/bridge.ts` reads
 * `out/compiler/mindc.cjs`, and bundling the probe inlines whatever that file
 * held at that moment -- so without this, a probe run straight after editing
 * the compiler answers from the previous build. That failure is silent and
 * costs an afternoon: the probe reports the compiler as it was, not as it is,
 * and a fix looks like it did not take.
 *
 * `probe.mts` is scratch and is not committed: write a question about the
 * compiler's AST there, run it, throw it away. See
 * docs/COMPILER-INTEGRATION.md, "Checking these claims against the compiler".
 *
 * What a probe discovers is worth turning into a test in test/ before it is
 * forgotten, so that a refactor fails loudly instead of quietly degrading a
 * feature.
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { compilerDirOf, makeCompilerOptions } from './lib/compiler-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2] ?? 'probe.mts';
const outfile = 'out/probe.mjs';

await build(makeCompilerOptions({ root, compilerDir: compilerDirOf(root) }));

await build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	logLevel: 'silent',
});
await import(pathToFileURL(path.resolve(outfile)).href);
