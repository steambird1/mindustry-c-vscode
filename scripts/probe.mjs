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
 * `probe.mts` is scratch and is not committed: write a question about the
 * compiler's AST there, run it, throw it away. See
 * docs/COMPILER-INTEGRATION.md, "Checking these claims against the compiler".
 *
 * What a probe discovers is worth turning into a test in test/ before it is
 * forgotten, so that a refactor fails loudly instead of quietly degrading a
 * feature.
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const entry = process.argv[2] ?? 'probe.mts';
const outfile = 'out/probe.mjs';
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

