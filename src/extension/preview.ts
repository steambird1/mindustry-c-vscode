/*
 * Showing what the compiler produced.
 *
 * The output is never written to disk. It goes into a virtual document served
 * by a TextDocumentContentProvider, which is what makes "preview, then copy"
 * work without littering the project. Copying is a first-class command because
 * pasting into Mindustry's own editor is the point of building.
 *
 * The mlog grammar highlights the preview, so the generated instructions read
 * the way they will in game.
 */

import * as vscode from 'vscode';

export const OUTPUT_SCHEME = 'mindc-output';
const OUTPUT_LANGUAGE_ID = 'mlog';

/**
 * The virtual documents' backing store.
 *
 * Registered once per session and registered in `context.subscriptions`, so the
 * provider outlives any single build.
 */
export class OutputStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly contents = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this.emitter.event;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(this);
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider(OUTPUT_SCHEME, this)
		);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	set(uri: vscode.Uri, text: string): void {
		this.contents.set(uri.toString(), text);
		this.emitter.fire(uri);
	}

	get(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	dispose(): void {
		this.emitter.dispose();
		this.contents.clear();
	}
}

/**
 * The compiled-output view.
 *
 * Holds the most recent build so that "Copy Compiled Output" works even when
 * the preview tab was closed.
 */
export class CompilePreview {
	private latestUri: vscode.Uri | null = null;
	private latestText = '';
	private revision = 0;

	constructor(
		private readonly store: OutputStore,
		private readonly output: vscode.LogOutputChannel
	) {}

	get text(): string {
		return this.latestText;
	}

	get uri(): vscode.Uri | null {
		return this.latestUri;
	}

	get hasOutput(): boolean {
		return this.latestText.length > 0;
	}

	/** Record a build and, unless the user turned previews off, show it. */
	async publish(code: string, source: vscode.Uri): Promise<vscode.Uri> {
		this.latestText = code;
		// A fresh query per build: reusing the uri would leave a stale tab open.
		this.revision++;
		const uri = vscode.Uri.from({
			scheme: OUTPUT_SCHEME,
			path: `/${outputName(source)}`,
			query: `v${this.revision}`,
		});
		this.latestUri = uri;
		this.store.set(uri, code);

		const instructions = code.split('\n').filter(line => line.trim().length > 0).length;
		this.output.info(`Compiled ${instructions} instructions.`);

		if (!vscode.workspace.getConfiguration('mindc').get<boolean>('compile.showPreview', true)) {
			return uri;
		}
		await this.open();
		return uri;
	}

	/** Open (or re-open) the last build. */
	async open(): Promise<vscode.Uri | null> {
		if (!this.latestUri) {
			void vscode.window.showInformationMessage('Mindustry-C: nothing has been compiled yet.');
			return null;
		}
		const document = await vscode.workspace.openTextDocument(this.latestUri);
		if (document.languageId !== OUTPUT_LANGUAGE_ID) {
			await vscode.languages.setTextDocumentLanguage(document, OUTPUT_LANGUAGE_ID);
		}
		await vscode.window.showTextDocument(document, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true,
			preserveFocus: false,
		});
		return this.latestUri;
	}

	async copy(): Promise<void> {
		if (!this.hasOutput) {
			void vscode.window.showInformationMessage('Mindustry-C: nothing has been compiled yet.');
			return;
		}
		await vscode.env.clipboard.writeText(this.latestText);
		const instructions = this.latestText.split('\n').filter(line => line.trim().length > 0).length;
		this.output.info(`Copied ${instructions} instructions to the clipboard.`);
		void vscode.window.setStatusBarMessage(
			`$(check) Mindustry-C: ${instructions} instructions copied`,
			4000
		);
	}
}

/** `foo.mlgc` -> `foo.mlog`, so the preview tab is recognisable. */
function outputName(source: vscode.Uri): string {
	const name = source.path.split('/').pop() ?? 'output';
	return (name.replace(/\.mlgc$/, '') || 'output') + '.mlog';
}
