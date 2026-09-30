/*
 * Loading the Mindustry-C compiler from a build script.
 *
 * The compiler is ESM but ships no `package.json`, so importing its files
 * directly makes Node guess the module type, print a
 * MODULE_TYPELESS_PACKAGE_JSON warning, and re-parse each file as ESM. Bundling
 * it first with the same esbuild settings the extension uses avoids all three,
 * and means build scripts and the running extension read the same code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

/**
 * Bundle `dir` and return the named exports.
 *
 * @param {string} dir       the compiler checkout to read
 * @param {string[]} names   export names to pull out of the bundle
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadCompilerExports(dir, names) {
	const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindc-load-'));
	const bundleFile = path.join(bundleDir, 'compiler.mjs');
	try {
		await esbuild.build({
			stdin: {
				contents: names.map(name => `export { ${name} } from './mindc.js';`).join('\n'),
				resolveDir: dir,
				loader: 'js',
			},
			outfile: bundleFile,
			bundle: true,
			format: 'esm',
			platform: 'node',
			target: 'node18',
			external: ['node:*'],
			// The compiler's own duplicate keys and cases are the author's; the
			// caller decides whether they are worth reporting.
			logLevel: 'silent',
		});
		const module = await import(pathToFileURL(bundleFile).href);
		return Object.fromEntries(names.map(name => [name, module[name]]));
	} catch (error) {
		throw new Error(`Could not load the compiler from ${dir}: ${error.message}`, { cause: error });
	} finally {
		// The temp bundle is a build artefact, not a cache.
		fs.rmSync(bundleDir, { recursive: true, force: true });
	}
}

/**
 * Bundle one extra compiler module and return its exports.
 *
 * Used for tables that live in a module the entry point does not re-export,
 * such as the content id tables in `mindcContent.js`.
 *
 * @param {string} dir
 * @param {string} moduleName  file within the compiler checkout
 * @param {string[]} names
 */
export async function loadCompilerModule(dir, moduleName, names) {
	const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindc-load-'));
	const bundleFile = path.join(bundleDir, 'module.mjs');
	try {
		await esbuild.build({
			stdin: {
				contents: names.map(name => `export { ${name} } from './${moduleName}';`).join('\n'),
				resolveDir: dir,
				loader: 'js',
			},
			outfile: bundleFile,
			bundle: true,
			format: 'esm',
			platform: 'node',
			target: 'node18',
			external: ['node:*'],
			logLevel: 'silent',
		});
		const module = await import(pathToFileURL(bundleFile).href);
		return Object.fromEntries(names.map(name => [name, module[name]]));
	} catch (error) {
		throw new Error(`Could not load ${moduleName} from ${dir}: ${error.message}`, { cause: error });
	} finally {
		fs.rmSync(bundleDir, { recursive: true, force: true });
	}
}
