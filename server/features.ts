/*
 * Language features, as pure functions over the symbol index.
 *
 * Everything here takes plain data -- an index, some text, a position -- so the
 * behaviour can be tested without a language server, and the compiler can only
 * ever affect them through `src/compiler/symbols.ts`.
 */

import type {
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
		const { type, name, container } = reference.target;
		return {
			contents: [
				'```mlgc',
				`${type} ${name};`,
				'```',
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

	const declaration =
		target.path !== null
			? `\n\nDeclared in \`${basename(target.path)}\`, line ${target.range.start.line + 1}.`
			: '';

	return {
		contents: ['```mlgc', signatureOf(target), '```', declaration].join('\n\n'),
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
	/** Replace only what was typed, for `@` and `.` completions. */
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

	return generalCompletions(document);
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
			items.push({
				// The table entries already carry the sigil.
				label: name,
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

function generalCompletions(document: IndexedDocument): CompletionItem[] {
	const items: CompletionItem[] = [];
	const seen = new Set<string>();

	for (const symbol of document.index.symbols) {
		// A field is only nameable through an object, so offering it bare would
		// suggest `x` where only `p.x` compiles. It is offered after a `.`
		// instead, by `memberCompletions`.
		if (symbol.kind === 'field') continue;
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
	const declared = symbol.parameters;
	if (!declared) {
		// No parameter list in the index: an old worker, or a type this cannot
		// split. The rendered type is still a usable label.
		return { label: signatureOf(symbol), parameters: [] };
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
	return { label, parameters };
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
	return document.index.symbols
		.filter(symbol => symbol.scope === 'file' && symbol.kind !== 'field')
		// A document's outline is its own declarations; one that came from an
		// `#include` belongs to that header's outline. Without this the header's
		// ranges are listed against the including file and point at other lines.
		.filter(symbol => mainPath === undefined || sameDocument(symbol.path, mainPath))
		.map(symbol => ({
			name: symbol.name,
			detail: symbol.type,
			kind:
				symbol.kind === 'function' ? 'function' : symbol.kind === 'type' ? 'type' : 'variable',
			range: symbol.range,
		}));
}
