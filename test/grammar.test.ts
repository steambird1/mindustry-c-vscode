/*
 * Structural checks on the generated grammars.
 *
 * They are generated from the compiler's tables, so a mistake in the generator
 * is copied into every grammar. Two kinds are completely silent:
 *
 *   - a rule carrying both `match` and `begin`/`end`. TextMate uses `match` and
 *     drops the block, so `"..."` was highlighted as two lone quotation marks
 *     and nothing reported it;
 *   - an `include` naming a rule that does not exist. No error, no colour.
 *
 * Neither is a TypeScript error, and `gen:check` only proves the committed file
 * matches the generator -- it happily agrees with a broken generator. So they
 * are checked here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(__dirname, '..', '..');

type Rule = Record<string, unknown>;

function readGrammar(name: string): Rule {
	return JSON.parse(fs.readFileSync(path.join(root, 'syntaxes', name), 'utf8')) as Rule;
}

/** Every object in the tree, including the containers between rules. */
function walk(node: unknown, visit: (node: Rule, where: string) => void, where = ''): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) => walk(item, visit, `${where}[${index}]`));
		return;
	}
	if (!node || typeof node !== 'object') return;
	visit(node as Rule, where);
	for (const [key, value] of Object.entries(node as Rule)) walk(value, visit, `${where}.${key}`);
}

function repositoryOf(grammar: Rule): Record<string, unknown> {
	return (grammar.repository ?? {}) as Record<string, unknown>;
}

describe('the generated grammars', () => {
	for (const name of ['mlgc.tmLanguage.json', 'mlog.tmLanguage.json']) {
		const grammar = readGrammar(name);
		const repository = repositoryOf(grammar);

		it(`${name} has no rule with both match and begin`, () => {
			const broken: string[] = [];
			walk(grammar, (rule, where) => {
				if (typeof rule.match === 'string' && typeof rule.begin === 'string') broken.push(where);
			});
			assert.deepEqual(
				broken,
				[],
				'TextMate uses `match` and drops `begin`/`end`, so the block would never run'
			);
		});

		it(`${name} only includes rules it defines`, () => {
			const missing: string[] = [];
			walk(grammar, (rule, where) => {
				const include = rule.include;
				if (typeof include !== 'string' || !include.startsWith('#')) return;
				if (!(include.slice(1) in repository)) missing.push(`${where}: ${include}`);
			});
			assert.deepEqual(missing, [], 'an include that names nothing highlights nothing');
		});
	}

	it('mlgc highlights a whole string, not just its quotes', () => {
		const grammar = readGrammar('mlgc.tmLanguage.json');
		const strings = (repositoryOf(grammar).strings as { patterns?: Rule[] }).patterns ?? [];
		const doubleQuoted = strings.find(rule => String(rule.name).includes('string.quoted.double'));

		assert.ok(doubleQuoted, 'the grammar has no double-quoted string rule');
		assert.equal(typeof doubleQuoted.begin, 'string', 'the string rule has no begin');
		assert.equal(typeof doubleQuoted.end, 'string', 'the string rule has no end');
		assert.equal(doubleQuoted.match, undefined, 'a `match` here would win and scope only the quote');
	});

	it('mlgc highlights a whole block comment, not just its opening', () => {
		const grammar = readGrammar('mlgc.tmLanguage.json');
		const comments = (repositoryOf(grammar).comments as { patterns?: Rule[] }).patterns ?? [];
		const blockComment = comments.find(rule => String(rule.name).includes('comment.block'));

		assert.ok(blockComment, 'the grammar has no block comment rule');
		assert.equal(typeof blockComment.begin, 'string', 'the block comment rule has no begin');
		assert.equal(typeof blockComment.end, 'string', 'the block comment rule has no end');
		assert.equal(blockComment.match, undefined, 'a `match` here would win and scope only `/*`');
	});

	it('mlgc colours the compiler`s types, keyword or not', () => {
		const grammar = readGrammar('mlgc.tmLanguage.json');
		const types = (repositoryOf(grammar).types as { patterns?: Rule[] }).patterns ?? [];
		const rule = String(types[0]?.match ?? '');

		for (const type of ['int', 'char', 'struct', 'string_t', 'device', 'content_t', 'item_t']) {
			assert.ok(new RegExp(`\\b${type}\\b`).test(rule), `${type} is not coloured as a type`);
		}
		// `Object.keys` over the spelling array once slipped in here and made the
		// rule match the indices 0-12 instead of the type keywords.
		assert.doesNotMatch(rule, /\d/, 'the type rule matches a digit');
	});
});
