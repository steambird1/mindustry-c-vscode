/*
 * Flattening the compiler's analysed AST into an index the language server can
 * use without ever touching a compiler object again.
 *
 * After `analyze()` the semantic analyser has annotated every node it could
 * resolve: `Identifier` nodes get a `symbol` (a `SymbolEntry`) and a `dataType`,
 * and declaration nodes resolve through the scope of the block they sit in.
 * Everything the editor needs -- hover, go-to-definition, references, rename,
 * the outline -- comes out of a single walk, so the server holds plain data and
 * a compiler refactor can only break this one file.
 *
 * The AST is not shaped the way an editor wants it, and these are the gaps that
 * matter. Every one of them is a quirk of the compiler, not a choice, so each
 * is bridged here rather than patched into the compiler:
 *
 *  - A declaration's `location` is the *start of the statement*, not the name.
 *    `int total(int a)` reports the position of `int`, and a function's symbol
 *    does the same, so go-to-definition would land on the return type. The name
 *    is recovered from the source text: for a function it is the identifier in
 *    front of the parameter list's `(`, elsewhere it is the first whole-word
 *    match after the reported position.
 *
 *  - A struct definition's `type` is the bare keyword `'struct'` or `'union'`
 *    (the parser overwrites the node type), its name is on `name` rather than
 *    `typeName`, and its members are untyped nodes whose `type` is a type
 *    specifier object. Nothing about it looks like a declaration unless you
 *    already know that, so `typeDefinitions` is walked up front and the generic
 *    walk skips it.
 *
 *  - A `TypeSpecifier` carries a `typeName`, so any generic "this node declares
 *    a type" rule fires on every return type and every declared type and invents
 *    a type called `int`. Only `typeDefinitions` declares types here.
 *
 *  - `MemberExpression`'s member name is an `Identifier` with no location and no
 *    symbol; the expression's own location points at the object. The member's
 *    position comes from the source text, and the member's type and declaration
 *    come from the struct definition the object resolved to.
 *
 * Overloaded functions are renamed to `name__ov1` internally. They are indexed
 * under the name the user wrote, one entry per declaration.
 */

import type { DocumentIndex, ParameterInfo, ReferenceInfo, StructInfo, SymbolInfo } from '../common/types';

/* ------------------------------------------------------------------ *
 * Structural views of the compiler's AST
 *
 * Declared here rather than imported: the compiler ships no types, and if its
 * shape changes the compiler should fail to build in one file only.
 * ------------------------------------------------------------------ */

interface AstLocation {
	line: number;
	column: number;
	index?: number;
	filename?: string;
}

interface AstNode {
	type?: unknown;
	location?: AstLocation | null;
	/** SymbolEntry, set by the semantic analyser on resolved identifiers. */
	symbol?: SymbolEntry | null;
	/** TypeInfo, set by the semantic analyser on expressions. */
	dataType?: TypeInfo | null;
	scope?: AstScope | null;
	name?: unknown;
	typeName?: unknown;
	children?: unknown[];
	/** A type specifier: `typeName` plus the declarator's pointer/array shape. */
	pointerDepth?: number;
	pointerQualifiers?: string[];
	arrayDimensions?: unknown[];
	/** Set on function declarations. */
	returnType?: AstNode;
	parameters?: AstNode[];
	/** Set on struct and union definitions. */
	members?: AstNode[];
	/** Set on typedefs, and on variable declaration statements. */
	declarators?: AstNode[];
	typeDefinitions?: AstNode[];
	functions?: AstNode[];
	globalDeclarations?: AstNode[];
	[key: string]: unknown;
}

interface AstScope {
	lookup?(name: string): SymbolEntry | null;
}

interface TypeInfo {
	name?: string;
	kind?: string;
	members?: TypeMember[];
	pointerTo?: TypeInfo | null;
	arraySize?: { value?: number } | number | null;
	qualifiers?: string[];
	[unknown: string]: unknown;
}

interface TypeMember {
	name: string;
	type?: TypeInfo;
	offset?: number;
	[unknown: string]: unknown;
}

interface FunctionSignature {
	returnType: string;
	parameters?: Array<{ name?: string; type?: string }>;
	hasVarArgs?: boolean;
}

interface SymbolEntry {
	name: string;
	kind: string;
	type?: unknown;
	location?: AstLocation | null;
	[unknown: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Public input / output
 * ------------------------------------------------------------------ */

export interface IndexInput {
	ast: unknown;
	version: number;
	/** The document being indexed. */
	uri: string;
	/** fs path of the main file, or null when analysing a buffer with no file. */
	mainPath: string | null;
	/** Text of every file that took part, so positions can be recovered. */
	sources?: Map<string, string>;
	/** Files pulled in by #include, for watching. */
	includes?: string[];
	/** Set when analysis blew up, so the caller can show it once. */
	internalError?: string;
}

/* ------------------------------------------------------------------ *
 * Positions
 *
 * The compiler reports 1-based line and column with a 0-based character index.
 * LSP wants 0-based for both, and `index` is not always present, so a line-start
 * table per file backs it up.
 * ------------------------------------------------------------------ */

interface LineIndex {
	starts: number[];
	length: number;
}

export class FileText {
	private readonly cache = new Map<string, LineIndex>();

	constructor(private readonly sources: Map<string, string>) {}

	text(path: string): string {
		return this.sources.get(path) ?? '';
	}

	private index(path: string): LineIndex {
		let index = this.cache.get(path);
		if (index) return index;
		const text = this.text(path);
		const starts = [0];
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) starts.push(i + 1);
		}
		index = { starts, length: text.length };
		this.cache.set(path, index);
		return index;
	}

	/** 0-based character offset for a 1-based line/column pair. */
	offset(path: string, line: number, column: number, index?: number): number {
		if (typeof index === 'number' && index >= 0) return Math.min(index, this.index(path).length);
		const { starts, length } = this.index(path);
		if (line < 1 || line > starts.length) return 0;
		return Math.min(starts[line - 1] + Math.max(0, column - 1), length);
	}

	/** LSP position for a 0-based character offset. */
	position(path: string, offset: number): SymbolInfo['range']['start'] {
		const { starts, length } = this.index(path);
		const clamped = Math.max(0, Math.min(offset, length));
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (starts[middle] <= clamped) low = middle;
			else high = middle - 1;
		}
		return { line: low, character: clamped - starts[low] };
	}

	range(path: string, offset: number, length: number): SymbolInfo['range'] {
		return {
			start: this.position(path, offset),
			end: this.position(path, offset + length),
		};
	}
}

/* ------------------------------------------------------------------ *
 * Type rendering
 * ------------------------------------------------------------------ */

function renderTypeInfo(type: TypeInfo | null | undefined): string {
	if (!type) return '?';
	switch (type.kind) {
		case 'pointer': {
			const inner = renderTypeInfo(type.pointerTo);
			return inner.endsWith('*') ? `${inner}*` : `${inner} *`;
		}
		case 'array':
			return `${renderTypeInfo(type.pointerTo)}[${sizeOf(type.arraySize) ?? ''}]`;
		case 'function':
			return renderSignature(type as unknown as FunctionSignature);
		default: {
			const name = type.name || type.kind || '?';
			const qualifiers = type.qualifiers?.length ? `${type.qualifiers.join(' ')} ` : '';
			return `${qualifiers}${name}`;
		}
	}
}

function sizeOf(arraySize: TypeInfo['arraySize']): number | null {
	if (typeof arraySize === 'number') return arraySize;
	if (arraySize && typeof arraySize === 'object' && typeof arraySize.value === 'number') {
		return arraySize.value;
	}
	return null;
}

function renderSignature(signature: FunctionSignature): string {
	const parameters = (signature.parameters ?? [])
		.map(parameter => parameter.type ?? '?')
		.join(', ');
	return `${signature.returnType ?? '?'}(${parameters}${signature.hasVarArgs ? ', ...' : ''})`;
}

/**
 * A function's parameter list, for signature help.
 *
 * `f(void)` is C's "no parameters", but the parser hands back one parameter of
 * type `void` with no name; it is dropped so signature help does not claim the
 * function takes an argument.
 */
function renderParameters(node: AstNode, path: string | null, texts: FileText): ParameterInfo[] | undefined {
	if (!Array.isArray(node.parameters)) return undefined;
	const parameters = node.parameters.map(parameter => {
		const name = typeof parameter.name === 'string' ? parameter.name : null;
		return { name, type: parameterType(parameter, path, texts, name) };
	});
	if (parameters.length === 1 && parameters[0].name === null && parameters[0].type === 'void') return [];
	return parameters;
}

/**
 * The parameter's type as it was written.
 *
 * A `TypeSpecifier` keeps only the keyword for a struct parameter (`struct`,
 * not `struct point`), so the source between the declaration and the name is
 * the reliable spelling. Array dimensions are written after the name, so they
 * are appended from the declarator.
 */
function parameterType(
	parameter: AstNode,
	path: string | null,
	texts: FileText,
	name: string | null
): string {
	const dimensions = Array.isArray(parameter.arrayDimensions) ? parameter.arrayDimensions : [];
	const suffix = dimensions
		.map(dimension => {
			const value = dimension && typeof dimension === 'object' ? (dimension as AstNode).value : undefined;
			return `[${typeof value === 'number' ? value : ''}]`;
		})
		.join('');

	const location = parameter.location;
	if (path && location) {
		const start = texts.offset(path, location.line, location.column, location.index);
		const nameStart = name ? nameOffset(texts, path, location, name, false) : -1;
		if (nameStart > start) return `${texts.text(path).slice(start, nameStart).trim()}${suffix}`;
	}

	// No source to read (an untitled buffer): the specifier is all there is.
	const specifier = parameter.type as AstNode | null;
	const base = specifier && typeof specifier.typeName === 'string' ? specifier.typeName : '?';
	const depth = specifier && typeof specifier.pointerDepth === 'number' ? specifier.pointerDepth : 0;
	return `${base}${suffix}${depth > 0 ? ` ${'*'.repeat(depth)}` : ''}`;
}

/**
 * Render whatever `SymbolEntry.type` happens to hold.
 *
 * A symbol's type is either a value type (`{ type, isConst, ... }` wrapping a
 * TypeInfo) or a function signature. Both are plain objects here, so they are
 * told apart by shape rather than by a tag the compiler may rename.
 */
export function renderSymbolType(type: unknown): string {
	if (type === null || type === undefined) return '?';
	if (typeof type === 'string') return type;
	const candidate = type as {
		type?: TypeInfo;
		returnType?: string;
		parameters?: unknown;
		isConst?: boolean;
		isVolatile?: boolean;
		isExtern?: boolean;
	};
	if (typeof candidate.returnType === 'string' || Array.isArray(candidate.parameters)) {
		return renderSignature(candidate as FunctionSignature);
	}
	const base = renderTypeInfo(candidate.type);
	const flags = [
		candidate.isConst ? 'const' : '',
		candidate.isVolatile ? 'volatile' : '',
		candidate.isExtern ? 'extern' : '',
	].filter(Boolean);
	return flags.length ? `${base} ${flags.join(' ')}` : base;
}

/* ------------------------------------------------------------------ *
 * Names inside the source text
 * ------------------------------------------------------------------ */

function isWordChar(code: number): boolean {
	return (
		(code >= 97 && code <= 122) || // a-z
		(code >= 65 && code <= 90) || // A-Z
		(code >= 48 && code <= 57) || // 0-9
		code === 95 // _
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is `name` written at `offset` as a whole word? */
function wordAt(text: string, offset: number, name: string): boolean {
	if (!text.startsWith(name, offset)) return false;
	if (offset > 0 && isWordChar(text.charCodeAt(offset - 1))) return false;
	const after = text.charCodeAt(offset + name.length);
	return !(after === after && isWordChar(after));
}

/** Offset of the first whole-word `name` at or after `from`, or -1. */
function findWord(text: string, from: number, name: string, limit: number): number {
	const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
	pattern.lastIndex = Math.max(0, from);
	const match = pattern.exec(text);
	if (!match || match.index > limit) return -1;
	return match.index;
}

/**
 * Where a function's name is written.
 *
 * A function declaration's location is its return type, and the symbol the
 * analyser hands out for it points at the same place, so the name has to be
 * found. Every function declaration opens its parameter list with `(` and the
 * name is the identifier directly in front of it, which is exact rather than a
 * search; the word search is only the fallback for a return type that itself
 * contains a parenthesis, such as a function-pointer typedef.
 */
function findFunctionName(text: string, from: number, name: string): number {
	if (wordAt(text, from, name)) return from;
	const open = text.indexOf('(', from);
	if (open > from) {
		let start = open;
		while (start > from && isWordChar(text.charCodeAt(start - 1))) start--;
		if (text.slice(start, open) === name) return start;
	}
	return findWord(text, from, name, from + 512);
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

function asName(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function nodeType(node: AstNode): string {
	return typeof node.type === 'string' ? node.type : '';
}

/** The compiler renames the second and later overloads to `name__ov1`. */
function sourceName(name: string): string {
	const match = /^(.*)__ov\d+$/.exec(name);
	return match ? match[1] : name;
}

interface MemberDeclaration {
	path: string;
	offset: number;
	/** The field itself, so a use resolves to the same declaration object. */
	symbol: SymbolInfo;
}

interface WalkState {
	references: ReferenceInfo[];
	symbols: SymbolInfo[];
	structs: StructInfo[];
	/** `struct name` + member name -> the member's declaration site. */
	memberDeclarations: Map<string, MemberDeclaration>;
	/** Resolved struct types, keyed by the struct's own name. */
	structTypes: Map<string, TypeInfo>;
	/** Declarations the type pre-pass has already recorded. */
	claimed: WeakSet<object>;
}

export function buildDocumentIndex(input: IndexInput): DocumentIndex {
	const texts = new FileText(input.sources ?? new Map());
	const state: WalkState = {
		references: [],
		symbols: [],
		structs: [],
		memberDeclarations: new Map(),
		structTypes: new Map(),
		claimed: new WeakSet(),
	};

	if (input.ast) {
		const program = input.ast as AstNode;
		collectTypeDefinitions(program, input.mainPath, texts, state);
		walk(program, input.mainPath, texts, state, program.scope ?? null, false, null, new WeakSet());
	}

	state.references.sort((a, b) => a.offset - b.offset);
	state.symbols.sort((a, b) => a.range.start.line - b.range.start.line);

	return {
		uri: input.uri,
		version: input.version,
		references: state.references,
		symbols: state.symbols,
		structs: state.structs,
		includes: input.includes ?? [],
		...(input.internalError ? { internalError: input.internalError } : {}),
	};
}

/* ------------------------------------------------------------------ *
 * Type definitions
 *
 * `Program.typeDefinitions` is the only place a type is declared, and its nodes
 * look like nothing else in the AST, so it is read up front. That also gives
 * member accesses somewhere to jump to.
 * ------------------------------------------------------------------ */

function collectTypeDefinitions(
	program: AstNode,
	mainPath: string | null,
	texts: FileText,
	state: WalkState
): void {
	const definitions = Array.isArray(program.typeDefinitions) ? program.typeDefinitions : [];
	for (const node of definitions) {
		if (!node || typeof node !== 'object') continue;
		const keyword = nodeType(node);
		if (keyword === 'struct' || keyword === 'union') {
			collectStruct(node as AstNode, keyword, mainPath, texts, state);
		} else if (Array.isArray(node.declarators)) {
			collectTypedef(node as AstNode, mainPath, texts, state);
		}
	}
}

function collectStruct(
	node: AstNode,
	keyword: 'struct' | 'union',
	mainPath: string | null,
	texts: FileText,
	state: WalkState
): void {
	const name = asName(node.name);
	if (!name || !node.location) return;
	const path = node.location.filename ?? mainPath;
	if (!path) return;
	state.claimed.add(node);

	const offset = nameOffset(texts, path, node.location, name, false);
	if (offset < 0) return;

	const symbol: SymbolInfo = {
		kind: 'type',
		name,
		type: keyword,
		scope: 'file',
		path,
		range: texts.range(path, offset, name.length),
		declarationOffset: offset,
	};
	state.symbols.push(symbol);
	state.references.push({
		path,
		range: symbol.range,
		offset,
		isDeclaration: true,
		target: symbol,
	});

	// The analyser resolves the struct's own type into the program scope, which
	// gives every member a rendered type without reading the declaration back.
	const resolved = lookupType(node, name);
	if (resolved) state.structTypes.set(name, resolved);

	const members: StructInfo['members'] = [];
	for (const memberNode of Array.isArray(node.members) ? node.members : []) {
		if (!memberNode || typeof memberNode !== 'object') continue;
		state.claimed.add(memberNode);
		const member = memberNode as AstNode;
		const memberName = asName(member.name);
		if (!memberName || !member.location) continue;
		const memberPath = member.location.filename ?? path;
		if (!memberPath) continue;
		const memberOffset = nameOffset(texts, memberPath, member.location, memberName, false);
		if (memberOffset < 0) continue;

		const type = memberTypeText(name, memberName, member, state);
		// A member is a declaration like any other: it gets a symbol of its own so
		// that find-references and rename work from inside the struct body, not
		// only from a use. `symbols` holds it for the same reason, though the
		// outline leaves fields out -- a flat outline with every field in it is
		// noise, and completion finds them through the struct instead.
		const field: SymbolInfo = {
			kind: 'field',
			name: memberName,
			type,
			scope: 'file',
			path: memberPath,
			range: texts.range(memberPath, memberOffset, memberName.length),
			declarationOffset: memberOffset,
			container: name,
		};
		state.memberDeclarations.set(`${name} ${memberName}`, {
			path: memberPath,
			offset: memberOffset,
			symbol: field,
		});
		state.symbols.push(field);
		state.references.push({
			path: memberPath,
			range: field.range,
			offset: memberOffset,
			isDeclaration: true,
			target: field,
		});
		members.push({
			name: memberName,
			type,
			offset: memberOffset,
			...(bitFieldText(member, texts, memberPath) ?? {}),
		});
	}

	if (!members.length) return;
	state.structs.push({ name, path, range: symbol.range, members });
}

/**
 * A member's declared type.
 *
 * The analyser already rendered it, which resolves the awkward cases (`struct
 * point` collapses to just `point`, a pointer to a struct included from another
 * file resolves to that struct). The declaration's own type specifier is the
 * fallback, and is lossy for `struct X` -- it only records the keyword.
 */
function memberTypeText(
	structName: string,
	memberName: string,
	member: AstNode,
	state: WalkState
): string {
	const resolved = state.structTypes
		.get(structName)
		?.members?.find(candidate => candidate.name === memberName);
	if (resolved?.type) return renderTypeInfo(resolved.type);
	return renderSpecifier(member.type as TypeInfo | null | undefined);
}

/** A `TypeSpecifier`, as far as it can be rendered without the analyser. */
function renderSpecifier(specifier: TypeInfo | null | undefined): string {
	if (!specifier) return '?';
	const name = asName(specifier.typeName) ?? '?';
	const stars = '*'.repeat(Math.max(0, Number(specifier.pointerDepth) || 0));
	const base = stars ? `${name} ${stars}` : name;
	const arrays = Array.isArray(specifier.arrayDimensions) ? specifier.arrayDimensions.length : 0;
	return `${base}${'[]'.repeat(arrays)}`;
}

function bitFieldText(member: AstNode, texts: FileText, path: string): { bitField: string } | null {
	// A bit field's width lives in an expression node with no useful location, so
	// the text after the name is taken instead. Only present when the source
	// really has one, which is the `name : width;` form.
	const name = asName(member.name);
	const location = member.location;
	if (!name || !location) return null;
	const start = texts.offset(path, location.line, location.column, location.index);
	const after = texts.text(path).slice(start + name.length, start + name.length + 32);
	const match = /^\s*:\s*([0-9]+)\s*;/.exec(after);
	return match ? { bitField: match[1] } : null;
}

/**
 * The struct's own type, as the analyser resolved it.
 *
 * Looking the name up in the scope the definition sits in gives the resolved
 * TypeInfo, whose members carry their own types -- which is the only way to
 * render a member of a struct included from another file, or one whose
 * declaration says `struct point` where the specifier records only `struct`.
 */
function lookupType(node: AstNode, name: string): TypeInfo | null {
	const entry = callLookup(node.scope ?? null, name);
	const type = entry ? unwrapSymbolType(entry.type) : null;
	return type && type.members ? type : null;
}

function collectTypedef(
	node: AstNode,
	mainPath: string | null,
	texts: FileText,
	state: WalkState
): void {
	if (!node.location) return;
	const path = node.location.filename ?? mainPath;
	if (!path) return;
	const declaredAt = texts.offset(path, node.location.line, node.location.column, node.location.index);
	const text = texts.text(path);

	for (const declarator of node.declarators ?? []) {
		if (!declarator || typeof declarator !== 'object') continue;
		state.claimed.add(declarator);
		const alias = declarator as AstNode;
		const name = asName(alias.name);
		const location = alias.location;
		if (!name || !location) continue;
		const aliasPath = location.filename ?? path;
		if (!aliasPath) continue;
		const offset = nameOffset(texts, aliasPath, location, name, false);
		if (offset < 0) continue;

		// The type specifier only records `struct` for `typedef struct point p`,
		// so the declared type is read out of the text between the keyword and
		// the name, which is exactly what the user wrote.
		const base = text
			.slice(declaredAt + TYPEDEF_KEYWORD.length, offset)
			.replace(/\s+/g, ' ')
			.trim();
		const symbol: SymbolInfo = {
			kind: 'type',
			name,
			type: base ? `typedef ${base}` : 'typedef',
			scope: 'file',
			path: aliasPath,
			range: texts.range(aliasPath, offset, name.length),
			declarationOffset: offset,
		};
		state.symbols.push(symbol);
		state.references.push({
			path: aliasPath,
			range: symbol.range,
			offset,
			isDeclaration: true,
			target: symbol,
		});
	}
}

const TYPEDEF_KEYWORD = 'typedef';

/* ------------------------------------------------------------------ *
 * The generic walk
 * ------------------------------------------------------------------ */

function walk(
	node: unknown,
	mainPath: string | null,
	texts: FileText,
	state: WalkState,
	scope: AstScope | null,
	inFunction: boolean,
	owner: string | null,
	seen: WeakSet<object>
): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, mainPath, texts, state, scope, inFunction, owner, seen);
		return;
	}
	if (seen.has(node)) return;
	seen.add(node);

	const ast = node as AstNode;
	const location = ast.location;
	const childScope = (ast.scope as AstScope | null) ?? scope;
	// Everything under a function is block scope, including its parameters, so
	// the outline can tell a local from a declaration.
	const childInFunction = inFunction || nodeType(ast) === 'FunctionDeclaration';
	// And everything under it belongs to that function, which is what lets
	// completion leave another function's locals out.
	const functionName = nodeType(ast) === 'FunctionDeclaration' ? asName(ast.name) : null;
	const childOwner = functionName ? sourceName(functionName) : owner;

	if (location && typeof location.line === 'number' && !state.claimed.has(ast)) {
		visit(ast, location.filename ?? mainPath, texts, state, childScope, inFunction, owner);
	}

	for (const [key, value] of Object.entries(ast)) {
		// `parent` would loop forever, and the rest hold no child nodes:
		//   - `scope` and `location` are not trees;
		//   - `symbol` is a flat SymbolEntry that carries the *same* name and
		//     location as the node it was resolved from, so walking it would
		//     declare every parameter and variable a second time;
		//   - `dataType` is a resolved type, and nothing under it is source;
		//   - `type` is a type specifier node on struct members, where it holds
		//     the member's type rather than its node type;
		//   - `typeDefinitions` is already done by the type pre-pass.
		if (SKIPPED_KEYS.has(key)) continue;
		if (key === 'typeDefinitions' && Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === 'object') seen.add(child);
			}
			continue;
		}
		if (value && typeof value === 'object') {
			walk(value, mainPath, texts, state, childScope, childInFunction, childOwner, seen);
		}
	}
}

const SKIPPED_KEYS = new Set(['parent', 'scope', 'location', 'symbol', 'dataType', 'type']);

function visit(
	node: AstNode,
	path: string | null,
	texts: FileText,
	state: WalkState,
	scope: AstScope | null,
	inFunction: boolean,
	owner: string | null
): void {
	const location = node.location;
	if (!location) return;

	const type = nodeType(node);
	const name = asName(node.name);
	const symbol = resolveSymbol(node, name, scope);
	const local = inFunction ? ('local' as const) : ('file' as const);

	/* -- declarations ------------------------------------------------ */

	if (type === 'FunctionDeclaration' && name) {
		// Overloads are `name__ov1` internally but share the source name, so
		// each declaration gets its own entry under the name the user wrote.
		const info = describe(symbol, sourceName(name), 'function', local, path, texts, location, true);
		if (info) {
			info.parameters = renderParameters(node, path, texts);
			declare(state, info, path);
		}
		return;
	}

	if (type === 'VariableDeclarator' && name) {
		// The analyser resolves the declared type on the declarator itself, which
		// resolves typedefs and `struct X` alike; the symbol is the fallback for
		// a declarator it did not reach.
		const offset = nameOffset(texts, path ?? '', location, name, false);
		if (offset < 0) return;
		const resolved = node.dataType as TypeInfo | null | undefined;
		const info: SymbolInfo = {
			kind: 'variable',
			name,
			type: resolved ? renderTypeInfo(resolved) : renderSymbolType(symbol?.type),
			scope: local,
			path,
			range: texts.range(path ?? '', offset, name.length),
			declarationOffset: offset,
			...(local === 'local' && owner ? { owner } : {}),
		};
		state.symbols.push(info);
		state.references.push({
			path,
			range: info.range,
			offset,
			isDeclaration: true,
			target: info,
		});
		return;
	}

	// A parameter is an untyped node: no `type`, a `name`, and no symbol of its
	// own, but the function it belongs to can resolve the name.
	if (!type && name && symbol?.kind === 'parameter') {
		const info = describe(symbol, name, 'parameter', 'local', path, texts, location, false);
		if (info) {
			if (owner) info.owner = owner;
			declare(state, info, path);
		}
		return;
	}

	/* -- member access ----------------------------------------------- */

	if (type === 'MemberExpression') {
		// The object expression is a child and gets visited normally; only the
		// member name, which the parser left without a location, is handled here.
		visitMemberAccess(node, path, texts, state);
		return;
	}

	/* -- uses --------------------------------------------------------- */

	// `print(...)`, `write(...)`: builtins carry no SymbolEntry. The generated
	// tables give the server their signatures for hover and completion, and they
	// are never renameable, so they are simply not indexed.
	if (type === 'BuiltinCall') return;

	// `@copper` and friends parse as identifiers named after the whole sigil, but
	// they are content ids rather than names the user declared. Indexing them as
	// unresolved would have hover claim they are undeclared, which is the opposite
	// of the truth, so they are left to the generated tables.
	if (type === 'Identifier' || type === 'FunctionCall') {
		if (!name || name.startsWith('@')) return;
		const offset = texts.offset(path ?? '', location.line, location.column, location.index);
		const target = symbol
			? describe(
					symbol,
					name,
					symbol.kind,
					local,
					path,
					texts,
					symbol.location ?? null,
					symbol.kind === 'function'
				)
			: null;
		state.references.push({
			path,
			range: texts.range(path ?? '', offset, name.length),
			offset,
			isDeclaration: false,
			target,
		});
	}
}

/** Where a declaration's name is written, or -1 if the text is not available. */
function nameOffset(
	texts: FileText,
	path: string,
	location: AstLocation,
	name: string,
	isFunction: boolean
): number {
	if (!path) return -1;
	const from = texts.offset(path, location.line, location.column, location.index);
	const text = texts.text(path);
	return isFunction
		? findFunctionName(text, from, name)
		: wordAt(text, from, name)
			? from
			: findWord(text, from, name, from + 512);
}

function resolveSymbol(node: AstNode, name: string | null, scope: AstScope | null): SymbolEntry | null {
	if (node.symbol) return node.symbol;
	if (!name) return null;
	return callLookup(scope, name);
}

function callLookup(scope: AstScope | null, name: string): SymbolEntry | null {
	const lookup = scope?.lookup;
	if (typeof lookup !== 'function' || !scope) return null;
	try {
		return lookup.call(scope, name) ?? null;
	} catch {
		return null;
	}
}

/** A symbol's type, whether it is a value type or the type itself. */
function unwrapSymbolType(type: unknown): TypeInfo | null {
	if (!type || typeof type !== 'object') return null;
	const candidate = type as TypeInfo & { type?: TypeInfo };
	if (candidate.members) return candidate;
	return candidate.type ?? null;
}

/**
 * Build the symbol a reference or declaration points at.
 *
 * The position of the *name* is what every feature needs -- go-to-definition,
 * rename and the outline all address ranges, not statements -- so it is
 * recovered from the source even when the compiler reported the start of the
 * declaration instead. Without a location there is nothing to point at, and the
 * reference is recorded unresolved rather than pointing somewhere plausible.
 */
function describe(
	symbol: SymbolEntry | null,
	name: string,
	kind: string,
	scope: 'file' | 'local',
	path: string | null,
	texts: FileText,
	location: AstLocation | null,
	isFunction: boolean
): SymbolInfo | null {
	if (!location || typeof location.line !== 'number') return null;
	const declarationPath = location.filename ?? path;
	if (!declarationPath) return null;
	const offset = nameOffset(texts, declarationPath, location, name, isFunction);
	if (offset < 0) return null;
	return {
		kind,
		name,
		type: symbol ? renderSymbolType(symbol.type) : '?',
		scope,
		path: declarationPath,
		range: texts.range(declarationPath, offset, name.length),
		declarationOffset: offset,
	};
}

function declare(state: WalkState, info: SymbolInfo, path: string | null): void {
	state.symbols.push(info);
	state.references.push({
		path,
		range: info.range,
		offset: info.declarationOffset,
		isDeclaration: true,
		target: info,
	});
}

/* ------------------------------------------------------------------ *
 * Member access
 * ------------------------------------------------------------------ */

function visitMemberAccess(
	node: AstNode,
	path: string | null,
	texts: FileText,
	state: WalkState
): void {
	const children = node.children ?? [];
	const objectNode = children[0] as AstNode | undefined;
	const memberNode = children[1] as AstNode | undefined;
	const memberName = memberNode ? asName(memberNode.name) : null;
	if (!objectNode || !memberName || !node.location) return;

	// The object resolved to a TypeInfo; a pointer to a struct puts the struct
	// one level down, and an array of structs puts it under `pointerTo` too.
	const type = unwrapSymbolType(objectNode.dataType) ?? null;
	const structName = structNameOf(type);
	const member = type?.members?.find(candidate => candidate.name === memberName) ?? null;

	// The member token has no location in the AST; find it in the source. The
	// expression's own location is the object's, so the scan starts there.
	const start = texts.offset(path ?? '', node.location.line, node.location.column, node.location.index);
	const memberOffset = findMemberToken(texts.text(path ?? ''), start, memberName);
	if (memberOffset < 0) return;

	// Prefer the field the struct definition declared, so the use resolves to
	// the same object the declaration did and find-references finds both. A
	// struct that was only forward-declared, or a member the analyser could not
	// resolve, has no such declaration; the use is then still recorded, pointing
	// at itself, so rename edits that occurrence rather than refusing outright.
	const declaration = structName
		? state.memberDeclarations.get(`${structName} ${memberName}`)
		: undefined;
	const target = declaration
		? declaration.symbol
		: member
			? {
					kind: 'field',
					name: memberName,
					type: renderTypeInfo(member.type),
					scope: 'file' as const,
					path: path ?? '',
					range: texts.range(path ?? '', memberOffset, memberName.length),
					declarationOffset: memberOffset,
				}
			: null;

	state.references.push({
		path,
		range: texts.range(path ?? '', memberOffset, memberName.length),
		offset: memberOffset,
		isDeclaration: false,
		target,
	});
}

/** The name of the struct a resolved type ends at, following pointers and arrays. */
function structNameOf(type: TypeInfo | null): string | null {
	let current = type;
	for (let depth = 0; current && depth < 8; depth++) {
		if ((current.kind === 'struct' || current.kind === 'union') && current.name) {
			return current.name;
		}
		current = current.pointerTo ?? null;
	}
	return null;
}

/**
 * `p . x` -> the offset of `x`, or -1.
 *
 * The scan is bounded because the AST gives only the object's position: without
 * a limit, an unresolvable member could match a `.x` in a later statement. A
 * miss returns -1 rather than a guess, so the reference is dropped instead of
 * being attached to the wrong token.
 */
function findMemberToken(text: string, from: number, memberName: string): number {
	const pattern = /(\.|->)(\s*)([A-Za-z_]\w*)/g;
	pattern.lastIndex = Math.max(0, from);
	const limit = from + 512;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > limit) break;
		if (match[3] === memberName) return match.index + match[1].length + match[2].length;
	}
	return -1;
}
