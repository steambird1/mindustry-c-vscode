/*
 * Compile every file in a compiler checkout and print a fingerprint per file.
 *
 * Used by `verify-patch-neutrality.mjs`. Kept separate because it is also the
 * easiest way to see what a compiler change actually did: run it against two
 * trees and diff the JSON.
 *
 *   node scripts/compile-hashes.mjs [compilerDir]
 *
 * The fingerprint is deliberately wider than "did it succeed": the generated
 * code's hash and line count, plus every error and warning with its position.
 * A patch that changed the order of two warnings would show up here even though
 * the output is byte-identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadCompilerExports, loadCompilerModule } from './lib/load-compiler.mjs';

// `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter starts
// with a slash, and path.resolve then doubles the drive letter.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] ?? path.join(root, 'compiler'));

const { Compiler } = await loadCompilerExports(dir, ['Compiler']);
const { MemoryBlock } = await loadCompilerModule(dir, 'mindcGeneratorBase.js', ['MemoryBlock']);
const { AttributeClass } = await loadCompilerModule(dir, 'mindcBase.js', ['AttributeClass']);

// The compiler logs progress to the console; this script owns stdout.
console.log = () => {};
console.debug = () => {};
console.info = () => {};

const testDir = path.join(dir, 'testers');
const files = fs.readdirSync(testDir).filter(file => file.endsWith('.c')).sort();
const result = {};
for (const file of files) {
	const source = fs.readFileSync(path.join(testDir, file), 'utf8');
	try {
		const compiler = new Compiler(source, [new MemoryBlock('cell1', 64)], new AttributeClass());
		const outcome = await compiler.compile();
		const code = outcome.code ?? '';
		result[file] = {
			success: Boolean(outcome.success),
			hash: crypto.createHash('md5').update(code).digest('hex').slice(0, 12),
			lines: code === '' ? 0 : code.split('\n').length,
			errors: (outcome.errors ?? []).map(describe),
			warnings: (outcome.warnings ?? []).map(describe),
			fatal: outcome.fatalError ? String(outcome.fatalError).split('\n')[0] : null,
		};
	} catch (error) {
		result[file] = { success: false, threw: String(error.message).split('\n')[0].trim() };
	}
}

process.stdout.write(JSON.stringify(result, null, 1));

/**
 * A diagnostic's position is where a behaviour change is most likely to hide.
 *
 * Stack frames are stripped. An "Internal parser error" carries the whole trace
 * in its message, and every frame is a file path plus a line number inside the
 * compiler: moving code around shifts every one of them, so comparing traces
 * between a patched and an unpatched tree reports differences that are not
 * behaviour. The first line -- the reason -- is kept.
 */
function describe(diagnostic) {
	const message = String(diagnostic.message).split('\n')[0];
	return `${diagnostic.line}:${diagnostic.column} ${message}`;
}
