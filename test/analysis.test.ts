/*
 * What a run that died looks like once it reaches the editor.
 *
 * A compiler crash is not reported as an error: patch 0001 catches it and
 * returns a run with `fatalError` set, no AST, and often no diagnostics at all.
 * The worker's own failures are a second spelling of the same thing -- `fatal`
 * on a response with no index. The server reads exactly one field to decide
 * that the file has not been checked, so both spellings are pinned here.
 *
 * If either stops being written, the squiggle that stands in for a whole run's
 * worth of findings disappears and the file looks clean again, which is the
 * failure this file exists to catch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromRun } from '../src/compiler/analysis';
// The run's own diagnostic type, not the LSP-facing one: the compiler's line
// field can be a location object, and only the run type says so.
import type { CompilerDiagnostic as RunDiagnostic, RunResult } from '../src/compiler/bridge';
import type { AnalysisRequest, AnalysisResponse } from '../src/common/types';

const URI = 'file:///project/main.mlgc';
const PATH = '/project/main.mlgc';
const TEXT = 'int main() { return 0; }\n';

const FIRST_LINE = `Cannot read properties of undefined (reading 'type')`;

function request(): AnalysisRequest {
	return {
		id: 1,
		uri: URI,
		text: TEXT,
		version: 7,
		targetVersion: 154.3,
		memoryBlocks: [{ name: 'cell1', size: 64, building: 'memory-cell' }],
		includePaths: [],
	};
}

/** The shape a run has once the compiler's own `try` has caught a throw. */
function crashedRun(): RunResult {
	return {
		success: false,
		code: '',
		errors: [],
		warnings: [],
		fatalError: `${FIRST_LINE}
TypeError: ${FIRST_LINE}
    at SemanticAnalyzer.visitFunctionCall (mindcSemantic.js:6684:20)`,
		ast: null,
		tokens: [],
		sources: new Map([[PATH, TEXT]]),
		includes: [],
		elapsedMs: 1,
	};
}

/** The same run, without a crash. An empty AST stands in for a trivial file. */
function cleanRun(): RunResult {
	return {
		success: true,
		code: '',
		errors: [],
		warnings: [],
		ast: null,
		tokens: [],
		sources: new Map([[PATH, TEXT]]),
		includes: [],
		elapsedMs: 1,
	};
}

function withErrors(run: RunResult, messages: string[]): RunResult {
	const errors: RunDiagnostic[] = messages.map(message => ({ message }));
	return { ...run, errors };
}

describe('a run the compiler crashed in', () => {
	const response: AnalysisResponse = fromRun(request(), crashedRun(), PATH);

	it('carries the whole trace, so the server can log it somewhere it fits', () => {
		assert.equal(typeof response.fatal, 'string');
		assert.match(response.fatal!, /visitFunctionCall/);
	});

	it('carries the first line on the index, for the one-line summary', () => {
		assert.ok(response.index);
		assert.equal(response.index.internalError, FIRST_LINE);
	});

	it('returns an index rather than null, so the stale-version check still runs', () => {
		// A null index would leave the previous run's symbols in place, pointing
		// at characters the user has since edited.
		assert.ok(response.index);
		assert.equal(response.index.version, 7);
		assert.equal(response.index.uri, URI);
	});

	it('holds no symbols rather than wrong ones', () => {
		assert.ok(response.index);
		assert.deepEqual(response.index.symbols, []);
		assert.deepEqual(response.index.references, []);
		assert.deepEqual(response.index.structs, []);
	});

	it('still reports whatever the compiler said before it died', () => {
		const partial = fromRun(request(), withErrors(crashedRun(), ['nope']), PATH);
		assert.deepEqual(
			partial.diagnostics.map(diagnostic => diagnostic.message),
			['nope']
		);
		// The real error and the crash are separate facts; losing either would
		// leave the user reading half a picture.
		assert.match(partial.fatal!, /visitFunctionCall/);
	});
});

describe('a run that did not crash', () => {
	it('leaves both crash fields unset', () => {
		const response = fromRun(request(), cleanRun(), PATH);
		assert.equal(response.fatal, undefined);
		assert.equal(response.index?.internalError, undefined);
	});

	it('still reports ordinary errors without claiming a crash', () => {
		const response = fromRun(request(), withErrors(cleanRun(), ['undeclared thing']), PATH);
		assert.deepEqual(
			response.diagnostics.map(diagnostic => diagnostic.message),
			['undeclared thing']
		);
		assert.equal(response.fatal, undefined);
	});
});
