/*
 * One analysis run: compiler in, diagnostics and a symbol index out.
 *
 * This is what the analysis worker calls, and what the build path reuses for
 * its diagnostics. It is deliberately free of any Node or VS Code specifics so
 * it can be unit-tested directly.
 */

import { analyze as compilerAnalyze, capabilities, type ReadFile, type RunResult } from './bridge';
import {
	indexTokenLocations,
	normaliseDiagnostics,
	type TokenLocationIndex,
} from './diagnostics';
import { buildDocumentIndex } from './symbols';
import type { AnalysisRequest, AnalysisResponse, CompilerDiagnostic } from '../common/types';

export interface AnalysisHost {
	/** Reads a file from disk, or returns null. Called for `#include` only. */
	readFile: ReadFile;
	/** fs path of the document, or null when it has never been saved. */
	pathOf(uri: string): string | null;
}

function lineCount(text: string): number {
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

/**
 * Attribute diagnostics to files.
 *
 * The compiler reports positions relative to whichever file raised them, and
 * nothing says which file that was (see src/compiler/diagnostics.ts). The token
 * stream does record it, so it is used to reconstruct the answer.
 */
export function attributeDiagnostics(
	errors: readonly { message: string }[],
	warnings: readonly { message: string }[],
	tokens: RunResult['tokens'],
	mainPath: string | null,
	sources: Map<string, string>
): { errors: CompilerDiagnostic[]; warnings: CompilerDiagnostic[] } {
	const lineCounts = new Map<string, number>();
	for (const [path, text] of sources) lineCounts.set(path, lineCount(text));
	const index: TokenLocationIndex = indexTokenLocations(tokens, mainPath, lineCounts);

	const convert = (
		list: readonly { message: string }[],
		severity: 'error' | 'warning'
	): CompilerDiagnostic[] =>
		normaliseDiagnostics(list as never[], index, mainPath).map(diagnostic => ({
			severity,
			message: diagnostic.message,
			...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
			...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
			...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
		}));

	return { errors: convert(errors, 'error'), warnings: convert(warnings, 'warning') };
}

/**
 * Analyse a document and build its index.
 *
 * The index is built even when the file has errors -- that is when the editor
 * needs it most -- because the semantic analyser annotates the parts of the AST
 * it understood before giving up.
 */
export async function analyse(
	request: AnalysisRequest,
	host: AnalysisHost
): Promise<AnalysisResponse> {
	const mainPath = host.pathOf(request.uri);
	const result = await compilerAnalyze({
		source: request.text,
		target: {
			targetVersion: request.targetVersion,
			memoryBlocks: request.memoryBlocks,
			includePaths: request.includePaths,
		},
		filePath: mainPath,
		readFile: host.readFile,
	});

	return fromRun(request, result, mainPath);
}

/** The part of `analyse` that only needs a completed run, for testing. */
export function fromRun(
	request: AnalysisRequest,
	result: RunResult,
	mainPath: string | null
): AnalysisResponse {
	const { errors, warnings } = attributeDiagnostics(
		result.errors,
		result.warnings,
		result.tokens,
		mainPath,
		result.sources
	);

	const index = buildDocumentIndex({
		ast: result.ast,
		version: request.version,
		uri: request.uri,
		mainPath,
		sources: result.sources,
		includes: result.includes,
		...(result.fatalError ? { internalError: firstLine(result.fatalError) } : {}),
	});

	return {
		id: request.id,
		uri: request.uri,
		diagnostics: [...errors, ...warnings],
		index,
		...(result.fatalError ? { fatal: result.fatalError } : {}),
	};
}

function firstLine(text: string): string {
	const index = text.indexOf('\n');
	return index < 0 ? text : text.slice(0, index);
}

/**
 * Whether diagnostics are being produced by the slow path.
 *
 * Without patch 0001 every keystroke pays for a full build, which on a large
 * file is tens of seconds; the caller surfaces this in the status bar.
 */
export const diagnosticsAreSlow = !capabilities.analyze;
