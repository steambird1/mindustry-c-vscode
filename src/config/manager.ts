/*
 * Reading, merging and writing `mlgc.json`.
 *
 * Two files are involved:
 *
 *   ~/.mindustry-c/mlgc.json        user-level, shared by every project
 *   <workspace>/.vscode/mlgc.json    per project, overrides the above
 *
 * The merge is per *profile*: a workspace file that names a profile only has to
 * state what it changes, so a global file can hold the shared settings and a
 * project can override just the target version. `memoryBlocks` is the exception
 * -- it is a list of physical links, so it is replaced wholesale rather than
 * merged; a project with its own map must not inherit somebody else's cells.
 *
 * Everything here is filesystem-agnostic: the caller passes in a `FileSystem`
 * so the merge can be tested without touching a disk.
 */

import type {
	CompilerOptionsConfig,
	ConfigurationFile,
	ConfigurationProfile,
	EffectiveConfig,
	IdOverrides,
	MemoryBlockConfig,
} from '../common/types';

/** The compiler's own default when `targetVersion` is not set. */
export const DEFAULT_TARGET_VERSION = 154.3;

export const DEFAULT_COMPILER_OPTIONS: Required<CompilerOptionsConfig> = {
	array: false,
	constArray: false,
	pointer: false,
	structPointerThreshold: 0,
	stackCheck: '',
	stackUnderflow: '',
	noInline: [],
};

/** Byte sizes of the buildings a memory block can correspond to. */
export const BUILDING_SIZES: Record<string, number> = {
	'memory-cell': 64,
	'memory-bank': 256,
	'world-cell': 256,
};

export interface ConfigurationFileOnDisk {
	/** Absolute path of the file the object came from. */
	path: string;
	data: ConfigurationFile;
}

export interface FileSystem {
	read(path: string): string | null;
	write(path: string, contents: string): void;
	exists(path: string): boolean;
	mkdirp(path: string): void;
	join(...parts: string[]): string;
	dirname(path: string): string;
}

export interface LoadResult {
	/** The merged, defaulted configuration the compiler will use. */
	effective: EffectiveConfig;
	/** Every profile from both files, merged, in file order. */
	profiles: ConfigurationProfile[];
	/** Name of the profile `effective` came from. */
	activeName: string | null;
	/** Files that were read, and whether each existed. */
	files: { global: string; workspace: string | null; globalFound: boolean; workspaceFound: boolean };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function parse(
	fs: FileSystem,
	path: string
): { data: ConfigurationFile | null; problem: string | null } {
	const text = fs.read(path);
	if (text === null) return { data: null, problem: null };
	try {
		const parsed = JSON.parse(stripJsonComments(text)) as ConfigurationFile;
		if (!parsed || typeof parsed !== 'object') {
			return { data: null, problem: `${path}: the file is not a JSON object.` };
		}
		if (!Array.isArray(parsed.configurations)) {
			return {
				data: null,
				problem: `${path}: "configurations" must be an array.`,
			};
		}
		return { data: parsed, problem: null };
	} catch (error) {
		return {
			data: null,
			problem: `${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * JSONC, so `//` comments and trailing commas are tolerated.
 *
 * A configuration file is hand-written often enough that a stray comma should
 * not cost the user their whole build setup; VS Code's JSON validation already
 * warns about it.
 */
export function stripJsonComments(text: string): string {
	let out = '';
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const next = text[i + 1];
		if (inLine) {
			if (char === '\n') {
				inLine = false;
				out += char;
			}
			continue;
		}
		if (inBlock) {
			if (char === '*' && next === '/') {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === '\\') {
				out += next ?? '';
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === '/' && next === '/') {
			inLine = true;
			i++;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlock = true;
			i++;
			continue;
		}
		out += char;
	}
	// Trailing commas before a closing brace or bracket.
	return out.replace(/,(\s*[}\]])/g, '$1');
}

/* ------------------------------------------------------------------ *
 * Merging
 * ------------------------------------------------------------------ */

function mergeProfile(
	base: ConfigurationProfile,
	overlay: ConfigurationProfile
): ConfigurationProfile {
	const merged: ConfigurationProfile = { ...base, ...overlay, name: overlay.name || base.name };
	// Arrays of physical links are replaced, not concatenated.
	if (overlay.memoryBlocks) merged.memoryBlocks = overlay.memoryBlocks.map(cloneBlock);
	if (overlay.includePaths) merged.includePaths = [...overlay.includePaths];
	if (overlay.compilerOptions) {
		merged.compilerOptions = { ...base.compilerOptions, ...overlay.compilerOptions };
	}
	if (overlay.idOverrides) {
		merged.idOverrides = mergeIdOverrides(base.idOverrides, overlay.idOverrides);
	}
	return merged;
}

function mergeIdOverrides(
	base: IdOverrides | undefined,
	overlay: IdOverrides
): IdOverrides {
	const merged: IdOverrides = { ...base };
	for (const [category, map] of Object.entries(overlay)) {
		if (!map) continue;
		merged[category as keyof IdOverrides] = { ...(base?.[category as keyof IdOverrides] ?? {}), ...map };
	}
	return merged;
}

function cloneBlock(block: MemoryBlockConfig): MemoryBlockConfig {
	return { ...block };
}

/**
 * Merge the two files into the profile list.
 *
 * A workspace profile with the same name as a global one overrides it field by
 * field; a workspace-only profile is added as-is.
 */
export function mergeConfigurations(
	global: ConfigurationFile | null,
	workspace: ConfigurationFile | null
): { profiles: ConfigurationProfile[]; problems: string[] } {
	const problems: string[] = [];
	const profiles = new Map<string, ConfigurationProfile>();

	for (const profile of global?.configurations ?? []) {
		if (typeof profile?.name !== 'string' || !profile.name) {
			problems.push('Skipped a configuration with no name.');
			continue;
		}
		profiles.set(profile.name, { ...profile, name: profile.name });
	}

	for (const profile of workspace?.configurations ?? []) {
		if (typeof profile?.name !== 'string' || !profile.name) {
			problems.push('Skipped a configuration with no name.');
			continue;
		}
		const existing = profiles.get(profile.name);
		profiles.set(
			profile.name,
			existing ? mergeProfile(existing, profile) : { ...profile, name: profile.name }
		);
	}

	return { profiles: [...profiles.values()], problems };
}

function pickActive(
	profiles: ConfigurationProfile[],
	global: ConfigurationFile | null,
	workspace: ConfigurationFile | null
): ConfigurationProfile | null {
	const requested = workspace?.activeConfiguration || global?.activeConfiguration;
	if (requested) {
		const match = profiles.find(profile => profile.name === requested);
		if (match) return match;
	}
	return profiles[0] ?? null;
}

/** Fill in the defaults the compiler would otherwise pick, and record provenance. */
export function toEffective(
	profile: ConfigurationProfile | null,
	context: { globalPath: string | null; workspacePath: string | null; workspace?: ConfigurationFile | null; global?: ConfigurationFile | null }
): EffectiveConfig {
	const sources: EffectiveConfig['sources'] = {};
	if (!profile) {
		return {
			profileName: '',
			targetVersion: DEFAULT_TARGET_VERSION,
			includePaths: [],
			memoryBlocks: [],
			compilerOptions: { ...DEFAULT_COMPILER_OPTIONS },
			idOverrides: {},
			sources,
			globalPath: context.globalPath,
			workspacePath: context.workspacePath,
			problems: [],
		};
	}

	// A field that appears in the workspace file's version of this profile is the
	// workspace's, whatever the merge order was.
	const workspaceProfile = context.workspace?.configurations?.find(
		candidate => candidate.name === profile.name
	);
	const globalProfile = context.global?.configurations?.find(
		candidate => candidate.name === profile.name
	);
	const from = (key: keyof ConfigurationProfile): 'global' | 'workspace' | 'default' => {
		if (workspaceProfile && workspaceProfile[key] !== undefined) return 'workspace';
		if (globalProfile && globalProfile[key] !== undefined) return 'global';
		return 'default';
	};

	sources.targetVersion = from('targetVersion');
	sources.includePaths = from('includePaths');
	sources.memoryBlocks = from('memoryBlocks');
	sources.compilerOptions = from('compilerOptions');
	sources.idOverrides = from('idOverrides');

	return {
		profileName: profile.name,
		targetVersion: profile.targetVersion ?? DEFAULT_TARGET_VERSION,
		includePaths: [...(profile.includePaths ?? [])],
		memoryBlocks: (profile.memoryBlocks ?? []).map(normaliseBlock),
		compilerOptions: { ...DEFAULT_COMPILER_OPTIONS, ...profile.compilerOptions },
		idOverrides: profile.idOverrides ?? {},
		sources,
		globalPath: context.globalPath,
		workspacePath: context.workspacePath,
		problems: [],
	};
}

function normaliseBlock(block: MemoryBlockConfig): MemoryBlockConfig {
	// `??` is not enough here: a size of 0 is what a hand-edited file gets when
	// the author left the field blank for "whatever this building is".
	const declared = typeof block.size === 'number' && block.size > 0 ? block.size : undefined;
	const size = Math.max(1, Math.floor(declared ?? BUILDING_SIZES[block.building ?? ''] ?? 64));
	return {
		name: block.name,
		size,
		...(block.building ? { building: block.building } : {}),
		...(block.note ? { note: block.note } : {}),
	};
}

/* ------------------------------------------------------------------ *
 * The public API
 * ------------------------------------------------------------------ */

export class ConfigurationManager {
	constructor(
		private readonly fs: FileSystem,
		private readonly globalPath: string,
		private readonly workspacePath: string | null
	) {}

	load(): LoadResult {
		const problems: string[] = [];

		const globalResult = parse(this.fs, this.globalPath);
		if (globalResult.problem) problems.push(globalResult.problem);

		let workspaceResult: { data: ConfigurationFile | null; problem: string | null } = {
			data: null,
			problem: null,
		};
		if (this.workspacePath) {
			workspaceResult = parse(this.fs, this.workspacePath);
			if (workspaceResult.problem) problems.push(workspaceResult.problem);
		}

		const { profiles, problems: mergeProblems } = mergeConfigurations(
			globalResult.data,
			workspaceResult.data
		);
		problems.push(...mergeProblems);

		const active = pickActive(profiles, globalResult.data, workspaceResult.data);
		const effective = toEffective(active, {
			globalPath: this.globalPath,
			workspacePath: this.workspacePath,
			workspace: workspaceResult.data,
			global: globalResult.data,
		});
		effective.problems = problems;

		return {
			effective,
			profiles,
			activeName: active?.name ?? null,
			files: {
				global: this.globalPath,
				workspace: this.workspacePath,
				globalFound: globalResult.data !== null,
				workspaceFound: workspaceResult.data !== null,
			},
		};
	}

	/**
	 * Write a profile back.
	 *
	 * `target` is where the profile is written: the workspace file when the
	 * workspace is trusted and the change is project-specific, otherwise the
	 * global one. Profiles that came from the other file are left untouched.
	 */
	save(
		profile: ConfigurationProfile,
		target: 'global' | 'workspace',
		activeName?: string
	): { path: string } {
		const isWorkspace = target === 'workspace' && this.workspacePath !== null;
		const path = isWorkspace ? this.workspacePath! : this.globalPath;

		const existing = parse(this.fs, path).data ?? { configurations: [] };
		const configurations = (existing.configurations ?? []).filter(
			candidate => candidate.name !== profile.name
		);
		configurations.push(profile);

		const file: ConfigurationFile = {
			...(existing.activeConfiguration ? { activeConfiguration: existing.activeConfiguration } : {}),
			configurations,
			...(activeName ? { activeConfiguration: activeName } : {}),
		};

		this.fs.mkdirp(this.fs.dirname(path));
		this.fs.write(path, `${JSON.stringify(file, null, '\t')}\n`);
		return { path };
	}

	/**
	 * Remove a profile from one file.
	 *
	 * A profile that only exists in the other file cannot be removed from here,
	 * and says so rather than pretending to succeed.
	 */
	removeProfile(name: string, target: 'global' | 'workspace'): { path: string } {
		const path = this.pathFor(target);
		const existing = parse(this.fs, path).data;
		if (!existing) {
			throw new Error(`There is no configuration file at ${path}.`);
		}
		const remaining = (existing.configurations ?? []).filter(profile => profile.name !== name);
		if (remaining.length === (existing.configurations ?? []).length) {
			throw new Error(`"${name}" is not in ${path}; it may be defined in the other file.`);
		}
		this.writeFile(path, {
			...(existing.activeConfiguration === name
				? {}
				: { activeConfiguration: existing.activeConfiguration }),
			configurations: remaining,
		});
		return { path };
	}

	/** Point one file's `activeConfiguration` at a profile. */
	setActive(name: string, target: 'global' | 'workspace'): { path: string } {
		const path = this.pathFor(target);
		const existing = parse(this.fs, path).data ?? { configurations: [] };
		if (!(existing.configurations ?? []).some(profile => profile.name === name)) {
			throw new Error(`"${name}" is not in ${path}; it may be defined in the other file.`);
		}
		this.writeFile(path, {
			activeConfiguration: name,
			configurations: existing.configurations ?? [],
		});
		return { path };
	}

	/** Create a starter file, so the UI has something to open. */
	ensureGlobal(defaults: { memoryBlocks?: MemoryBlockConfig[] } = {}): void {
		if (this.fs.exists(this.globalPath)) return;
		this.writeFile(this.globalPath, {
			activeConfiguration: 'default',
			configurations: [
				{
					name: 'default',
					targetVersion: DEFAULT_TARGET_VERSION,
					...(defaults.memoryBlocks?.length
						? { memoryBlocks: defaults.memoryBlocks.map(cloneBlock) }
						: {}),
				},
			],
		});
	}

	private pathFor(target: 'global' | 'workspace'): string {
		if (target === 'workspace') {
			if (!this.workspacePath) {
				throw new Error('There is no workspace configuration file for this window.');
			}
			return this.workspacePath;
		}
		return this.globalPath;
	}

	private writeFile(path: string, file: ConfigurationFile): void {
		this.fs.mkdirp(this.fs.dirname(path));
		this.fs.write(path, `${JSON.stringify(file, null, '\t')}\n`);
	}
}
