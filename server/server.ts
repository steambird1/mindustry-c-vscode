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
import type { AnalysisResponse, CompilerDiagnostic, EffectiveConfig } from '../src/common/types';
import {
	canRename,
	complete,
	definition,
	hover,
	offsetOf,
	outline,
	references,
	rename,
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

/** Text the workers should serve from memory: every open mlgc document. */
function syncKnownDocuments(): void {
	const known = new Map<string, string>();
	for (const document of documents.all()) {
		if (document.languageId === 'mlgc') known.set(document.uri, document.getText());
	}
	worker?.setKnownDocuments(known);
}

/**
 * Debounced here rather than in the worker host, so a settings change takes
 * effect without rebuilding the host.
 */
function scheduleAnalysis(document: TextDocument): void {
	if (document.languageId !== 'mlgc' || !settings.diagnostics.enable) return;
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
		});
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
		const target = diagnostic.path ? toUri(diagnostic.path) : response.uri;
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

function indexed(uri: string): IndexedDocument | null {
	const entry = indexes.get(uri);
	if (!entry) return null;
	const document = documents.get(uri);
	if (document && entry.index.version !== document.version) return null;
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
	return entry ? references([...indexes.values()], entry, params.position) : null;
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
	return entry ? rename([...indexes.values()], entry, params.position, params.newName) : null;
});

connection.onCompletion(params => {
	const entry = indexed(params.textDocument.uri);
	const items = entry ? complete(entry, params.position).map(toLspCompletion) : [];
	return {
		// Incomplete: symbols change on every keystroke, and a stale cached list
		// would be worse than recomputing.
		isIncomplete: true,
		items,
	};
});

connection.onDocumentSymbol(params => {
	const entry = indexed(params.textDocument.uri);
	if (!entry) return [];
	return outline(entry).map(symbol => ({
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
		// An explicit edit wins over the client's own word replacement, which is
		// what makes `@copper` replace the half-typed name and not the sigil too.
		...(item.range ? { textEdit: { range: item.range, newText: item.label } } : {}),
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

documents.onDidOpen(event => scheduleAnalysis(event.document));
documents.onDidChangeContent(event => scheduleAnalysis(event.document));
documents.onDidClose(event => {
	const { uri } = event.document;
	indexes.delete(uri);
	const timer = pendingTimers.get(uri);
	if (timer) clearTimeout(timer);
	pendingTimers.delete(uri);
	void connection.sendDiagnostics({ uri, diagnostics: [] });
});

// A header changed on disk: everything that includes it must be re-analysed.
connection.onDidChangeWatchedFiles(() => {
	for (const document of documents.all()) scheduleAnalysis(document);
});

connection.listen();
