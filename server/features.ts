/*
 * Language features, as pure functions over the symbol index.
 *
 * Everything here takes plain data -- an index, some text, a position -- so the
 * behaviour can be tested without a language server, and the compiler can only
 * ever affect them through `src/compiler/symbols.ts`.
 */

import type {
	CompilerDiagnostic,
	DocumentIndex,
	ReferenceInfo,
	Range,
	SymbolInfo,
} from '../src/common/types';
import {
	BUILTIN_FUNCTIONS,
	BUILTIN_SIGNATURES,
	CONTENT_CATEGORIES,
	CONTENT_NAMES,
	EXTRA_TYPES,
	KEYWORDS,
	PROCESSOR_VARIABLES,
	SPECIAL_INSTRUCTIONS,
	TYPE_KEYWORDS,
} from '../src/compiler/generatedTables';
import { samePath } from '../src/compiler/documentAccess';

export interface Position {
	line: number;
	character: number;
}

/** One document's index, plus the text it was built from. */
export interface IndexedDocument {
	uri: string;
	index: DocumentIndex;
	text: string;
	/**
	 * The file's own fs path, when it has one.
	 *
	 * Used to tell this document's functions from ones that came in through an
	 * `#include`, whose offsets belong to another file.
	 */
	mainPath?: string | null;
	/**
	 * The text the index was built from, when the buffer has changed since.
	 *
	 * Semantic tokens use it to map recorded positions onto the current text
	 * instead of dropping everything after the edit.
	 */
	analyzedText?: string;
}

/* ------------------------------------------------------------------ *
 * Positions
 * ------------------------------------------------------------------ */

export function positionIn(text: string, offset: number): Position {
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, character: Math.max(0, Math.min(offset, text.length) - lineStart) };
}

export function offsetOf(text: string, position: Position): number {
	if (position.line <= 0) return Math.min(position.character, text.length);
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
			if (line === position.line) break;
		}
	}
	return Math.min(lineStart + position.character, text.length);
}

export function contains(range: Range, position: Position): boolean {
	if (position.line < range.start.line || position.line > range.end.line) return false;
	if (position.line === range.start.line && position.character < range.start.character) return false;
	if (position.line === range.end.line && position.character > range.end.character) return false;
	return true;
}

function lineText(text: string, line: number): string {
	const lines = text.split('\n');
	return lines[line] ?? '';
}

/* ------------------------------------------------------------------ *
 * Looking things up
 * ------------------------------------------------------------------ */

/**
 * The reference under the cursor.
 *
 * The references are sorted by offset, so this is a binary search. A cursor
 * sitting just past a name still counts: clicking to the right of an identifier
 * should not do nothing.
 */
export function referenceAt(document: IndexedDocument, position: Position): ReferenceInfo | null {
	const { references } = document.index;
	let low = 0;
	let high = references.length - 1;
	let best: ReferenceInfo | null = null;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const candidate = references[middle];
		if (startsAtOrBefore(candidate.range, position)) {
			// The cursor is at or after this name. It is the best candidate so far,
			// but a later one may also start before the cursor, so keep going right.
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (best && contains(best.range, position)) return best;
	// One character to the left of the end still belongs to the name.
	if (best && best.range.end.line === position.line && position.character === best.range.end.character) {
		return best;
	}
	return null;
}

function startsAtOrBefore(range: Range, position: Position): boolean {
	if (position.line !== range.start.line) return position.line > range.start.line;
	return position.character >= range.start.character;
}

/** The word around the cursor, for completion and rename validation. */
export function wordAt(text: string, position: Position): { word: string; range: Range } {
	const offset = offsetOf(text, position);
	let start = offset;
	let end = offset;
	while (start > 0 && isWordChar(text.charCodeAt(start - 1))) start--;
	while (end < text.length && isWordChar(text.charCodeAt(end))) end++;
	return {
		word: text.slice(start, end),
		range: {
			start: positionIn(text, start),
			end: positionIn(text, end),
		},
	};
}

function isWordChar(code: number): boolean {
	return (
		(code >= 97 && code <= 122) || // a-z
		(code >= 65 && code <= 90) || // A-Z
		(code >= 48 && code <= 57) || // 0-9
		code === 95 // _
	);
}

/** Do two references point at the same declaration? */
function sameTarget(a: SymbolInfo | null, b: SymbolInfo | null): boolean {
	if (!a || !b) return false;
	if (a.path && b.path && a.path !== b.path) return false;
	return a.declarationOffset === b.declarationOffset && a.name === b.name;
}

/**
 * Whether a symbol belongs to this document rather than to a file it includes.
 *
 * `null` means "no file", which is what an untitled buffer has; two nulls are
 * the same document, but null and a path are not.
 */
function sameDocument(symbolPath: string | null, mainPath: string | null): boolean {
	if (symbolPath === null || mainPath === null) return symbolPath === mainPath;
	return samePath(symbolPath, mainPath);
}

/** A location key that ignores which translation unit reported it. */
function locationKey(uri: string, range: Range): string {
	return `${uri}|${range.start.line}:${range.start.character}|${range.end.line}:${range.end.character}`;
}

/* ------------------------------------------------------------------ *
 * Hover
 * ------------------------------------------------------------------ */

export interface Hover {
	contents: string;
	range?: Range;
}

/**
 * The `@`-prefixed content id at the cursor, e.g. `@copper`, or null.
 *
 * `@` is not a word character, so the word under the cursor is just the name; the
 * sigil has to be checked separately.
 */
function contentNameAt(text: string, position: Position): { name: string; range: Range } | null {
	const { word, range } = wordAt(text, position);
	if (!word) return null;
	const line = lineText(text, position.line);
	if (!line.slice(0, range.start.character).endsWith('@')) return null;
	return { name: `@${word}`, range };
}

/**
 * Which group a content id belongs to, e.g. `item` for `@copper`.
 *
 * The generated tables carry the sigil themselves -- they are read straight out
 * of the compiler's own tables -- so they are matched with the sigil attached.
 */
function contentCategory(name: string): string | null {
	for (const category of CONTENT_CATEGORIES) {
		if (CONTENT_NAMES[category]?.includes(name)) return category;
	}
	return PROCESSOR_VARIABLES.includes(name.slice(1)) ? 'processor' : null;
}

/**
 * What to show for a symbol.
 *
 * A function gets its full signature; a variable gets its rendered type. Both
 * are rendered from the compiler's own type objects, so they read the way the
 * language does rather than the way the AST is shaped.
 */
export function hover(document: IndexedDocument, position: Position): Hover | null {
	// A content id is not a name the user declared, so it is answered from the
	// generated tables before the index is consulted.
	const content = contentNameAt(document.text, position);
	if (content) {
		const category = contentCategory(content.name);
		return category
			? { contents: ['```mlgc', `${content.name}`, '```', `Content (${category}).`].join('\n\n'), range: content.range }
			: null;
	}

	const reference = referenceAt(document, position);
	if (!reference) return null;

	// A member of a struct: `p.x` where x is a field.
	if (reference.target?.kind === 'field') {
		const { type, name, container, doc } = reference.target;
		return {
			contents: [
				'```mlgc',
				`${type} ${name};`,
				'```',
				...(doc ? [doc] : []),
				...(container ? [`Field of \`${container}\`.`] : []),
			].join('\n\n'),
			range: reference.range,
		};
	}

	const target = reference.target;
	if (!target) {
		// An unresolved name is still worth commenting on: the user probably just
		// typed it.
		if (referenceAt(document, position)?.target === null) {
			return { contents: 'Not declared in the analysed files.', range: reference.range };
		}
		return null;
	}

	const declarationLine =
		target.path !== null
			? `Declared in \`${basename(target.path)}\`, line ${target.range.start.line + 1}.`
			: null;

	return {
		contents: [
			'```mlgc',
			signatureOf(target),
			'```',
			...(target.doc ? [target.doc] : []),
			...(declarationLine ? [declarationLine] : []),
		].join('\n\n'),
		range: reference.range,
	};
}

/**
 * `int add(int, int)` -> `int add(int, int)`, `int counter` -> `int counter`.
 *
 * `SymbolInfo.type` already holds the rendered type, so a function's is
 * `returnType(parameters)`; splitting it back apart is only needed to put the
 * name in the middle where a reader expects it.
 */
export function signatureOf(target: SymbolInfo): string {
	if (target.kind !== 'function') return `${target.type} ${target.name}`;
	const match = /^([^()]*)\(([^()]*)\)$/.exec(target.type);
	if (!match) return `${target.type} ${target.name}`;
	const [, returnType, parameters] = match;
	const rendered = parameters.trim();
	return `${returnType} ${target.name}(${rendered})`;
}

/**
 * Which struct a member reference belongs to, from the text before it.
 *
 * The reference's range starts at the member name, so what precedes the cursor
 * ends with the `.` or `->` -- the object is the last identifier before it.
 */
/** The struct a named object holds, if the object is a struct or points at one. */
function structNameOfType(document: IndexedDocument, objectName: string): string | null {
	for (const symbol of document.index.symbols) {
		if (symbol.name !== objectName) continue;
		// The rendered type carries the indirection as syntax, so strip it rather
		// than teaching this about the renderer's grammar: `vec *` and `vec *[4]`
		// are both just `vec` once the decorations are gone.
		const base = symbol.type.replace(/[\s*[\]]+/g, '');
		if (document.index.structs.some(struct => struct.name === base)) return base;
	}
	return null;
}

function basename(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index < 0 ? path : path.slice(index + 1);
}

/* ------------------------------------------------------------------ *
 * Definition
 * ------------------------------------------------------------------ */

export interface Location {
	uri: string;
	range: Range;
}

/**
 * Where a symbol is declared.
 *
 * The index stores fs paths (the worker only ever sees paths), so the caller
 * supplies the mapping back to uris.
 */
export function definition(
	document: IndexedDocument,
	position: Position,
	toUri: (path: string) => string
): Location | null {
	const reference = referenceAt(document, position);
	if (!reference?.target?.path) return null;
	return { uri: toUri(reference.target.path), range: reference.target.range };
}

/**
 * The first declaration of the symbol under the cursor.
 *
 * For a function that is its prototype, for a struct/union with a forward
 * declaration it is that forward declaration; everything else has only one
 * declaration site. `definition` answers the complement: the function body or
 * the complete type.
 */
export function declaration(
	document: IndexedDocument,
	position: Position,
	toUri: (path: string) => string
): Location | null {
	const target = referenceAt(document, position)?.target;
	if (!target) return null;
	const site = target.declaration ?? { path: target.path, range: target.range };
	return site.path ? { uri: toUri(site.path), range: site.range } : null;
}

/* ------------------------------------------------------------------ *
 * References
 * ------------------------------------------------------------------ */

export function references(
	documents: IndexedDocument[],
	document: IndexedDocument,
	position: Position,
	toUri: (path: string) => string
): Location[] {
	const reference = referenceAt(document, position);
	if (!reference) return [];
	const target = reference.target;
	if (!target) return [];

	const locations: Location[] = [];
	const seen = new Set<string>();
	for (const candidate of documents) {
		for (const other of candidate.index.references) {
			if (!sameTarget(other.target, target)) continue;
			/*
			 * The reference knows which file it is written in; `candidate` is
			 * only the open document whose translation unit happened to contain
			 * it. Two open files that share a header both carry that header's
			 * references, so the same location can arrive twice.
			 */
			const uri = other.path ? toUri(other.path) : candidate.uri;
			const key = locationKey(uri, other.range);
			if (seen.has(key)) continue;
			seen.add(key);
			locations.push({ uri, range: other.range });
		}
	}
	return locations;
}

/* ------------------------------------------------------------------ *
 * Rename
 * ------------------------------------------------------------------ */

export interface WorkspaceEdit {
	changes: Record<string, Array<{ range: Range; newText: string }>>;
}

/** Names the user must not rename: builtins and content constants. */
export function isReservedName(name: string): boolean {
	return (
		BUILTIN_FUNCTIONS.includes(name) ||
		KEYWORDS.includes(name) ||
		SPECIAL_INSTRUCTIONS.includes(name) ||
		TYPE_KEYWORDS.includes(name) ||
		EXTRA_TYPES.includes(name)
	);
}

export function canRename(document: IndexedDocument, position: Position): { range: Range } | null {
	const { word } = wordAt(document.text, position);
	if (!word || isReservedName(word)) return null;
	const reference = referenceAt(document, position);
	// Renaming something the analyser could not resolve would be a guess.
	if (!reference?.target) return null;
	return { range: reference.range };
}

export function rename(
	documents: IndexedDocument[],
	document: IndexedDocument,
	position: Position,
	newName: string,
	toUri: (path: string) => string
): WorkspaceEdit | null {
	const reference = referenceAt(document, position);
	const target = reference?.target;
	if (!target || isReservedName(target.name)) return null;

	const changes: Record<string, Array<{ range: Range; newText: string }>> = {};
	const seen = new Set<string>();
	for (const candidate of documents) {
		for (const other of candidate.index.references) {
			if (!sameTarget(other.target, target)) continue;
			const uri = other.path ? toUri(other.path) : candidate.uri;
			const key = locationKey(uri, other.range);
			if (seen.has(key)) continue;
			seen.add(key);
			(changes[uri] ??= []).push({ range: other.range, newText: newName });
		}
	}
	return Object.keys(changes).length > 0 ? { changes } : null;
}

/* ------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------ */

export interface CompletionItem {
	label: string;
	kind:
		| 'function'
		| 'variable'
		| 'field'
		| 'keyword'
		| 'class'
		| 'constant'
		| 'snippet'
		| 'module';
	detail?: string;
	documentation?: string;
	/** Replace only this, rather than the word at the cursor. */
	range?: Range;
	/**
	 * Text actually inserted, when it differs from `label`.
	 *
	 * The `@` items are labelled with the sigil but replace only the half-typed
	 * name after it, so the sigil itself is not duplicated.
	 */
	insertText?: string;
	/**
	 * What the client matches the typed prefix against.
	 *
	 * VS Code's word pattern treats `@` as a separator, so for `@co` the prefix
	 * is `co`; a label of `@copper` would be filtered out without this.
	 */
	filterText?: string;
	/** Sort key, so categories and the user's own names group predictably. */
	sortText?: string;
}

export const COMPLETION_KIND = {
	function: 3, // Function
	variable: 6, // Variable
	field: 5, // Field
	keyword: 14, // Keyword
	class: 7, // Class
	constant: 21, // Constant
	snippet: 15,
	module: 9,
} as const;

/**
 * Completions for a position.
 *
 * Three contexts, in priority order:
 *
 *  1. after `.` -- the members of that struct, which is the only place where a
 *     wrong guess is actually painful;
 *  2. after `@` -- content ids and processor variables, which is the dialect's
 *     one sigil;
 *  3. everything else -- symbols in scope, then the builtins and keywords, with
 *     the user's own declarations first because they are what they are typing.
 */
export function complete(document: IndexedDocument, position: Position): CompletionItem[] {
	const line = lineText(document.text, position.line);
	const before = line.slice(0, position.character);

	// The member may be absent or half-typed, so it is optional; the object and
	// the `.` / `->` are not, and a float literal like `1.5` cannot match.
	const memberMatch = /([A-Za-z_]\w*)\s*(?:\.|->)\s*[A-Za-z_]*$/.exec(before);
	if (memberMatch) {
		const members = memberCompletions(document, position, memberMatch[1]);
		if (members.length) return members;
	}

	if (/(^|[^\w])@[\w]*$/.test(before)) {
		return constantCompletions(document, position);
	}

	return generalCompletions(document, position);
}

/**
 * The members of the struct the object holds, for `object.` and `object->`.
 *
 * The compiler already resolved the member at the cursor to a field, and a field
 * knows the struct that declares it, so the common case is answered from the
 * index. The text is only consulted when the expression is too broken to have
 * produced a reference -- which is exactly the case where completion matters,
 * because it is mid-edit.
 */
function memberCompletions(
	document: IndexedDocument,
	position: Position,
	objectName: string
): CompletionItem[] {
	const resolved = referenceAt(document, position);
	const structName =
		(resolved?.target?.kind === 'field' ? resolved.target.container : null) ??
		structNameOfType(document, objectName);
	if (!structName) return [];
	const struct = document.index.structs.find(entry => entry.name === structName);
	if (!struct) return [];
	return struct.members.map(member => ({
		label: member.name,
		kind: 'field' as const,
		detail: member.type,
		...(member.doc ? { documentation: member.doc } : {}),
	}));
}

/**
 * Content ids and processor variables, for after an `@`.
 *
 * The label carries the sigil, because that is what the source has to end up
 * with, but the replace range deliberately does not: `@` is not a word
 * character, so the client would otherwise replace only the name and leave the
 * user with `@@copper`.
 */
function constantCompletions(document: IndexedDocument, position: Position): CompletionItem[] {
	// The half-typed name after the sigil, which the completion replaces.
	const typed = /\w*$/.exec(textBefore(document, position))?.[0].length ?? 0;
	const range: Range = {
		start: positionIn(document.text, offsetOf(document.text, position) - typed),
		end: position,
	};

	const items: CompletionItem[] = [];
	for (const category of CONTENT_CATEGORIES) {
		for (const name of CONTENT_NAMES[category] ?? []) {
			// The table entries carry the sigil; the text at the cursor does not
			// (the `@` is already there), so it is dropped from the edit and the
			// filter text while the label keeps it.
			const bare = name.replace(/^@/, '');
			items.push({
				label: name,
				insertText: bare,
				filterText: bare,
				kind: 'constant',
				detail: category,
				range,
				// Content ids are grouped by category, then alphabetical.
				sortText: `2${category}${name}`,
			});
		}
	}
	for (const name of PROCESSOR_VARIABLES) {
		items.push({
			label: `@${name}`,
			insertText: name,
			filterText: name,
			kind: 'constant',
			detail: 'processor',
			range,
			sortText: `1${name}`,
		});
	}
	return items;
}

function textBefore(document: IndexedDocument, position: Position): string {
	return lineText(document.text, position.line).slice(0, position.character);
}

/**
 * The function whose body contains `offset`, by source order.
 *
 * Functions cannot nest in this dialect, so the last one declared at or before
 * the cursor is the one the cursor is in. A function that came from an
 * `#include` carries offsets into that header, so it is skipped: the comparison
 * would be against the wrong file.
 */
function enclosingFunction(document: IndexedDocument, offset: number): string | null {
	let best: SymbolInfo | null = null;
	for (const symbol of document.index.symbols) {
		if (symbol.kind !== 'function' || symbol.scope !== 'file') continue;
		if (document.mainPath && symbol.path && !samePath(document.mainPath, symbol.path)) continue;
		if (symbol.declarationOffset > offset) continue;
		if (!best || symbol.declarationOffset > best.declarationOffset) best = symbol;
	}
	return best?.name ?? null;
}

function generalCompletions(document: IndexedDocument, position: Position): CompletionItem[] {
	const items: CompletionItem[] = [];
	const seen = new Set<string>();
	const owner = enclosingFunction(document, offsetOf(document.text, position));

	for (const symbol of document.index.symbols) {
		// A field is only nameable through an object, so offering it bare would
		// suggest `x` where only `p.x` compiles. It is offered after a `.`
		// instead, by `memberCompletions`.
		if (symbol.kind === 'field') continue;
		// `scope` is the only visibility the compiler records. `owner` narrows a
		// local to the function it is declared in; without it the list carries
		// every other function's variables and parameters.
		if (symbol.scope === 'local' && (owner === null || symbol.owner !== owner)) continue;
		if (seen.has(symbol.name)) continue;
		seen.add(symbol.name);
		items.push({
			label: symbol.name,
			kind:
				symbol.kind === 'function'
					? 'function'
					: symbol.kind === 'type'
						? 'class'
						: 'variable',
			detail: symbol.type,
			...(symbol.doc ? { documentation: symbol.doc } : {}),
			// The user's own declarations, by order of appearance.
			sortText: `0${String(symbol.range.start.line).padStart(6, '0')}${symbol.name}`,
		});
	}

	for (const name of BUILTIN_FUNCTIONS) {
		if (seen.has(name)) continue;
		seen.add(name);
		items.push({
			label: name,
			kind: 'function',
			detail: BUILTIN_SIGNATURES[name] ?? 'builtin',
			sortText: `1${name}`,
		});
	}

	for (const name of [...KEYWORDS, ...TYPE_KEYWORDS, ...EXTRA_TYPES]) {
		if (seen.has(name)) continue;
		seen.add(name);
		items.push({ label: name, kind: 'keyword', sortText: `2${name}` });
	}

	return items;
}

/* ------------------------------------------------------------------ *
 * Signature help
 * ------------------------------------------------------------------ */

export interface SignatureParameter {
	/** Offsets into the signature's label. */
	label: [number, number];
}

export interface Signature {
	label: string;
	parameters: SignatureParameter[];
	/** The declaration's comment, when it has one. */
	documentation?: string;
}

export interface SignatureHelp {
	signatures: Signature[];
	activeSignature: number;
	activeParameter: number;
}

/**
 * The call the cursor is inside, if any.
 *
 * Read from the text rather than from the AST: signature help is asked for
 * while the file is mid-edit, when the last analysed AST may not contain the
 * call at all. The scan starts at the top of the file so comments and literals
 * can be skipped; it is linear in the file size, which is fine for a request
 * triggered by `(` or `,`.
 */
export function signatureHelp(document: IndexedDocument, position: Position): SignatureHelp | null {
	const offset = offsetOf(document.text, position);
	const call = callAt(document.text, offset);
	if (!call) return null;

	const signatures: Signature[] = [];
	const seen = new Set<string>();
	for (const symbol of document.index.symbols) {
		if (symbol.kind !== 'function' || symbol.name !== call.name) continue;
		const signature = functionSignature(symbol);
		if (seen.has(signature.label)) continue;
		seen.add(signature.label);
		signatures.push(signature);
	}

	// A builtin is only consulted when the user has not declared the name; a
	// local declaration shadows it, and offering both would be a guess.
	if (signatures.length === 0) {
		const builtin = builtinSignature(call.name);
		if (builtin) signatures.push(builtin);
	}
	if (signatures.length === 0) return null;

	const argument = argumentIndex(document.text, call.open, offset);
	const activeSignature = chooseSignature(signatures, argument + 1);
	const parameters = signatures[activeSignature].parameters;
	return {
		signatures,
		activeSignature,
		// `argument` can run past the list while the user is mid-edit; pointing
		// at the last parameter is more useful than pointing at nothing.
		activeParameter: Math.min(argument, Math.max(0, parameters.length - 1)),
	};
}

function callAt(text: string, offset: number): { name: string; open: number } | null {
	const parens: number[] = [];
	scanCode(text, 0, offset, (character, index) => {
		if (character === '(') parens.push(index);
		else if (character === ')') parens.pop();
		// A call cannot span a statement boundary, so a stray `(` further up is
		// not the one the cursor belongs to.
		else if (character === ';') parens.length = 0;
	});

	const open = parens[parens.length - 1];
	if (open === undefined) return null;

	let end = open;
	while (end > 0 && /\s/.test(text[end - 1])) end--;
	let start = end;
	while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
	if (start === end) return null;
	const name = text.slice(start, end);
	return /^[A-Za-z_]\w*$/.test(name) ? { name, open } : null;
}

/** Which argument the cursor is in, counting only commas at the call's level. */
function argumentIndex(text: string, open: number, offset: number): number {
	let depth = 0;
	let count = 0;
	scanCode(text, open + 1, offset, character => {
		if (character === '(' || character === '[' || character === '{') depth++;
		else if (character === ')' || character === ']' || character === '}') depth = Math.max(0, depth - 1);
		else if (character === ',' && depth === 0) count++;
	});
	return count;
}

/**
 * Walk `text` from `from` to `to`, calling `visit` for code only.
 *
 * Comments, string literals and character literals are skipped, so a `(`
 * inside `print("(")` is not mistaken for a call.
 */
function scanCode(
	text: string,
	from: number,
	to: number,
	visit: (character: string, index: number) => void
): void {
	let lineComment = false;
	let blockComment = false;
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let index = from; index < to && index < text.length; index++) {
		const character = text[index];
		if (lineComment) {
			if (character === '\n') lineComment = false;
			continue;
		}
		if (blockComment) {
			if (character === '*' && text[index + 1] === '/') {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === '/' && text[index + 1] === '/') {
			lineComment = true;
			index++;
			continue;
		}
		if (character === '/' && text[index + 1] === '*') {
			blockComment = true;
			index++;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		visit(character, index);
	}
}

/** A user function's signature, with its parameter names. */
function functionSignature(symbol: SymbolInfo): Signature {
	const match = /^([^()]*)\(([^()]*)\)$/.exec(symbol.type);
	const returnType = match ? match[1].trim() : '?';
	const documentation = symbol.doc ? { documentation: symbol.doc } : {};
	const declared = symbol.parameters;
	if (!declared) {
		// No parameter list in the index: an old worker, or a type this cannot
		// split. The rendered type is still a usable label.
		return { label: signatureOf(symbol), parameters: [], ...documentation };
	}

	let label = `${returnType} ${symbol.name}(`;
	const parameters: SignatureParameter[] = [];
	declared.forEach((parameter, index) => {
		if (index > 0) label += ', ';
		const text = parameter.name ? `${parameter.type} ${parameter.name}` : parameter.type;
		const start = label.length;
		label += text;
		parameters.push({ label: [start, label.length] });
	});
	label += ')';
	return { label, parameters, ...documentation };
}

/** `void printflush(device)` from the generated tables, with parameter ranges. */
function builtinSignature(name: string): Signature | null {
	const label = BUILTIN_SIGNATURES[name];
	if (!label) return null;
	const open = label.indexOf('(');
	const close = label.lastIndexOf(')');
	if (open < 0 || close < open) return null;

	const parameters: SignatureParameter[] = [];
	let cursor = open + 1;
	for (const part of label.slice(open + 1, close).split(',')) {
		const text = part.trim();
		if (!text) continue;
		const start = label.indexOf(text, cursor);
		if (start < 0) continue;
		parameters.push({ label: [start, start + text.length] });
		cursor = start + text.length;
	}
	return { label, parameters };
}

/**
 * Which overload the cursor is in.
 *
 * An exact arity wins; otherwise the richest one, so an argument list that
 * already has more arguments than any overload still highlights something.
 */
function chooseSignature(signatures: Signature[], argumentCount: number): number {
	let richest = 0;
	for (let index = 0; index < signatures.length; index++) {
		if (signatures[index].parameters.length === argumentCount) return index;
		if (signatures[index].parameters.length > signatures[richest].parameters.length) richest = index;
	}
	return richest;
}

/* ------------------------------------------------------------------ *
 * Code actions
 * ------------------------------------------------------------------ */

export interface QuickFix {
	title: string;
	/** The message of the diagnostic this fixes. */
	diagnostic: string;
	edit: WorkspaceEdit;
}

/** An LSP diagnostic carries its range; the analyser's own shape does not. */
export interface ActionDiagnostic extends Pick<CompilerDiagnostic, 'message'> {
	range?: { start: Position };
}

const UNDECLARED_IDENTIFIER = /^Undeclared identifier '([^']+)'$/;

/*
 * `char *p = "hi"` is refused: the text is read-only. The message names the
 * variable and the alternatives, so a fix can locate the declaration without
 * guessing which one the user meant.
 */
const MUTABLE_CHAR_LITERAL = /^Cannot initialize 'char\s*\*[^']*' with a string literal/;
const MUTABLE_CHAR_LITERAL_NAME = /'char ([A-Za-z_]\w*)\[\] =/;

/**
 * Fixes for the diagnostics the client asked about.
 *
 * The one this dialect invites is a linked processor block: `message1` is not a
 * keyword, so it has to be declared at file scope. Only names ending in a digit
 * are offered the fix -- linked blocks always carry an index, and a bare typo
 * like `helper` should not silently become a device declaration.
 *
 * A string literal in a mutable `char*` declaration is the other: the text is
 * read-only, so the declaration can be a `const char*` view, the one-cell
 * `string_t` value, or a `char[]` copy. All three are offered; the choice is
 * about what the program does with the text, which the compiler cannot know.
 */
export function quickFixes(
	document: IndexedDocument,
	diagnostics: readonly ActionDiagnostic[],
	options: { targetVersion?: number } = {}
): QuickFix[] {
	const actions: QuickFix[] = [];
	const insertion = positionIn(document.text, declarationInsertionOffset(document.text));
	const targetVersion = options.targetVersion ?? 154.3;

	for (const diagnostic of diagnostics) {
		const match = UNDECLARED_IDENTIFIER.exec(diagnostic.message);
		if (match) {
			const name = match[1];
			if (!/\d$/.test(name)) continue;
			actions.push({
				title: `Declare '${name}' as a processor block: auto device ${name};`,
				diagnostic: diagnostic.message,
				edit: {
					changes: {
						[document.uri]: [
							{
								range: { start: insertion, end: insertion },
								newText: `auto device ${name};\n`,
							},
						],
					},
				},
			});
			continue;
		}

		actions.push(...mutableCharFixes(document, diagnostic, targetVersion));
	}
	return actions;
}

/** The ways to keep `"hi"` in a `char*` declaration. */
function mutableCharFixes(
	document: IndexedDocument,
	diagnostic: ActionDiagnostic,
	targetVersion: number
): QuickFix[] {
	if (!MUTABLE_CHAR_LITERAL.test(diagnostic.message)) return [];
	const name = MUTABLE_CHAR_LITERAL_NAME.exec(diagnostic.message)?.[1];
	const start = diagnostic.range?.start;
	if (!name || !start) return [];

	const literal = offsetOf(document.text, start);
	const spot = charPointerBefore(document.text, literal, name);
	if (!spot) return [];

	const run = (offset: number) => positionIn(document.text, offset);
	const type = { start: run(spot.typeStart), end: run(spot.starEnd) };
	const nameEnd = run(spot.nameStart + name.length);
	const spaced = (text: string) =>
		/\s/.test(document.text[spot.starEnd] ?? '') ? text : `${text} `;
	const replaceType = (text: string): QuickFix['edit'] => ({
		changes: { [document.uri]: [{ range: type, newText: spaced(text) }] },
	});

	const fixes: QuickFix[] = [
		{
			title: `Make '${name}' a read-only view: const char *${name}`,
			diagnostic: diagnostic.message,
			edit: { changes: { [document.uri]: [{ range: type, newText: 'const char *' }] } },
		},
		{
			title: `Use the native string type: string_t ${name}`,
			diagnostic: diagnostic.message,
			edit: replaceType('string_t'),
		},
	];

	/*
	 * `string_view` is not one of the compiler's alternatives, because a literal
	 * does not convert to it: the view has to be built with `sv_of_string`.
	 * That needs the header and a v150 target, so it is offered only when both
	 * are already true -- the fix must not add an include behind the user's back.
	 */
	const literalEnd = stringLiteralEnd(document.text, literal);
	if (targetVersion >= 150 && hasStringHeader(document.text) && literalEnd > literal) {
		fixes.push({
			title: `View the text as a string_view: sv_of_string(...)`,
			diagnostic: diagnostic.message,
			edit: {
				changes: {
					[document.uri]: [
						{ range: type, newText: spaced('string_view') },
						{ range: { start: run(literal), end: run(literal) }, newText: 'sv_of_string(' },
						{ range: { start: run(literalEnd), end: run(literalEnd) }, newText: ')' },
					],
				},
			},
		});
	}

	fixes.push({
		title: `Copy the text into a mutable array: char ${name}[]`,
		diagnostic: diagnostic.message,
		edit: {
			changes: {
				[document.uri]: [
					{ range: type, newText: spaced('char') },
					{ range: { start: nameEnd, end: nameEnd }, newText: '[]' },
				],
			},
		},
	});

	return fixes;
}

/** The end of a double-quoted literal, past the closing quote; -1 if unclosed. */
function stringLiteralEnd(text: string, start: number): number {
	if (text[start] !== '"') return -1;
	for (let index = start + 1; index < text.length; index++) {
		if (text[index] === '\\') {
			index++;
			continue;
		}
		if (text[index] === '"') return index + 1;
	}
	return -1;
}

function hasStringHeader(text: string): boolean {
	return /^[ \t]*#[ \t]*include[ \t]*[<"]string\.h[>"]/m.test(text);
}

interface CharPointerSpot {
	/** Offset of the `char` keyword. */
	typeStart: number;
	/** Offset just past the `*` that makes it a pointer. */
	starEnd: number;
	/** Offset of the declared name. */
	nameStart: number;
}

/**
 * The `char *name` spelling that the literal initialises.
 *
 * The diagnostic points at the literal, not at the declaration, so the
 * declaration is found by walking back over the initialiser. Requiring nothing
 * but whitespace and `=` between the name and the literal keeps an unrelated
 * earlier `char *name` from being rewritten.
 */
function charPointerBefore(text: string, literal: number, name: string): CharPointerSpot | null {
	const pattern = new RegExp(`\\bchar\\s*\\*\\s*${escapePattern(name)}\\b`, 'g');
	let found: RegExpExecArray | null = null;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) {
		if (match.index >= literal) break;
		const after = text.slice(match.index + match[0].length, literal);
		if (!/^\s*=\s*$/.test(after)) continue;
		found = match;
	}
	if (!found) return null;
	const star = found.index + found[0].indexOf('*');
	return {
		typeStart: found.index,
		starEnd: star + 1,
		nameStart: found.index + found[0].length - name.length,
	};
}

function escapePattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where a file-scope declaration belongs: after the leading blank lines and
 * preprocessor directives, before the first real code.
 */
function declarationInsertionOffset(text: string): number {
	let offset = 0;
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed !== '' && !trimmed.startsWith('#')) break;
		offset += line.length + 1;
	}
	return Math.min(offset, text.length);
}

/* ------------------------------------------------------------------ *
 * Semantic tokens
 * ------------------------------------------------------------------ */

export const SEMANTIC_TOKEN_TYPES = [
	'variable',
	'parameter',
	'function',
	'type',
	'property',
	'macro',
] as const;
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration'] as const;

/**
 * The identifiers this file declares or uses, typed from the symbol index.
 *
 * TextMate already colours keywords, literals and `@content`; what it cannot
 * know is whether `helper` is a function, a parameter or a struct field. Only
 * resolved references are emitted, so an unresolved name keeps whatever the
 * grammar gave it rather than being painted as a variable.
 *
 * A stale index (the text changed since the analysis) is usable here: a token
 * is kept only while its name still sits where the index recorded it and the
 * word boundaries still hold. That preserves the colours an edit did not move
 * instead of clearing the whole file until the next analysis.
 */
export function semanticTokens(document: IndexedDocument): number[] {
	const tokens: Array<{ line: number; character: number; length: number; type: number; modifiers: number }> = [];
	const seen = new Set<string>();
	const starts = lineStarts(document.text);
	// The index may describe the text before the latest keystrokes. Map each
	// recorded span onto the current text instead of dropping everything after
	// the edit: text inserted or removed before a token moves it by a known
	// delta, and a token the edit runs through is the only one without a
	// trustworthy position.
	const analyzed = document.analyzedText ?? document.text;
	const oldStarts = analyzed === document.text ? starts : lineStarts(analyzed);
	const edit = diffTexts(analyzed, document.text);

	for (const reference of document.index.references) {
		const target = reference.target;
		if (!target) continue;
		// References from an `#include` carry offsets into that header.
		if (document.mainPath && reference.path && !samePath(reference.path, document.mainPath)) continue;
		if (reference.range.start.line !== reference.range.end.line) continue;

		const offset = shiftOffset(
			offsetIn(oldStarts, reference.range.start),
			target.name.length,
			edit
		);
		if (offset < 0) continue;
		if (!spellsName(document.text, offset, target.name)) continue;

		const type = semanticTokenType(target);
		if (type < 0) continue;

		const { line, character } = positionOfOffset(starts, offset);
		const key = `${line}:${character}:${character + target.name.length}`;
		if (seen.has(key)) continue;
		seen.add(key);

		tokens.push({
			line,
			character,
			length: target.name.length,
			type,
			modifiers: reference.isDeclaration ? 1 : 0,
		});
	}

	// Macro uses never reach the AST: the lexer expands them before parsing, so
	// there is no reference to paint. The names come from the lexer instead, and
	// the occurrences are matched in code only -- not in comments or literals.
	for (const macro of macroOccurrences(document.text, document.index.macros ?? [], starts)) {
		const key = `${macro.line}:${macro.character}:${macro.character + macro.length}`;
		if (seen.has(key)) continue;
		seen.add(key);
		tokens.push({ ...macro, type: 5, modifiers: 0 });
	}

	tokens.sort((a, b) => a.line - b.line || a.character - b.character);

	const data: number[] = [];
	let line = 0;
	let character = 0;
	for (const token of tokens) {
		const deltaLine = token.line - line;
		data.push(
			deltaLine,
			deltaLine === 0 ? token.character - character : token.character,
			token.length,
			token.type,
			token.modifiers
		);
		line = token.line;
		character = token.character;
	}
	return data;
}

/** Index into `SEMANTIC_TOKEN_TYPES`, or -1 for a kind we do not paint. */
function semanticTokenType(symbol: SymbolInfo): number {
	switch (symbol.kind) {
		case 'function':
			return 2;
		case 'type':
			return 3;
		case 'field':
			return 4;
		case 'parameter':
			return 1;
		case 'variable':
			return 0;
		default:
			return -1;
	}
}

/**
 * Every use of a macro name in code.
 *
 * `scanCode` gives a mask of code characters, so a `#define` line counts (the
 * name there is a macro too) while comments and string literals do not.
 */
function macroOccurrences(
	text: string,
	names: readonly string[],
	starts: number[]
): Array<{ line: number; character: number; length: number }> {
	const wanted = new Set(names);
	if (wanted.size === 0) return [];

	const code = new Uint8Array(text.length);
	scanCode(text, 0, text.length, (_character, index) => {
		code[index] = 1;
	});

	const occurrences: Array<{ line: number; character: number; length: number }> = [];
	for (const match of text.matchAll(/[A-Za-z_]\w*/g)) {
		const offset = match.index ?? 0;
		if (!code[offset]) continue;
		if (!wanted.has(match[0])) continue;
		const { line, character } = positionOfOffset(starts, offset);
		occurrences.push({ line, character, length: match[0].length });
	}
	return occurrences;
}

/** Offsets at which each line starts. */
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) starts.push(index + 1);
	}
	return starts;
}

/** Offset of a 0-based line/character position. */
function offsetIn(starts: number[], position: Position): number {
	const line = Math.min(Math.max(0, position.line), starts.length - 1);
	return starts[line] + Math.max(0, position.character);
}

/**
 * Whether `name` is still written at `offset`, as a whole word.
 *
 * A token from an index that is one keystroke behind can point at text that has
 * moved or changed; a token from a macro expansion can point at a placeholder
 * near the definition. Painting either would colour the wrong characters.
 */
function spellsName(text: string, offset: number, name: string): boolean {
	if (offset < 0 || text.slice(offset, offset + name.length) !== name) return false;
	const before = offset > 0 ? text[offset - 1] : '';
	const after = text[offset + name.length] ?? '';
	return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

interface TextEdit {
	/** Where the change begins in both texts. */
	start: number;
	/** End of the replaced span in the analysed text. */
	oldEnd: number;
	/** End of the replacement in the current text. */
	newEnd: number;
	/** Net length change. */
	delta: number;
}

/**
 * The single replacement that turns `before` into `after`.
 *
 * The server syncs full text, so a change arrives as a whole new document. The
 * common prefix and suffix recover the span that actually changed, which is one
 * contiguous edit for typing and pasting.
 */
function diffTexts(before: string, after: string): TextEdit {
	if (before === after) {
		return { start: before.length, oldEnd: before.length, newEnd: after.length, delta: 0 };
	}

	const max = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < max && before[prefix] === after[prefix]) prefix++;

	let suffix = 0;
	while (
		suffix < max - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}

	return {
		start: prefix,
		oldEnd: before.length - suffix,
		newEnd: after.length - suffix,
		delta: after.length - before.length,
	};
}

/**
 * Where a recorded span moved to, or -1 when the edit overlaps it.
 *
 * A span before the change stays put; one after it moves by the net delta. A
 * span the change runs through has no trustworthy position -- its name may be
 * half rewritten -- so it is dropped until the next analysis.
 */
function shiftOffset(offset: number, length: number, edit: TextEdit): number {
	if (offset + length <= edit.start) return offset;
	if (offset >= edit.oldEnd) return offset + edit.delta;
	return -1;
}

function positionOfOffset(starts: number[], offset: number): { line: number; character: number } {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low, character: offset - starts[low] };
}

/* ------------------------------------------------------------------ *
 * Document symbols (outline)
 * ------------------------------------------------------------------ */

export interface OutlineSymbol {
	name: string;
	detail?: string;
	kind: 'function' | 'variable' | 'type';
	range: Range;
}

/**
 * The document's own declarations, in source order.
 *
 * Two kinds are left out. Locals and parameters are block scope, which the index
 * records but an outline has no use for. Struct fields are left out too: a flat
 * list interleaved with functions is harder to read than not having them, and
 * they are reachable through the struct they belong to.
 */
export function outline(document: IndexedDocument, mainPath?: string | null): OutlineSymbol[] {
	const symbols = document.index.symbols
		.filter(symbol => symbol.scope === 'file' && symbol.kind !== 'field')
		// A document's outline is its own declarations; one that came from an
		// `#include` belongs to that header's outline. Without this the header's
		// ranges are listed against the including file and point at other lines.
		.filter(symbol => mainPath === undefined || sameDocument(symbol.path, mainPath));

	const out: OutlineSymbol[] = [];
	// A forward declaration and its definition share a name. Show one entry,
	// preferably the definition (the symbol that points back at the forward).
	const typeAt = new Map<string, number>();
	for (const symbol of symbols) {
		const item: OutlineSymbol = {
			name: symbol.name,
			detail: symbol.type,
			kind:
				symbol.kind === 'function' ? 'function' : symbol.kind === 'type' ? 'type' : 'variable',
			range: symbol.range,
		};
		if (symbol.kind !== 'type') {
			out.push(item);
			continue;
		}
		const at = typeAt.get(symbol.name);
		if (at === undefined) {
			typeAt.set(symbol.name, out.length);
			out.push(item);
		} else if (symbol.declaration) {
			out[at] = item;
		}
	}
	return out;
}
