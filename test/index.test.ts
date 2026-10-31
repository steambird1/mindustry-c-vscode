/*
 * The symbol index and the coding features, end to end.
 *
 * These run against the real compiler through the bridge, so they cover the
 * awkward parts: a declaration's location points at the start of the statement
 * rather than at the name, a struct definition's node type is the bare keyword
 * `struct`, a `MemberExpression` loses its member identifier entirely, and
 * overloads are renamed to `name__ov1` internally. Hand-written ASTs would test
 * none of that.
 *
 * What is asserted is the shape the language server depends on: that every name
 * resolves to the others, that positions land inside the name they claim to, and
 * that the resolver degrades rather than lying when it cannot resolve something.
 *
 * Probe points are located by `indexOf` rather than by counting lines, so that
 * editing the fixture does not silently invalidate the expectations. Each one is
 * asserted to hold the expected word, which is what catches a needle that no
 * longer means what it did.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { capabilities } from '../src/compiler/bridge';
import { analyse, type AnalysisHost } from '../src/compiler/analysis';
import {
	complete,
	definition,
	hover,
	isReservedName,
	offsetOf,
	outline,
	positionIn,
	references,
	rename,
	semanticTokens,
	signatureHelp,
	quickFixes,
	type IndexedDocument,
} from '../server/features';
import type { AnalysisRequest, DocumentIndex } from '../src/common/types';

const URI = 'file:///project/main.mlgc';
const PATH = '/project/main.mlgc';

const SOURCE = `// A small program to index.
struct point {
	int x;
	int y;
};

int total(int a, int b) {
	return a + b;
}

int main() {
	point p;
	p.x = 1;
	p.y = 2;
	content_t ore = @copper;
	int s = total(p.x, p.y);
	return s;
}
`;

/** The offset of `needle`, verified to be a whole word. */
function at(needle: string, { occurrence = 1 }: { occurrence?: number } = {}): number {
	let offset = -1;
	for (let seen = 0; seen < occurrence; seen++) {
		offset = SOURCE.indexOf(needle, offset + 1);
	}
	assert.notEqual(offset, -1, `"${needle}" is not in the fixture`);
	// A needle that is a prefix of a longer name would put the cursor in the
	// middle of a different identifier, which is the failure this guards against.
	const after = SOURCE[offset + needle.length] ?? '';
	assert.ok(!/[A-Za-z0-9_]/.test(after), `"${needle}" is part of a longer name`);
	return offset;
}

/** The offset of the start of `word` in a MemberExpression's object, plus the member. */
function memberAt(expression: string): number {
	const offset = at(expression);
	const dot = SOURCE.indexOf('.', offset);
	assert.notEqual(dot, -1, `${expression} has no member access`);
	return dot + 1;
}

/** The index works in fs paths; the tests assert in uris. */
const toUri = (path: string) => (path === PATH ? URI : `file://${path}`);

function request(text: string): AnalysisRequest {
	return {
		id: 1,
		uri: URI,
		text,
		version: 1,
		targetVersion: 154.3,
		memoryBlocks: [{ name: 'cell1', size: 64, building: 'memory-cell' }],
		includePaths: [],
	};
}

const host: AnalysisHost = { readFile: () => null, pathOf: () => PATH };

let index: DocumentIndex;
let document: IndexedDocument;

before(async () => {
	assert.ok(capabilities.analyze, 'compiler patch 0001 is not applied; the analysis path needs it');
	const response = await analyse(request(SOURCE), host);
	assert.deepEqual(
		response.diagnostics.map(diagnostic => diagnostic.message),
		[],
		'the fixture must compile cleanly, or these tests prove nothing'
	);
	assert.ok(response.index, 'no index was produced');
	index = response.index;
	document = { uri: URI, index, text: SOURCE, mainPath: PATH };
});

/** The text a position covers, which must be the name it claims to be. */
function covered(start: { line: number; character: number }, length: number): string {
	const offset = offsetOf(SOURCE, start);
	return SOURCE.slice(offset, offset + length);
}

/** A position, for a readable failure message. */
function show(start: { line: number; character: number }): string {
	return `${start.line}:${start.character}`;
}

describe('positions', () => {
	it('round-trips an offset through a position', () => {
		const offset = at('total');
		assert.equal(offsetOf(SOURCE, positionIn(SOURCE, offset)), offset);
	});

	it('clamps a position past the end of the file', () => {
		assert.equal(offsetOf(SOURCE, { line: 9999, character: 9999 }), SOURCE.length);
		assert.deepEqual(positionIn(SOURCE, SOURCE.length + 50), positionIn(SOURCE, SOURCE.length));
	});
});

describe('the index', () => {
	it('finds the struct, the functions and the main declaration', () => {
		const names = index.symbols.map(symbol => symbol.name);
		for (const expected of ['point', 'total', 'main']) {
			assert.ok(names.includes(expected), `expected ${expected} in ${names.join(', ')}`);
		}
	});

	it('gives every symbol a range that covers the name it names', () => {
		// A declaration's location is the start of the statement, so the index has
		// to find the name itself. Getting this wrong by one token makes
		// go-to-definition land on the return type, and rename rewrite it.
		for (const symbol of index.symbols) {
			if (symbol.path !== PATH) continue;
			assert.equal(
				covered(symbol.range.start, symbol.name.length),
				symbol.name,
				`${symbol.kind} ${symbol.name} is declared at ${show(symbol.range.start)}`
			);
		}
	});

	it('gives every reference a range that covers the name it names', () => {
		for (const reference of index.references) {
			const name = reference.target?.name;
			if (!name || reference.path !== PATH) continue;
			assert.equal(
				covered(reference.range.start, name.length),
				name,
				`a reference to ${name} is at ${show(reference.range.start)}`
			);
		}
	});

	it('lists the struct with its members', () => {
		const point = index.structs.find(struct => struct.name === 'point');
		assert.ok(point, 'struct point was not indexed');
		assert.deepEqual(
			point.members.map(member => member.name),
			['x', 'y']
		);
		// Members carry their own offsets, taken from the AST, so each one is
		// addressable without re-scanning the struct's text.
		for (const member of point.members) {
			assert.equal(SOURCE.slice(member.offset, member.offset + member.name.length), member.name);
		}
		assert.equal(covered(point.range.start, point.name.length), 'point');
	});

	it('records the declared type of a struct member', () => {
		const point = index.structs.find(struct => struct.name === 'point')!;
		assert.deepEqual(
			point.members.map(member => member.type),
			['int', 'int']
		);
	});

	it('marks locals apart from file scope, so the outline can tell them apart', () => {
		const scope = (name: string) => index.symbols.find(symbol => symbol.name === name)?.scope;
		assert.equal(scope('total'), 'file');
		assert.equal(scope('main'), 'file');
		assert.equal(scope('point'), 'file');
		assert.equal(scope('p'), 'local');
		assert.equal(scope('s'), 'local');
		// A parameter is block scope even though it is declared in a signature.
		assert.equal(scope('a'), 'local');
	});

	it('does not invent a type for a built-in type name', () => {
		// A TypeSpecifier carries a `typeName`, so a naive "this node declares a
		// type" rule records every return type as a declaration of `int`.
		const types = index.symbols.filter(symbol => symbol.kind === 'type');
		assert.deepEqual(
			types.map(symbol => symbol.name),
			['point']
		);
	});

	it('orders references by offset', () => {
		const offsets = index.references.map(reference => reference.offset);
		assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
	});
});

describe('hover', () => {
	it('describes a parameter at its use', () => {
		const shown = hover(document, positionIn(SOURCE, at('a + b')));
		assert.ok(shown, 'no hover for a parameter');
		assert.match(shown.contents, /a/);
	});

	it('describes a function at its use, with its signature', () => {
		const shown = hover(document, positionIn(SOURCE, at('total(p.x')));
		assert.ok(shown, 'no hover for a function');
		assert.match(shown.contents, /int total\(int, int\)/);
	});

	it('describes a struct member access', () => {
		const shown = hover(document, positionIn(SOURCE, memberAt('p.x = 1')));
		assert.ok(shown, 'no hover for a struct member');
		assert.match(shown.contents, /x/);
	});

	it('says which struct a member belongs to', () => {
		const shown = hover(document, positionIn(SOURCE, memberAt('p.x = 1')));
		assert.match(shown!.contents, /Field of `point`/);
	});

	it('returns nothing on whitespace rather than guessing', () => {
		assert.equal(hover(document, positionIn(SOURCE, SOURCE.indexOf('\n\nint main'))), null);
	});
});

describe('go to definition', () => {
	it('jumps from a use of a function to its declaration', () => {
		const found = definition(document, positionIn(SOURCE, at('total(p.x')), toUri);
		assert.ok(found, 'no definition for total');
		assert.equal(found.uri, URI);
		// The declaration's own location is the `int`; this must not land there.
		assert.equal(covered(found.range.start, 'total'.length), 'total');
	});

	it('jumps from a struct member to its declaration', () => {
		const found = definition(document, positionIn(SOURCE, memberAt('p.y = 2')), toUri);
		assert.ok(found, 'no definition for the member y');
		assert.equal(covered(found.range.start, 1), 'y');
		assert.equal(positionIn(SOURCE, offsetOf(SOURCE, found.range.start)).line, 3, 'expected the struct body');
	});

	it('jumps from a local variable to its declaration', () => {
		const found = definition(document, positionIn(SOURCE, at('p.y', { occurrence: 2 })), toUri);
		assert.ok(found, 'no definition for p');
		assert.equal(covered(found.range.start, 1), 'p');
	});

	it('jumps from a declaration to itself', () => {
		const found = definition(document, positionIn(SOURCE, at('total', { occurrence: 1 })), toUri);
		assert.equal(found?.uri, URI);
	});
});

describe('type rendering', () => {
	it('shows byname after the star, on variables and struct members', async () => {
		const BYNAME = `int *byname named;
int *plain;
struct holder { int *byname member; int *raw; };
int main(void) { return 0; }
`;
		const response = await analyse(request(BYNAME), host);
		assert.deepEqual(
			response.diagnostics.map(diagnostic => diagnostic.message),
			[],
			'the byname fixture must compile cleanly'
		);
		assert.ok(response.index, 'no index for the byname fixture');
		const byname: IndexedDocument = { uri: URI, index: response.index, text: BYNAME, mainPath: PATH };

		const named = byname.index.symbols.find(symbol => symbol.name === 'named' && symbol.scope === 'file');
		assert.equal(named?.type, 'int *byname');
		const plain = byname.index.symbols.find(symbol => symbol.name === 'plain' && symbol.scope === 'file');
		assert.equal(plain?.type, 'int *');

		const holder = byname.index.structs.find(struct => struct.name === 'holder');
		assert.equal(holder?.members.find(member => member.name === 'member')?.type, 'int *byname');
		assert.equal(holder?.members.find(member => member.name === 'raw')?.type, 'int *');

		const shown = hover(byname, positionIn(BYNAME, BYNAME.indexOf('named')));
		assert.match(shown?.contents ?? '', /int \*byname named/);
	});

	it('distinguishes string_t, char pointers and char', async () => {
		const STRINGS = `string_t native = "hi";
const char *view = "hi";
char letter = 'A';
char buffer[] = "hi";
int main(void) { return 0; }
`;
		const response = await analyse(request(STRINGS), host);
		assert.deepEqual(
			response.diagnostics.map(diagnostic => diagnostic.message),
			[],
			'the string fixture must analyse cleanly'
		);
		assert.ok(response.index, 'no index for the string fixture');
		const strings: IndexedDocument = { uri: URI, index: response.index, text: STRINGS, mainPath: PATH };
		const typeOf = (name: string) =>
			strings.index.symbols.find(symbol => symbol.name === name && symbol.scope === 'file')?.type;

		assert.equal(typeOf('native'), 'string_t');
		assert.equal(typeOf('view'), 'const char *');
		assert.equal(typeOf('letter'), 'char');
		assert.equal(typeOf('buffer'), 'char[3]', 'the array carries the literal and its NUL');

		const shown = hover(strings, positionIn(STRINGS, STRINGS.indexOf('native')));
		assert.match(shown?.contents ?? '', /string_t native/);
	});
});

describe('find references', () => {
	it('lists the declaration and every use', () => {
		const found = references([document], document, positionIn(SOURCE, at('total(p.x')), toUri);
		assert.equal(found.length, 2, 'expected the declaration plus the one call');
		assert.ok(found.every(location => location.uri === URI));
	});

	it('lists every use of a struct member', () => {
		const found = references([document], document, positionIn(SOURCE, memberAt('p.x = 1')), toUri);
		// The declaration in the struct plus the two `p.x` uses.
		assert.equal(found.length, 3);
	});

	it('finds the same set from a member declaration as from a use', () => {
		const fromUse = references([document], document, positionIn(SOURCE, memberAt('p.x = 1')), toUri).map(
			location => JSON.stringify(location.range)
		);
		const fromDeclaration = references([document], document, positionIn(SOURCE, at('int x') + 4), toUri).map(
			location => JSON.stringify(location.range)
		);
		assert.deepEqual(fromDeclaration, fromUse);
	});

	it('finds the same set from the declaration as from a use', () => {
		const fromUse = references([document], document, positionIn(SOURCE, at('total(p.x')), toUri).map(location =>
			JSON.stringify(location.range)
		);
		const fromDeclaration = references([document], document, positionIn(SOURCE, at('total')), toUri).map(
			location => JSON.stringify(location.range)
		);
		assert.deepEqual(fromDeclaration, fromUse);
	});

	it('finds every use of a local, not just the first', () => {
		const found = references([document], document, positionIn(SOURCE, at('p.x = 1')), toUri);
		// The declaration, plus the four `p.` accesses: two assignments and the
		// two arguments of the call.
		assert.equal(found.length, 5);
	});
});

describe('rename', () => {
	it('rewrites the declaration and every use, and nothing else', () => {
		const edit = rename([document], document, positionIn(SOURCE, at('total(p.x')), 'sum', toUri);
		assert.ok(edit, 'rename produced no edit');
		const edits = edit.changes[URI];
		assert.ok(edits);
		assert.equal(edits.length, 2);
		assert.equal(applyEdits(SOURCE, edits), SOURCE.replaceAll('total', 'sum'));
	});

	it('does not touch the return type when renaming a function', () => {
		// The compiler points a declaration at its own return type, so a rename
		// that trusted that position would rewrite `int` into the new name.
		const edit = rename([document], document, positionIn(SOURCE, at('total')), 'sum', toUri);
		assert.equal(applyEdits(SOURCE, edit!.changes[URI]), SOURCE.replaceAll('total', 'sum'));
	});

	it('renames a struct member through a dot access', () => {
		const edit = rename([document], document, positionIn(SOURCE, memberAt('p.x = 1')), 'horizontal', toUri);
		assert.ok(edit, 'rename produced no edit for a member');
		const edited = applyEdits(SOURCE, edit.changes[URI]);
		// The declaration and both uses, and nothing else. `x` also appears inside
		// `point`, so a rename that matched text instead of ranges would corrupt it.
		assert.equal(edited.split('horizontal').length - 1, 3);
		assert.ok(edited.includes('\tint horizontal;'), 'the member declaration was not renamed');
		assert.ok(edited.includes('p.horizontal = 1;'), 'the first use was not renamed');
		assert.ok(edited.includes('total(p.horizontal, p.y)'), 'the second use was not renamed');
		assert.ok(edited.includes('struct point'), 'an unrelated occurrence of the letter was rewritten');
	});

	it('renames a struct member from its own declaration', () => {
		const edit = rename([document], document, positionIn(SOURCE, at('int x') + 4), 'horizontal', toUri);
		assert.ok(edit, 'rename produced no edit from the member declaration');
		assert.equal(applyEdits(SOURCE, edit.changes[URI]).split('horizontal').length - 1, 3);
	});

	it('refuses to rename a name the compiler owns', () => {
		// Renaming `print` would break every call site in every header.
		assert.equal(isReservedName('print'), true);
		// Types are generated from the parser's own list, including the ones
		// that are not keywords.
		assert.equal(isReservedName('string_t'), true, 'string_t is a compiler type');
		assert.equal(isReservedName('item_t'), true, 'item_t is a compiler type');
		assert.equal(isReservedName('total'), false);
	});

	it('refuses to rename a name it could not resolve', () => {
		assert.equal(rename([document], document, positionIn(SOURCE, at('return s')), 'x', toUri), null);
	});
});

describe('completion', () => {
	it('offers the program`s own names', () => {
		const offset = SOURCE.indexOf('int s = ') + 'int s = '.length;
		const labels = complete(document, positionIn(SOURCE, offset)).map(item => item.label);
		for (const expected of ['total', 'main', 'point', 'p', 's']) {
			assert.ok(labels.includes(expected), `expected ${expected} in ${labels.join(', ')}`);
		}
	});

	it('offers struct members after a dot', () => {
		// The member identifier in a MemberExpression has no location, so this
		// depends on the text scan in symbols.ts rather than on the AST.
		const items = complete(document, positionIn(SOURCE, memberAt('p.x = 1')));
		assert.deepEqual(
			items.map(item => item.label).sort(),
			['x', 'y']
		);
		assert.ok(items.every(item => item.kind === 'field'));
	});

	it('offers struct members after a half-typed name', () => {
		const items = complete(document, positionIn(SOURCE, memberAt('p.x = 1') + 1));
		assert.deepEqual(items.map(item => item.label).sort(), ['x', 'y']);
	});

	it('offers content constants and instructions after an @', () => {
		const offset = SOURCE.indexOf('= @') + 3;
		const labels = new Set(complete(document, positionIn(SOURCE, offset)).map(item => item.label));
		// `@copper` is an item id. The keywords must not be offered here: they
		// would be accepted and produce source that does not compile.
		assert.ok(labels.has('@copper'), 'no content constants offered');
		assert.ok(labels.has('@lead'), 'no instructions offered');
		assert.ok(!labels.has('return'), 'a keyword leaked into @ completion');
	});

	it('replaces only the name after the @, not the sigil', () => {
		// `@` is not a word character, so without an explicit range accepting
		// `@copper` would leave the user with `@@copper`.
		const offset = SOURCE.indexOf('= @') + 3;
		const [first] = complete(document, positionIn(SOURCE, offset));
		assert.ok(first.range, 'the @ completion carries no replace range');
		// The range starts after the sigil, so the `@` is left alone.
		const sigil = offsetOf(SOURCE, first.range.start) - 1;
		assert.equal(SOURCE[sigil], '@');
		assert.equal(first.range.end.character, positionIn(SOURCE, offset).character);
	});

	it('hovers a content id as a content id, not as an undeclared name', () => {
		// `@copper` parses as an identifier, so a naive index claims the user
		// typed a name that does not exist. It is a content id.
		const shown = hover(document, positionIn(SOURCE, SOURCE.indexOf('@copper') + 3));
		assert.ok(shown, 'no hover for a content id');
		assert.match(shown.contents, /@copper/);
		assert.match(shown.contents, /item/);
	});

	it('offers keywords on an empty line', () => {
		const offset = SOURCE.indexOf('\tint s = total');
		const labels = new Set(complete(document, positionIn(SOURCE, offset)).map(item => item.label));
		assert.ok(labels.has('if'), 'no keywords offered');
		assert.ok(labels.has('while'), 'no keywords offered');
		// Types that are not keywords are generated from the parser's list.
		assert.ok(labels.has('string_t'), 'string_t is not offered');
		assert.ok(labels.has('item_t'), 'item_t is not offered');
	});

	it('offers this function`s locals but not another`s', async () => {
		const SCOPED = `int first(void) {
	int alpha = 1;
	return alpha;
}

int second(int beta) {
	int gamma = 2;
	return beta + gamma;
}
`;
		const response = await analyse(request(SCOPED), host);
		assert.ok(response.index, 'no index for the scope fixture');
		const scoped: IndexedDocument = { uri: URI, index: response.index, text: SCOPED, mainPath: PATH };

		const offset = SCOPED.indexOf('return beta + gamma;');
		const labels = new Set(complete(scoped, positionIn(SCOPED, offset)).map(item => item.label));

		assert.ok(labels.has('gamma'), 'this function`s local is missing');
		assert.ok(labels.has('beta'), 'the parameter is missing');
		assert.ok(labels.has('first') && labels.has('second'), 'file-scope functions are missing');
		assert.ok(!labels.has('alpha'), 'another function`s local leaked into the list');
	});

	it('keeps the sigil out of the inserted text and filters on the bare name', () => {
		// The fixture has `content_t ore = @copper;`; ask just after `@co`.
		const items = complete(document, positionIn(SOURCE, SOURCE.indexOf('@copper') + 3));
		const copper = items.find(item => item.label === '@copper');
		assert.ok(copper, 'no @copper completion');
		assert.equal(copper.insertText, 'copper', 'inserting the label would leave @@copper');
		assert.equal(copper.filterText, 'copper', 'the client filters on `co`, not `@co`');

		assert.ok(
			items.some(item => item.label === '@unit'),
			'@unit is missing from the processor variables'
		);
	});

	it('does not offer a struct field as a bare name', () => {
		// `x` is only nameable through an object, so offering it bare would
		// suggest source that does not compile.
		const offset = SOURCE.indexOf('\tint s = total');
		const labels = new Set(complete(document, positionIn(SOURCE, offset)).map(item => item.label));
		assert.ok(!labels.has('x'), 'a field was offered as a top-level name');
	});
});

describe('signature help', () => {
	const CALLS = `int add(int a, int b) {
	return a + b;
}

int add(int a) {
	return a;
}

int main() {
	print("x");
	return add(add(1, 2), 3);
}
`;

	let calls: IndexedDocument;

	before(async () => {
		const response = await analyse(request(CALLS), host);
		assert.deepEqual(
			response.diagnostics.map(diagnostic => diagnostic.message),
			[],
			'the signature-help fixture must compile cleanly'
		);
		assert.ok(response.index, 'no index for the signature-help fixture');
		calls = { uri: URI, index: response.index, text: CALLS };
	});

	/** The position just after `needle`. */
	const inside = (needle: string) => positionIn(CALLS, CALLS.indexOf(needle) + needle.length);

	it('names the parameters and tracks the argument the cursor is in', () => {
		const help = signatureHelp(calls, inside('add(add(1, 2), '));
		assert.ok(help, 'no help in the outer call');
		const active = help.signatures[help.activeSignature];
		assert.equal(active.label, 'int add(int a, int b)');
		assert.equal(help.activeParameter, 1);
	});

	it('picks the innermost call rather than the one around it', () => {
		const help = signatureHelp(calls, inside('add(add(1, '));
		assert.ok(help, 'no help in the inner call');
		assert.equal(help.signatures[help.activeSignature].label, 'int add(int a, int b)');
		assert.equal(help.activeParameter, 1);
	});

	it('offers every overload', () => {
		const help = signatureHelp(calls, inside('add(add(1, 2), '));
		assert.ok(help);
		assert.deepEqual(
			help.signatures.map(signature => signature.label).sort(),
			['int add(int a)', 'int add(int a, int b)']
		);
	});

	it('answers a builtin from the generated tables', () => {
		const help = signatureHelp(calls, inside('print('));
		assert.ok(help, 'no help for a builtin');
		assert.equal(help.signatures[0].label, 'void print(…)');
		assert.equal(help.activeParameter, 0);
	});

	it('is null when the cursor is not inside a call', () => {
		assert.equal(signatureHelp(calls, positionIn(CALLS, CALLS.indexOf('int add'))), null);
	});
});

describe('quick fixes', () => {
	const WITH_DIRECTIVE = `#define FOO 1

int main(void) {
    printflush(message1);
}
`;

	it('declares a missing processor block after the directives', async () => {
		const response = await analyse(request(WITH_DIRECTIVE), host);
		assert.ok(response.index, 'no index for the quick-fix fixture');
		const scoped: IndexedDocument = { uri: URI, index: response.index, text: WITH_DIRECTIVE, mainPath: PATH };

		const fixes = quickFixes(scoped, [{ message: "Undeclared identifier 'message1'" }]);
		assert.equal(fixes.length, 1, 'no fix offered');
		assert.match(fixes[0].title, /auto device message1;/);

		const edits = fixes[0].edit.changes[URI];
		assert.equal(edits.length, 1);
		assert.equal(edits[0].newText, 'auto device message1;\n');
		assert.deepEqual(
			edits[0].range.start,
			positionIn(WITH_DIRECTIVE, WITH_DIRECTIVE.indexOf('int main')),
			'the declaration was not placed after the directive'
		);
	});

	it('does not offer to declare a name that is not block-like', () => {
		assert.deepEqual(quickFixes(document, [{ message: "Undeclared identifier 'helper'" }]), []);
	});

	it('ignores diagnostics it does not understand', () => {
		assert.deepEqual(quickFixes(document, [{ message: 'Expected variable name in declaration' }]), []);
	});

	it('turns a mutable char* literal into a view, a string_t or a copy', async () => {
		const MUTABLE = `int main(void) {
	char *p = "hi";
	return 0;
}
`;
		const response = await analyse(request(MUTABLE), host);
		const diagnostic = response.diagnostics.find(entry =>
			entry.message.includes('with a string literal')
		);
		assert.ok(diagnostic, 'the mutable char* was not refused');
		assert.ok(response.index, 'no index for the char* fixture');

		const mutable: IndexedDocument = { uri: URI, index: response.index, text: MUTABLE, mainPath: PATH };
		// The client passes the squiggle's range with the diagnostic; it starts at
		// the literal, not at the declaration.
		const range = {
			start: { line: (diagnostic.line ?? 1) - 1, character: (diagnostic.column ?? 1) - 1 },
		};
		const fixes = quickFixes(mutable, [{ message: diagnostic.message, range }]);
		assert.equal(fixes.length, 3, 'expected const, string_t and char[]');

		const [readOnly, native, copy] = fixes.map(fix => applyEdits(MUTABLE, fix.edit.changes[URI]));
		assert.match(readOnly, /const char \*p = "hi";/);
		assert.match(native, /string_t p = "hi";/);
		assert.match(copy, /char p\[\] = "hi";/);
	});

	it('offers a string_view when the header is there and the target supports it', () => {
		const VIEW = `#include <string.h>
int main(void) {
	char *p = "hi";
	return 0;
}
`;
		const message =
			`Cannot initialize 'char*' with a string literal: the characters are read-only. ` +
			`Use 'const char*' for a view, or 'char p[] = "..."' for a mutable copy.`;
		const literal = positionIn(VIEW, VIEW.indexOf('"hi"'));
		const view = { ...document, text: VIEW };

		// A literal does not convert to string_view; it needs sv_of_string().
		const current = quickFixes(view, [{ message, range: { start: literal } }], {
			targetVersion: 154.3,
		});
		assert.equal(current.length, 4, 'the string_view fix is missing');
		const wrapped = current.find(fix => /string_view/.test(fix.title));
		assert.ok(wrapped, 'no string_view fix');
		assert.match(
			applyEdits(VIEW, wrapped.edit.changes[URI]),
			/string_view p = sv_of_string\("hi"\);/,
			'the view was not built from the literal'
		);

		// Before v150 the header has no string_view API, so offering it would
		// only trade one error for another.
		const older = quickFixes(view, [{ message, range: { start: literal } }], {
			targetVersion: 149,
		});
		assert.equal(older.length, 3, 'string_view offered below v150');
	});
});

describe('semantic tokens', () => {
	const decode = (data: number[]) => {
		const tokens: Array<{ line: number; character: number; length: number; type: number; modifiers: number }> = [];
		let line = 0;
		let character = 0;
		for (let index = 0; index < data.length; index += 5) {
			line += data[index];
			character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
			tokens.push({
				line,
				character,
				length: data[index + 2],
				type: data[index + 3],
				modifiers: data[index + 4],
			});
		}
		return tokens;
	};

	const at = (tokens: ReturnType<typeof decode>, offset: number) => {
		const position = positionIn(SOURCE, offset);
		return tokens.find(token => token.line === position.line && token.character === position.character);
	};

	it('types functions, parameters, locals and fields', () => {
		const tokens = decode(semanticTokens(document));
		assert.ok(tokens.length > 0, 'no semantic tokens');

		const total = at(tokens, SOURCE.indexOf('total(int a'));
		assert.equal(total?.type, 2, 'the function name is not a function');
		assert.equal(total?.modifiers, 1, 'the declaration modifier is missing');

		assert.equal(at(tokens, SOURCE.indexOf('int a, int b') + 'int '.length)?.type, 1, 'a parameter is missing');
		assert.equal(at(tokens, SOURCE.indexOf('point p;') + 'point '.length)?.type, 0, 'a local is missing');
		assert.equal(at(tokens, SOURCE.indexOf('int x;') + 'int '.length)?.type, 4, 'a field is missing');

		const member = at(tokens, SOURCE.indexOf('p.x = 1') + 2);
		assert.equal(member?.type, 4);
		assert.equal(member?.modifiers, 0, 'a use was marked as a declaration');
	});

	it('paints a custom type at its uses, not only at its declaration', async () => {
		const CUSTOM = `typedef int myint;
struct point { int x; };
myint a;
struct point p;
int main(void) { return a; }
`;
		const response = await analyse(request(CUSTOM), host);
		assert.ok(response.index, 'no index for the custom-type fixture');
		const custom: IndexedDocument = { uri: URI, index: response.index, text: CUSTOM, mainPath: PATH };
		const tokens = decode(semanticTokens(custom));

		const tokenAt = (needle: string, delta = 0) => {
			const position = positionIn(CUSTOM, CUSTOM.indexOf(needle) + delta);
			return tokens.find(token => token.line === position.line && token.character === position.character);
		};

		assert.equal(tokenAt('myint a;')?.type, 3, 'the typedef use is not a type');
		assert.equal(tokenAt('struct point p;', 'struct '.length)?.type, 3, 'the struct tag use is not a type');
	});

	it('highlights macro uses, and ignores the fake location expansion tokens carry', async () => {
		const MACROS = `#define SIZE 4
#define SQUARE(x) ((x) * (x))
int main(void) {
    int value = 2;
    return SQUARE(value) + SIZE;
}
`;
		const response = await analyse(request(MACROS), host);
		assert.ok(response.index, 'no index for the macro fixture');
		assert.ok(response.index.macros?.includes('SQUARE'), 'macro names did not reach the index');

		const macros: IndexedDocument = { uri: URI, index: response.index, text: MACROS, mainPath: PATH };
		const tokens = decode(semanticTokens(macros));

		const tokenAt = (needle: string, delta = 0) => {
			const position = positionIn(MACROS, MACROS.indexOf(needle) + delta);
			return tokens.find(token => token.line === position.line && token.character === position.character);
		};

		assert.equal(tokenAt('#define SIZE 4', '#define '.length)?.type, 5, 'the macro definition is not a macro');
		assert.equal(tokenAt('SQUARE(value)')?.type, 5, 'the function-like macro use is not a macro');
		assert.equal(tokenAt('+ SIZE;', 2)?.type, 5, 'the object-like macro use is not a macro');

		// Expanded body tokens carry the definition's placeholder location
		// (line 1, column 1), which used to paint a variable over `#defi`.
		assert.equal(
			tokens.some(token => token.line === 0 && token.character === 0),
			false,
			'a macro expansion location leaked into the file'
		);
	});
	it('keeps the tokens an edit below them did not move', () => {
		const before = semanticTokens(document);
		const appended = semanticTokens({
			...document,
			text: `${SOURCE}// trailing edit\n`,
			analyzedText: SOURCE,
		});
		assert.deepEqual(appended, before, 'an edit after the code removed tokens');
	});

	it('shifts the tokens after an insertion instead of dropping them', () => {
		const prefix = '// one more line\n';
		const shifted = decode(
			semanticTokens({ ...document, text: prefix + SOURCE, analyzedText: SOURCE })
		);

		const oldPosition = positionIn(SOURCE, SOURCE.indexOf('total(int a'));
		const newPosition = positionIn(prefix + SOURCE, prefix.length + SOURCE.indexOf('total(int a'));

		assert.equal(newPosition.line, oldPosition.line + 1, 'the fixture did not shift the token');
		assert.ok(
			shifted.some(token => token.line === newPosition.line && token.character === newPosition.character),
			'the token after the insertion was dropped'
		);
		assert.equal(
			shifted.some(token => token.line === oldPosition.line && token.character === oldPosition.character),
			false,
			'the token was left at its old position'
		);
	});

	it('drops only the token the edit changed', () => {
		const renamed = SOURCE.replace('int total(', 'int totals(');
		const tokens = decode(semanticTokens({ ...document, text: renamed, analyzedText: SOURCE }));

		const declaration = positionIn(SOURCE, SOURCE.indexOf('total(int a'));
		assert.equal(
			tokens.some(token => token.line === declaration.line && token.character === declaration.character),
			false,
			'the renamed declaration was painted'
		);

		// The call further down is untouched; the net +1 shift keeps its line and
		// character because the line start moved with it.
		const use = positionIn(SOURCE, SOURCE.indexOf('total(p.x'));
		assert.ok(
			tokens.some(token => token.line === use.line && token.character === use.character),
			'the untouched call was dropped'
		);
	});
});

describe('outline', () => {
	it('lists file-scope declarations in source order', () => {
		const listed = outline(document);
		assert.deepEqual(
			listed.map(symbol => symbol.name),
			['point', 'total', 'main']
		);
		assert.equal(listed.find(symbol => symbol.name === 'point')?.kind, 'type');
		assert.equal(listed.find(symbol => symbol.name === 'total')?.kind, 'function');
	});

	it('leaves locals and parameters out', () => {
		const names = outline(document).map(symbol => symbol.name);
		for (const local of ['p', 's', 'a', 'b']) {
			assert.ok(!names.includes(local), `${local} should not be in the outline`);
		}
	});

	it('shows a function as `int total(int, int)`', () => {
		const total = outline(document).find(symbol => symbol.name === 'total');
		assert.equal(total?.detail, 'int(int, int)');
	});
});

describe('overloads', () => {
	/*
	Both arities are called, on purpose. This used to crash the compiler's
	semantic analyser: `visitFunctionCall` read a property of `undefined`, the
	file came back with `ast: null`, no diagnostics, and nothing on screen said
	anything was wrong. It is fixed upstream, and the fixture calls both arities
	so a reintroduction fails here rather than quietly in the editor.
	*/
	const OVERLOADS = `int add(int a, int b) {
	return a + b;
}

int add(int a, int b, int c) {
	return a + b + c;
}

int main() {
	return add(1, 2) + add(1, 2, 3);
}
`;

	it('analyses a file that calls both arities', async () => {
		const response = await analyse(request(OVERLOADS), host);
		assert.equal(response.fatal, undefined, 'the analyser crashed on a valid overload set');
		assert.equal(response.index?.internalError, undefined);
		assert.deepEqual(
			response.diagnostics.map(diagnostic => diagnostic.message),
			[],
			'a file that calls each overload correctly should be clean'
		);
	});

	it('reports a call matching no arity rather than crashing on it', async () => {
		// Two versions, four arguments: nothing to choose from. Before the fix
		// this threw after writing its message, so the run ended with `ast: null`
		// and the message the user needed was thrown away with it.
		const bad = OVERLOADS.replace('add(1, 2) + add(1, 2, 3)', 'add(1, 2, 3, 4)');
		const response = await analyse(request(bad), host);
		assert.equal(response.fatal, undefined, 'an unmatched arity must not end the run');
		assert.ok(
			response.diagnostics.some(diagnostic =>
				/No version of 'add' accepts these arguments/.test(diagnostic.message)
			),
			`expected an arity diagnostic, got ${JSON.stringify(response.diagnostics)}`
		);
		assert.ok(response.index, 'a file with errors still needs its index');
	});

	it('reports the count when only one version exists', async () => {
		const single = `int add(int a, int b) {
	return a + b;
}

int main() {
	return add(1, 2, 3);
}
`;
		const response = await analyse(request(single), host);
		assert.equal(response.fatal, undefined);
		assert.deepEqual(
			response.diagnostics.map(diagnostic => diagnostic.message),
			["Function 'add' expects 2 arguments, but 3 were provided"]
		);
	});

	it('indexes each overload under the name the user wrote', async () => {
		const response = await analyse(request(OVERLOADS), host);
		assert.ok(response.index);
		const adds = response.index.symbols.filter(symbol => symbol.name === 'add');
		assert.equal(adds.length, 2, 'expected both overloads');
		// The compiler renames the second to `add__ov1`; the user must not see that.
		assert.deepEqual(
			adds.map(symbol => symbol.type),
			['int(int, int)', 'int(int, int, int)'],
			'each overload keeps its own signature'
		);
		for (const add of adds) {
			assert.equal(
				OVERLOADS.slice(offsetOf(OVERLOADS, add.range.start), offsetOf(OVERLOADS, add.range.start) + 3),
				'add',
				'an overload is not declared over its own name'
			);
		}
	});

	it('does not offer `add__ov1` in completion', async () => {
		const response = await analyse(request(OVERLOADS), host);
		const overloaded: IndexedDocument = { uri: URI, index: response.index!, text: OVERLOADS };
		const labels = complete(overloaded, positionIn(OVERLOADS, OVERLOADS.indexOf('return add'))).map(
			item => item.label
		);
		assert.ok(labels.includes('add'));
		assert.ok(!labels.some(label => label.startsWith('add__')), 'the internal overload name leaked');
	});
});

describe('a file that does not compile', () => {
	it('still produces an index, so completion keeps working', async () => {
		// This is the whole reason `analyze()` returns the AST even on failure
		// (patch 0001): the user is mid-edit most of the time.
		const broken = `int helper(int a) {
	return a;
}

int main() {
	helper(1);
	return undefinedThing;
}
`;
		const response = await analyse(request(broken), host);
		assert.ok(response.diagnostics.length > 0, 'expected diagnostics');
		const brokenDocument: IndexedDocument = {
			uri: URI,
			text: broken,
			index: response.index!,
		};
		const found = definition(
			brokenDocument,
			positionIn(broken, broken.indexOf('helper(1)') + 2),
			toUri
		);
		assert.equal(found?.uri, URI, 'could not resolve a name in a file with errors');
		assert.equal(broken.slice(offsetOf(broken, found!.range.start), offsetOf(broken, found!.range.start) + 6), 'helper');
	});

	it('leaves an undeclared name unresolved rather than guessing', async () => {
		const broken = `int main() {
	return undefinedThing;
}
`;
		const response = await analyse(request(broken), host);
		const brokenDocument: IndexedDocument = { uri: URI, text: broken, index: response.index! };
		const position = positionIn(broken, broken.indexOf('undefinedThing') + 2);
		assert.equal(definition(brokenDocument, position, toUri), null);
		// Hover says so plainly rather than inventing a type.
		assert.match(hover(brokenDocument, position)?.contents ?? '', /Not declared/);
	});
});

describe('types the compiler resolves rather than records', () => {
	const TYPED = `struct vec {
	int x;
	int y;
};

typedef struct vec vec_t;

int sum(vec a, vec_t *b) {
	b->x = 1;
	a.y = 2;
	return a.x + b->y;
}
`;

	it('resolves a typedef to the struct it names, for hover and completion', async () => {
		const response = await analyse(request(TYPED), host);
		assert.ok(response.index, 'no index');
		const document2: IndexedDocument = { uri: URI, text: TYPED, index: response.index! };
		// `b->x`: three characters in, the cursor is on the member.
		const position = positionIn(TYPED, TYPED.indexOf('b->x') + 3);
		const shown = hover(document2, position);
		assert.ok(shown, 'no hover for a member of a pointer to a typedef`d struct');
		assert.match(shown.contents, /Field of `vec`/);
	});

	it('offers members of a typedef`d struct after an arrow', async () => {
		const response = await analyse(request(TYPED), host);
		const document2: IndexedDocument = { uri: URI, text: TYPED, index: response.index! };
		// `b->x` starts at this offset, so `+ 3` is the member and `+ 4` is just
		// past it: the two positions a cursor can actually be at.
		const member = TYPED.indexOf('b->x');
		for (const offset of [member + 3, member + 4]) {
			const items = complete(document2, positionIn(TYPED, offset));
			assert.deepEqual(
				items.map(item => item.label).sort(),
				['x', 'y'],
				`a pointer to a typedef'd struct offered the wrong members at ${offset}`
			);
		}
	});

	it('indexes a typedef as a type, with the type the user wrote', async () => {
		const response = await analyse(request(TYPED), host);
		const types = response.index!.symbols.filter(symbol => symbol.kind === 'type');
		assert.deepEqual(
			types.map(symbol => `${symbol.name} : ${symbol.type}`),
			['vec : struct', 'vec_t : typedef struct vec']
		);
	});
});

/** Apply LSP text edits to a source, in document order. */
function applyEdits(
	text: string,
	edits: ReadonlyArray<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>
): string {
	const ordered = [...edits].sort((a, b) => offsetOf(text, a.range.start) - offsetOf(text, b.range.start));
	let result = '';
	let cursor = 0;
	for (const edit of ordered) {
		const start = offsetOf(text, edit.range.start);
		result += text.slice(cursor, start) + edit.newText;
		cursor = offsetOf(text, edit.range.end);
	}
	return result + text.slice(cursor);
}
