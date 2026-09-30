/*
 * The configuration, as VS Code sees it.
 *
 * `ConfigurationManager` (src/config/manager.ts) knows how to read, merge and
 * write `mlgc.json` and takes a `FileSystem` so it can be tested. This wraps it
 * with the things only the extension host knows: where the files are, that the
 * workspace may be untrusted, and that the files change on disk behind our back.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
	ConfigurationManager,
	DEFAULT_TARGET_VERSION,
	type FileSystem,
	type LoadResult,
} from '../config/manager';
import { nodeFileSystem } from '../config/nodeFileSystem';
import type { ConfigurationProfile, EffectiveConfig } from '../common/types';

const SECTION = 'mindc';

export class ConfigurationService implements vscode.Disposable {
	private readonly manager: ConfigurationManager;
	private readonly emitter = new vscode.EventEmitter<EffectiveConfig>();
	private current: EffectiveConfig;
	private result: LoadResult;

	readonly onDidChange = this.emitter.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.LogOutputChannel,
		fileSystem: FileSystem = nodeFileSystem
	) {
		this.manager = new ConfigurationManager(fileSystem, this.globalPath, this.workspacePath);
		this.result = this.manager.load();
		this.current = this.result.effective;
		this.report(this.result);
		this.watch();
	}

	/** The merged configuration the compiler will be given. */
	get effective(): EffectiveConfig {
		return this.current;
	}

	get state(): LoadResult {
		return this.result;
	}

	/* ---------------------------------------------------------------- *
	 * Paths
	 * ---------------------------------------------------------------- */

	get globalPath(): string {
		const configured = vscode.workspace
			.getConfiguration(SECTION)
			.get<string>('config.globalPath', '');
		if (configured) return path.normalize(configured);
		return path.join(os.homedir(), '.mindustry-c', 'mlgc.json');
	}

	get workspacePath(): string | null {
		const relative = vscode.workspace
			.getConfiguration(SECTION)
			.get<string>('config.workspaceFile', path.join('.vscode', 'mlgc.json'));
		const folder = this.workspaceFolder();
		return folder ? path.join(folder.uri.fsPath, relative) : null;
	}

	get workspaceTrusted(): boolean {
		return vscode.workspace.isTrusted;
	}

	/**
	 * Can a change be written to the workspace file?
	 *
	 * Not in an untrusted workspace: writing there would be writing on behalf of
	 * a folder VS Code has not vouched for, so the global file is used instead and
	 * the UI says so.
	 */
	get canWriteWorkspace(): boolean {
		return this.workspacePath !== null && vscode.workspace.isTrusted;
	}

	/* ---------------------------------------------------------------- *
	 * Mutations
	 * ---------------------------------------------------------------- */

	/**
	 * Write a profile.
	 *
	 * `target` is honoured only when it is allowed; anything else falls back to
	 * the global file, because a build that silently writes nowhere is worse than
	 * one that writes somewhere shareable.
	 */
	saveProfile(profile: ConfigurationProfile, target: 'global' | 'workspace'): void {
		const effectiveTarget = target === 'workspace' && !this.canWriteWorkspace ? 'global' : target;
		const { path: written } = this.manager.save(profile, effectiveTarget, profile.name);
		this.output.info(
			`Wrote configuration "${profile.name}" to ${written}` +
				(effectiveTarget !== target ? ' (workspace not writable; wrote the user-level file)' : '')
		);
		this.reload();
	}

	/** Add a profile, based on the active one so the common case is a copy. */
	addProfile(name: string, base: ConfigurationProfile | null): void {
		if (this.result.profiles.some(profile => profile.name === name)) {
			throw new Error(`A configuration named "${name}" already exists.`);
		}
		const profile: ConfigurationProfile = base
			? { ...cloneProfile(base), name }
			: { name, targetVersion: DEFAULT_TARGET_VERSION };
		this.saveProfile(profile, this.canWriteWorkspace ? 'workspace' : 'global');
	}

	removeProfile(name: string): void {
		const { path: written } = this.manager.removeProfile(name, this.writeTarget);
		this.output.info(`Removed configuration "${name}" from ${written}.`);
		this.reload();
	}

	activate(name: string): void {
		const { path: written } = this.manager.setActive(name, this.writeTarget);
		this.output.info(`Activated configuration "${name}" in ${written}.`);
		this.reload();
	}

	/** Where a change goes: the workspace file when that is allowed. */
	private get writeTarget(): 'global' | 'workspace' {
		return this.canWriteWorkspace ? 'workspace' : 'global';
	}

	/** Re-read both files and tell anyone listening. */
	reload(): EffectiveConfig {
		this.result = this.manager.load();
		this.current = this.result.effective;
		this.report(this.result);
		this.emitter.fire(this.current);
		return this.current;
	}

	/**
	 * Create the user-level file if it is missing.
	 *
	 * The starter content is deliberately minimal: one profile, the current
	 * default target version, no memory blocks. A user who has no memory in their
	 * map is better served by an empty list than by a guessed one.
	 */
	ensureGlobal(): { created: boolean; path: string } {
		const existed = this.exists(this.globalPath);
		if (!existed) {
			this.manager.ensureGlobal();
			this.output.info(`Created ${this.globalPath}.`);
		}
		this.reload();
		return { created: !existed, path: this.globalPath };
	}

	/** Reveal the active configuration file, creating it if it is missing. */
	async openActiveFile(): Promise<void> {
		const path = this.result.files.workspaceFound
			? this.result.files.workspace!
			: this.result.files.global;
		if (!this.exists(path)) this.ensureGlobal();
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
		await vscode.window.showTextDocument(document);
	}

	/* ---------------------------------------------------------------- *
	 * Internals
	 * ---------------------------------------------------------------- */

	private workspaceFolder(): vscode.WorkspaceFolder | null {
		return (vscode.workspace.workspaceFolders ?? [])[0] ?? null;
	}

	private exists(path: string): boolean {
		return nodeFileSystem.exists(path);
	}

	/**
	 * React to the files changing.
	 *
	 * The config editor is the other way round (writing the file reloads the
	 * panel), so this closes the loop without either side polling.
	 */
	private watch(): vscode.Disposable {
		const paths = [this.globalPath, this.workspacePath].filter(
			(candidate): candidate is string => typeof candidate === 'string'
		);
		if (paths.length === 0) return new vscode.Disposable(() => {});

		// A RelativePattern per file keeps the watcher off unrelated trees, and one
		// watcher per pattern because VS Code takes a single glob.
		const watchers = paths.map(target =>
			vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(path.dirname(target)), path.basename(target))
			)
		);
		const reload = (uri: vscode.Uri) => {
			// Our own writes come back through here too; reload is idempotent.
			if (uri.fsPath === this.globalPath || uri.fsPath === this.workspacePath) {
				this.output.info(`Reloaded configuration after ${path.basename(uri.fsPath)} changed.`);
				this.reload();
			}
		};
		for (const watcher of watchers) {
			watcher.onDidChange(reload);
			watcher.onDidCreate(reload);
			watcher.onDidDelete(reload);
			this.context.subscriptions.push(watcher);
		}
		return new vscode.Disposable(() => {
			for (const watcher of watchers) watcher.dispose();
		});
	}

	private report(result: LoadResult): void {
		for (const problem of result.effective.problems) this.output.warn(problem);
		if (!result.effective.profileName) {
			this.output.info(
				'No Mindustry-C configuration found. Run "Mindustry C: Configure Target and Memory" to create one.'
			);
			return;
		}
		const { files } = result;
		this.output.info(
			`Configuration "${result.activeName}": target ${result.effective.targetVersion}, ` +
				`${result.effective.memoryBlocks.length} memory block(s), ` +
				`${result.effective.includePaths.length} include path(s). ` +
				`Files: ${files.globalFound ? path.basename(files.global) : 'no user-level file'}` +
				`${files.workspace ? ', ' + (files.workspaceFound ? path.basename(files.workspace) : 'no workspace file') : ''}.`
		);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

/** Structured clone for plain profile objects, with a JSON fallback. */
function cloneProfile(profile: ConfigurationProfile): ConfigurationProfile {
	return JSON.parse(JSON.stringify(profile)) as ConfigurationProfile;
}
