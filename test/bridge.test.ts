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
import { describe, it } from 'node:test';

import {
	capabilities,
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
