/*
 * Bundling the Mindustry-C compiler, for anything that needs to run it.
 *
 * The compiler is written for browsers and imports `main.html` siblings, so any
 * import esbuild cannot resolve is left alone rather than failing the build:
 * the code path that needs it (`#include` over HTTP) is dead in Node.
 *
 * The entry is synthetic rather than `mindc.js` itself: `mindc.js` only exports
 * `Compiler`, but the bridge also needs `AttributeClass`, `MemoryBlock` and
 * `Lexer`, which live in other modules. Listing them here means a missing
 * export becomes a build error rather than an `undefined is not a constructor`
 * at the user's first keystroke.
 *
 * This is the one place that decides what `out/compiler/mindc.cjs` contains.
 * `scripts/build.mjs` writes it for the extension; `scripts/probe.mjs`
 * rewrites it before every run, because a probe that reads a bundle from an
 * earlier build answers a question about the source in front of you with the
 * behaviour of the source as it was -- which is exactly the mistake a probe is
 * meant to rule out.
 */
import path from 'node:path';

const compilerEntry = [
	`export { Compiler, CompilerExtensionBase, defaultExtensions } from './mindc.js';`,
	`export { AttributeClass, ASTNodeType } from './mindcBase.js';`,
	`export { MemoryBlock, MEMORY_RESERVE_SIZE } from './mindcGeneratorBase.js';`,
	`export { Lexer, TokenType } from './mindcLexer.js';`,
].join('\n');

/**
 * esbuild options that produce `out/compiler/mindc.cjs`.
 *
 * @param {{ root: string, compilerDir: string }} paths
 * @returns {import('esbuild').BuildOptions}
 */
export function makeCompilerOptions({ root, compilerDir }) {
	return {
		stdin: { contents: compilerEntry, resolveDir: compilerDir, loader: 'js' },
		outfile: path.join(root, 'out', 'compiler', 'mindc.cjs'),
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		external: ['node:*'],
		loader: { '.js': 'js' },
		// The browser's `fetch`/`XMLHttpRequest` are absent in Node; the include
		// resolver hook (patch 0002) is what the extension actually uses.
		define: { 'import.meta.url': '__filename' },
		// Warnings are summarised by the caller rather than printed, so that a
		// warning in the compiler's own code never looks like a failure.
		logLevel: 'silent',
	};
}

/** The checkout to read: `MINDC_COMPILER_DIR` overrides for testing a tree. */
export function compilerDirOf(root) {
	return process.env.MINDC_COMPILER_DIR ?? path.join(root, 'compiler');
}
