/*
 * Build the extension.
 *
 * Five bundles come out of this:
 *
 *   out/compiler/mindc.cjs        the Mindustry-C compiler, ESM -> CJS
 *   out/server/server.js          the language server
 *   out/server/analysisWorker.js  parse + analyse, off the extension host
 *   out/server/buildWorker.js     the full pipeline, cancellable
 *   out/extension/extension.js    the VS Code extension host code
 *
 * The compiler is bundled first and then inlined into the workers, which keeps
 * `src/compiler/bridge.ts` free of any assumption about where the compiler
 * lives on disk.
 *
 *   node scripts/build.mjs           one-off build
 *   node scripts/build.mjs --watch   rebuild on change
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { compilerDirOf, makeCompilerOptions } from './lib/compiler-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compilerDir = compilerDirOf(root);
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** Dependencies provided by the host at runtime; bundling them breaks. */
const SERVER_EXTERNALS = [
	'vscode-languageserver',
	'vscode-languageserver-textdocument',
	'vscode-uri',
	'vscode-jsonrpc',
	'node:*',
];

/**
 * Defined in `scripts/lib/compiler-build.mjs` rather than here, so that
 * `scripts/probe.mjs` can produce the identical bundle: see that file for why
 * the entry is synthetic and why the warnings are held back.
 */
const compilerOptions = makeCompilerOptions({ root, compilerDir });

function jsOptions(entry, outfile, extra = {}) {
	return {
		entryPoints: [path.join(root, entry)],
		outfile: path.join(root, outfile),
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		sourcemap: dev ? 'inline' : false,
		minify: !dev,
		logLevel: 'silent',
		...extra,
	};
}

const compiler = await esbuild.build(compilerOptions);
if (compiler.errors.length) process.exit(1);

const bundles = [
	makeBundle('server', 'server/server.ts', 'out/server/server.js', {
		external: SERVER_EXTERNALS,
	}),
	makeBundle('analysisWorker', 'src/compiler/analysisWorker.ts', 'out/server/analysisWorker.js', {
		external: [...SERVER_EXTERNALS, 'vscode-languageclient'],
	}),
	makeBundle('buildWorker', 'src/compiler/buildWorker.ts', 'out/server/buildWorker.js', {
		external: [...SERVER_EXTERNALS, 'vscode-languageclient'],
	}),
	makeBundle('extension', 'src/extension/extension.ts', 'out/extension/extension.js', {
		external: ['vscode', ...SERVER_EXTERNALS],
	}),
];

const size = file => {
	try {
		return `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;
	} catch {
		return 'missing';
	}
};

if (!watch) {
	const results = await Promise.all(bundles.map(bundle => esbuild.build(bundle.options)));

	// The compiler is inlined into three of the bundles, so its warnings arrive
	// three times over. Deduplicate, then separate "ours" from "the compiler's":
	// the latter are the author's to fix, and repeating them on every build
	// would make this build look broken when it is not.
	const seen = new Set();
	const ours = [];
	const theirs = new Map();
	// A warning raised while building the compiler bundle itself is reported
	// against the bundle's output path, not the compiler's source, and esbuild
	// hands back relative paths.
	const isTheirs = file => {
		if (!file) return false;
		const absolute = path.resolve(root, file);
		return absolute.startsWith(compilerDir) || absolute === compilerOptions.outfile;
	};
	for (const warning of [...compiler.warnings, ...results.flatMap(r => r.warnings)]) {
		const key = `${warning.location?.file}:${warning.location?.line}:${warning.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (isTheirs(warning.location?.file ?? '')) {
			theirs.set(warning.text, true);
		} else {
			ours.push(warning);
		}
	}
	if (ours.length > 0) {
		for (const text of await esbuild.formatMessages(ours, { kind: 'warning', color: false })) {
			process.stderr.write(text);
		}
	}
	if (theirs.size > 0) {
		// Distinct problems, not distinct occurrences: the same four show up once
		// per bundle that inlines the compiler.
		for (const text of [...theirs.keys()].sort()) console.log(`note: compiler source: ${text}`);
	}

	for (const bundle of bundles) {
		console.log(
			`built ${bundle.name} -> ${relative(bundle.options.outfile)} (${size(bundle.options.outfile)})`
		);
	}
	console.log(`built compiler -> ${relative(compilerOptions.outfile)} (${size(compilerOptions.outfile)})`);
} else {
	const contexts = await Promise.all(
		bundles.map(async bundle => {
			const context = await esbuild.context(bundle.options);
			await context.watch();
			console.log(`watching ${bundle.name}`);
			return context;
		})
	);
	fs.watch(compilerDir, { recursive: false }, async () => {
		try {
			await esbuild.build(compilerOptions);
			console.log('rebuilt compiler');
		} catch (error) {
			console.error(error.message);
		}
	});
	await new Promise(() => {
		// Watch mode never resolves; the process is kept alive by esbuild.
		void contexts;
	});
}

/** esbuild chokes on unknown keys, so `name` is kept out of the options. */
function makeBundle(name, entry, outfile, extra) {
	return { name, options: jsOptions(entry, outfile, extra) };
}

function relative(file) {
	return path.relative(root, file).split(path.sep).join('/');
}
