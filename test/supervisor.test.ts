/*
 * What the supervisor says when a thread dies holding a request.
 *
 * The compiler runs in a worker thread so that a crash cannot reach the editor,
 * but that only moves the failure: a request posted to a thread that dies is
 * never answered, and the document it belongs to keeps the previous run's
 * diagnostics with nothing to say they are no longer current. `died()` used to
 * log the crash to the output channel and do nothing else -- the difference
 * between "your file has not been checked" and a file that looks checked.
 *
 * The two fixtures are written into out/test/ rather than bundled: they are one
 * line of JavaScript each, the supervisor only ever needs a path to hand to
 * `new Worker`, and the two failure modes have to be produced on demand.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AnalysisWorkerHost } from '../src/compiler/analysisSupervisor';
import type { AnalysisRequest, AnalysisResponse } from '../src/common/types';

const URI = 'file:///project/main.mlgc';

const request: Omit<AnalysisRequest, 'id'> = {
	uri: URI,
	version: 3,
	text: 'int main() { return 0; }\n',
	includePaths: [],
	memoryBlocks: [],
	targetVersion: 154.3,
};

/** A stand-in worker bundle, written next to the test bundles it sits beside. */
function fixture(name: string, body: string): string {
	const file = path.join(__dirname, name);
	fs.writeFileSync(file, body);
	return file;
}

function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 5);
		};
		tick();
	});
}

function settle(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe('a thread that dies with a request in flight', () => {
	it('answers that request rather than leaving the document looking checked', async () => {
		const seen: AnalysisResponse[] = [];
		const crashes: string[] = [];
		const host = new AnalysisWorkerHost({
			// Exits the moment it starts, which is the closest stand-in for a
			// thread that dies for a reason of its own.
			workerPath: fixture('fixture-dying-worker.js', 'process.exit(1);\n'),
			debounceMs: 0,
			onResult: response => seen.push(response),
			onCrash: reason => crashes.push(reason),
		});

		try {
			host.analyse(request);
			await waitFor(() => seen.length > 0, 'the lost request to be answered');

			const [response] = seen;
			assert.equal(seen.length, 1, 'the request was answered more than once');
			assert.equal(response.uri, URI);
			assert.equal(response.index, null, 'there is no index from a thread that died');
			assert.equal(response.diagnostics.length, 1, 'a lost request must leave a mark');
			assert.equal(response.diagnostics[0].severity, 'error');
			assert.match(response.fatal!, /stopped unexpectedly/);
			assert.ok(crashes.length >= 1, 'the crash itself should still be logged');
		} finally {
			await host.dispose();
		}
	});

	it('does not blame the shutdown for the thread it just terminated', async () => {
		const seen: AnalysisResponse[] = [];
		const crashes: string[] = [];
		const host = new AnalysisWorkerHost({
			// Never exits on its own, so the only `exit` is the one dispose causes.
			workerPath: fixture('fixture-hanging-worker.js', 'setInterval(() => {}, 1000);\n'),
			debounceMs: 0,
			onResult: response => seen.push(response),
			onCrash: reason => crashes.push(reason),
		});

		host.analyse(request);
		// The debounce is zero, so the request is on its way within a tick or
		// two; the thread then simply never answers it.
		await settle(100);

		await host.dispose();
		await settle(100);

		assert.deepEqual(crashes, [], 'a deliberate termination was reported as a crash');
		assert.deepEqual(seen, [], 'a request abandoned by shutdown was reported as a failure');
		assert.equal(host.crashCount, 0);
	});
});

describe('a result that a newer edit has superseded', () => {
	it('is not published as if it described the current text', async () => {
		const seen: AnalysisResponse[] = [];
		const host = new AnalysisWorkerHost({
			// Answers after 300 ms, so the edit below lands while it is running.
			workerPath: fixture(
				'fixture-delayed-worker.js',
				`const { parentPort } = require('node:worker_threads');
parentPort.on('message', message => {
	setTimeout(() => {
		parentPort.postMessage({ id: message.id, uri: message.uri, diagnostics: [], index: null, fatal: JSON.stringify({ version: message.version }) });
	}, 300);
});
`
			),
			debounceMs: 0,
			onResult: response => seen.push(response),
		});

		try {
			host.analyse(request);
			// Let the request reach the worker; it answers after 300 ms.
			await settle(50);
			// `analyse` is not called again until the server's debounce fires, so
			// `invalidate` is the only signal that this result is now outdated.
			host.invalidate(URI);
			await settle(400);
			assert.equal(seen.length, 0, 'a result for text that no longer exists was published');

			host.analyse({ ...request, version: 4 });
			await waitFor(() => seen.length > 0, 'the fresh result');
			assert.match(seen[0].fatal!, /"version":4/);
		} finally {
			await host.dispose();
		}
	});
});

describe('a thread that is told about buffers that changed', () => {
	it('uses the new text for the next request, not the map it started with', async () => {
		const seen: AnalysisResponse[] = [];
		const host = new AnalysisWorkerHost({
			// Answers with the map it currently holds, so the assertion is about
			// what the thread believes rather than about how it was told.
			workerPath: fixture(
				'fixture-documents-worker.js',
				`const { parentPort, workerData } = require('node:worker_threads');
let known = workerData.knownPaths ?? {};
parentPort.on('message', message => {
	if (message.type === 'known-documents') { known = message.documents; return; }
	parentPort.postMessage({ id: message.id, uri: message.uri, diagnostics: [], index: null, fatal: JSON.stringify(known) });
});
`
			),
			debounceMs: 0,
			onResult: response => seen.push(response),
		});

		try {
			host.setKnownDocuments(new Map([['file:///project/lib.h', 'int before(void);']]));
			host.analyse(request);
			await waitFor(() => seen.length === 1, 'the first answer');
			assert.match(seen[0].fatal!, /int before/);

			// The thread is already running, so only the message can reach it.
			host.setKnownDocuments(new Map([['file:///project/lib.h', 'int after(void);']]));
			host.analyse({ ...request, version: request.version + 1 });
			await waitFor(() => seen.length === 2, 'the second answer');

			assert.match(seen[1].fatal!, /int after/);
			assert.doesNotMatch(seen[1].fatal!, /int before/);
		} finally {
			await host.dispose();
		}
	});
});

