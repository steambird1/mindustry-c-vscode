/*
 * Diagnostics: shape and file attribution.
 *
 * This is the part of the integration most likely to quietly do the wrong
 * thing, because the compiler tells us a position and not a file, and a
 * position inside an `#include`d file is indistinguishable from one in the file
 * being edited. See docs/COMPILER-INTEGRATION.md.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	attributePath,
	indexTokenLocations,
	normaliseDiagnostic,
	normaliseDiagnostics,
} from '../src/compiler/diagnostics';

const MAIN = '/project/main.mlgc';
const HEADER = '/project/inc/header.h';

/** A token stream where `header.h` supplies line 2 and `main.mlgc` line 1. */
const index = () =>
	indexTokenLocations(
		[
			{ location: { line: 1, column: 1, filename: MAIN } },
			{ location: { line: 1, column: 10, filename: MAIN } },
			{ location: { line: 2, column: 1, filename: HEADER } },
			{ location: { line: 2, column: 5, filename: HEADER } },
			{ location: { line: 3, column: 1, filename: MAIN } },
		],
		MAIN
	);

describe('diagnostic shape', () => {
	it('keeps a plain message with line and column', () => {
		const result = normaliseDiagnostic({ message: 'unknown type', line: 3, column: 7 }, index(), MAIN);
		assert.deepEqual(result, { message: 'unknown type', line: 3, column: 7, path: MAIN });
	});

	it('accepts a location object passed as `line`', () => {
		// `addError(message, location)` is how some call sites report.
		const result = normaliseDiagnostic(
			{ message: 'bad', line: { line: 2, column: 5, filename: HEADER } },
			index(),
			MAIN
		);
		assert.equal(result.line, 2);
		assert.equal(result.column, 5);
		assert.equal(result.path, HEADER);
	});

	it('accepts a location object passed as `location`', () => {
		const result = normaliseDiagnostic(
			{ message: 'bad', location: { line: 1, column: 10, filename: MAIN } },
			index(),
			MAIN
		);
		assert.equal(result.line, 1);
		assert.equal(result.column, 10);
		assert.equal(result.path, MAIN);
	});

	it('omits a position the compiler did not give, rather than inventing one', () => {
		const result = normaliseDiagnostic({ message: 'no idea where' }, index(), MAIN);
		assert.deepEqual(result, { message: 'no idea where', path: MAIN });
		assert.equal('line' in result, false);
		assert.equal('column' in result, false);
	});

	it('rejects a nonsense position rather than passing it through', () => {
		// 0, negatives, NaN and non-numbers all mean "unknown" here.
		for (const line of [0, -3, Number.NaN, 'four', null, undefined]) {
			const result = normaliseDiagnostic(
				{ message: 'x', line: line as never, column: line as never },
				index(),
				MAIN
			);
			assert.equal(result.line, undefined, `line ${String(line)}`);
			assert.equal(result.column, undefined, `column ${String(line)}`);
		}
	});

	it('stringifies a non-string message instead of dropping it', () => {
		const result = normaliseDiagnostic({ message: 42 as never }, index(), MAIN);
		assert.equal(result.message, '42');
	});

	it('survives a missing diagnostic list', () => {
		assert.deepEqual(normaliseDiagnostics(undefined, index(), MAIN), []);
	});
});

describe('file attribution', () => {
	it('attributes a position that only an include has', () => {
		// Every file restarts at line 1, so (2, 1) is inside the header.
		const result = normaliseDiagnostic({ message: 'boom', line: 2, column: 1 }, index(), MAIN);
		assert.equal(result.path, HEADER);
	});

	it('prefers an include when both files hold a token at that position', () => {
		// main.mlgc line 1 col 1 and (in another shape) header.h could both match;
		// the include is the likelier home for a diagnostic about an undeclared
		// name the main file does not have.
		const ambiguous = indexTokenLocations(
			[
				{ location: { line: 1, column: 1, filename: HEADER } },
				{ location: { line: 1, column: 1, filename: MAIN } },
			],
			MAIN
		);
		assert.equal(
			attributePath({ message: 'x', line: 1, column: 1 }, ambiguous, MAIN),
			HEADER
		);
	});

	it('falls back to the edited file when no token sits there', () => {
		// A lexer error at end of file has no token of its own.
		const result = normaliseDiagnostic({ message: 'unterminated', line: 99, column: 1 }, index(), MAIN);
		assert.equal(result.path, MAIN);
	});

	it('trusts an explicit filename above everything else', () => {
		const result = normaliseDiagnostic(
			{ message: 'x', line: 1, column: 1, location: { filename: '/elsewhere/x.h' } },
			index(),
			MAIN
		);
		assert.equal(result.path, '/elsewhere/x.h');
	});

	it('attributes by line alone when there is no column, using line counts', () => {
		// The main file is 3 lines; a diagnostic on line 8 can only be the
		// header, which the token stream shows running to at least 8 lines.
		const counts = new Map([
			[MAIN, 3],
			[HEADER, 9],
		]);
		const withCounts = indexTokenLocations(
			[
				{ location: { line: 1, column: 1, filename: MAIN } },
				{ location: { line: 8, column: 1, filename: HEADER } },
			],
			MAIN,
			counts
		);
		assert.equal(attributePath({ message: 'x', line: 8 }, withCounts, MAIN), HEADER);
		// A line inside the main file stays in the main file.
		assert.equal(attributePath({ message: 'x', line: 2 }, withCounts, MAIN), MAIN);
	});

	it('works with no main path at all, e.g. an unsaved buffer', () => {
		const anonymous = indexTokenLocations(
			[{ location: { line: 1, column: 1, filename: HEADER } }],
			null
		);
		assert.equal(attributePath({ message: 'x', line: 1, column: 1 }, anonymous, null), HEADER);
		assert.equal(attributePath({ message: 'x' }, anonymous, null), null);
	});

	it('records the files in the order they were first seen', () => {
		const seen = indexTokenLocations(
			[
				{ location: { line: 1, column: 1, filename: HEADER } },
				{ location: { line: 5, column: 1, filename: MAIN } },
			],
			MAIN
		);
		assert.deepEqual(seen.files, [MAIN, HEADER]);
	});
});
