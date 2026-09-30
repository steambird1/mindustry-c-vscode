/*
 * The compiler's own vocabulary, baked in at build time.
 *
 * `tables.json` is written by `npm run gen` from the compiler's tables
 * (KEYWORDS, SPECIAL_INSTRUCTIONS, ...), so this file never drifts from what
 * the compiler accepts. The TextMate grammars are generated from the same data
 * in the same pass, which is why a new content id lights up everywhere at once.
 */
import raw from './generated/tables.json';

export type ContentCategory = 'item' | 'liquid' | 'unit' | 'block';

interface Tables {
	generatedFrom: string;
	keywords: string[];
	instructions: string[];
	builtinFunctions: string[];
	builtinSignatures: Record<string, string>;
	extraTypes: string[];
	operators: string[];
	punctuators: string[];
	contentNames: Record<ContentCategory, string[]>;
	contentOrder: Record<string, string[]>;
}

export const tables = raw as Tables;

/** Keywords, excluding the `#`-prefixed preprocessor directives. */
export const KEYWORDS: readonly string[] = tables.keywords;

/** `print`, `draw`, `write`, `control`, ... — keywords that emit instructions. */
export const SPECIAL_INSTRUCTIONS: readonly string[] = tables.instructions;

/** Library calls the semantic analyser registers (`sin`, `memcpy`, `lookup`, ...). */
export const BUILTIN_FUNCTIONS: readonly string[] = tables.builtinFunctions;

/** Cached signature for a builtin, for hover and completion. */
export const BUILTIN_SIGNATURES: Readonly<Record<string, string>> = tables.builtinSignatures;

export const EXTRA_TYPES: readonly string[] = tables.extraTypes;

export const OPERATORS: readonly string[] = tables.operators;

export const PUNCTUATORS: readonly string[] = tables.punctuators;

/** `@name` constants, grouped by category. */
export const CONTENT_NAMES: Readonly<Record<ContentCategory, readonly string[]>> = tables
	.contentNames as Record<ContentCategory, readonly string[]>;

export const CONTENT_CATEGORIES: readonly ContentCategory[] = ['item', 'liquid', 'unit', 'block'];

/** The processor's own `@variables`, which are not content ids. */
export const PROCESSOR_VARIABLES: readonly string[] = [
	'this',
	'thisx',
	'thisy',
	'links',
	'ipt',
	'pi',
	'e',
	'degToRad',
	'radToDeg',
	'time',
	'tick',
	'second',
	'minute',
	'waveNumber',
	'waveTime',
	'mapw',
	'maph',
	'server',
	'client',
	'clientLocale',
	'clientName',
	'clientTeam',
	'clientUnit',
	'clientMobile',
	'blockCount',
	'unitCount',
	'itemCount',
	'liquidCount',
];

/** Type keywords, for `storage.type` colouring and completion. */
export const TYPE_KEYWORDS: readonly string[] = [
	'void',
	'char',
	'short',
	'int',
	'long',
	'float',
	'double',
	'signed',
	'unsigned',
	'bool',
	'sizeof',
	'struct',
	'union',
	'enum',
	'const',
	'static',
	'extern',
	'register',
	'volatile',
	'typedef',
	'auto',
	'inline',
	'near',
	...EXTRA_TYPES,
];
