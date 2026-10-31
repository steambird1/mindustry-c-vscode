/*
 * The language server, over the wire.
 *
 * Every other test here calls a function directly, which is exactly how two
 * breaks reached a build:
 *
 *   - `documents.listen(connection)` was never called, so the document manager
 *     never heard a file open. Nothing was ever analysed, and the server still
 *     answered `initialize` with all seven capabilities.
 *   - `pathOf` answered with the buffer's text, so the diagnostics that did come
 *     back were published under a URI built from the file's own contents --
 *     which no editor draws, so the file looked checked and clean.
 *
 * Neither is visible when you call the function; both are visible the moment a
 * client asks a real question. So this test asks one.
 *
 * Needs the built server. `npm run build` produces it, and the pretest hook
 * runs that before the test bundles -- without it this fails rather than skips,
 * because a skipped test is how the above shipped.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(__dirname, '..', '..');
const serverPath = path.join(root, 'out', 'server', 'server.js');

/**
 * The same file two ways: what vscode-uri prints for a Windows drive, and the
 * same path with the colon left alone. The client picks one and the server has
 * to land on whichever it did -- they are the same file.
 */
const CANONICAL = 'file:///c%3A/project/main.mlgc';
const LITERAL = 'file:///c:/project/main.mlgc';

/**
 * A header that exists only in the editor, and the file that includes it.
 * Nothing is on disk here, so the include has nowhere else to come from.
 */
const INCLUDE_HEADER = 'file:///c%3A/project/lib.h';
const INCLUDE_MAIN = 'file:///c%3A/project/include-main.mlgc';
const INCLUDE_OTHER = 'file:///c%3A/project/other-main.mlgc';

const BROKEN = 'int main(void) {\n    return thisDoesNotExist;\n}\n';

interface Published {
	uri: string;
	count: number;
	messages: string[];
}

interface RpcMessage {
	id?: number;
	method?: string;
	params?: any;
	result?: any;
	error?: any;
}

/** A client on stdio: framed JSON-RPC, and answers to anything the server asks. */
function connect(target: string) {
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [target, '--stdio'], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	// Frames are counted in bytes, and a completion `detail` can contain a
	// multi-byte character (the `…` in `void* byname(…)`), so the buffer has to
	// be bytes: comparing `Content-Length` against a JS string length waits for
	// bytes that never arrive and swallows the next header into the body.
	let buffer = Buffer.alloc(0);
	let stderr = '';
	let nextId = 1;
	const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	const published: Published[] = [];

	child.stderr.on('data', chunk => {
		stderr += String(chunk);
	});

	const write = (message: RpcMessage): void => {
		const body = JSON.stringify(message);
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};

	const receive = (message: RpcMessage): void => {
		// A server->client request. Never leaving one unanswered is the whole
		// point: `workspace/configuration` can stall everything behind it.
		if (message.id !== undefined && message.method) {
			const result =
				message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null;
			write({ id: message.id, result });
			return;
		}
		if (message.id !== undefined && !message.method) {
			const waiter = waiting.get(message.id);
			if (!waiter) return;
			waiting.delete(message.id);
			if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
			else waiter.resolve(message.result);
			return;
		}
		if (message.method === 'textDocument/publishDiagnostics') {
			const diagnostics = message.params.diagnostics ?? [];
			published.push({
				uri: message.params.uri,
				count: diagnostics.length,
				messages: diagnostics.map((diagnostic: { message: string }) => diagnostic.message),
			});
		}
	};

	child.stdout.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
			if (!match) {
				buffer = buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
			buffer = buffer.subarray(headerEnd + 4 + length);
			receive(JSON.parse(body) as RpcMessage);
		}
	});

	const request = (method: string, params: unknown): Promise<any> => {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			waiting.set(id, { resolve, reject });
			write({ id, method, params });
			setTimeout(() => {
				if (!waiting.delete(id)) return;
				reject(new Error(`no answer to ${method}; stderr: ${stderr.slice(0, 400)}`));
			}, 15000);
		});
	};

	/**
	 * Wait until `uri` gets a publish the caller accepts.
	 *
	 * For a finding, `count > 0`; a clean run is a publish with none, and
	 * waiting for "a publish at all" is what distinguishes "the server said the
	 * file is fine" from "the server never spoke".
	 */
	const waitForPublished = (
		uri: string,
		accept: (entry: Published) => boolean,
		what: string,
		timeoutMs: number
	): Promise<Published> => {
		const already = published.find(entry => entry.uri === uri && accept(entry));
		if (already) return Promise.resolve(already);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const got = published.map(entry => `${entry.count} for ${entry.uri}`);
				reject(
					new Error(
						`no ${what} for ${uri} within ${timeoutMs} ms; saw ${JSON.stringify(got)}; stderr: ${stderr.slice(0, 400)}`
					)
				);
			}, timeoutMs);
			const poll = setInterval(() => {
				const found = published.find(entry => entry.uri === uri && accept(entry));
				if (!found) return;
				clearTimeout(timer);
				clearInterval(poll);
				resolve(found);
			}, 25);
		});
	};

	const waitForFinding = (uri: string, timeoutMs: number): Promise<Published> =>
		waitForPublished(uri, entry => entry.count > 0, 'finding', timeoutMs);

	const waitForPublish = (uri: string, timeoutMs: number): Promise<Published> =>
		waitForPublished(uri, () => true, 'publish', timeoutMs);

	const close = async (): Promise<void> => {
		try {
			await request('shutdown', null);
			write({ method: 'exit' });
		} catch {
			// Already gone, or never got going; the kill below is the answer.
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				child.kill();
				resolve();
			}, 2000);
			child.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	};

	return { child, request, write, published, waitForFinding, waitForPublish, close };
}

describe('the language server, over the wire', () => {
	let client: ReturnType<typeof connect>;
	let capabilities: Record<string, unknown>;

	before(async () => {
		assert.ok(
			fs.existsSync(serverPath),
			`${serverPath} is missing -- the server bundle has to be built before these run (the pretest hook does it)`
		);
		client = connect(serverPath);
		const result = await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
		capabilities = result.capabilities;
		client.write({ method: 'initialized', params: {} });
	});

	after(async () => {
		if (client) await client.close();
	});

	it('advertises every feature it implements', () => {
		for (const capability of [
			'hoverProvider',
			'definitionProvider',
			'referencesProvider',
			'renameProvider',
			'completionProvider',
			'signatureHelpProvider',
			'documentSymbolProvider',
		]) {
			assert.ok(capability in capabilities, `the server did not advertise ${capability}`);
		}
	});

	const open = (uri: string, languageId = 'mlgc', text = BROKEN): void => {
		client.write({
			method: 'textDocument/didOpen',
			params: {
				textDocument: { uri, languageId, version: 1, text },
			},
		});
	};

	it('analyses a document that is opened, and reports the finding against its own file', async () => {
		open(CANONICAL);

		// Long enough for the debounce and one analysis, short enough that a
		// regression fails the run rather than hanging it.
		const result = await client.waitForFinding(CANONICAL, 20000);

		assert.match(result.messages.join('\n'), /thisDoesNotExist/, 'the finding did not name the identifier');
	});

	it('reports against the document whichever way the client spelled its uri', async () => {
		// Same file, `c:` instead of `c%3A`. The server rebuilds a uri from the
		// path the compiler reported, and the two spellings are not the same
		// string -- so this is the case where rebuilding quietly misses.
		open(LITERAL);

		const result = await client.waitForFinding(LITERAL, 20000);

		assert.match(result.messages.join('\n'), /thisDoesNotExist/);
	});

	it('resolves #include from a header that exists only in the editor', async () => {
		// The header is opened before the file that includes it, and there is no
		// copy on disk, so the run cannot even open it without the buffer.
		open(INCLUDE_HEADER, 'c', 'int fromBuffer(int value);\n');
		open(INCLUDE_MAIN, 'mlgc', '#include "lib.h"\nint main(void) {\n    return fromBuffer(1);\n}\n');

		const result = await client.waitForPublish(INCLUDE_MAIN, 20000);

		assert.equal(result.count, 0, `expected a clean run, got: ${result.messages.join(' | ')}`);
	});

	it('offers the signature of the function being called', async () => {
		// Inside `fromBuffer(1)`. The declaration lives in the header, which is
		// only in the editor, so this also proves parameter lists cross includes.
		const help = await client.request('textDocument/signatureHelp', {
			textDocument: { uri: INCLUDE_MAIN },
			position: { line: 2, character: 22 },
		});

		assert.ok(help, 'no signature help inside the call');
		const active = help.signatures[help.activeSignature];
		assert.equal(active.label, 'int fromBuffer(int value)');
		assert.equal(help.activeParameter, 0);
	});

	it('answers completion while the index is one keystroke behind', async () => {
		// Analysis is debounced; a completion request that arrives between a
		// keystroke and the next run used to be answered from an index whose
		// version no longer matched, which meant an empty list and nothing but
		// VS Code's word suggestions on screen.
		client.write({
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri: CANONICAL, version: 2 },
				contentChanges: [{ text: BROKEN }],
			},
		});

		const result = await client.request('textDocument/completion', {
			textDocument: { uri: CANONICAL },
			position: { line: 1, character: 11 },
			context: { triggerKind: 1 },
		});
		const items = Array.isArray(result) ? result : result?.items ?? [];
		const labels = items.map((item: { label: string }) => item.label);

		assert.ok(labels.includes('main'), `no "main" in ${JSON.stringify(labels.slice(0, 12))}`);
	});

	it('attributes references, rename and the outline to the file they are in', async () => {
		// A second open file that includes the same header: both translation
		// units carry the header's declaration, so it must not be reported twice.
		open(INCLUDE_OTHER, 'mlgc', '#include "lib.h"\nint main(void) { return 0; }\n');
		await client.waitForPublish(INCLUDE_OTHER, 20000);

		// Inside `fromBuffer` at the call site.
		const position = { line: 2, character: 14 };

		const found = await client.request('textDocument/references', {
			textDocument: { uri: INCLUDE_MAIN },
			position,
			context: { includeDeclaration: true },
		});
		const locations = (found ?? []) as Array<{ uri: string; range: { start: { line: number; character: number } } }>;
		const uris = new Set(locations.map(location => location.uri));
		assert.ok(uris.has(INCLUDE_MAIN), 'the call site was not reported');
		assert.ok(uris.has(INCLUDE_HEADER), 'the header declaration was reported against the wrong document');

		const keys = locations.map(location => `${location.uri}:${location.range.start.line}:${location.range.start.character}`);
		assert.equal(new Set(keys).size, keys.length, 'the same location was reported more than once');

		const edit = await client.request('textDocument/rename', {
			textDocument: { uri: INCLUDE_MAIN },
			position,
			newName: 'renamedBuffer',
		});
		assert.ok(edit?.changes?.[INCLUDE_MAIN], 'the call site was not renamed');
		assert.ok(edit?.changes?.[INCLUDE_HEADER], 'the header declaration was not renamed');

		const symbols = (await client.request('textDocument/documentSymbol', {
			textDocument: { uri: INCLUDE_MAIN },
		})) as Array<{ name: string }>;
		const names = symbols.map(symbol => symbol.name);
		assert.ok(names.includes('main'), 'the outline lost the function');
		assert.ok(!names.includes('fromBuffer'), 'a header declaration leaked into the outline');
	});

	it('never publishes a finding under a uri that is not a document', () => {
		const known = new Set([CANONICAL, LITERAL, INCLUDE_HEADER, INCLUDE_MAIN, INCLUDE_OTHER]);
		const stray = client.published.filter(entry => entry.count > 0 && !known.has(entry.uri));
		assert.deepEqual(stray, [], 'a finding was attributed to something the editor does not have');
	});
});
