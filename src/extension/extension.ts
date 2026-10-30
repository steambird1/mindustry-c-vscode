/*
 * The extension host side.
 *
 * Its job: start the language server, own the configuration, run builds, and
 * show the results. The compiler itself is never loaded here -- it lives in the
 * server's analysis worker and in the build worker -- so a compiler crash costs
 * a lost build, not a lost editor.
 *
 * The extension is deliberately thin. Anything that can live in a worker does,
 * because a compiler that throws inside the extension host takes the editor with
 * it and the user cannot even read the log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';
import {
	LanguageClient,
	TransportKind,
	type LanguageClientOptions,
	type ServerOptions,
} from 'vscode-languageclient/node';

import { BuildWorkerHost } from '../compiler/buildSupervisor';
import type { BuildRequest, BuildResponse, EffectiveConfig } from '../common/types';
import { CompilePreview, OutputStore } from './preview';
import { ConfigurationPanel } from './configPanel';
import { ConfigurationService } from './configService';

const LANGUAGE_ID = 'mlgc';
const SECTION = 'mindc';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Mindustry-C', { log: true });
	context.subscriptions.push(output);
	output.info('Mindustry-C extension activating.');

	// -- language server -----------------------------------------------

	const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6019'] },
		},
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: LANGUAGE_ID },
			{ scheme: 'untitled', language: LANGUAGE_ID },
			// Headers, which VS Code gives language `c`. The server never
			// analyses them -- it needs their text so an unsaved `#include`
			// resolves. Matched by path rather than language, so a different
			// file association cannot quietly drop them.
			{ scheme: 'file', pattern: '**/*.h' },
			{ scheme: 'file', pattern: '**/*.hpp' },
		],
		outputChannel: output,
	};

	const client = new LanguageClient('mindc', 'Mindustry-C', serverOptions, clientOptions);
	context.subscriptions.push(client);
	await client.start();
	output.info('Language server started.');

	// -- configuration --------------------------------------------------

	const config = new ConfigurationService(context, output);
	context.subscriptions.push(config);
	config.onDidChange(effective => {
		void client.sendNotification('mindc/config', { config: effective });
	});
	await client.sendNotification('mindc/config', { config: config.effective });
	await client.sendNotification('mindc/settings', { settings: readSettings() });

	// -- compile preview and builds -------------------------------------

	const store = new OutputStore(context);
	const preview = new CompilePreview(store, output);
	const builds = new BuildService(output, context, config, preview);
	context.subscriptions.push(builds);
	void findCompilerRoot();

	// -- commands --------------------------------------------------------

	let panel: ConfigurationPanel | undefined;

	const compileCommand = async (uri?: vscode.Uri, copy = false) => {
		const document = await targetDocument(uri);
		if (!document) return;
		await builds.compile(document, copy);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('mindc.compile', uri => compileCommand(uri)),
		vscode.commands.registerCommand('mindc.compileAndCopy', uri => compileCommand(uri, true)),
		vscode.commands.registerCommand('mindc.cancelCompile', () => builds.cancel()),
		vscode.commands.registerCommand('mindc.showOutput', () => preview.open()),
		vscode.commands.registerCommand('mindc.copyOutput', () => preview.copy()),
		vscode.commands.registerCommand('mindc.openConfiguration', () => config.openActiveFile()),
		vscode.commands.registerCommand('mindc.configure', () => {
			panel ??= new ConfigurationPanel(context, config, output);
			panel.show();
		}),
		vscode.commands.registerCommand('mindc.rescanCompiler', async () => {
			// The compiler is bundled into the server's workers, so a new compiler
			// means a new server. Reloading is the honest way to say that.
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		})
	);

	// A CodeLens on the first line of each file, so the build button is where a
	// C programmer looks for it rather than only in the command palette.
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			[{ scheme: 'file', language: LANGUAGE_ID }, { scheme: 'untitled', language: LANGUAGE_ID }],
			{
				provideCodeLenses(document) {
					if (document.lineCount === 0) return [];
					const firstLine = new vscode.Range(0, 0, 0, 0);
					return [
						new vscode.CodeLens(firstLine, {
							title: '$(run) Compile to Mindustry Logic',
							command: 'mindc.compile',
							arguments: [document.uri],
						}),
						new vscode.CodeLens(firstLine, {
							title: '$(copy) Copy Output',
							command: 'mindc.copyOutput',
							arguments: [],
						}),
					];
				},
			}
		)
	);

	// The status bar reports build progress, which is the only thing the user is
	// waiting on.
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(status);
	builds.status = status;

	// Settings changes reach the server through the same channel as the config,
	// so there is one path to keep straight.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async event => {
			if (!event.affectsConfiguration(SECTION)) return;
			await client.sendNotification('mindc/settings', { settings: readSettings() });
		})
	);
}

export function deactivate(): void {
	// Everything is disposed through `context.subscriptions`.
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function targetDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | null> {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (!target) {
		void vscode.window.showErrorMessage('Mindustry-C: open a Mindustry-C file first.');
		return null;
	}
	if (target.scheme !== 'file' && target.scheme !== 'untitled') {
		void vscode.window.showErrorMessage(
			'Mindustry-C: this file has no location on disk, so #include cannot be resolved for it.'
		);
		return null;
	}
	return vscode.workspace.openTextDocument(target);
}

function readSettings() {
	const configuration = vscode.workspace.getConfiguration(SECTION);
	return {
		diagnostics: {
			enable: configuration.get('diagnostics.enable', true),
			debounce: configuration.get('diagnostics.debounce', 400),
			openIncludes: configuration.get('diagnostics.openIncludes', true),
		},
		compile: {
			showPreview: configuration.get('compile.showPreview', true),
			largeFileWarningChars: configuration.get('compile.largeFileWarningChars', 30000),
		},
	};
}

/**
 * Where the compiler source is, if it is findable.
 *
 * Only used to tell the user when it is missing: the server bundles the compiler
 * either way, so a missing directory costs diagnostics, not the build.
 */
export function findCompilerRoot(context?: vscode.ExtensionContext): string | null {
	const configured = vscode.workspace.getConfiguration(SECTION).get<string>('compilerPath', '');
	const candidates = [
		configured,
		context ? path.join(context.extensionPath, 'compiler') : '',
		process.env.MINDC_COMPILER_DIR ?? '',
	].filter(Boolean);

	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, 'mindc.js'))) return path.resolve(candidate);
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * Builds
 * ------------------------------------------------------------------ */

/**
 * Running builds.
 *
 * One at a time, in a worker thread, cancellable, and always in the background:
 * a full build of a large file takes tens of seconds, and the editor has to stay
 * usable throughout.
 */
class BuildService implements vscode.Disposable {
	private readonly worker: BuildWorkerHost;
	private readonly pending = new Map<number, { uri: vscode.Uri; copyAfterwards: boolean }>();
	private activeUri: vscode.Uri | null = null;
	private cancelled = false;
	/** Set by activate() once the status bar item exists. */
	status: vscode.StatusBarItem | null = null;

	constructor(
		private readonly output: vscode.LogOutputChannel,
		context: vscode.ExtensionContext,
		private readonly config: ConfigurationService,
		private readonly preview: CompilePreview
	) {
		this.worker = new BuildWorkerHost({
			workerPath: path.join(context.extensionPath, 'out', 'server', 'buildWorker.js'),
			onResult: response => this.finished(response),
			onCrash: reason => this.crashed(reason),
		});
	}

	cancel(): void {
		if (!this.activeUri) return;
		this.cancelled = true;
		this.worker.cancel();
		this.status?.hide();
		this.output.info('Build cancelled.');
	}

	/**
	 * Buffers a build may `#include`, so an unsaved header is not read from a
	 * stale copy on disk. The file being built is saved first; its includes are
	 * not, and that is exactly when the disk copy is wrong.
	 */
	private openBuffers(): Map<string, string> {
		const known = new Map<string, string>();
		for (const open of vscode.workspace.textDocuments) {
			if (open.uri.scheme === 'file') known.set(open.uri.toString(), open.getText());
		}
		return known;
	}

	async compile(document: vscode.TextDocument, copyAfterwards: boolean): Promise<void> {
		const configuration = vscode.workspace.getConfiguration(SECTION);
		const limit = configuration.get<number>('compile.largeFileWarningChars', 30000);
		const text = document.getText();

		// The optimiser's cost grows superlinearly: ~130 ms at 6 KB, ~1 s at
		// 26 KB, ~36 s at 107 KB. Better to say so than to look hung.
		if (text.length > limit) {
			const answer = await vscode.window.showWarningMessage(
				`Mindustry-C: this file is ${Math.round(text.length / 1024)} KB. ` +
					`Building it can take minutes, because the optimiser gets much slower as a file grows. Continue?`,
				'Build',
				'Cancel'
			);
			if (answer !== 'Build') return;
		}

		if (document.isDirty) {
			const saved = await document.save();
			if (!saved) {
				void vscode.window.showErrorMessage(
					'Mindustry-C: the file must be saved before building, so that #include can find it.'
				);
				return;
			}
		}

		const effective: EffectiveConfig = this.config.effective;
		if (effective.problems.length > 0) {
			void vscode.window.showWarningMessage(
				'Mindustry-C: the configuration has problems; see the log. Building anyway.'
			);
		}

		this.cancelled = false;
		this.activeUri = document.uri;
		if (this.status) {
			this.status.show();
			this.status.text = '$(sync~spin) Building Mindustry-C...';
		}

		const request: Omit<BuildRequest, 'id'> = {
			uri: document.uri.toString(),
			text: document.getText(),
			config: effective,
		};
		this.worker.setKnownDocuments(this.openBuffers());
		const id = this.worker.start(request);
		if (id < 0) {
			this.status?.hide();
			return;
		}
		this.pending.set(id, { uri: document.uri, copyAfterwards });
		this.output.info(
			`Building ${path.basename(document.uri.fsPath)}: ${text.length} characters, ` +
				`target ${effective.targetVersion}, profile "${effective.profileName}", ` +
				`${effective.memoryBlocks.length} memory block(s).`
		);
	}

	private finished(response: BuildResponse): void {
		const request = this.pending.get(response.id);
		this.pending.delete(response.id);
		this.status?.hide();

		for (const error of response.errors) {
			this.output.error(`${formatPosition(error.line, error.column)} ${error.message}`);
		}
		for (const warning of response.warnings) {
			this.output.warn(`${formatPosition(warning.line, warning.column)} ${warning.message}`);
		}
		if (response.fatalError) this.output.error(response.fatalError);

		const verdict = response.success
			? `succeeded in ${formatDuration(response.elapsedMs)}, ${response.instructionCount} instructions`
			: `failed after ${formatDuration(response.elapsedMs)}`;
		this.output.info(`Build ${verdict}.`);

		if (this.cancelled || !request) return;
		if (!response.ok || !response.success || !response.code) {
			// The first message is usually the whole story -- "Undeclared
			// identifier 'message1'" is actionable, "the build failed" is not --
			// and the rest are one click away in the output channel.
			const first = response.errors[0];
			const where =
				first?.line !== undefined
					? `${first.line}${first.column !== undefined ? `:${first.column}` : ''}: `
					: '';
			const detail = first
				? ` ${where}${firstLineOf(first.message)}${
						response.errors.length > 1 ? ` (+${response.errors.length - 1} more)` : ''
					}`
				: response.fatalError
					? ` ${firstLineOf(response.fatalError)}`
					: '';
			void vscode.window
				.showErrorMessage(`Mindustry-C: the build failed.${detail}`, 'Show Output')
				.then(choice => {
					if (choice === 'Show Output') this.output.show();
				});
			return;
		}

		void this.preview.publish(response.code, request.uri).then(async () => {
			if (request.copyAfterwards) await this.preview.copy();
		});
	}

	private crashed(reason: string): void {
		this.status?.hide();
		this.output.error(reason);
		void vscode.window.showErrorMessage(`Mindustry-C: ${reason}`);
	}

	dispose(): void {
		void this.worker.dispose();
	}
}

function formatPosition(line?: number, column?: number): string {
	if (line === undefined) return '(no position)';
	return column === undefined ? `${line}` : `${line}:${column}`;
}

/** The first line of a compiler message, short enough for a notification. */
function firstLineOf(text: string, limit = 180): string {
	const line = text.split('\n')[0].trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}...` : line;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60000);
	return `${minutes} min ${Math.round((ms % 60000) / 1000)} s`;
}
