/*
 * The compiler adapter's contract with the bundled compiler.
 *
 * `out/compiler/mindc.cjs` is produced by esbuild from a synthetic entry that
 * re-exports exactly the handful of names the extension uses, so a missing or
 * renamed export shows up here as a construction failure rather than as a
 * confusing error deep in a worker. The capability flags matter just as much:
 * two of the three come from patches, and the extension has to keep working
 * without them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
	analyze,
	capabilities,
	compile,
	dirname,
	isWindowsPath,
	joinPath,
	makeConfig,
	makeMemoryBlocks,
} from '../src/compiler/bridge';

describe('the bundled compiler', () => {
	it('exports the four constructors the extension needs', () => {
		// Each is used with `new`, so a missing export is a crash at this line
		// rather than a mysterious failure later.
		const [block] = makeMemoryBlocks([{ name: 'cell', size: 64 }]);
		assert.equal(block.name, 'cell');
		assert.equal(block.size, 64);
		const config = makeConfig(154.3);
		assert.equal(config.getAttribute('targetVersion'), 154.3);
	});

	it('reports the capabilities the patches add', () => {
		// Without `analyze` the extension still runs, but it is much worse: every
		// keystroke would need a full compile. This is the flag that tells a user
		// (and us) the compiler is not patched.
		assert.ok(capabilities.analyze, 'patch 0001 is missing: Compiler#analyze');
		assert.ok(capabilities.prepare, 'patch 0001 is missing: Compiler#prepare');
		// Without the resolver, `#include` is reported instead of resolved, so the
		// user loses cross-file navigation -- but nothing breaks.
		assert.ok(capabilities.includeResolver, 'patch 0002 is missing: Lexer includeResolver');
	});
});

describe('memory blocks', () => {
	it('never produces a zero-sized block', () => {
		// The compiler reserves cells at the start of every block; a size of 0
		// would silently make every access land in that reserve.
		const blocks = makeMemoryBlocks([
			{ name: 'a', size: 0 },
			{ name: 'b', size: -4 },
			{ name: 'c', size: 12.7 },
		]);
		assert.deepEqual(
			blocks.map(block => [block.name, block.size]),
			[
				['a', 1],
				['b', 1],
				['c', 12],
			]
		);
	});
});

describe('paths', () => {
	it('recognises a Windows path', () => {
		assert.equal(isWindowsPath('C:\\project\\main.mlgc'), true);
		assert.equal(isWindowsPath('\\\\server\\share'), true);
		assert.equal(isWindowsPath('/project/main.mlgc'), false);
		assert.equal(isWindowsPath('main.mlgc'), false);
	});

	it('takes the directory of a file', () => {
		assert.equal(dirname('/project/inc/header.h'), '/project/inc');
		assert.equal(dirname('C:\\project\\inc\\header.h'), 'C:\\project\\inc');
		assert.equal(dirname('header.h'), null);
		// A root is its own directory, not an empty string.
		assert.equal(dirname('/header.h'), '/');
		assert.equal(dirname('C:\\header.h'), 'C:\\');
		assert.equal(dirname('/'), null);
	});

	it('joins an include path, keeping a rooted relative path absolute', () => {
		assert.equal(joinPath('/project', 'inc/header.h'), '/project/inc/header.h');
		assert.equal(joinPath('C:\\project', 'inc\\header.h'), 'C:\\project\\inc\\header.h');
		// A path the host gave in full is used as it stands.
		assert.equal(joinPath('/project', '/elsewhere/header.h'), '/elsewhere/header.h');
		assert.equal(joinPath('/project', 'D:\\elsewhere\\header.h'), 'D:\\elsewhere\\header.h');
	});
});

/*
 * The compiler separated `char` from its native string type: `char` is a
 * one-cell character/number again, `string_t` is the Mindustry string, and a
 * mutable `char*` may not point at a literal. These run the real compiler, so
 * they also prove the adapter keeps the lexer's constructor state.
 */
const TARGET = { targetVersion: 154.3, memoryBlocks: [], includePaths: [] as string[] };
const MEMORY = [{ name: 'cell1', size: 64 }];

describe('string types', () => {
	it('compiles char as a number and string_t as the native string', async () => {
		const result = await compile({
			source:
				'int main(void) { string_t s = "hi"; char c = \'A\'; char a[] = "hi"; ' +
				'return c + (int)s[0] + a[0]; }',
			target: { ...TARGET, memoryBlocks: MEMORY },
		});
		assert.equal(result.success, true, result.errors.map(error => error.message).join('\n'));
	});

	it('refuses a mutable char* initialised from a literal', async () => {
		const result = await analyze({
			source: 'int main(void) { char *p = "hi"; return 0; }',
			target: TARGET,
		});
		assert.equal(result.success, false, 'the literal must not be writable through char*');
		assert.match(
			result.errors.map(error => error.message).join('\n'),
			/Cannot initialize 'char\*' with a string literal/,
			'the message the quick fix is built on changed'
		);
	});

	it('accepts the legacy char spelling only behind its pragma', async () => {
		const legacy = await analyze({
			source: '#pragma legacy_char_string\nint main(void) { char s = "hi"; return s[0]; }',
			target: TARGET,
		});
		assert.equal(legacy.success, true, legacy.errors.map(error => error.message).join('\n'));

		const plain = await analyze({
			source: 'int main(void) { char s = "hi"; return s[0]; }',
			target: TARGET,
		});
		assert.equal(plain.success, false, 'without the pragma, char is numeric');
	});

	/*
	 * The lexer gets `__MINDC_TARGET_VERSION__` from the Compiler constructor.
	 * The adapter used to replace that lexer with a fresh one, which dropped the
	 * macro and made every `#if` over the target take the `#else` branch.
	 */
	it('evaluates #if against the configured target version', async () => {
		const result = await compile({
			source:
				'int main(void) {\n#if __MINDC_TARGET_VERSION__ >= 154\n\treturn 1;\n' +
				'#else\n\treturn 2;\n#endif\n}',
			target: { ...TARGET, memoryBlocks: MEMORY },
		});
		assert.equal(result.success, true, result.errors.map(error => error.message).join('\n'));
		assert.match(result.code, /set __return 1/);
		assert.doesNotMatch(result.code, /set __return 2/);
	});

	it('applies the legacy spelling to included headers too', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindc-legacy-'));
		fs.writeFileSync(path.join(dir, 'legacy.h'), 'char shared = "hi";\n');
		try {
			const result = await analyze({
				source: '#pragma legacy_char_string\n#include "legacy.h"\nint main(void) { return shared[0]; }',
				target: { ...TARGET, includePaths: [dir] },
				filePath: path.join(dir, 'main.mlgc'),
				readFile: target => {
					try {
						return fs.readFileSync(target, 'utf8');
					} catch {
						return null;
					}
				},
			});
			assert.equal(result.success, true, result.errors.map(error => error.message).join('\n'));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	/*
	 * `include/string.h` is where `string_view` and `sv_*` live. The build
	 * copies the compiler's headers into `out/include`, so `#include <string.h>`
	 * has somewhere to resolve even without a compiler checkout.
	 */
	it('ships the compiler headers, so <string.h> resolves', async () => {
		const includeDir = path.join(__dirname, '..', '..', 'out', 'include');
		assert.ok(fs.existsSync(path.join(includeDir, 'string.h')), 'out/include/string.h is missing');

		const result = await analyze({
			source:
				'#include <string.h>\nint main(void) { string_t s = "hi"; ' +
				'string_view v = sv_of_string(s); return sv_len(v); }',
			target: { ...TARGET, includePaths: [includeDir] },
			filePath: path.join(includeDir, '..', 'main.mlgc'),
			readFile: target => {
				try {
					return fs.readFileSync(target, 'utf8');
				} catch {
					return null;
				}
			},
		});
		assert.equal(result.success, true, result.errors.map(error => error.message).join('\n'));
		assert.ok(
			result.includes.some(file => file.endsWith('string.h')),
			'<string.h> did not come from the bundled headers'
		);
	});
});
