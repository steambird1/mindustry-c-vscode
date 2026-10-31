/*
 * Wire types shared by the extension host, the language server and the workers.
 *
 * These mirror the configuration file (`mlgc.json`) on the way in, and the LSP
 * shapes on the way out. The compiler's own diagnostic shape
 * (`{ message, line, column }`, from `CompilationPhase#addError`) is
 * normalised into `CompilerDiagnostic` at the adapter boundary.
 */

export interface Position {
	line: number;
	character: number;
}

export interface Location {
	uri: string;
	range: Range;
}

/** A memory cell / bank, as configured. Order in the array is significant. */
export interface MemoryBlockConfig {
	/** Becomes `<name>_id` in the generated code. */
	name: string;
	/** Capacity in bytes. */
	size: number;
	/** The in-game building this corresponds to. Informational. */
	building?: 'memory-cell' | 'memory-bank' | 'world-cell' | 'unconfigured';
	/** Free text: where it is wired in the map. */
	note?: string;
}

export interface CompilerOptionsConfig {
	array?: boolean;
	constArray?: boolean;
	pointer?: boolean;
	structPointerThreshold?: number;
	stackCheck?: string;
	stackUnderflow?: string;
	noInline?: string[];
}

export type IdOverrides = Partial<Record<'item' | 'liquid' | 'unit' | 'block', Record<string, number | null>>>;

export interface ConfigurationProfile {
	name: string;
	targetVersion?: number;
	includePaths?: string[];
	memoryBlocks?: MemoryBlockConfig[];
	compilerOptions?: CompilerOptionsConfig;
	idOverrides?: IdOverrides;
}

/** The on-disk shape of `mlgc.json`. */
export interface ConfigurationFile {
	activeConfiguration?: string;
	configurations: ConfigurationProfile[];
	/** Which file this was read from; not part of the schema. */
	$source?: string;
}

/** A profile after merging and defaulting, as the compiler will see it. */
export interface EffectiveConfig {
	profileName: string;
	targetVersion: number;
	includePaths: string[];
	memoryBlocks: MemoryBlockConfig[];
	compilerOptions: Required<CompilerOptionsConfig>;
	idOverrides: IdOverrides;
	/** Where each field came from, for the "this comes from the workspace" hint. */
	sources: Record<string, 'global' | 'workspace' | 'default'>;
	globalPath: string | null;
	workspacePath: string | null;
	/** Problems found while merging; the UI shows these instead of failing. */
	problems: string[];
}

/* ------------------------------------------------------------------ *
 * Compiler-facing requests
 * ------------------------------------------------------------------ */

/** What a single analysis run needs to know. */
export interface AnalysisRequest {
	/** Monotonic id; the worker drops results for superseded ids. */
	id: number;
	uri: string;
	/** The document's version, recorded in the index so stale hits are visible. */
	version: number;
	text: string;
	/** Absolute directories to search for #include, in order. */
	includePaths: string[];
	memoryBlocks: MemoryBlockConfig[];
	targetVersion: number;
}

/**
 * Pushed to a worker whenever the editor's open buffers change.
 *
 * The worker is handed the map when its thread starts, but the thread lives on,
 * and a header edited afterwards would otherwise stay at whatever it was at
 * spawn time. There is no `id`: this is not a request and is never answered.
 */
export interface KnownDocumentsMessage {
	type: 'known-documents';
	/** uri -> buffer text, for every open file the editor has. */
	documents: Record<string, string>;
}

export interface CompilerDiagnostic {
	message: string;
	/** 1-based, as the compiler reports. */
	line?: number;
	column?: number;
	severity: 'error' | 'warning';
	/** fs path of the file the diagnostic belongs to, when it came from an #include. */
	path?: string;
}

/* ------------------------------------------------------------------ *
 * Language-server-facing results
 * ------------------------------------------------------------------ */

export interface Range {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

/**
 * A resolved symbol, flattened out of the compiler's scope tree.
 *
 * `path` is an fs path rather than a URI: the index is built in a worker that
 * only ever sees paths, and the server is the only place that maps them.
 */
export interface SymbolInfo {
	/** Compiler `SymbolEntry.kind`: variable | function | parameter | type. */
	kind: 'variable' | 'function' | 'parameter' | 'type' | 'field' | string;
	name: string;
	/** Rendered type, e.g. `int`, `int *`, `struct vec3`, `int(int, int)`. */
	type: string;
	/** Where the declaration sits. The outline shows only `file` scope. */
	scope: 'file' | 'local';
	/** File the symbol is declared in. */
	path: string | null;
	/** Declaration site, LSP-style (0-based). */
	range: Range;
	/** Character offset of the declaration's name within `path`. */
	declarationOffset: number;
	/**
	 * For a field, the struct or union that declares it.
	 *
	 * Carried because the compiler's `MemberExpression` throws the member's
	 * identity away -- the node has a name but no location, no symbol and no
	 * type -- so without this the only way to say which struct a `p.x` belongs
	 * to is to read the text in front of the dot.
	 */
	container?: string;
	/**
	 * For a function, its parameters in source order.
	 *
	 * `type` alone renders as `int(int, int)`; signature help wants the names,
	 * and wants to know which `(void)` means "no parameters".
	 */
	parameters?: ParameterInfo[];
	/**
	 * For a local, the function whose body declares it.
	 *
	 * Completion uses this to stop offering another function's locals; the index
	 * has no block ranges, so the function is the finest granularity available.
	 */
	owner?: string;
}

/** One entry in a function's parameter list. */
export interface ParameterInfo {
	/** The name, when the declaration has one: a lone `void` has none. */
	name: string | null;
	/** Rendered type, e.g. `int *`. */
	type: string;
}

/** A struct/union/enum, with the members completion needs after a `.`. */
export interface StructInfo {
	name: string;
	path: string;
	range: Range;
	members: Array<{
		name: string;
		/** Source text of the declared type, e.g. `int *`. */
		type: string;
		/** Character offset of the member's name within `path`. */
		offset: number;
		bitField?: string;
	}>;
}

/** One resolved reference to a symbol, used by hover/definition/references/rename. */
export interface ReferenceInfo {
	/** File the reference is written in. */
	path: string | null;
	range: Range;
	/** Character offset of the name within `path`. */
	offset: number;
	/** True at the declaration site itself. */
	isDeclaration: boolean;
	/** The symbol this reference resolves to, if it could be resolved. */
	target: SymbolInfo | null;
}

/** What the index of one document contains. */
export interface DocumentIndex {
	uri: string;
	version: number;
	/** Resolved references, ordered by offset. */
	references: ReferenceInfo[];
	/** Declarations only, for the outline and workspace symbols. */
	symbols: SymbolInfo[];
	/** Structs with their members, for completion after `.`. */
	structs: StructInfo[];
	/** Files pulled in by #include, so the server can watch them. */
	includes: string[];
	/** Macro names the lexer defined, so their uses can be highlighted. */
	macros?: string[];
	/** Set when analysis failed outright (a compiler crash). */
	internalError?: string;
}

export interface AnalysisResponse {
	id: number;
	uri: string;
	diagnostics: CompilerDiagnostic[];
	index: DocumentIndex | null;
	/** Set when the run itself failed, e.g. a worker crash. */
	fatal?: string;
}

/* ------------------------------------------------------------------ *
 * Build-facing requests
 * ------------------------------------------------------------------ */

export interface BuildRequest {
	id: number;
	uri: string;
	text: string;
	config: EffectiveConfig;
}

export interface BuildResponse {
	id: number;
	ok: boolean;
	success: boolean;
	/** Generated mlog, or '' on failure. */
	code: string;
	instructionCount: number;
	errors: CompilerDiagnostic[];
	warnings: CompilerDiagnostic[];
	fatalError?: string;
	elapsedMs: number;
}

/* ------------------------------------------------------------------ *
 * Extension <-> webview
 * ------------------------------------------------------------------ */

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'save'; profile: ConfigurationProfile }
	| { type: 'saveGlobal'; profile: ConfigurationProfile }
	| { type: 'addProfile'; name: string }
	| { type: 'removeProfile'; name: string }
	| { type: 'activate'; name: string }
	| { type: 'openFile' }
	| { type: 'ensureGlobal' };

/** The panel -> extension direction. */
export type HostMessage = { type: 'notify'; message: string } | { type: 'error'; message: string };

export interface WebviewState {
	/** The merged configuration, or null before anything is loaded. */
	config: EffectiveConfig | null;
	/** Every profile from both files, merged. */
	profiles: ConfigurationProfile[];
	/** The profile in effect, if any. */
	activeName: string | null;
	/** Global config file path, for display. */
	globalPath: string | null;
	workspacePath: string | null;
	workspaceTrusted: boolean;
	/** Whether each file exists on disk, so the UI can say so. */
	hasGlobalFile: boolean;
	hasWorkspaceFile: boolean;
}
