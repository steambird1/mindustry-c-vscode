/*
 * Build the tests, then let `node --test` run them.
 *
 * The sources are TypeScript with extensionless relative imports, so they have
 * to be bundled before Node can load them. Each test file becomes one CommonJS
 * bundle in `out/test/`, with everything it imports inlined -- including the
 * compiler, for the tests that exercise the bridge.
 *
 * Only the VS Code-free modules are testable this way, which is most of the
 * logic: diagnostics attribution, the symbol index, the feature functions, and
 * the configuration merge. The parts that talk to the editor (preview, config
 * panel, commands) are exercised by running the extension, not by a unit test.
 *
 *   node scripts/build-tests.mjs           # once
 *   node scripts/build-tests.mjs --watch   # rebuild on change
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
const outDir = path.join(root, 'out', 'test');
const watch = process.argv.includes('--watch');

if (!fs.existsSync(testDir)) {
	console.log('no test directory');
	process.exit(0);
}

const entryPoints = fs
	.readdirSync(testDir)
	.filter(file => file.endsWith('.test.ts'))
	.map(file => path.join(testDir, file));

if (entryPoints.length === 0) {
	console.log('no *.test.ts files');
	process.exit(0);
}

/** `vscode` only exists inside the editor host; no unit test may reach for it. */
const options = entryPoints.map(entry => ({
	entryPoints: [entry],
	outfile: path.join(outDir, path.basename(entry).replace(/\.ts$/, '.js')),
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: 'inline',
	// Fail loudly rather than producing a test that cannot possibly work.
	external: ['vscode', 'node:*'],
	logLevel: 'warning',
}));

fs.mkdirSync(outDir, { recursive: true });

if (!watch) {
	await Promise.all(options.map(option => esbuild.build(option)));
	console.log(`built ${entryPoints.length} test bundle(s) into out/test/`);
} else {
	const contexts = await Promise.all(options.map(option => esbuild.context(option)));
	await Promise.all(contexts.map(context => context.watch()));
	console.log(`watching ${entryPoints.length} test bundle(s)`);
	await new Promise(() => {});
}
