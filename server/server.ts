/*
 * The Mindustry-C language server.
 *
 * It owns three things: the open documents, the symbol indexes built from them,
 * and the compiler analysis worker. Everything expensive happens in the worker;
 * this process only turns indexes into LSP replies.
 *
 * It is launched by the extension over stdio, so nothing here may write to
 * stdout: `console.log` is redirected to stderr below, and the workers silence
 * the compiler's own logging for the same reason.
 */

import {
	createConnection,
	CodeActionKind,
	CompletionItemKind as LspCompletionItemKind,
	DiagnosticSeverity,
	DidChangeWatchedFilesNotification,
	ProposedFeatures,
	SymbolKind as LspSymbolKind,
	type CompletionItem as LspCompletionItem,
	type Connection,
	type Diagnostic,
	type InitializeResult,
	type InitializeParams,
	type TextDocumentPositionParams,
	type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { URI } from 'vscode-uri';

import { AnalysisWorkerHost, defaultWorkerPath } from '../src/compiler/analysisSupervisor';
import { diagnosticsAreSlow } from '../src/compiler/analysis';
import { samePath } from '../src/compiler/documentAccess';
import type { AnalysisResponse, CompilerDiagnostic, EffectiveConfig } from '../src/common/types';
import {
	canRename,
	complete,
	definition,
	hover,
	offsetOf,
	outline,
	quickFixes,
	references,
	rename,
	semanticTokens,
	signatureHelp,
	SEMANTIC_TOKEN_MODIFIERS,
	SEMANTIC_TOKEN_TYPES,
	type CompletionItem,
	type IndexedDocument,
} from './features';

console.log = (...args: unknown[]) => console.error(...args);

const connection: Connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

/* ------------------------------------------------------------------ *
 * Settings and configuration
 * ------------------------------------------------------------------ */

interface Settings {
	diagnostics: { enable: boolean; debounce: number; openIncludes: boolean };
	compile: { showPreview: boolean; largeFileWarningChars: number };
}

const DEFAULT_SETTINGS: Settings = {
	diagnostics: { enable: true, debounce: 400, openIncludes: true },
	compile: { showPreview: true, largeFileWarningChars: 30000 },
};

let settings = DEFAULT_SETTINGS;
/** Pushed by the extension whenever the merged `mlgc.json` changes. */
let effectiveConfig: EffectiveConfig | null = null;

/* ------------------------------------------------------------------ *
 * Indexes
 * ------------------------------------------------------------------ */

const indexes = new Map<string, IndexedDocument>();
const pendingTimers = new Map<string, NodeJS.Timeout>();
/**
 * Documents whose semantic tokens were asked for before an index existed.
 *
 * The client requests them immediately on `didOpen`, while analysis is still in
 * its debounce window; returning empty is right, but the client does not ask
 * again on its own -- only an edit or a theme change re-triggers it. So the
 * publish below asks for a refresh once the index is there.
 */
const semanticRefreshPending = new Set<string>();
let worker: AnalysisWorkerHost | null = null;
let watchedDirectories = new Set<string>();
let watcherRegistered = false;

function toUri(fsPath: string): string {
	return URI.file(fsPath).toString();
}

function fromUri(uri: string): string | null {
	try {
		const parsed = URI.parse(uri);
		return parsed.scheme === 'file' ? parsed.fsPath : null;
	} catch {
		return null;
	}
}

/**
 * Which document a diagnostic belongs to, given the file it came from.
 *
 * The uri the client sent and `URI.file(path).toString()` are the same string
 * only when the client spelled it the way vscode-uri does: on Windows the drive
 * colon is percent-encoded or left alone depending on which side built the
 * text, and the filesystem accepts both. A diagnostic published under the other
 * spelling lands on a document the editor does not have, so the file it belongs
 * to keeps its previous squiggles and looks checked.
 *
 * So the open documents are asked first. A path nobody has open falls back to
 * being turned into a uri, which is the right answer for a file nobody is
 * looking at either way.
 */
function documentUriFor(fsPath: string, mainUri: string): string {
	const main = fromUri(mainUri);
	if (main && samePath(main, fsPath)) return mainUri;
	for (const document of documents.all()) {
		const uri = fromUri(document.uri);
		if (uri && samePath(uri, fsPath)) return document.uri;
	}
	return toUri(fsPath);
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

connection.onInitialize((_params: InitializeParams): InitializeResult => {
	worker = new AnalysisWorkerHost({
		workerPath: defaultWorkerPath(__dirname),
		onResult: (response: AnalysisResponse) => publish(response),
		onCrash: reason => connection.console.warn(`Mindustry-C: ${reason}`),
	});
	connection.console.info(
		diagnosticsAreSlow
			? 'Mindustry-C: this compiler build has no analyze(); diagnostics use a full build and will lag on large files'
			: 'Mindustry-C: diagnostics use semantic analysis only'
	);

	return {
		capabilities: {
			textDocumentSync: { openClose: true, change: 1 },
			hoverProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			renameProvider: { prepareProvider: true },
			completionProvider: { triggerCharacters: ['.', '@'], resolveProvider: false },
			signatureHelpProvider: { triggerCharacters: ['(', ','] },
			codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
			semanticTokensProvider: {
				legend: {
					tokenTypes: [...SEMANTIC_TOKEN_TYPES],
					tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
				},
				full: true,
			},
			documentSymbolProvider: true,
		},
	};
});

connection.onInitialized(() => {
	void loadWorkspaceRoots().then(syncKnownDocuments);
});

connection.onShutdown(() => {
	for (const timer of pendingTimers.values()) clearTimeout(timer);
	pendingTimers.clear();
	void worker?.dispose();
});

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

/**
 * Text the workers should serve from memory: every open file the editor has.
 *
 * Not just `.mlgc`. `#include` reaches for headers, and an unsaved header has
 * to resolve like any other buffer; leaving them out meant the include was
 * read from disk, or not found at all. Untitled documents are skipped -- an
 * `#include` names a path, and they have none.
 *
 * The map is pushed to a live worker (see `setKnownDocuments`), not only handed
 * over at spawn, so this runs before every analysis rather than once.
 */
let lastKnown: { uri: string; text: string }[] = [];

function syncKnownDocuments(): void {
	const current: { uri: string; text: string }[] = [];
	for (const document of documents.all()) {
		if (document.uri.startsWith('file:')) {
			current.push({ uri: document.uri, text: document.getText() });
		}
	}

	// `getText()` hands back the same string until the document changes, so
	// identity is enough to tell whether this push would say anything new.
	const unchanged =
		current.length === lastKnown.length &&
		current.every((entry, index) => {
			const previous = lastKnown[index];
			return previous !== undefined && previous.uri === entry.uri && previous.text === entry.text;
		});
	if (unchanged) return;

	lastKnown = current;
	worker?.setKnownDocuments(new Map(current.map(entry => [entry.uri, entry.text])));
}

/**
 * Re-analyse whatever included the file that just changed.
 *
 * `index.includes` only holds includes that resolved, which is exactly the set
 * that can be silently out of date: the file compiled, and the header it
 * compiled against has been edited since. A header that never resolved is
 * picked up on the next edit of the file that includes it.
 */
function scheduleDependents(changed: TextDocument): void {
	const changedPath = fromUri(changed.uri);
	if (!changedPath) return;
	for (const [uri, entry] of indexes) {
		if (!entry.index.includes.some(include => samePath(include, changedPath))) continue;
		const document = documents.get(uri);
		if (document) scheduleAnalysis(document);
	}
}

/**
 * Debounced here rather than in the worker host, so a settings change takes
 * effect without rebuilding the host.
 */
function scheduleAnalysis(document: TextDocument): void {
	if (document.languageId !== 'mlgc' || !settings.diagnostics.enable) return;
	// The timer defers the next request, but the edit already supersedes the one
	// that may be running: its result must not be published as current.
	worker?.invalidate(document.uri);
	const existing = pendingTimers.get(document.uri);
	if (existing) clearTimeout(existing);

	pendingTimers.set(
		document.uri,
		setTimeout(() => {
			pendingTimers.delete(document.uri);
			if (!worker) return;
			syncKnownDocuments();
			worker.analyse({
				uri: document.uri,
				version: document.version,
				text: document.getText(),
				includePaths: resolveIncludePaths(fromUri(document.uri)),
				memoryBlocks: effectiveConfig?.memoryBlocks ?? [],
				targetVersion: effectiveConfig?.targetVersion ?? 154.3,
			});
		}, settings.diagnostics.debounce)
	);
}

function resolveIncludePaths(documentPath: string | null): string[] {
	return (effectiveConfig?.includePaths ?? []).map(entry => resolveRelative(entry, documentPath));
}

/** Config paths may be absolute or relative to the file or the workspace root. */
function resolveRelative(entry: string, documentPath: string | null): string {
	if (path.isAbsolute(entry)) return path.normalize(entry);
	const roots: string[] = [];
	if (documentPath) roots.push(path.dirname(documentPath));
	roots.push(...workspaceRoots);
	for (const root of roots) {
		const candidate = path.resolve(root, entry);
		if (fs.existsSync(candidate)) return candidate;
	}
	return documentPath ? path.resolve(path.dirname(documentPath), entry) : path.resolve(entry);
}

/**
 * The workspace folders, resolved once.
 *
 * The client only reports them in response to a request, so they are fetched
 * during initialisation and cached: include resolution runs on every analysis.
 */
const workspaceRoots: string[] = [];

async function loadWorkspaceRoots(): Promise<void> {
	try {
		const response = await connection.workspace.getWorkspaceFolders();
		workspaceRoots.length = 0;
		for (const folder of response ?? []) {
			try {
				workspaceRoots.push(URI.parse(folder.uri).fsPath);
			} catch {
				workspaceRoots.push(folder.uri);
			}
		}
	} catch {
		workspaceRoots.length = 0;
	}
}

/**
 * Send one analysis result to the editor.
 *
 * Two things arrive here that are not findings about the file: a run that died
 * before it could read it, and a run whose index is from an older version of
 * the text. Both are handled below rather than left to look like a clean file.
 */
function publish(response: AnalysisResponse): void {
	const document = documents.get(response.uri);
	if (!document) return;

	// Only an index built from the text on screen may be used, both for features
	// and for squiggles: a stale one would point at the wrong characters.
	if (response.index && response.index.version === document.version) {
		indexes.set(response.uri, {
			uri: response.uri,
			index: response.index,
			text: document.getText(),
			mainPath: fromUri(response.uri),
		});
		if (semanticRefreshPending.delete(response.uri)) {
			// `refresh()` returns a promise at run time although its type says
			// void, and a client without refresh support rejects it.
			void Promise.resolve(connection.languages.semanticTokens.refresh()).catch(() => {});
		}
		if (settings.diagnostics.openIncludes) void watchIncludes(response.index.includes);
	}

	/*
	A run that died says nothing about the file, and this is also where the
	previous run's squiggles are cleared -- which a reader takes as "it compiles
	now". The whole stack goes to the output channel, where all of it fits.
	*/
	const failure = response.fatal ?? response.index?.internalError;
	if (failure) {
		connection.console.error(`Mindustry-C: analysis failed for ${response.uri}\n${failure}`);
	}

	if (!settings.diagnostics.enable) return;

	// Group by the file each diagnostic belongs to: some come from #include.
	const byUri = new Map<string, Diagnostic[]>();
	for (const diagnostic of response.diagnostics) {
		// A diagnostic from an `#include`d file belongs to that file, not to the
		// one the user is editing -- that is the whole point of resolving them.
		const target = diagnostic.path ? documentUriFor(diagnostic.path, response.uri) : response.uri;
		const list = byUri.get(target) ?? [];
		list.push(toDiagnostic(diagnostic));
		byUri.set(target, list);
	}

	/*
	One diagnostic stands in for everything the run failed to say. The
	supervisor already writes its own when the worker thread itself dies, and
	its message is the `fatal` we just read -- so adding a second would put the
	same event in the file twice.
	*/
	const alreadyReported = response.diagnostics.some(diagnostic => diagnostic.message === failure);
	if (failure && !alreadyReported) {
		const list = byUri.get(response.uri) ?? [];
		list.unshift(failureDiagnostic(failure));
		byUri.set(response.uri, list);
	}

	for (const uri of new Set([...byUri.keys(), response.uri])) {
		void connection.sendDiagnostics({ uri, diagnostics: byUri.get(uri) ?? [] });
	}
}

/**
 * The mark a dead run leaves behind.
 *
 * It sits at the top of the document rather than on a line, because a run that
 * never finished has no opinion about any line in particular, and the one
 * conclusion a reader must not reach is that line 1 is wrong.
 */
function failureDiagnostic(detail: string): Diagnostic {
	return {
		severity: DiagnosticSeverity.Error,
		message:
			'Mindustry-C could not finish analysing this file, so it has not been checked: ' +
			'diagnostics and language features for it may be missing or wrong.\n\n' +
			`${firstLineOf(detail)}\n\n` +
			'Full stack trace in the "Mindustry-C" output channel.',
		source: 'mindc',
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	};
}

function firstLineOf(text: string): string {
	const end = text.indexOf('\n');
	return end < 0 ? text : text.slice(0, end);
}

/** Errors and warnings arrive in one list; `severity` says which is which. */
function toDiagnostic(diagnostic: CompilerDiagnostic): Diagnostic {
	const line = Math.max(0, (diagnostic.line ?? 1) - 1);
	const character = Math.max(0, (diagnostic.column ?? 1) - 1);
	return {
		severity:
			diagnostic.severity === 'warning'
				? DiagnosticSeverity.Warning
				: DiagnosticSeverity.Error,
		message: diagnostic.message,
		source: 'mindc',
		range: {
			start: { line, character },
			// A zero-width range is invisible in the editor; one character of
			// underline is the least surprising default.
			end: { line, character: character + 1 },
		},
	};
}

/* ------------------------------------------------------------------ *
 * Include watching
 *
 * A header the user edits must re-analyse the files that include it. The worker
 * reports the include list of every document it analysed, which is exactly the
 * set of directories worth watching.
 * ------------------------------------------------------------------ */

async function watchIncludes(includes: string[]): Promise<void> {
	if (!settings.diagnostics.openIncludes) return;
	const wanted = new Set<string>();
	for (const include of includes) wanted.add(path.dirname(include));
	for (const uri of indexes.keys()) {
		const fsPath = fromUri(uri);
		if (fsPath) wanted.add(path.dirname(fsPath));
	}

	let added = false;
	for (const directory of wanted) {
		if (watchedDirectories.has(directory) || !fs.existsSync(directory)) continue;
		watchedDirectories.add(directory);
		added = true;
	}

	if (!added && watcherRegistered) return;
	watcherRegistered = true;
	try {
		await connection.client.register(DidChangeWatchedFilesNotification.type, {
			watchers: [...watchedDirectories].map(directory => ({
				globPattern: URI.file(directory).toString() + '/**/*.{c,h}',
			})),
		});
	} catch {
		// Registration is best-effort: without it, editing a header only refreshes
		// when the including file is touched.
	}
}

/* ------------------------------------------------------------------ *
 * Language features
 * ------------------------------------------------------------------ */

function indexed(uri: string, options: { allowStale?: boolean } = {}): IndexedDocument | null {
	const entry = indexes.get(uri);
	if (!entry) return null;
	const document = documents.get(uri);
	// Analysis is debounced, so while the user types the index is normally one
	// keystroke behind. Hover and navigation must not act on stale positions,
	// but completion is better served by the previous symbol list than by none.
	if (!options.allowStale && document && entry.index.version !== document.version) return null;
	return entry;
}

connection.onHover((params: TextDocumentPositionParams) => {
	const entry = indexed(params.textDocument.uri);
	if (!entry) return null;
	const result = hover(entry, params.position);
	return result
		? { contents: { kind: 'markdown', value: result.contents }, range: result.range }
		: null;
});

connection.onDefinition(params => {
	const entry = indexed(params.textDocument.uri);
	return entry ? definition(entry, params.position, toUri) : null;
});

connection.onReferences(params => {
	const entry = indexed(params.textDocument.uri);
	return entry ? references([...indexes.values()], entry, params.position, toUri) : null;
});

connection.onPrepareRename(params => {
	const entry = indexed(params.textDocument.uri);
	if (!entry) return null;
	const renameable = canRename(entry, params.position);
	// Null tells VS Code "cannot rename" instead of renaming something unchecked.
	if (!renameable) return null;
	return {
		range: renameable.range,
		placeholder: entry.text.slice(
			offsetOf(entry.text, renameable.range.start),
			offsetOf(entry.text, renameable.range.end)
		),
	};
});

connection.onRenameRequest((params): WorkspaceEdit | null => {
	const entry = indexed(params.textDocument.uri);
	return entry ? rename([...indexes.values()], entry, params.position, params.newName, toUri) : null;
});

connection.onCompletion(params => {
	// The index may lag the buffer by one keystroke (analysis is debounced); a
	// slightly stale symbol list is useful, an empty one is not. The text must
	// not lag, though: the `.` / `@` prefix is read from it.
	const entry = indexed(params.textDocument.uri, { allowStale: true });
	if (!entry) return { isIncomplete: true, items: [] };

	const document = documents.get(params.textDocument.uri);
	const current = document ? { ...entry, text: document.getText() } : entry;
	return {
		// Incomplete: symbols change on every keystroke, and a stale cached list
		// would be worse than recomputing.
		isIncomplete: true,
		items: complete(current, params.position).map(toLspCompletion),
	};
});

connection.onSignatureHelp(params => {
	// Same reason as completion: the call is being typed, so the index is one
	// version behind. The text must be current, because the call is found in it.
	const entry = indexed(params.textDocument.uri, { allowStale: true });
	if (!entry) return null;
	const document = documents.get(params.textDocument.uri);
	const current = document ? { ...entry, text: document.getText() } : entry;
	return signatureHelp(current, params.position);
});

connection.onCodeAction(params => {
	const entry = indexed(params.textDocument.uri, { allowStale: true });
	if (!entry) return [];
	const document = documents.get(params.textDocument.uri);
	const current = document ? { ...entry, text: document.getText() } : entry;
	const diagnostics = params.context.diagnostics ?? [];
	return quickFixes(current, diagnostics).map(fix => ({
		title: fix.title,
		kind: CodeActionKind.QuickFix,
		// Attach the diagnostic it was derived from, so the client groups it
		// under the squiggle instead of offering it at the top of the file.
		diagnostics: diagnostics.filter(diagnostic => diagnostic.message === fix.diagnostic),
		edit: fix.edit,
	}));
});

connection.onRequest('textDocument/semanticTokens/full', (params: { textDocument: { uri: string } }) => {
	// Strict, unlike completion: a stale index would paint the previous text's
	// ranges onto the current one. An empty answer leaves TextMate in charge
	// until the next analysis lands -- and `publish` then asks the client to ask
	// again, because it will not do so by itself.
	const entry = indexed(params.textDocument.uri);
	if (!entry) {
		semanticRefreshPending.add(params.textDocument.uri);
		return { data: [] };
	}
	const document = documents.get(params.textDocument.uri);
	const current = document ? { ...entry, text: document.getText() } : entry;
	return { data: semanticTokens(current) };
});

connection.onDocumentSymbol(params => {
	const entry = indexed(params.textDocument.uri);
	if (!entry) return [];
	return outline(entry, fromUri(params.textDocument.uri)).map(symbol => ({
		name: symbol.name,
		detail: symbol.detail,
		kind:
			symbol.kind === 'function'
				? LspSymbolKind.Function
				: symbol.kind === 'type'
					? LspSymbolKind.Struct
					: LspSymbolKind.Variable,
		range: symbol.range,
		selectionRange: symbol.range,
	}));
});

/** Our `kind` -> the LSP `CompletionItemKind`. */
const COMPLETION_KINDS: Record<CompletionItem['kind'], LspCompletionItemKind> = {
	function: LspCompletionItemKind.Function,
	variable: LspCompletionItemKind.Variable,
	field: LspCompletionItemKind.Field,
	keyword: LspCompletionItemKind.Keyword,
	class: LspCompletionItemKind.Class,
	constant: LspCompletionItemKind.Constant,
	snippet: LspCompletionItemKind.Snippet,
	module: LspCompletionItemKind.Module,
};

function toLspCompletion(item: CompletionItem): LspCompletionItem {
	return {
		label: item.label,
		kind: COMPLETION_KINDS[item.kind],
		detail: item.detail,
		documentation: item.documentation,
		sortText: item.sortText,
		...(item.filterText ? { filterText: item.filterText } : {}),
		// An explicit edit wins over the client's own word replacement, which is
		// what makes `@copper` replace the half-typed name and not the sigil too.
		...(item.range
			? { textEdit: { range: item.range, newText: item.insertText ?? item.label } }
			: {}),
	};
}

/* ------------------------------------------------------------------ *
 * Notifications from the extension
 * ------------------------------------------------------------------ */

connection.onNotification('mindc/settings', (payload: { settings?: Partial<Settings> }) => {
	if (payload.settings) {
		settings = {
			diagnostics: { ...settings.diagnostics, ...payload.settings.diagnostics },
			compile: { ...settings.compile, ...payload.settings.compile },
		};
		connection.console.log('Mindustry-C: settings updated');
	}
	for (const document of documents.all()) scheduleAnalysis(document);
});

connection.onNotification('mindc/config', (payload: { config: EffectiveConfig | null }) => {
	effectiveConfig = payload.config;
	connection.console.log(`Mindustry-C: configuration "${payload.config?.profileName ?? 'none'}"`);
	for (const document of documents.all()) scheduleAnalysis(document);
});

connection.onDidChangeConfiguration(change => {
	const section = (change.settings as { mindc?: Partial<Settings> } | undefined)?.mindc;
	if (!section) return;
	settings = {
		diagnostics: { ...settings.diagnostics, ...section.diagnostics },
		compile: { ...settings.compile, ...section.compile },
	};
});

/* ------------------------------------------------------------------ *
 * Document events
 * ------------------------------------------------------------------ */

/*
 * A document that is not `mlgc` is a header the client syncs so `#include` can
 * see it. It is never analysed itself, but whatever includes it has to be,
 * and the workers have to be told about the buffer before that happens.
 */
documents.onDidOpen(event => {
	scheduleAnalysis(event.document);
	if (event.document.languageId !== 'mlgc') scheduleDependents(event.document);
});
documents.onDidChangeContent(event => {
	scheduleAnalysis(event.document);
	if (event.document.languageId !== 'mlgc') scheduleDependents(event.document);
});
documents.onDidClose(event => {
	const { uri } = event.document;
	indexes.delete(uri);
	const timer = pendingTimers.get(uri);
	if (timer) clearTimeout(timer);
	pendingTimers.delete(uri);
	void connection.sendDiagnostics({ uri, diagnostics: [] });

	if (event.document.languageId === 'mlgc') return;
	// The buffer is gone, so the worker must go back to the file on disk --
	// even if nothing includes it any more, or a file that starts to include
	// that path later would be analysed against text nobody is editing.
	syncKnownDocuments();
	scheduleDependents(event.document);
});

// A header changed on disk: everything that includes it must be re-analysed.
connection.onDidChangeWatchedFiles(() => {
	for (const document of documents.all()) scheduleAnalysis(document);
});

/*
 * Without this the manager never hears a document open, change or close, so
 * `documents` stays empty forever: nothing above would ever fire, no analysis
 * would be scheduled, and every feature -- hover, definition, completion --
 * would look the document up and find nothing. The failure is entirely silent,
 * because the server still answers `initialize` with all seven capabilities.
 *
 * It has to be registered before `connection.listen()` starts dispatching.
 */
documents.listen(connection);

connection.listen();
