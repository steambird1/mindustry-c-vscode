/*
 * The one place that knows how to drive the Mindustry-C compiler.
 *
 * Everything above this file (the language server, the build worker, the config
 * UI) talks to this module and never to the compiler directly. That is
 * deliberate: the compiler is young and its internals move, so the coupling is
 * kept small, feature-detected, and documented in docs/COMPILER-INTEGRATION.md.
 *
 * The compiler is ESM without a package.json of its own, so esbuild bundles it
 * into `out/compiler/mindc.cjs` (see scripts/build.mjs) and this module requires
 * that bundle.
 */

const loaded = require('../../out/compiler/mindc.cjs') as CompilerModule;

/* ------------------------------------------------------------------ *
 * Structural types
 *
 * Declared locally rather than imported: the compiler ships no type
 * definitions, and if its shape changes the compiler should fail to build here
 * (one file) rather than anywhere else in the extension.
 * ------------------------------------------------------------------ */

export interface AttributeClass {
	getAttribute(name: string): unknown;
	setAttribute(name: string, value: unknown): AttributeClass;
	hasAttribute(name: string): boolean;
}

export interface CompilerDiagnostic {
	message: string;
	line?: number | { line: number; column: number; index?: number; filename?: string };
	column?: number;
	[key: string]: unknown;
}

export interface TokenLocation {
	line: number;
	column: number;
	index?: number;
	filename?: string;
}

export interface TokenLike {
	value?: string;
	location?: TokenLocation;
}

export interface MemoryBlockLike {
	name: string;
	size: number;
}

export interface CompileResult {
	success: boolean;
	code: string;
	errors?: CompilerDiagnostic[];
	warnings?: CompilerDiagnostic[];
	fatalError?: string;
}

export interface AnalyzeResult {
	ast: unknown;
	ok: boolean;
	errors: CompilerDiagnostic[];
	warnings: CompilerDiagnostic[];
	fatalError?: string;
}

export interface LexerLike {
	tokens: TokenLike[];
	errors: CompilerDiagnostic[];
	tokenize(): Promise<{ tokens: TokenLike[] }>;
	includeResolver?: unknown;
	filename?: string | null;
	/** Name -> replacement, for every macro the lexer defined. */
	macros?: Record<string, unknown>;
}

export interface CompilerLike {
	lexer: LexerLike;
	compile(): Promise<CompileResult>;
	analyze?(): Promise<AnalyzeResult>;
	prepare?(): Promise<unknown>;
}

export interface CompilerModule {
	Compiler: new (
		source: string,
		memory: MemoryBlockLike[],
		config: AttributeClass
	) => CompilerLike;
	AttributeClass: new () => AttributeClass;
	MemoryBlock: new (name: string, size: number) => MemoryBlockLike;
	Lexer: new (
		source: string,
		macros?: Record<string, string>,
		suppressMacroExpansion?: boolean,
		macroParams?: Record<string, unknown>,
		options?: { includeResolver?: unknown; filename?: string | null }
	) => LexerLike;
}

/* ------------------------------------------------------------------ *
 * Capability detection
 * ------------------------------------------------------------------ */

/**
 * What the bundled compiler supports.
 *
 * `analyze` and the include resolver come from patches (see
 * docs/COMPILER-INTEGRATION.md). If a future build of the compiler drops them
 * the bridge degrades rather than breaking: without `analyze`, diagnostics come
 * from a full `compile()`; without `includeResolver`, `#include` is reported
 * rather than silently ignored.
 */
export const capabilities = {
	/** `Compiler#analyze()`: parse + semantics, skipping the optimiser. */
	analyze: typeof loaded.Compiler.prototype.analyze === 'function',
	/** `Compiler#prepare()`: tokenise + read pragmas without compiling. */
	prepare: typeof loaded.Compiler.prototype.prepare === 'function',
	/** `Lexer` options argument: host-provided `#include` resolution. */
	includeResolver: false as boolean,
} as const;

// Detected on an instance rather than on the prototype: the field is set in the
// constructor, so only an instance can answer for it.
function detectIncludeResolver(): boolean {
	try {
		const lexer = new loaded.Lexer('', {}, true, {});
		return 'includeResolver' in lexer;
	} catch {
		return false;
	}
}
(capabilities as { includeResolver: boolean }).includeResolver = detectIncludeResolver();

/* ------------------------------------------------------------------ *
 * Configuration -> compiler
 * ------------------------------------------------------------------ */

export interface CompilerTarget {
	targetVersion: number;
	memoryBlocks: MemoryBlockLike[];
	/** Absolute directories searched for `#include`, in order. */
	includePaths: string[];
}

export function makeMemoryBlocks(blocks: { name: string; size: number }[]): MemoryBlockLike[] {
	const MemoryBlock = loaded.MemoryBlock;
	return blocks.map(block => new MemoryBlock(block.name, Math.max(1, Math.floor(block.size))));
}

export function makeConfig(targetVersion: number): AttributeClass {
	const config = new loaded.AttributeClass();
	config.setAttribute('targetVersion', targetVersion);
	return config;
}

/* ------------------------------------------------------------------ *
 * Paths
 *
 * Only what include resolution needs, kept local so this module does not
 * depend on the host's path style (the extension runs on Windows, macOS and
 * Linux from the same bundle).
 * ------------------------------------------------------------------ */

export function isWindowsPath(path: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function separatorFor(path: string): string {
	return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

export function dirname(path: string): string | null {
	const normalised = path.replace(/[\\/]+$/, '');
	const separator = Math.max(normalised.lastIndexOf('/'), normalised.lastIndexOf('\\'));
	if (separator < 0) return null;
	// The directory of a file at a root is that root. An empty string would turn
	// `/header.h`'s include into a relative path, and `C:` alone is *drive
	// relative* on Windows -- resolved against the process's current directory --
	// so the separator has to stay.
	if (separator === 0) return normalised[0];
	if (separator === 2 && isWindowsPath(normalised)) return normalised.slice(0, 3);
	return normalised.slice(0, separator);
}

export function joinPath(base: string, relative: string): string {
	if (isWindowsPath(relative) || relative.startsWith('/')) return relative;
	const separator = separatorFor(base);
	return base.replace(/[\\/]+$/, '') + separator + relative.replace(/[\\/]/g, separator);
}

/* ------------------------------------------------------------------ *
 * Include resolution
 * ------------------------------------------------------------------ */

export type ReadFile = (path: string) => string | null;

export interface IncludeTracker {
	/** Every file that was read, with its text. Keyed by resolved fs path. */
	sources: Map<string, string>;
	/** The includes, in the order they were resolved. */
	includes: string[];
}

/**
 * Search order for `#include "x.h"`:
 *
 *  1. the including file's own directory (so a header next to its user works),
 *  2. the main file's directory,
 *  3. each configured `includePaths` entry, in order.
 *
 * Quoted and angled includes are treated the same; the compiler has no
 * distinction between them today.
 */
export function includeCandidates(
	filename: string,
	from: string | null,
	mainPath: string | null,
	includePaths: readonly string[]
): string[] {
	const roots: string[] = [];
	const push = (root: string | null) => {
		if (root && !roots.includes(root)) roots.push(root);
	};
	push(from ? dirname(from) : null);
	push(mainPath ? dirname(mainPath) : null);
	for (const entry of includePaths) push(entry);

	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const root of roots) {
		const candidate = joinPath(root, filename);
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
	}
	return candidates;
}

/**
 * A resolver for patch 0002.
 *
 * `.js` includes are compiler extensions: the host would have to load and
 * evaluate them, which this resolver deliberately does not do, so they are
 * reported as unresolved rather than mis-read as C source.
 */
export function createIncludeResolver(
	readFile: ReadFile,
	includePaths: readonly string[],
	mainPath: string | null,
	tracker: IncludeTracker
): (filename: string, from: string | null) => Promise<{ text: string; path: string } | null> {
	return async (filename, from) => {
		if (/\.[cm]?js$/i.test(filename)) return null;
		for (const candidate of includeCandidates(filename, from, mainPath, includePaths)) {
			const text = readFile(candidate);
			if (text === null) continue;
			tracker.sources.set(candidate, text);
			if (!tracker.includes.includes(candidate)) tracker.includes.push(candidate);
			return { text, path: candidate };
		}
		return null;
	};
}

/* ------------------------------------------------------------------ *
 * Running the compiler
 * ------------------------------------------------------------------ */

export interface RunOptions {
	source: string;
	target: CompilerTarget;
	/** Absolute path of the file, so `#include` resolves relative to it. */
	filePath?: string | null;
	readFile?: ReadFile;
}

export interface RunResult {
	success: boolean;
	/** Generated mlog; empty for analysis-only runs. */
	code: string;
	errors: CompilerDiagnostic[];
	warnings: CompilerDiagnostic[];
	fatalError?: string;
	/** The analysed AST, for the symbol index. Null when analysis crashed. */
	ast: unknown;
	/** Merged token stream, used to attribute diagnostics to included files. */
	tokens: TokenLike[];
	/** Text of every file that took part, keyed by fs path. */
	sources: Map<string, string>;
	/** Files pulled in by #include. */
	includes: string[];
	/** Macro names the lexer defined, for highlighting their uses. */
	macros: string[];
	elapsedMs: number;
}

function createCompiler(options: RunOptions, tracker: IncludeTracker): CompilerLike {
	const compiler = new loaded.Compiler(
		options.source,
		makeMemoryBlocks(options.target.memoryBlocks),
		makeConfig(options.target.targetVersion)
	);

	// Patch 0002: hand the lexer a resolver so `#include` works off disk. When
	// the compiler lacks the hook, includes are reported as errors by the
	// compiler itself, which is honest.
	if (capabilities.includeResolver && options.readFile) {
		const includeResolver = createIncludeResolver(
			options.readFile,
			options.target.includePaths,
			options.filePath ?? null,
			tracker
		);
		// Install the resolver on the compiler's own lexer instead of replacing
		// it. The constructor puts `__MINDC_TARGET_VERSION__` in this lexer's
		// macro table and records options such as `legacy_char_string` on it; a
		// fresh lexer would silently lose both, so `#if` over the target version
		// would take the wrong branch.
		compiler.lexer.includeResolver = includeResolver;
		compiler.lexer.filename = options.filePath ?? null;
	}
	return compiler;
}

async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
	const start = Date.now();
	const value = await fn();
	return { value, elapsedMs: Date.now() - start };
}

function finish(
	compiler: CompilerLike,
	tracker: IncludeTracker,
	options: RunOptions,
	elapsedMs: number,
	partial: Partial<RunResult>
): RunResult {
	const sources = new Map(tracker.sources);
	if (options.filePath) sources.set(options.filePath, options.source);
	return {
		success: false,
		code: '',
		errors: [],
		warnings: [],
		ast: null,
		tokens: compiler.lexer?.tokens ?? [],
		sources,
		includes: tracker.includes,
		macros: macroNames(compiler),
		elapsedMs,
		...partial,
	};
}

/**
 * The macro names the lexer ended up with, including ones from `#include`d
 * files. Read from the instance rather than the source, because `#define` is
 * the lexer's business and macro parameters are not distinguishable afterwards.
 */
function macroNames(compiler: CompilerLike): string[] {
	const macros = compiler.lexer?.macros;
	return macros && typeof macros === 'object' ? Object.keys(macros) : [];
}

/**
 * Parse + semantic analysis only: the path behind live diagnostics.
 *
 * ~130 ms on a 100 KB file, against ~36 s for a full build, because the
 * optimiser's fixed-point loop is skipped entirely.
 */
export async function analyze(options: RunOptions): Promise<RunResult> {
	if (!capabilities.analyze) {
		// No `analyze()`: a full compile is the only way to get diagnostics.
		// Still correct, just slow, so callers warn about the latency.
		return compile(options);
	}
	const tracker: IncludeTracker = { sources: new Map(), includes: [] };
	try {
		const compiler = createCompiler(options, tracker);
		const { value, elapsedMs } = await measure(() => compiler.analyze!());
		return finish(compiler, tracker, options, elapsedMs, {
			success: value.ok && !value.fatalError,
			errors: value.errors ?? [],
			warnings: value.warnings ?? [],
			...(value.fatalError ? { fatalError: value.fatalError } : {}),
			ast: value.ast ?? null,
		});
	} catch (error) {
		return crashed(error, tracker, options);
	}
}

/** The full pipeline, including the optimiser and the code generator. */
export async function compile(options: RunOptions): Promise<RunResult> {
	const tracker: IncludeTracker = { sources: new Map(), includes: [] };
	try {
		const compiler = createCompiler(options, tracker);
		const { value, elapsedMs } = await measure(() => compiler.compile());
		return finish(compiler, tracker, options, elapsedMs, {
			success: value.success,
			code: value.code ?? '',
			errors: value.errors ?? [],
			warnings: value.warnings ?? [],
			...(value.fatalError ? { fatalError: value.fatalError } : {}),
		});
	} catch (error) {
		return crashed(error, tracker, options);
	}
}

function crashed(error: unknown, tracker: IncludeTracker, options: RunOptions): RunResult {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
	return {
		success: false,
		code: '',
		errors: [{ message }],
		warnings: [],
		fatalError: `${message}${stack}`,
		ast: null,
		tokens: [],
		sources: options.filePath ? new Map([[options.filePath, options.source]]) : new Map(),
		includes: tracker.includes,
		macros: [],
		elapsedMs: 0,
	};
}

/**
 * Silence the compiler's own logging. The optimiser prints a line per iteration
 * and dumps whole AST nodes at some stages; in a long-lived worker that is
 * thousands of lines per keystroke.
 */
export function silenceCompilerLogs(): void {
	const noop = () => {};
	console.log = noop;
	console.debug = noop;
	console.info = noop;
	// Warnings are kept: they may carry real information.
}
