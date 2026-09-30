/*
 * The configuration merge.
 *
 * Two files, one active profile, and a rule that is easy to get wrong: memory
 * blocks are replaced, not merged. If they were merged, a project with its own
 * map would inherit somebody else's cells and the generated `<name>_id` symbols
 * would point at the wrong links.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ConfigurationManager,
	DEFAULT_TARGET_VERSION,
	mergeConfigurations,
	stripJsonComments,
	toEffective,
	type FileSystem,
} from '../src/config/manager';
import type { ConfigurationFile, ConfigurationProfile } from '../src/common/types';

/** An in-memory filesystem, so the tests never touch a disk. */
function memoryFs(files: Record<string, string> = {}): FileSystem & { files: Record<string, string> } {
	const store: Record<string, string> = { ...files };
	return {
		files: store,
		read: path => (path in store ? store[path] : null),
		write: (path, contents) => {
			store[path] = contents;
		},
		exists: path => path in store,
		mkdirp: () => {},
		join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
		dirname: path => path.slice(0, path.lastIndexOf('/')) || '/',
	};
}

const file = (configurations: ConfigurationProfile[], activeConfiguration?: string): ConfigurationFile => ({
	...(activeConfiguration ? { activeConfiguration } : {}),
	configurations,
});

describe('stripJsonComments', () => {
	it('removes line and block comments', () => {
		assert.equal(stripJsonComments('{"a": 1} // trailing'), '{"a": 1} ');
		assert.equal(stripJsonComments('{/* hi */"a": 1}'), '{"a": 1}');
	});

	it('keeps the line a comment sat on, so positions do not shift', () => {
		// A comment becomes an empty line rather than disappearing: the compiler
		// reports positions in the text it was given, and a stripped line would
		// move every diagnostic after it.
		const stripped = stripJsonComments('{\n// x\n"a": 1\n}');
		assert.equal(stripped.split('\n').length, 4);
		assert.equal(JSON.parse(stripped).a, 1);
	});

	it('leaves comment-like text inside strings alone', () => {
		// A note field saying "use // for includes" must survive.
		assert.equal(
			stripJsonComments('{"note": "use // for includes"}'),
			'{"note": "use // for includes"}'
		);
		assert.equal(
			stripJsonComments('{"note": "a /* b */ c"}'),
			'{"note": "a /* b */ c"}'
		);
	});

	it('keeps an escaped quote inside a string', () => {
		assert.equal(stripJsonComments('{"a": "say \\"hi\\" // ok"}'), '{"a": "say \\"hi\\" // ok"}');
	});

	it('removes trailing commas', () => {
		assert.equal(stripJsonComments('{"a": 1,}'), '{"a": 1}');
		assert.equal(stripJsonComments('[1, 2, ]'), '[1, 2 ]');
	});
});

describe('mergeConfigurations', () => {
	it('lets a workspace profile override field by field', () => {
		const { profiles } = mergeConfigurations(
			file([{ name: 'main', targetVersion: 146, includePaths: ['lib'] }]),
			file([{ name: 'main', targetVersion: 154.3 }])
		);
		assert.equal(profiles.length, 1);
		assert.equal(profiles[0].targetVersion, 154.3);
		// Untouched fields survive from the user-level file.
		assert.deepEqual(profiles[0].includePaths, ['lib']);
	});

	it('replaces memory blocks rather than concatenating them', () => {
		// The order of this list is the wiring order, so merging two lists would
		// produce a map that is neither of the two the user has.
		const { profiles } = mergeConfigurations(
			file([
				{
					name: 'main',
					memoryBlocks: [
						{ name: 'cell1', size: 64, building: 'memory-cell' },
						{ name: 'bank1', size: 256, building: 'memory-bank' },
					],
				},
			]),
			file([{ name: 'main', memoryBlocks: [{ name: 'mc1', size: 64, building: 'memory-cell' }] }])
		);
		assert.deepEqual(profiles[0].memoryBlocks, [
			{ name: 'mc1', size: 64, building: 'memory-cell' },
		]);
	});

	it('merges compiler options one key at a time', () => {
		const { profiles } = mergeConfigurations(
			file([{ name: 'main', compilerOptions: { array: true, pointer: true } }]),
			file([{ name: 'main', compilerOptions: { pointer: false } }])
		);
		assert.deepEqual(profiles[0].compilerOptions, { array: true, pointer: false });
	});

	it('merges id overrides per category, so a project can fix one name', () => {
		const { profiles } = mergeConfigurations(
			file([{ name: 'main', idOverrides: { item: { copper: 13, lead: 14 } } }]),
			file([{ name: 'main', idOverrides: { item: { lead: 99 } } }])
		);
		assert.deepEqual(profiles[0].idOverrides?.item, { copper: 13, lead: 99 });
	});

	it('adds a workspace-only profile without touching the global ones', () => {
		const { profiles } = mergeConfigurations(
			file([{ name: 'main', targetVersion: 146 }]),
			file([{ name: 'scratch', targetVersion: 154.3 }])
		);
		assert.deepEqual(
			profiles.map(profile => profile.name),
			['main', 'scratch']
		);
	});

	it('skips and reports a profile with no name', () => {
		const { profiles, problems } = mergeConfigurations(
			file([{ targetVersion: 146 } as ConfigurationProfile]),
			null
		);
		assert.equal(profiles.length, 0);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /no name/);
	});

	it('copes with both files being absent', () => {
		const { profiles, problems } = mergeConfigurations(null, null);
		assert.deepEqual(profiles, []);
		assert.deepEqual(problems, []);
	});
});

describe('toEffective', () => {
	it('fills in the compiler default for an absent target version', () => {
		const effective = toEffective({ name: 'main' }, { globalPath: '/g', workspacePath: null });
		assert.equal(effective.targetVersion, DEFAULT_TARGET_VERSION);
		assert.equal(effective.sources.targetVersion, 'default');
	});

	it('records which file each field came from', () => {
		const global = file([{ name: 'main', targetVersion: 146, includePaths: ['lib'] }]);
		const workspace = file([{ name: 'main', targetVersion: 154.3 }]);
		const effective = toEffective(
			{ name: 'main', targetVersion: 154.3, includePaths: ['lib'] },
			{ globalPath: '/g', workspacePath: '/w', global, workspace }
		);
		assert.equal(effective.sources.targetVersion, 'workspace');
		assert.equal(effective.sources.includePaths, 'global');
	});

	it('returns a usable empty configuration when there is no profile', () => {
		const effective = toEffective(null, { globalPath: '/g', workspacePath: null });
		assert.equal(effective.profileName, '');
		assert.deepEqual(effective.memoryBlocks, []);
		assert.deepEqual(effective.includePaths, []);
		assert.equal(effective.targetVersion, DEFAULT_TARGET_VERSION);
	});

	it('fills a missing block size from the building it names', () => {
		const effective = toEffective(
			{ name: 'main', memoryBlocks: [{ name: 'cell1', size: 0, building: 'memory-bank' }] },
			{ globalPath: '/g', workspacePath: null }
		);
		assert.equal(effective.memoryBlocks[0].size, 256);
	});

	it('falls back to 64 bytes for a block with no size and no building', () => {
		const effective = toEffective(
			{ name: 'main', memoryBlocks: [{ name: 'cell1', size: 0 }] },
			{ globalPath: '/g', workspacePath: null }
		);
		assert.equal(effective.memoryBlocks[0].size, 64);
	});
});

describe('ConfigurationManager', () => {
	const GLOBAL = '/home/u/.mindustry-c/mlgc.json';
	const WORKSPACE = '/proj/.vscode/mlgc.json';

	it('reports a broken file as a problem but keeps the other one', () => {
		const fs = memoryFs({
			[GLOBAL]: '{ this is not json',
			[WORKSPACE]: JSON.stringify(file([{ name: 'main', targetVersion: 154.3 }])),
		});
		const result = new ConfigurationManager(fs, GLOBAL, WORKSPACE).load();
		assert.equal(result.activeName, 'main');
		assert.equal(result.effective.targetVersion, 154.3);
		assert.equal(result.files.globalFound, false);
		assert.equal(result.files.workspaceFound, true);
		assert.equal(result.effective.problems.length, 1);
		// The problem names the file, so the user knows which one to fix.
		assert.ok(result.effective.problems[0].startsWith(GLOBAL), result.effective.problems[0]);
	});

	it('rejects a file whose `configurations` is not an array', () => {
		const fs = memoryFs({ [GLOBAL]: '{"configurations": {}}' });
		const result = new ConfigurationManager(fs, GLOBAL, null).load();
		assert.match(result.effective.problems[0], /must be an array/);
	});

	it('prefers the workspace `activeConfiguration` over the global one', () => {
		const fs = memoryFs({
			[GLOBAL]: JSON.stringify(file([{ name: 'a' }, { name: 'b' }], 'a')),
			[WORKSPACE]: JSON.stringify(file([{ name: 'a' }, { name: 'b' }], 'b')),
		});
		assert.equal(new ConfigurationManager(fs, GLOBAL, WORKSPACE).load().activeName, 'b');
	});

	it('falls back to the first profile when the active name is unknown', () => {
		const fs = memoryFs({
			[GLOBAL]: JSON.stringify(file([{ name: 'a' }], 'nope')),
		});
		assert.equal(new ConfigurationManager(fs, GLOBAL, null).load().activeName, 'a');
	});

	it('saves a profile without disturbing the others', () => {
		const fs = memoryFs({
			[GLOBAL]: JSON.stringify(file([{ name: 'keep', targetVersion: 146 }])),
		});
		new ConfigurationManager(fs, GLOBAL, null).save({ name: 'new', targetVersion: 154.3 }, 'global');
		const written = JSON.parse(fs.files[GLOBAL]) as ConfigurationFile;
		assert.deepEqual(
			written.configurations.map(profile => profile.name),
			['keep', 'new']
		);
	});

	it('falls back to the global file when asked to save to a workspace with none', () => {
		const fs = memoryFs();
		const { path } = new ConfigurationManager(fs, GLOBAL, null).save(
			{ name: 'main', targetVersion: 154.3 },
			'workspace'
		);
		assert.equal(path, GLOBAL);
		assert.ok(fs.files[GLOBAL]);
	});

	it('refuses to remove a profile that lives in the other file', () => {
		const fs = memoryFs({ [GLOBAL]: JSON.stringify(file([{ name: 'elsewhere' }])) });
		assert.throws(
			() => new ConfigurationManager(fs, GLOBAL, WORKSPACE).removeProfile('elsewhere', 'workspace'),
			/there is no configuration file|is not in/i
		);
	});

	it('removes a profile and drops the stale active name', () => {
		const fs = memoryFs({
			[WORKSPACE]: JSON.stringify(
				file([{ name: 'gone' }, { name: 'stay' }], 'gone')
			),
		});
		new ConfigurationManager(fs, GLOBAL, WORKSPACE).removeProfile('gone', 'workspace');
		const written = JSON.parse(fs.files[WORKSPACE]) as ConfigurationFile;
		assert.deepEqual(
			written.configurations.map(profile => profile.name),
			['stay']
		);
		assert.equal(written.activeConfiguration, undefined);
	});

	it('creates a starter file only when there is none', () => {
		const fs = memoryFs();
		const manager = new ConfigurationManager(fs, GLOBAL, null);
		manager.ensureGlobal();
		assert.equal(JSON.parse(fs.files[GLOBAL]).configurations.length, 1);
		fs.files[GLOBAL] = '{"activeConfiguration":"mine","configurations":[]}';
		manager.ensureGlobal();
		assert.equal(fs.files[GLOBAL], '{"activeConfiguration":"mine","configurations":[]}');
	});

	it('writes files the loader can read back', () => {
		// The round trip through JSON.stringify must not produce something the
		// loader then rejects.
		const fs = memoryFs();
		const manager = new ConfigurationManager(fs, GLOBAL, null);
		manager.ensureGlobal();
		manager.save({ name: 'main', targetVersion: 154.3, includePaths: ['lib'] }, 'global', 'main');

		const result = manager.load();
		assert.equal(result.activeName, 'main');
		assert.equal(result.effective.includePaths[0], 'lib');
		assert.equal(result.effective.problems.length, 0);
	});
});
