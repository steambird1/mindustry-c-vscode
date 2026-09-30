/*
 * The configuration UI.
 *
 * A webview rather than a settings.json editor, because the two things that
 * actually go wrong in a Mindustry-C setup -- memory block order and target
 * version -- are both order-and-number sensitive, and neither is something a
 * hand-edited JSON file can explain.
 *
 * The panel is a pure view over `ConfigurationService`: it sends a whole profile
 * when the user saves, and re-renders whenever the service says the files
 * changed. That means the panel stays correct when someone edits mlgc.json in
 * another window, and there is no second source of truth to keep in sync.
 */

import * as vscode from 'vscode';

import type { ConfigurationService } from './configService';
import type {
	ConfigurationProfile,
	EffectiveConfig,
	HostMessage,
	MemoryBlockConfig,
	WebviewMessage,
	WebviewState,
} from '../common/types';

const TITLE = 'Mindustry-C Configuration';

export class ConfigurationPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly onChange: vscode.Disposable;

	constructor(
		context: vscode.ExtensionContext,
		private readonly service: ConfigurationService,
		private readonly output: vscode.OutputChannel
	) {
		// The files can change under us (the other window, a git checkout); the
		// panel follows rather than showing a stale view of a live file.
		this.onChange = service.onDidChange(() => this.render());
		this.disposables.push(this.onChange);
		context.subscriptions.push(this);
	}

	show(preselect?: string): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			void preselect;
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'mindc.config',
			TITLE,
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [],
			}
		);
		this.panel.webview.onDidReceiveMessage(
			message => void this.receive(message as WebviewMessage),
			undefined,
			this.disposables
		);
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
		this.render();
	}

	private render(): void {
		if (!this.panel) return;
		const { files, effective, profiles, activeName } = this.service.state;
		const state: WebviewState = {
			config: effective,
			profiles,
			activeName,
			globalPath: files.global,
			workspacePath: files.workspace,
			workspaceTrusted: this.service.workspaceTrusted,
			hasGlobalFile: files.globalFound,
			hasWorkspaceFile: files.workspaceFound,
		};
		this.panel.webview.html = render(state, {
			canWriteWorkspace: this.service.canWriteWorkspace,
		});
	}

	/** Handle a message from the webview. */
	private async receive(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					this.render();
					return;
				case 'save':
					this.service.saveProfile(message.profile, this.service.canWriteWorkspace ? 'workspace' : 'global');
					void this.notify(`Saved "${message.profile.name}".`);
					return;
				case 'saveGlobal':
					this.service.saveProfile(message.profile, 'global');
					void this.notify(`Saved "${message.profile.name}" to the user-level file.`);
					return;
				case 'addProfile':
					this.service.addProfile(
						message.name,
						this.service.state.profiles.find(
							profile => profile.name === this.service.state.activeName
						) ?? null
					);
					return;
				case 'removeProfile':
					this.service.removeProfile(message.name);
					return;
				case 'activate':
					this.service.activate(message.name);
					return;
				case 'openFile':
					await this.service.openActiveFile();
					return;
				case 'ensureGlobal': {
					const { created, path } = this.service.ensureGlobal();
					void this.notify(created ? `Created ${path}.` : `${path} already existed.`);
					return;
				}
				default:
					return;
			}
		} catch (error) {
			// Errors from the service are the interesting case: a profile that
			// lives in the other file, an unparseable mlgc.json. Show them in
			// place rather than as a modal.
			const text = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[error] ${text}`);
			this.post({ type: 'error', message: text });
			void vscode.window.showErrorMessage(`Mindustry-C: ${text}`);
		}
	}

	private async notify(message: string): Promise<void> {
		this.post({ type: 'notify', message });
	}

	private post(message: HostMessage): void {
		void this.panel?.webview.postMessage(message);
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
		for (const disposable of this.disposables) disposable.dispose();
		this.disposables.length = 0;
	}
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

interface RenderFlags {
	/** False in an untrusted workspace, which is where saves go to the user file. */
	canWriteWorkspace: boolean;
}

function render(state: WebviewState, flags: RenderFlags): string {
	// The panel edits the *raw* profile for the active name, not the merged
	// result: showing merged values would make it impossible to see what this
	// file actually says. Defaults come from the merged config for display only.
	const active = state.profiles.find(candidate => candidate.name === state.activeName) ?? null;
	const profile: ConfigurationProfile = active
		? { ...active }
		: {
				name: 'default',
				targetVersion: state.config?.targetVersion,
			};

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${TITLE}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
	<header>
		<h1>Target &amp; Memory</h1>
		<p class="sub">
			These settings describe the map you are building for: the game's version, and the
			memory cells wired into the processor.
		</p>
	</header>

	${renderSources(state)}
	${state.config && state.config.problems.length > 0 ? renderProblems(state.config) : ''}
	${renderProfiles(state)}
	${renderTargetVersion(profile, state.config?.sources.targetVersion)}
	${renderMemoryBlocks(profile)}
	${renderIncludePaths(profile)}
	${renderCompilerOptions(profile)}
	${renderIdOverrides(profile)}
	${renderFooter(flags)}
</main>
<script>${script()}</script>
</body>
</html>`;
}

function renderSources(state: WebviewState): string {
	const rows: string[] = [];
	rows.push(
		row(
			'User-level',
			`<code>${escapeHtml(state.globalPath ?? '')}</code>`,
			state.hasGlobalFile
				? '<span class="badge ok">found</span>'
				: '<span class="badge">not created</span>'
		)
	);
	if (state.workspacePath) {
		rows.push(
			row(
				'Workspace',
				`<code>${escapeHtml(state.workspacePath)}</code>`,
				state.hasWorkspaceFile
					? '<span class="badge ok">found</span>'
					: '<span class="badge">not created</span>'
			)
		);
	} else {
		rows.push(row('Workspace', '<em>no folder is open</em>', ''));
	}
	return `<section class="card">
	<h2>Configuration files</h2>
	<p class="hint">The workspace file overrides the user-level one, field by field, per configuration.
	Memory blocks are the exception: they are replaced wholesale, because their order is the wiring order.</p>
	<table class="kv">${rows.join('')}</table>
	${
		!state.hasGlobalFile
			? '<button id="ensureGlobal" class="secondary">Create the user-level file</button>'
			: ''
	}
	<button id="openFile" class="secondary">Open the file</button>
</section>`;
}

function renderProblems(config: EffectiveConfig): string {
	return `<section class="card problems">
	<h2>Problems</h2>
	<ul>${config.problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>
	<p class="hint">The rest of the settings below still apply.</p>
</section>`;
}

function renderProfiles(state: WebviewState): string {
	const options = state.profiles
		.map(
			profile =>
				`<option value="${escapeHtml(profile.name)}"${
					profile.name === state.activeName ? ' selected' : ''
				}>${escapeHtml(profile.name)}</option>`
		)
		.join('');
	const names = state.profiles.map(profile => profile.name);
	return `<section class="card">
	<h2>Configuration</h2>
	<p class="hint">A named set of settings. Switching it re-analyses every open file.</p>
	<div class="row">
		<label for="profile">Active</label>
		<select id="profile">${options || '<option value="">none</option>'}</select>
		<button id="activate" class="secondary">Apply</button>
	</div>
	<div class="row">
		<label for="newProfile">New</label>
		<input id="newProfile" type="text" placeholder="name" list="profileNames" />
		<datalist id="profileNames">${names.map(name => `<option value="${escapeHtml(name)}">`).join('')}</datalist>
		<button id="addProfile" class="secondary">Add a copy</button>
		<button id="removeProfile" class="secondary danger">Remove</button>
	</div>
	<p class="hint">Removing only affects the file that defines it; a configuration that lives in
	the other file has to be removed there.</p>
</section>`;
}

function renderTargetVersion(
	profile: ConfigurationProfile,
	source: 'global' | 'workspace' | 'default' | undefined
): string {
	const value = profile.targetVersion ?? 154.3;
	return `<section class="card">
	<h2>Target version</h2>
	<p class="hint">The Mindustry version to compile for. It decides which instructions and
	constants the compiler may use, so it must match the game the map runs in.${sourceBadge(source)}</p>
	<div class="row">
		<input id="targetVersion" type="number" step="0.1" min="0" value="${value}" />
		<span class="unit">game version, e.g. 154.3</span>
	</div>
</section>`;
}

/**
 * Memory blocks.
 *
 * Order is the whole point: the Nth entry binds to the Nth memory link of that
 * kind, so reordering these rows is not a cosmetic change. The panel says so
 * and offers move buttons rather than a drag handle, which is more reliable in a
 * webview.
 */
function renderMemoryBlocks(profile: ConfigurationProfile): string {
	const blocks = profile.memoryBlocks ?? [];
	const rows = blocks
		.map((block, index) => renderMemoryRow(block, index, blocks.length))
		.join('');

	return `<section class="card">
	<h2>Memory blocks</h2>
	<p class="hint"><strong>Order matters.</strong> The first memory-cell link on the processor
	becomes <code>cell1</code>, the second <code>cell2</code>, and so on; the same applies to
	memory banks. Renaming a block renames the generated <code>&lt;name&gt;_id</code>
	variable, so the names below are what you write in your code.</p>
	<table class="blocks">
		<thead>
			<tr>
				<th class="n">#</th>
				<th>Name</th>
				<th>Building</th>
				<th>Size (bytes)</th>
				<th>Note</th>
				<th class="buttons"></th>
			</tr>
		</thead>
		<tbody id="blocks">${rows}</tbody>
	</table>
	<div class="row">
		<button id="addBlock" class="secondary">Add a memory cell</button>
		<button id="addBank" class="secondary">Add a memory bank</button>
	</div>
	${blocks.length === 0 ? '<p class="hint">No memory blocks. Code that declares <code>remote()</code> bindings or large arrays will not build.</p>' : ''}
</section>`;
}

function renderMemoryRow(block: MemoryBlockConfig, index: number, total: number): string {
	const building = block.building ?? '';
	return `<tr data-index="${index}">
		<td class="n">${index + 1}</td>
		<td><input class="b-name" type="text" value="${escapeHtml(block.name)}" placeholder="cell${index + 1}" /></td>
		<td>
			<select class="b-building">
				<option value=""${building === '' ? ' selected' : ''}>not set</option>
				<option value="memory-cell"${building === 'memory-cell' ? ' selected' : ''}>memory cell (64 B)</option>
				<option value="memory-bank"${building === 'memory-bank' ? ' selected' : ''}>memory bank (256 B)</option>
				<option value="world-cell"${building === 'world-cell' ? ' selected' : ''}>world cell (256 B)</option>
			</select>
		</td>
		<td><input class="b-size" type="number" min="1" step="1" value="${block.size}" /></td>
		<td><input class="b-note" type="text" value="${escapeHtml(block.note ?? '')}" placeholder="where it is wired" /></td>
		<td class="buttons">
			<button class="move secondary" data-dir="-1"${index === 0 ? ' disabled' : ''} title="Move up">↑</button>
			<button class="move secondary" data-dir="1"${index === total - 1 ? ' disabled' : ''} title="Move down">↓</button>
			<button class="remove danger secondary" title="Remove">✕</button>
		</td>
	</tr>`;
}

function renderIncludePaths(profile: ConfigurationProfile): string {
	const value = (profile.includePaths ?? []).join('\n');
	return `<section class="card">
	<h2>Include paths</h2>
	<p class="hint">Directories searched for <code>#include</code>, one per line, in order.
		A header next to the file that includes it is always found first. Paths may be absolute,
		or relative to the workspace folder.</p>
		<textarea id="includePaths" rows="3" placeholder="lib&#10;include">${escapeHtml(value)}</textarea>
</section>`;
}

function renderCompilerOptions(profile: ConfigurationProfile): string {
	const options = profile.compilerOptions ?? {};
	const check = (id: string, label: string, checked: boolean, hint: string) => `
		<label class="check">
			<input id="${id}" type="checkbox"${checked ? ' checked' : ''} />
			<span><strong>${label}</strong><br /><span class="hint">${hint}</span></span>
		</label>`;
	return `<section class="card">
	<h2>Compiler options</h2>
	<p class="hint">These map onto the compiler's own options. They change how a program is
	compiled, not what it should do, so they are per-configuration.</p>
	${check('optArray', 'array', options.array === true, 'Enable array support.')}
	${check('optConstArray', 'const array', options.constArray === true, 'Enable arrays declared const.')}
	${check('optPointer', 'pointer', options.pointer === true, 'Enable pointer support.')}
	<div class="row">
		<label for="optStructPointer">struct pointer threshold</label>
		<input id="optStructPointer" type="number" min="0" step="1" value="${options.structPointerThreshold ?? 0}" />
		<span class="unit">bytes; 0 means always pass structs by pointer</span>
	</div>
	<div class="row">
		<label for="optStackCheck">stack check</label>
		<input id="optStackCheck" type="text" value="${escapeHtml(options.stackCheck ?? '')}" placeholder="(off)" />
	</div>
	<div class="row">
		<label for="optStackUnderflow">stack underflow</label>
		<input id="optStackUnderflow" type="text" value="${escapeHtml(options.stackUnderflow ?? '')}" placeholder="(off)" />
	</div>
	<div class="row">
		<label for="optNoInline">never inline</label>
		<input id="optNoInline" type="text" value="${escapeHtml((options.noInline ?? []).join(', '))}" placeholder="f, g" />
		<span class="unit">comma-separated function names</span>
	</div>
</section>`;
}

function renderIdOverrides(profile: ConfigurationProfile): string {
	const overrides = profile.idOverrides ?? {};
	const categories = ['item', 'liquid', 'unit', 'block'] as const;
	const rows = categories
		.map(category => {
			const map = overrides[category] ?? {};
			const text = Object.entries(map)
				.map(([name, id]) => (id === null ? `${name} = (removed)` : `${name} = ${id}`))
				.join('\n');
			return `<div class="override">
				<label for="ids-${category}">${category} ids</label>
				<textarea id="ids-${category}" rows="3" placeholder="copper = 13&#10;lead = (removed)">${escapeHtml(text)}</textarea>
			</div>`;
		})
		.join('');
	return `<section class="card">
	<h2>Content id overrides <small>(advanced)</small></h2>
	<p class="hint">The compiler reads content names like <code>@copper</code> and turns them
	into numeric ids. This table fixes or removes individual names, for when the compiler's
	ids do not match the mods or the game version you target. Leave empty unless something is
	wrong. <code>name = (removed)</code> makes the name an error rather than a wrong id.</p>
	${rows}
</section>`;
}

function renderFooter(flags: RenderFlags): string {
	return `<section class="card footer">
	<p class="hint">Changes apply to the next build. Open files are re-analysed when the
	active configuration changes, so diagnostics follow immediately.</p>
	<button id="saveWorkspace" class="primary"${
		flags.canWriteWorkspace ? '' : ' disabled title="Not available in an untrusted workspace"'
	}>Save to the workspace file</button>
	<button id="saveGlobal" class="primary">Save to the user-level file</button>
	<span id="status" class="status"></span>
</section>`;
}

function row(label: string, value: string, extra: string): string {
	return `<tr><th>${label}</th><td>${value}</td><td>${extra}</td></tr>`;
}

function sourceBadge(source: string | undefined): string {
	if (source === 'workspace') return ' <span class="badge">from the workspace file</span>';
	if (source === 'global') return ' <span class="badge">from the user-level file</span>';
	return ' <span class="badge">compiler default</span>';
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ *
 * Styles and behaviour
 * ------------------------------------------------------------------ */

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 1.25rem 1.5rem 3rem;
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	line-height: 1.5;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 0 0 .5rem; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
h2 small { text-transform: none; letter-spacing: 0; }
header { margin-bottom: 1.25rem; }
.sub, .hint { opacity: .72; font-size: .9em; margin: .25rem 0 .75rem; }
.card {
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
	border-radius: 6px;
	padding: .9rem 1rem 1rem;
	margin-bottom: 1rem;
	background: var(--vscode-sideBar-background, transparent);
}
.row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: .4rem 0; }
.row label { min-width: 11rem; }
input[type=text], input[type=number], select, textarea {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
	border-radius: 3px;
	padding: .3rem .45rem;
	font-family: inherit;
	font-size: inherit;
	min-width: 8rem;
}
input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
textarea { width: 100%; font-family: var(--vscode-editor-font-family, monospace); resize: vertical; }
button {
	border: 1px solid transparent; border-radius: 3px; padding: .35rem .8rem;
	font-family: inherit; font-size: inherit; cursor: pointer;
	background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: .4; cursor: default; }
button.secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2)); color: var(--vscode-button-secondaryForeground, inherit); }
button.danger { color: var(--vscode-errorForeground, #e51400); }
table { border-collapse: collapse; width: 100%; }
table.kv th { text-align: left; font-weight: 500; width: 9rem; padding: .2rem .5rem .2rem 0; vertical-align: top; }
table.kv td { padding: .2rem .5rem .2rem 0; }
table.blocks th { text-align: left; font-weight: 500; font-size: .85em; opacity: .75; padding: .25rem .35rem; }
table.blocks td { padding: .2rem .35rem; vertical-align: middle; }
table.blocks input { width: 100%; }
table.blocks .n { width: 2rem; text-align: right; opacity: .6; }
table.blocks .buttons { width: 8rem; white-space: nowrap; }
table.blocks button { padding: .2rem .45rem; }
code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; }
.badge {
	display: inline-block; padding: 0 .4rem; border-radius: 8px; font-size: .78em;
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); opacity: .8;
}
.badge.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.problems { border-color: var(--vscode-editorWarning-foreground, #cca700); }
.check { display: flex; gap: .5rem; align-items: start; margin: .4rem 0; cursor: pointer; }
.check input { margin-top: .3rem; }
.override { margin: .5rem 0; }
.override label { display: block; font-size: .85em; opacity: .75; margin-bottom: .15rem; }
.unit { opacity: .6; font-size: .85em; }
.status { opacity: .8; font-size: .9em; margin-left: .5rem; }
.footer { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.footer .hint { flex-basis: 100%; margin: 0 0 .25rem; }
`;

function script(): string {
	return `
const vscode = acquireVsCodeApi();
const post = message => vscode.postMessage(message);
let state = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function status(text, isError) {
	const element = $('#status');
	if (!element) return;
	element.textContent = text;
	element.style.color = isError ? 'var(--vscode-errorForeground)' : 'var(--vscode-testing-iconPassed, #3fb950)';
	clearTimeout(status.timer);
	status.timer = setTimeout(() => { element.textContent = ''; }, 4000);
}

/* ---- reading the form back into a profile ---- */

function readBlocks() {
	return $$('#blocks tr').map((row, index) => {
		const name = row.querySelector('.b-name').value.trim();
		const size = Number(row.querySelector('.b-size').value);
		const note = row.querySelector('.b-note').value.trim();
		const building = row.querySelector('.b-building').value;
		const block = {
			name: name || 'cell' + (index + 1),
			size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 64,
		};
		if (building) block.building = building;
		if (note) block.note = note;
		return block;
	});
}

function readOverrides() {
	const result = {};
	for (const category of ['item', 'liquid', 'unit', 'block']) {
		const text = ($('#ids-' + category)?.value ?? '').trim();
		if (!text) continue;
		const map = {};
		for (const line of text.split(/\\r?\\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const match = /^([A-Za-z_]\\w*)\\s*=\\s*(.+)$/.exec(trimmed);
			if (!match) continue;
			const [, name, raw] = match;
			if (/^\\(removed\\)$/i.test(raw.trim()) || raw.trim() === '-') map[name] = null;
			else {
				const id = Number(raw.trim());
				if (Number.isFinite(id)) map[name] = id;
			}
		}
		if (Object.keys(map).length) result[category] = map;
	}
	return result;
}

function readProfile() {
	const active = $('#profile');
	const name = active && active.value ? active.value : 'default';
	const profile = { name };

	const version = Number($('#targetVersion').value);
	if (Number.isFinite(version) && version > 0) profile.targetVersion = version;

	const paths = ($('#includePaths').value ?? '')
		.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean);
	if (paths.length) profile.includePaths = paths;

	const blocks = readBlocks();
	if (blocks.length) profile.memoryBlocks = blocks;

	profile.compilerOptions = {
		array: $('#optArray').checked,
		constArray: $('#optConstArray').checked,
		pointer: $('#optPointer').checked,
		structPointerThreshold: Number($('#optStructPointer').value) || 0,
		stackCheck: $('#optStackCheck').value.trim(),
		stackUnderflow: $('#optStackUnderflow').value.trim(),
		noInline: $('#optNoInline').value.split(',').map(part => part.trim()).filter(Boolean),
	};

	const overrides = readOverrides();
	if (Object.keys(overrides).length) profile.idOverrides = overrides;
	return profile;
}

/* ---- actions ---- */

function move(row, direction) {
	const body = row.parentElement;
	const rows = [...body.children];
	const target = rows.indexOf(row) + direction;
	if (target < 0 || target >= rows.length) return;
	if (direction < 0) body.insertBefore(row, rows[target]);
	else body.insertBefore(rows[target], row);
	renumber();
}

function renumber() {
	$$('#blocks tr').forEach((row, index) => {
		row.dataset.index = index;
		row.querySelector('.n').textContent = index + 1;
		const up = row.querySelector('[data-dir="-1"]');
		const down = row.querySelector('[data-dir="1"]');
		up.disabled = index === 0;
		down.disabled = index === $$('#blocks tr').length - 1;
		const name = row.querySelector('.b-name');
		if (!name.value.trim()) name.placeholder = 'cell' + (index + 1);
	});
}

function addBlock(size, building) {
	const body = $('#blocks');
	if (!body) return;
	const count = body.children.length;
	const row = document.createElement('tr');
	row.dataset.index = count;
	row.innerHTML =
		'<td class="n">' + (count + 1) + '</td>' +
		'<td><input class="b-name" type="text" value="cell' + (count + 1) + '" /></td>' +
		'<td><select class="b-building">' +
			'<option value="">not set</option>' +
			'<option value="memory-cell"' + (building === 'memory-cell' ? ' selected' : '') + '>memory cell (64 B)</option>' +
			'<option value="memory-bank"' + (building === 'memory-bank' ? ' selected' : '') + '>memory bank (256 B)</option>' +
			'<option value="world-cell"' + (building === 'world-cell' ? ' selected' : '') + '>world cell (256 B)</option>' +
		'</select></td>' +
		'<td><input class="b-size" type="number" min="1" step="1" value="' + size + '" /></td>' +
		'<td><input class="b-note" type="text" placeholder="where it is wired" /></td>' +
		'<td class="buttons">' +
			'<button class="move secondary" data-dir="-1">↑</button>' +
			'<button class="move secondary" data-dir="1">↓</button>' +
			'<button class="remove danger secondary">✕</button>' +
		'</td>';
	body.appendChild(row);
	renumber();
	row.querySelector('.b-note').focus();
}

document.addEventListener('click', event => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;

	const moveButton = target.closest('.move');
	if (moveButton) {
		const row = moveButton.closest('tr');
		move(row, Number(moveButton.dataset.dir));
		return;
	}
	if (target.closest('.remove')) {
		const row = target.closest('tr');
		row.remove();
		renumber();
		return;
	}

	switch (target.id) {
		case 'addBlock':
			addBlock(64, 'memory-cell');
			return;
		case 'addBank':
			addBlock(256, 'memory-bank');
			return;
		case 'saveWorkspace':
			post({ type: 'save', profile: readProfile() });
			return;
		case 'saveGlobal':
			post({ type: 'saveGlobal', profile: readProfile() });
			return;
		case 'activate': {
			const select = $('#profile');
			if (select && select.value) post({ type: 'activate', name: select.value });
			return;
		}
		case 'addProfile': {
			const input = $('#newProfile');
			const name = input.value.trim();
			if (!name) { input.focus(); return; }
			post({ type: 'addProfile', name });
			return;
		}
		case 'removeProfile': {
			const select = $('#profile');
			if (select && select.value) post({ type: 'removeProfile', name: select.value });
			return;
		}
		case 'openFile':
			post({ type: 'openFile' });
			return;
		case 'ensureGlobal':
			post({ type: 'ensureGlobal' });
			return;
	}
});

// Choosing a building fills in the size it implies, but does not lock it: a
// memory cell with a custom capacity is a real thing.
document.addEventListener('change', event => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	if (target.classList.contains('b-building')) {
		const row = target.closest('tr');
		const size = { 'memory-cell': 64, 'memory-bank': 256, 'world-cell': 256 }[target.value];
		if (size) row.querySelector('.b-size').value = size;
	}
});

window.addEventListener('message', event => {
	const message = event.data;
	if (!message) return;
	if (message.type === 'notify') status(message.message, false);
	if (message.type === 'error') status(message.message, true);
});

post({ type: 'ready' });
`;
}
