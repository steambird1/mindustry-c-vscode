/*
 * Generate the TextMate grammars from the compiler's own tables.
 *
 * The compiler already knows every keyword, instruction, operator and `@`
 * content id it accepts. Rather than hand-maintaining a list in this
 * repository (which is how grammars rot), we import those tables from
 * `compiler/` and write the grammar from them. A Mindustry update that adds a
 * content id shows up in the editor after `npm run gen`.
 *
 *   node scripts/gen-grammar.mjs            # write grammars + tables.json
 *   node scripts/gen-grammar.mjs --check    # fail if the output is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCompilerModule } from './lib/load-compiler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compilerDir = process.env.MINDC_COMPILER_DIR ?? path.join(root, 'compiler');
const check = process.argv.includes('--check');

if (!fs.existsSync(path.join(compilerDir, 'mindcLexer.js'))) {
	console.error(
		`Cannot find the Mindustry-C compiler at ${compilerDir}.\n` +
			'Set MINDC_COMPILER_DIR, or place the compiler repository in ./compiler.'
	);
	process.exit(2);
}

const { KEYWORDS, SPECIAL_INSTRUCTIONS, OPERATORS, PUNCTUATORS } = await loadCompilerModule(
	compilerDir,
	'mindcLexer.js',
	['KEYWORDS', 'SPECIAL_INSTRUCTIONS', 'OPERATORS', 'PUNCTUATORS']
);
const { CONTENT_ORDER, DEFAULT_CONTENT_NAMES, CONTENT_CATEGORIES } = await loadCompilerModule(
	compilerDir,
	'mindcContent.js',
	['CONTENT_ORDER', 'DEFAULT_CONTENT_NAMES', 'CONTENT_CATEGORIES']
);

/*
 * The compiler keeps its builtin function table inside
 * `SemanticAnalyzer#initializeBuiltinFunctions`, as data rather than as an
 * export. Rather than duplicating that list here (which would rot the moment a
 * builtin is added), read the source and pull the names out. This is a build
 * script, not runtime code, and a parse failure is loud.
 */
const semanticSource = fs.readFileSync(
	path.join(compilerDir, 'mindcSemantic.js'),
	'utf8'
);
const builtinBlock = semanticSource.match(
	/initializeBuiltinFunctions\(\)\s*\{[\s\S]*?const builtins = \[([\s\S]*?)\n\s{4,8}\];/
);
if (!builtinBlock) {
	console.error('Could not find the builtin table in mindcSemantic.js');
	process.exit(1);
}
const BUILTIN_FUNCTIONS = [
	...new Set(
		[...builtinBlock[1].matchAll(/\{\s*name:\s*'([^']+)'/g)].map(match => match[1])
	),
].sort();
if (BUILTIN_FUNCTIONS.length < 20) {
	console.error(
		`Only found ${BUILTIN_FUNCTIONS.length} builtins; the compiler's table probably moved.`
	);
	process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. Vocabulary
 * ------------------------------------------------------------------ */

// Keyword spellings, minus the preprocessor directives: those are handled by a
// dedicated rule that colours the whole logical line.
const KEYWORD_LIST = Object.keys(KEYWORDS).filter(word => !word.startsWith('#'));
// `draw`, `print`, `read`, ... are special instructions, and get their own scope.
const INSTRUCTION_LIST = Object.keys(SPECIAL_INSTRUCTIONS);

// Builtin functions: the instruction set plus the library calls the semantic
// analyser registers. `BUILTIN_FUNCTIONS` is read from the compiler above.
const BUILTIN_SIGNATURES = {
	print: 'void print(…)',
	printflush: 'void printflush(device)',
	draw: 'void draw(color, …)',
	drawflush: 'void drawflush(device)',
	sensor: 'null_t sensor(device, content_t)',
	getlink: 'device getlink(int)',
	control: 'void control(char, device, …)',
	radar: 'device radar(char, char, char, char, device, int)',
	set: 'void set(…)',
	op: 'void op(…)',
	jump: 'void jump(…)',
	read: 'null_t read(…)',
	write: 'void write(…)',
	wait: 'void wait(float)',
	stop: 'void stop()',
	end: 'void end()',
	ubind: 'void ubind(content_t)',
	ucontrol: 'void ucontrol(…)',
	uradar: 'device uradar(char, char, char, char, int, int)',
	ulocate: 'int ulocate(…)',
	lookup: 'content_t lookup(char, int)',
	asm: 'null_t asm(char)',
	sin: 'float sin(float)',
	cos: 'float cos(float)',
	tan: 'float tan(float)',
	min: 'float min(float, float)',
	max: 'float max(float, float)',
	pow: 'float pow(float, float)',
	sqrt: 'float sqrt(float)',
	abs: 'float abs(float)',
	ceil: 'float ceil(long)',
	floor: 'float floor(long)',
	rand: 'float rand(float)',
	memcpy: 'void memcpy(void*, void*, unsigned)',
	memsp: 'void* memsp(device, int)',
	byname: 'void* byname(…)',
	remote: 'void* remote(…)',
	vecalias: 'void vecalias(…)',
	veccpy: 'void veccpy(…)',
};

// Types the dialect adds on top of C: `device` is a connected building,
// `content_t` a content constant, `null_t` the absence of a value.
const EXTRA_TYPES = [
	'device',
	'content_t',
	'null_t',
	'pdlist_t',
	'bool',
	'inline',
	'auto',
	'near',
	'byname',
	'remote',
	'widthof',
	'true',
	'false',
	'null',
];

/* ------------------------------------------------------------------ *
 * 2. TextMate grammar
 * ------------------------------------------------------------------ */

// Spellings of the C type keywords, taken from the lexer's KEYWORDS map so we
// colour exactly what the lexer accepts.
const TOKEN_TYPE_SPELLINGS = Object.keys(KEYWORDS).filter(word =>
	/^(INT|CHAR|DOUBLE|FLOAT|LONG|SHORT|SIGNED|UNSIGNED|VOID|BOOL|STRUCT|UNION|ENUM)$/.test(
		KEYWORDS[word]
	)
);

const escapeForRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first: `printflush` must win over `print`.
const alternation = words =>
	[...new Set(words)].sort((a, b) => b.length - a.length).map(escapeForRegex).join('|');

const rule = (name, match) => ({ name, match });

const mlgcGrammar = {
	$schema:
		'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
	name: 'Mindustry-C',
	scopeName: 'source.mlgc',
	fileTypes: ['mlgc'],
	patterns: [
		{ include: '#comments' },
		{ include: '#directives' },
		{ include: '#asm' },
		{ include: '#strings' },
		{ include: '#numbers' },
		{ include: '#content-constants' },
		{ include: '#processor-vars' },
		{ include: '#instructions' },
		{ include: '#builtin-functions' },
		{ include: '#types' },
		{ include: '#keywords' },
		{ include: '#operators' },
	],
	repository: {
		comments: {
			patterns: [
				rule('comment.line.double-slash.mlgc', '//.*$'),
				rule(
					'comment.block.mlgc',
					'/\\*',
					{ name: 'comment.block.mlgc', begin: '/\\*', end: '\\*/' }
				),
			],
		},
		directives: {
			// One logical line, with backslash continuation.
			name: 'meta.preprocessor.mlgc',
			begin: '(?<=^|\\n)(\\s*)(#)\\s*(include|define|undef|if|ifdef|ifndef|else|elif|endif|pragma)\\b',
			beginCaptures: {
				'2': { name: 'punctuation.definition.keyword.mlgc' },
				'3': { name: 'keyword.control.directive.mlgc' },
			},
			end: '(?<!\\\\)(?=\\n|$)',
			patterns: [
				{ include: '#directive-arguments' },
				rule('constant.character.string.mlgc', '"[^"]*"'),
			],
		},
		'directive-arguments': {
			patterns: [
				rule('keyword.control.directive.mlgc', '\\b(include|define|undef|pragma)\\b'),
				rule('constant.numeric.mlgc', '\\b\\d+(\\.\\d+)?\\b'),
				rule('entity.name.tag.mlgc', '@[A-Za-z_][A-Za-z0-9_]*'),
			],
		},
		asm: {
			name: 'meta.asm.mlgc',
			begin: '\\b(asm)\\s*\\(',
			beginCaptures: { '1': { name: 'keyword.control.asm.mlgc' } },
			end: '\\)',
			patterns: [
				rule('string.quoted.other.mlgc', '"[^"]*"'),
				rule('support.function.mlog.mlgc', '\\b[a-z]+\\b'),
			],
		},
		strings: {
			patterns: [
				/*
				 * Written out rather than through `rule`: a TextMate rule cannot
				 * carry both `match` and `begin`/`end`. When it does, `match` wins
				 * and the block is dropped -- which is why a string used to
				 * highlight as two lone quotation marks.
				 */
				{
					name: 'string.quoted.double.mlgc',
					begin: '"',
					end: '"',
					patterns: [{ include: '#escapes' }],
				},
				{
					// The lexer calls these CHARACTER: `'a'` is an int holding the
					// code of `a`, not a string of length one.
					name: 'constant.character.mlgc',
					begin: "'",
					end: "'",
					patterns: [{ include: '#escapes' }],
				},
			],
		},
		escapes: {
			patterns: [rule('constant.character.escape.mlgc', '\\\\.')],
		},
		numbers: {
			patterns: [
				rule('constant.numeric.hex.mlgc', '\\b0[xX][0-9a-fA-F]+\\b'),
				rule(
					'constant.numeric.mlgc',
					'\\b\\d+(\\.\\d+)?([eE][+-]?\\d+)?[fFlLuU]*\\b'),
			],
		},
		'content-constants': {
			// @copper, @water, @flarer, @conveyor -- ids come from the compiler.
			patterns: [
				rule(
					'constant.language.content-item.mlgc',
					`(?<![\\w@])@(${alternation(DEFAULT_CONTENT_NAMES.item ?? [])})\\b`,
					'constant.language.item.mlgc'
				),
				rule(
					'constant.language.content-liquid.mlgc',
					`(?<![\\w@])@(${alternation(DEFAULT_CONTENT_NAMES.liquid ?? [])})\\b`,
					'constant.language.liquid.mlgc'
				),
				rule(
					'constant.language.content-unit.mlgc',
					`(?<![\\w@])@(${alternation(DEFAULT_CONTENT_NAMES.unit ?? [])})\\b`,
					'constant.language.unit.mlgc'
				),
				rule(
					'constant.language.content-block.mlgc',
					`(?<![\\w@])@(${alternation(DEFAULT_CONTENT_NAMES.block ?? [])})\\b`,
					'constant.language.block.mlgc'
				),
			],
		},
		'processor-vars': {
			// @this, @time, @links, @mapw ... the processor's own variables.
			patterns: [
				rule(
					'variable.language.processor.mlgc',
					'@\\b(this|thisx|thisy|links|ipt|pi|e|degToRad|radToDeg|time|tick|second|minute|waveNumber|waveTime|mapw|maph|server|client|clientLocale|clientName|clientTeam|clientUnit|clientMobile|blockCount|unitCount|itemCount|liquidCount|unit)\\b'),
				// A `@name` that is not a known content: `#pragma var(int, @mine)`.
				rule('variable.other.constant.mlgc', '@[A-Za-z_][A-Za-z0-9_]*'),
			],
		},
		instructions: {
			patterns: [
				rule(
					'keyword.control.instruction.mlgc',
					`\\b(${alternation(INSTRUCTION_LIST)})\\b(?=\\s*\\()`),
			],
		},
		'builtin-functions': {
			patterns: [
				rule(
					'support.function.builtin.mlgc',
					`\\b(${alternation(BUILTIN_FUNCTIONS)})\\b(?=\\s*\\()`),
			],
		},
		types: {
			patterns: [
				rule(
					'storage.type.mlgc',
					`\\b(${alternation([
						...Object.keys(TOKEN_TYPE_SPELLINGS),
						...EXTRA_TYPES,
					])})\\b`),
				// A builtin type as a pointer: `int*`, `device*`.
				rule('storage.type.pointer.mlgc', '(?<=\\*)\\s*(?=const\\b)'),
			],
		},
		keywords: {
			patterns: [
				rule(
					'keyword.control.mlgc',
					`\\b(${alternation(KEYWORD_LIST)})\\b`),
			],
		},
		operators: {
			patterns: [
				rule('keyword.operator.mlgc', `(?:${Object.keys(OPERATORS).map(escapeForRegex).join('|')})`),
				rule('keyword.operator.mlgc', '(?:;|,|\\.|\\?|\\(|\\)|\\[|\\]|\\{|\\})'),
			],
		},
	},
};

const mlogGrammar = {
	$schema:
		'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
	name: 'Mindustry Logic',
	scopeName: 'source.mlog',
	fileTypes: ['mlog'],
	patterns: [
		rule('comment.line.double-slash.mlog', '^//.*$'),
		{
			name: 'meta.instruction.mlog',
			match: '^\\s*([a-z]+)(.*)$',
			captures: {
				'1': { name: 'keyword.operator.mlog' },
				'2': { name: 'meta.arguments.mlog' },
			},
		},
		// Instructions and builtin functions both appear as bare words in mlog.
		rule(
			'keyword.operator.mlog',
			`\\b(${alternation([...INSTRUCTION_LIST, ...BUILTIN_FUNCTIONS])})\\b`),
		rule('string.quoted.double.mlog', '"[^"]*"'),
		rule('constant.character.mlog', "'[^']'"),
		rule('constant.numeric.mlog', '(?<![\\w-])-?\\d+(\\.\\d+)?\\b'),
		rule('variable.language.link.mlog', '\\b[a-zA-Z_][A-Za-z0-9_]*\\b'),
		rule('punctuation.separator.mlog', '[ \\t]+'),
	],
};

/* ------------------------------------------------------------------ *
 * 3. Output
 * ------------------------------------------------------------------ */

const targets = [
	['syntaxes/mlgc.tmLanguage.json', mlgcGrammar],
	['syntaxes/mlog.tmLanguage.json', mlogGrammar],
];

let stale = false;
for (const [relative, value] of targets) {
	const file = path.join(root, relative);
	const text = JSON.stringify(value, null, '\t') + '\n';
	if (check) {
		const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
		if (current !== text) {
			stale = true;
			console.error(`stale: ${relative} (run: npm run gen)`);
		}
		continue;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, 'utf8');
	console.log(`wrote ${relative}`);
}

// The same tables, in a form the extension can import at runtime.
const tables = {
	generatedFrom: path.relative(root, compilerDir).split(path.sep).join('/'),
	keywords: KEYWORD_LIST.sort(),
	instructions: INSTRUCTION_LIST.sort(),
	builtinFunctions: BUILTIN_FUNCTIONS,
	builtinSignatures: BUILTIN_SIGNATURES,
	extraTypes: EXTRA_TYPES.sort(),
	operators: Object.keys(OPERATORS).sort(),
	punctuators: Object.keys(PUNCTUATORS).sort(),
	contentNames: Object.fromEntries(CONTENT_CATEGORIES.map(c => [c, DEFAULT_CONTENT_NAMES[c] ?? []])),
	contentOrder: CONTENT_ORDER,
};
const tablesFile = path.join(root, 'src', 'compiler', 'generated', 'tables.json');
const tablesText = JSON.stringify(tables, null, '\t') + '\n';
if (check) {
	const current = fs.existsSync(tablesFile) ? fs.readFileSync(tablesFile, 'utf8') : '';
	if (current !== tablesText) {
		stale = true;
		console.error('stale: src/compiler/generated/tables.json (run: npm run gen)');
	}
} else {
	fs.mkdirSync(path.dirname(tablesFile), { recursive: true });
	fs.writeFileSync(tablesFile, tablesText, 'utf8');
	console.log('wrote src/compiler/generated/tables.json');
}

const summary = `${KEYWORD_LIST.length} keywords, ${INSTRUCTION_LIST.length} instructions, ` +
	`${BUILTIN_FUNCTIONS.length} builtins, ` +
	`${CONTENT_CATEGORIES.map(c => (DEFAULT_CONTENT_NAMES[c] ?? []).length).join('/')} item/liquid/unit/block ids`;
console.log(summary);

if (stale) process.exit(1);
