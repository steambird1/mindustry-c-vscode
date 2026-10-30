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

	let buffer = '';
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
		buffer += String(chunk);
		for (;;) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const match = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd));
			if (!match) {
				buffer = buffer.slice(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length);
			buffer = buffer.slice(headerEnd + 4 + length);
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
		open(INCLUDE_HEADER, 'c', 'int fromBuffer(void);\n');
		open(INCLUDE_MAIN, 'mlgc', '#include "lib.h"\nint main(void) {\n    return 0;\n}\n');

		const result = await client.waitForPublish(INCLUDE_MAIN, 20000);

		assert.equal(result.count, 0, `expected a clean run, got: ${result.messages.join(' | ')}`);
	});

	it('never publishes a finding under a uri that is not a document', () => {
		const known = new Set([CANONICAL, LITERAL, INCLUDE_HEADER, INCLUDE_MAIN]);
		const stray = client.published.filter(entry => entry.count > 0 && !known.has(entry.uri));
		assert.deepEqual(stray, [], 'a finding was attributed to something the editor does not have');
	});
});
