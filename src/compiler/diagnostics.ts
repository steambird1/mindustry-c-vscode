/*
 * Turning the compiler's diagnostics into something the editor can show.
 *
 * Two problems to solve, both documented in docs/COMPILER-INTEGRATION.md:
 *
 * 1. The shape varies by call site. `CompilationPhase#addError(message, line)`
 *    stores whatever it is given, so some diagnostics carry `line`/`column` and
 *    some carry a whole location object (or nothing at all).
 *
 * 2. There is no file. A diagnostic raised while analysing an `#include`d file
 *    reports the position *within that file* (each file restarts at line 1),
 *    but nothing says which file. Left alone it would be reported in the file
 *    the user is editing, which is wrong and confusing.
 *
 * For (2) we use the token stream: every token records the file it came from,
 * so the (line, column) of a diagnostic identifies its file whenever a token
 * sits there. Diagnostics that match no token (a lexer error at end of file,
 * say) fall back to the file being edited.
 */

export interface RawLocation {
	line?: number;
	column?: number;
	index?: number;
	filename?: string;
	length?: number;
	endLine?: number;
	endColumn?: number;
}

export interface RawRelated {
	message?: string;
	location?: RawLocation;
	range?: { start?: RawLocation; end?: RawLocation };
}

export interface RawFix {
	range?: { start?: RawLocation; end?: RawLocation };
	text?: string;
}

/** What the compiler pushes into `errors` / `warnings`. */
export interface RawDiagnostic {
	message: string;
	line?: number | RawLocation | null;
	column?: number | RawLocation | null;
	location?: RawLocation;
	severity?: string;
	stage?: string;
	code?: string;
	range?: { start?: RawLocation; end?: RawLocation };
	endLine?: number;
	endColumn?: number;
	related?: RawRelated[];
	hints?: Array<string | { message?: string }>;
	fix?: RawFix;
	[key: string]: unknown;
}

export interface NormalisedDiagnostic {
	message: string;
	/** 1-based, as the compiler reports it. Absent when the compiler gave none. */
	line?: number;
	/** 1-based. Absent when the compiler gave none. */
	column?: number;
	/** End of the compiler's range, 1-based. Absent when it only gave a point. */
	endLine?: number;
	endColumn?: number;
	severity?: 'error' | 'warning' | 'note';
	code?: string;
	stage?: string;
	/** fs path of the file the diagnostic belongs to, when it is known. */
	path?: string;
	related?: Array<Required<Pick<NormalisedDiagnostic, 'message'>> & {
		path?: string;
		line?: number;
		column?: number;
		endLine?: number;
		endColumn?: number;
	}>;
	hints?: string[];
	fix?: {
		path?: string;
		line: number;
		column: number;
		endLine: number;
		endColumn: number;
		text: string;
	};
}

/** Enough of the token stream to attribute a position to a file. */
export interface TokenLocationIndex {
	/** "line:column" -> the files that have a token there (main file first). */
	byPosition: Map<string, string[]>;
	/** Paths seen anywhere in the stream, main file first, deduplicated. */
	files: string[];
	/** Line count per file, for the fallback. */
	linesByFile: Map<string, number>;
}

const key = (line: number, column: number): string => `${line}:${column}`;

function locationOf(diagnostic: RawDiagnostic): RawLocation | null {
	if (diagnostic.location && typeof diagnostic.location === 'object') {
		return diagnostic.location;
	}
	// Some call sites pass the whole location as the second argument.
	if (diagnostic.line && typeof diagnostic.line === 'object') {
		return diagnostic.line;
	}
	return null;
}

/** Where the diagnostic starts, from the old shape or the structured range. */
function startOf(diagnostic: RawDiagnostic): RawLocation | null {
	const location = locationOf(diagnostic);
	if (location) return location;
	const start = diagnostic.range?.start;
	return start && typeof start === 'object' ? start : null;
}

/** Where the diagnostic ends, if the compiler gave a range. */
function endOf(diagnostic: RawDiagnostic): RawLocation | null {
	const end = diagnostic.range?.end;
	if (end && typeof end === 'object') return end;
	if (typeof diagnostic.endLine === 'number' || typeof diagnostic.endColumn === 'number') {
		return { line: diagnostic.endLine, column: diagnostic.endColumn };
	}
	return null;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Build the position -> file index from a merged token stream.
 *
 * Tokens from an `#include` keep the filename of the file they came from, which
 * is the only record of the include graph's file boundaries.
 */
export function indexTokenLocations(
	tokens: ReadonlyArray<{ location?: RawLocation }> | undefined,
	mainPath: string | null,
	lineCounts?: ReadonlyMap<string, number>
): TokenLocationIndex {
	const byPosition = new Map<string, string[]>();
	const files: string[] = [];
	const linesByFile = new Map<string, number>();

	const note = (path: string) => {
		if (!files.includes(path)) files.push(path);
	};

	if (mainPath) {
		note(mainPath);
		if (lineCounts?.has(mainPath)) linesByFile.set(mainPath, lineCounts.get(mainPath)!);
	}

	for (const token of tokens ?? []) {
		const location = token.location;
		if (!location || !location.filename) continue;
		const line = number(location.line);
		const column = number(location.column);
		if (line === undefined || column === undefined) continue;
		note(location.filename);
		const existing = byPosition.get(key(line, column));
		if (existing) {
			if (!existing.includes(location.filename)) existing.push(location.filename);
		} else {
			byPosition.set(key(line, column), [location.filename]);
		}
		const highest = linesByFile.get(location.filename) ?? 0;
		if (line > highest) linesByFile.set(location.filename, line);
	}

	return { byPosition, files, linesByFile };
}

/**
 * Decide which file a diagnostic belongs to.
 *
 * Order of preference:
 *  1. an explicit filename, if the diagnostic ever grows one;
 *  2. a token of an included file at exactly that position;
 *  3. the main file;
 *
 * Step 2 deliberately prefers an include over the main file. Two files can hold
 * a token at the same line and column (a lone `;` in both), and when that
 * happens the include is the likelier culprit for a diagnostic that mentions
 * something the main file does not declare. This is a heuristic, and the
 * alternative -- silently reporting an include's error in the wrong file -- is
 * worse.
 */
export function attributePath(
	diagnostic: RawDiagnostic,
	index: TokenLocationIndex,
	mainPath: string | null
): string | null {
	const location = startOf(diagnostic);
	if (location?.filename) return location.filename;

	const line = number(location?.line) ?? number(diagnostic.line);
	const column = number(location?.column) ?? number(diagnostic.column);
	if (line === undefined) return mainPath;

	const candidates = column === undefined ? undefined : index.byPosition.get(key(line, column));
	if (candidates && candidates.length > 0) {
		const include = candidates.find(path => path !== mainPath);
		return include ?? candidates[0];
	}

	if (column === undefined) {
		// Without a column only the line is known. A diagnostic on a line past
		// the end of the main file can only have come from an include.
		const mainLines = mainPath ? index.linesByFile.get(mainPath) ?? 0 : 0;
		if (line > mainLines) {
			const owner = index.files.find(path => (index.linesByFile.get(path) ?? 0) >= line);
			if (owner) return owner;
		}
	}

	return mainPath;
}

/**
 * Normalise one diagnostic. `severity` handling and LSP conversion happen in
 * the server; this only fixes up the shape and the file.
 */
export function normaliseDiagnostic(
	diagnostic: RawDiagnostic,
	index: TokenLocationIndex,
	mainPath: string | null
): NormalisedDiagnostic {
	const start = startOf(diagnostic);
	const end = endOf(diagnostic);
	const line = number(start?.line) ?? number(diagnostic.line);
	const column = number(start?.column) ?? number(diagnostic.column);
	const endLine = number(end?.line) ?? number(diagnostic.endLine);
	const endColumn = number(end?.column) ?? number(diagnostic.endColumn);
	const path = attributePath(diagnostic, index, mainPath);

	const message = typeof diagnostic.message === 'string' ? diagnostic.message : String(diagnostic.message);
	const severity =
		diagnostic.severity === 'error' ||
		diagnostic.severity === 'warning' ||
		diagnostic.severity === 'note'
			? diagnostic.severity
			: undefined;
	const code = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
	const stage = typeof diagnostic.stage === 'string' ? diagnostic.stage : undefined;
	const related = relatedOf(diagnostic, index, mainPath, path);
	const hints = hintsOf(diagnostic.hints);
	const fix = fixOf(diagnostic, index, mainPath, path);

	return {
		message,
		...(line === undefined ? {} : { line }),
		...(column === undefined ? {} : { column }),
		...(endLine === undefined ? {} : { endLine }),
		...(endColumn === undefined ? {} : { endColumn }),
		...(severity ? { severity } : {}),
		...(code ? { code } : {}),
		...(stage ? { stage } : {}),
		...(path ? { path } : {}),
		...(related.length ? { related } : {}),
		...(hints.length ? { hints } : {}),
		...(fix ? { fix } : {}),
	};
}

function relatedOf(
	diagnostic: RawDiagnostic,
	index: TokenLocationIndex,
	mainPath: string | null,
	fallbackPath: string | null
): NonNullable<NormalisedDiagnostic['related']> {
	const related: NonNullable<NormalisedDiagnostic['related']> = [];
	for (const item of Array.isArray(diagnostic.related) ? diagnostic.related : []) {
		if (!item || typeof item !== 'object') continue;
		const start = item.range?.start ?? item.location ?? null;
		const end = item.range?.end ?? null;
		const line = number(start?.line);
		const column = number(start?.column);
		const endLine = number(end?.line);
		const endColumn = number(end?.column);
		const path =
			line !== undefined
				? attributePath({ message: '', line, column }, index, mainPath)
				: fallbackPath;
		related.push({
			message: typeof item.message === 'string' ? item.message : '',
			...(path ? { path } : {}),
			...(line === undefined ? {} : { line }),
			...(column === undefined ? {} : { column }),
			...(endLine === undefined ? {} : { endLine }),
			...(endColumn === undefined ? {} : { endColumn }),
		});
	}
	return related;
}

function hintsOf(hints: RawDiagnostic['hints']): string[] {
	const result: string[] = [];
	for (const hint of Array.isArray(hints) ? hints : []) {
		const text = typeof hint === 'string' ? hint : hint?.message;
		if (typeof text === 'string' && text.length > 0) result.push(text);
	}
	return result;
}

function fixOf(
	diagnostic: RawDiagnostic,
	index: TokenLocationIndex,
	mainPath: string | null,
	fallbackPath: string | null
): NormalisedDiagnostic['fix'] {
	const fix = diagnostic.fix;
	if (!fix || typeof fix.text !== 'string' || fix.text.length === 0) return undefined;
	const start = fix.range?.start;
	const end = fix.range?.end;
	const line = number(start?.line);
	const column = number(start?.column);
	if (line === undefined || column === undefined) return undefined;
	const endLine = number(end?.line) ?? line;
	const endColumn = number(end?.column) ?? column;
	const path =
		attributePath({ message: '', line, column }, index, mainPath) ?? fallbackPath;
	return {
		...(path ? { path } : {}),
		line,
		column,
		endLine,
		endColumn,
		text: fix.text,
	};
}

export function normaliseDiagnostics(
	diagnostics: readonly RawDiagnostic[] | undefined,
	index: TokenLocationIndex,
	mainPath: string | null
): NormalisedDiagnostic[] {
	return (diagnostics ?? []).map(diagnostic => normaliseDiagnostic(diagnostic, index, mainPath));
}
